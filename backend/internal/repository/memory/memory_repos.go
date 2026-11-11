package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
)

// Compile-time checks that the in-memory stores stay in sync with the domain interfaces.
var (
	_ domain.ApplicantRepository = (*MemoryApplicantRepo)(nil)
	_ domain.SettingRepository   = (*MemorySettingRepo)(nil)
	_ domain.AdminRepository     = (*MemoryAdminRepo)(nil)
	_ domain.PaymentRepository   = (*MemoryPaymentRepo)(nil)
	_ domain.AuditRepository     = (*MemoryAuditRepo)(nil)
)

// MemoryAuditRepo keeps audit entries in memory (development and tests only).
type MemoryAuditRepo struct {
	mu      sync.RWMutex
	entries []*domain.AuditEntry
}

func NewMemoryAuditRepo() *MemoryAuditRepo {
	return &MemoryAuditRepo{}
}

// checkAuditDetails mirrors what the Postgres insertAudit does with Details (json.Marshal into a
// jsonb column). A value that cannot be marshalled, such as a method value passed instead of the
// result of calling it, fails there with HTTP 500, so the in-memory store must fail the same way
// and let unit tests catch it.
func checkAuditDetails(e *domain.AuditEntry) error {
	if e == nil || e.Details == nil {
		return nil
	}
	if _, err := json.Marshal(e.Details); err != nil {
		return fmt.Errorf("audit details for %q are not JSON-serialisable: %w", e.Action, err)
	}
	return nil
}

func (m *MemoryAuditRepo) Log(ctx context.Context, e *domain.AuditEntry) error {
	if err := checkAuditDetails(e); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	clone := *e
	clone.ID = int64(len(m.entries) + 1)
	clone.CreatedAt = time.Now().UTC()
	m.entries = append(m.entries, &clone)
	return nil
}

// Entries returns a snapshot of all audit entries, oldest first.
func (m *MemoryAuditRepo) Entries() []domain.AuditEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]domain.AuditEntry, len(m.entries))
	for i, e := range m.entries {
		out[i] = *e
	}
	return out
}

// MemoryApplicantRepo provides thread-safe in-memory storage for applicants
type MemoryApplicantRepo struct {
	mu    sync.RWMutex
	data  map[uuid.UUID]*domain.Applicant
	logs  []*domain.ApplicantStatusLog
	audit *MemoryAuditRepo

	// payments is the payment store built on this repository (set by NewMemoryPaymentRepo), so a
	// self-service withdrawal can check for slips under the same locks. Lock order everywhere:
	// payments.mu before mu.
	payments *MemoryPaymentRepo
}

func NewMemoryApplicantRepo() *MemoryApplicantRepo {
	return &MemoryApplicantRepo{
		data:  make(map[uuid.UUID]*domain.Applicant),
		logs:  make([]*domain.ApplicantStatusLog, 0),
		audit: NewMemoryAuditRepo(),
	}
}

// Audit is the audit store this repository (and the payment repo built on it) writes to.
func (m *MemoryApplicantRepo) Audit() *MemoryAuditRepo { return m.audit }

// StatusLogs returns a snapshot of the status change log, oldest first.
func (m *MemoryApplicantRepo) StatusLogs() []domain.ApplicantStatusLog {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]domain.ApplicantStatusLog, len(m.logs))
	for i, l := range m.logs {
		out[i] = *l
	}
	return out
}

func (m *MemoryApplicantRepo) Create(ctx context.Context, a *domain.Applicant) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.createLocked(a)
}

func (m *MemoryApplicantRepo) CreateWithinCapacity(ctx context.Context, a *domain.Applicant, maxCapacity int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if maxCapacity > 0 && m.countActiveLocked() >= maxCapacity {
		return domain.ErrCapacityReached
	}
	return m.createLocked(a)
}

func (m *MemoryApplicantRepo) createLocked(a *domain.Applicant) error {
	for _, existing := range m.data {
		if a.IdempotencyKey != nil && existing.IdempotencyKey != nil && *existing.IdempotencyKey == *a.IdempotencyKey {
			return domain.ErrDuplicateIdempotencyKey
		}
		if existing.ApplicationNo == a.ApplicationNo {
			return domain.ErrDuplicateApplicationNo
		}
		// A withdrawn / deleted application no longer holds the person's identity, so they can
		// register again (mirrors the partial unique indexes in migration 000003).
		if existing.DeletedAt != nil {
			continue
		}
		if existing.NationalID == a.NationalID || existing.Phone == a.Phone ||
			(a.Email != "" && existing.Email == a.Email) {
			return domain.ErrDuplicateApplicant
		}
	}

	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	now := time.Now().UTC()
	a.CreatedAt = now
	a.UpdatedAt = now

	// Clone to avoid pointer side-effects
	clone := *a
	m.data[a.ID] = &clone
	return nil
}

func (m *MemoryApplicantRepo) find(match func(*domain.Applicant) bool) (*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, a := range m.data {
		if a.DeletedAt == nil && match(a) {
			clone := *a
			return &clone, nil
		}
	}
	return nil, domain.ErrNotFound
}

func (m *MemoryApplicantRepo) GetByID(ctx context.Context, id uuid.UUID) (*domain.Applicant, error) {
	return m.find(func(a *domain.Applicant) bool { return a.ID == id })
}

func (m *MemoryApplicantRepo) GetByApplicationNo(ctx context.Context, appNo string) (*domain.Applicant, error) {
	return m.find(func(a *domain.Applicant) bool { return a.ApplicationNo == appNo })
}

func (m *MemoryApplicantRepo) GetByNationalID(ctx context.Context, nationalID string) (*domain.Applicant, error) {
	return m.find(func(a *domain.Applicant) bool { return a.NationalID == nationalID })
}

func (m *MemoryApplicantRepo) GetByIdempotencyKey(ctx context.Context, key uuid.UUID) (*domain.Applicant, error) {
	return m.find(func(a *domain.Applicant) bool { return a.IdempotencyKey != nil && *a.IdempotencyKey == key })
}

func (m *MemoryApplicantRepo) FindByQuery(ctx context.Context, q string) (*domain.Applicant, error) {
	return m.find(func(a *domain.Applicant) bool {
		return a.ApplicationNo == q || a.NationalID == q || a.Phone == q
	})
}

func (m *MemoryApplicantRepo) ListAll(ctx context.Context, status *domain.ApplicationStatus) ([]*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var result []*domain.Applicant
	for _, a := range m.data {
		if a.DeletedAt != nil {
			continue
		}
		if status != nil && a.Status != *status {
			continue
		}
		clone := *a
		result = append(result, &clone)
	}
	return result, nil
}

func (m *MemoryApplicantRepo) UpdateStatus(ctx context.Context, id uuid.UUID, newStatus domain.ApplicationStatus, adminID *int64, reason string, audit *domain.AuditEntry) error {
	if err := checkAuditDetails(audit); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	// Mirrors Postgres: the caller chose this path on an unlocked read. If the seat was released
	// meanwhile, this change would take it back without the quota check.
	if a, ok := m.data[id]; ok && a.DeletedAt == nil && !a.Status.IsActive() && newStatus.IsActive() {
		return domain.ErrStateConflict
	}
	oldStatus, err := m.setStatusLocked(id, newStatus, adminID, reason)
	if err != nil {
		return err
	}
	if audit != nil {
		return m.audit.Log(ctx, withDetail(audit, "oldStatus", oldStatus))
	}
	return nil
}

// UpdateStatusWithinCapacity mirrors the Postgres version: one lock covers the status read, the
// seat count and the write, so a restore can never exceed maxCapacity.
func (m *MemoryApplicantRepo) UpdateStatusWithinCapacity(ctx context.Context, id uuid.UUID, newStatus domain.ApplicationStatus, adminID *int64, reason string, audit *domain.AuditEntry, maxCapacity int) error {
	if err := checkAuditDetails(audit); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return domain.ErrNotFound
	}
	if maxCapacity > 0 && !a.Status.IsActive() && newStatus.IsActive() && m.countActiveLocked() >= maxCapacity {
		return domain.ErrCapacityReached
	}
	oldStatus, err := m.setStatusLocked(id, newStatus, adminID, reason)
	if err != nil {
		return err
	}
	if audit != nil {
		return m.audit.Log(ctx, withDetail(audit, "oldStatus", oldStatus))
	}
	return nil
}

// UpdateProfile mirrors the Postgres version, including the duplicate check against the other
// live applicants (the partial unique indexes of migration 000003).
func (m *MemoryApplicantRepo) UpdateProfile(ctx context.Context, id uuid.UUID, p domain.ProfileFields, requireActive bool, audit *domain.AuditEntry) error {
	if err := checkAuditDetails(audit); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return domain.ErrNotFound
	}
	if requireActive && !a.Status.IsActive() {
		return domain.ErrStateConflict
	}
	for _, other := range m.data {
		if other.ID == id || other.DeletedAt != nil {
			continue
		}
		if other.NationalID == p.NationalID || other.Phone == p.Phone ||
			(p.Email != "" && other.Email == p.Email) {
			return domain.ErrDuplicateApplicant
		}
	}

	if a.EmergencyPhone == a.Phone {
		a.EmergencyPhone = p.Phone
	}
	a.FirstName, a.LastName, a.Nickname = p.FirstName, p.LastName, p.Nickname
	a.NationalID, a.Phone, a.Email = p.NationalID, p.Phone, p.Email
	a.School, a.Province, a.Grade, a.ShirtSize = p.School, p.Province, p.Grade, p.ShirtSize
	a.Motivation = p.Motivation
	a.UpdatedAt = time.Now().UTC()

	if audit != nil {
		return m.audit.Log(ctx, withDetail(audit, "status", a.Status))
	}
	return nil
}

func (m *MemoryApplicantRepo) setStatusLocked(id uuid.UUID, newStatus domain.ApplicationStatus, adminID *int64, reason string) (domain.ApplicationStatus, error) {
	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return "", domain.ErrNotFound
	}
	oldStatus := a.Status
	a.Status = newStatus
	a.UpdatedAt = time.Now().UTC()

	r := reason
	m.logs = append(m.logs, &domain.ApplicantStatusLog{
		ID:               int64(len(m.logs) + 1),
		ApplicantID:      id,
		ChangedByAdminID: adminID,
		OldStatus:        oldStatus,
		NewStatus:        newStatus,
		Reason:           &r,
		CreatedAt:        a.UpdatedAt,
	})
	return oldStatus, nil
}

func (m *MemoryApplicantRepo) SoftDelete(ctx context.Context, id uuid.UUID, adminID *int64, reason string, audit *domain.AuditEntry) error {
	if err := checkAuditDetails(audit); err != nil {
		return err
	}
	// Mirrors Postgres: the slip store is held for the whole step, so no slip can be added between
	// the check and the delete (lock order payments.mu, then mu).
	if p := m.payments; p != nil {
		p.mu.Lock()
		defer p.mu.Unlock()
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return domain.ErrNotFound
	}
	if adminID == nil {
		if a.Status == domain.StatusConfirmed || !a.Status.IsActive() {
			return domain.ErrStateConflict
		}
		if m.payments != nil && m.payments.holdsSlipLocked(id) {
			return domain.ErrStateConflict
		}
	}
	now := time.Now().UTC()
	a.DeletedAt = &now
	a.UpdatedAt = now
	// Mirrors migration 000006: the deleted applicant's slips keep their status and hash, but no
	// longer hold the hash against a new registration sending the same slip.
	if m.payments != nil {
		m.payments.releaseHashesLocked(id)
	}

	if audit != nil {
		entry := withDetail(audit, "deletedAt", now)
		entry.Details["oldStatus"] = a.Status
		entry.Details["reason"] = reason
		return m.audit.Log(ctx, entry)
	}
	return nil
}

func (m *MemoryApplicantRepo) UpdateAttendance(ctx context.Context, id uuid.UUID, confirmed bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return domain.ErrNotFound
	}
	a.AttendanceConfirmed = confirmed
	a.UpdatedAt = time.Now().UTC()
	return nil
}

func (m *MemoryApplicantRepo) CountActive(ctx context.Context) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.countActiveLocked(), nil
}

func (m *MemoryApplicantRepo) countActiveLocked() int {
	count := 0
	for _, a := range m.data {
		if a.Status.IsActive() && a.DeletedAt == nil {
			count++
		}
	}
	return count
}

func withDetail(e *domain.AuditEntry, key string, value any) *domain.AuditEntry {
	clone := *e
	clone.Details = make(map[string]any, len(e.Details)+1)
	for k, v := range e.Details {
		clone.Details[k] = v
	}
	clone.Details[key] = value
	return &clone
}

// MemorySettingRepo
type MemorySettingRepo struct {
	mu       sync.RWMutex
	settings *domain.Settings
}

func NewMemorySettingRepo() *MemorySettingRepo {
	now := time.Now().UTC()
	openAt := now.Add(-1 * time.Hour) // Open by default for test
	closeAt := now.Add(14 * 24 * time.Hour)

	return &MemorySettingRepo{
		settings: &domain.Settings{
			ID:                  1,
			CampName:            "ComCamp 25th",
			RegistrationOpenAt:  openAt,
			RegistrationCloseAt: closeAt,
			MaxCapacity:         30,
			CampFee:             decimal.NewFromFloat(1000.00),
			IsManualClosed:      false,
			UpdatedAt:           now,
		},
	}
}

func (m *MemorySettingRepo) Get(ctx context.Context) (*domain.Settings, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	clone := *m.settings
	return &clone, nil
}

func (m *MemorySettingRepo) Update(ctx context.Context, s *domain.Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	clone := *s
	clone.UpdatedAt = time.Now().UTC()
	m.settings = &clone
	return nil
}

// MemoryAdminRepo
type MemoryAdminRepo struct {
	mu    sync.RWMutex
	data  map[int64]*domain.Admin
	byUsr map[string]*domain.Admin
}

func NewMemoryAdminRepo() *MemoryAdminRepo {
	return &MemoryAdminRepo{
		data:  make(map[int64]*domain.Admin),
		byUsr: make(map[string]*domain.Admin),
	}
}

func (m *MemoryAdminRepo) GetByID(ctx context.Context, id int64) (*domain.Admin, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	a, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	clone := *a
	return &clone, nil
}

func (m *MemoryAdminRepo) GetByUsername(ctx context.Context, username string) (*domain.Admin, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	a, ok := m.byUsr[username]
	if !ok {
		return nil, domain.ErrNotFound
	}
	clone := *a
	return &clone, nil
}

func (m *MemoryAdminRepo) UpdateLastLogin(ctx context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok {
		return domain.ErrNotFound
	}
	now := time.Now().UTC()
	a.LastLoginAt = &now
	return nil
}

// SetActive enables or disables an admin account (used by tests).
func (m *MemoryAdminRepo) SetActive(id int64, active bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok {
		return domain.ErrNotFound
	}
	a.IsActive = active
	return nil
}

// SetRole changes an admin's role (used by tests).
func (m *MemoryAdminRepo) SetRole(id int64, role domain.AdminRole) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok {
		return domain.ErrNotFound
	}
	a.Role = role
	return nil
}

func (m *MemoryAdminRepo) Create(ctx context.Context, a *domain.Admin) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.byUsr[a.Username]; ok {
		return errors.New("username already exists")
	}
	if a.ID == 0 {
		a.ID = int64(len(m.data) + 1)
	}
	now := time.Now().UTC()
	a.CreatedAt = now
	a.UpdatedAt = now

	clone := *a
	m.data[a.ID] = &clone
	m.byUsr[a.Username] = &clone
	return nil
}

// MemoryPaymentRepo
type MemoryPaymentRepo struct {
	mu         sync.RWMutex
	data       map[uuid.UUID]*domain.Payment
	appRepo    *MemoryApplicantRepo
	transRefs  map[string]bool
	slipHashes map[string]bool
}

func NewMemoryPaymentRepo(appRepo *MemoryApplicantRepo) *MemoryPaymentRepo {
	m := &MemoryPaymentRepo{
		data:       make(map[uuid.UUID]*domain.Payment),
		appRepo:    appRepo,
		transRefs:  make(map[string]bool),
		slipHashes: make(map[string]bool),
	}
	if appRepo != nil {
		appRepo.mu.Lock()
		appRepo.payments = m
		appRepo.mu.Unlock()
	}
	return m
}

// releaseHashesLocked stops the applicant's slips from holding their hashes (the applicant was
// soft-deleted). Payment rows, their status and their SlipHash are left as they are. A REJECTED
// slip holds no hash already, and its hash may now belong to someone else's live slip, so it is
// not touched. Caller holds m.mu.
func (m *MemoryPaymentRepo) releaseHashesLocked(applicantID uuid.UUID) {
	for _, p := range m.data {
		if p.ApplicantID != applicantID || p.Status == domain.PaymentRejected || p.SlipHash == nil {
			continue
		}
		delete(m.slipHashes, *p.SlipHash)
	}
}

// holdsSlipLocked reports whether the applicant has a PENDING or APPROVED slip. Caller holds m.mu.
func (m *MemoryPaymentRepo) holdsSlipLocked(applicantID uuid.UUID) bool {
	for _, p := range m.data {
		if p.ApplicantID == applicantID && (p.Status == domain.PaymentPending || p.Status == domain.PaymentApproved) {
			return true
		}
	}
	return false
}

func (m *MemoryPaymentRepo) Create(ctx context.Context, p *domain.Payment) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if p.TransRef != nil && *p.TransRef != "" && m.transRefs[*p.TransRef] {
		return domain.ErrDuplicateSlipHash
	}
	if p.SlipHash != nil && *p.SlipHash != "" && m.slipHashes[*p.SlipHash] {
		return domain.ErrDuplicateSlipHash
	}

	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	p.UploadedAt = time.Now().UTC()

	clone := *p
	m.data[p.ID] = &clone
	if p.TransRef != nil && *p.TransRef != "" {
		m.transRefs[*p.TransRef] = true
	}
	if p.SlipHash != nil && *p.SlipHash != "" {
		m.slipHashes[*p.SlipHash] = true
	}
	return nil
}

// CreateReplacingPending mirrors the PostgreSQL implementation: one mutex section checks for an
// approved slip, drops the applicant's PENDING slips (freeing their hashes) and inserts the new one.
func (m *MemoryPaymentRepo) CreateReplacingPending(ctx context.Context, p *domain.Payment) ([]*domain.Payment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// A withdrawal holds m.mu for its whole step, so it either finished (the applicant is gone) or
	// will see this slip.
	if m.appRepo != nil {
		m.appRepo.mu.RLock()
		a, ok := m.appRepo.data[p.ApplicantID]
		live := ok && a.DeletedAt == nil
		m.appRepo.mu.RUnlock()
		if !live {
			return nil, domain.ErrNotFound
		}
	}

	var pending []*domain.Payment
	for _, old := range m.data {
		if old.ApplicantID != p.ApplicantID {
			continue
		}
		switch old.Status {
		case domain.PaymentApproved:
			return nil, domain.ErrPaymentAlreadyVerified
		case domain.PaymentPending:
			pending = append(pending, old)
		}
	}

	if p.TransRef != nil && *p.TransRef != "" && m.transRefs[*p.TransRef] {
		return nil, domain.ErrDuplicateSlipHash
	}
	if p.SlipHash != nil && *p.SlipHash != "" && m.slipHashes[*p.SlipHash] {
		// The hash of a slip that is being replaced right now would be free again, but the new
		// upload is checked against the table as it stands, like the unique index does.
		held := false
		for _, old := range pending {
			if old.SlipHash != nil && *old.SlipHash == *p.SlipHash {
				held = true
			}
		}
		if !held {
			return nil, domain.ErrDuplicateSlipHash
		}
	}

	superseded := make([]*domain.Payment, 0, len(pending))
	for _, old := range pending {
		clone := *old
		superseded = append(superseded, &clone)
		delete(m.data, old.ID)
		if old.SlipHash != nil {
			delete(m.slipHashes, *old.SlipHash)
		}
		if old.TransRef != nil {
			delete(m.transRefs, *old.TransRef)
		}
	}

	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	p.UploadedAt = time.Now().UTC()
	clone := *p
	m.data[p.ID] = &clone
	if p.TransRef != nil && *p.TransRef != "" {
		m.transRefs[*p.TransRef] = true
	}
	if p.SlipHash != nil && *p.SlipHash != "" {
		m.slipHashes[*p.SlipHash] = true
	}
	return superseded, nil
}

func (m *MemoryPaymentRepo) GetByID(ctx context.Context, id uuid.UUID) (*domain.Payment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	p, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	clone := *p
	return &clone, nil
}

func (m *MemoryPaymentRepo) GetByApplicantID(ctx context.Context, applicantID uuid.UUID) ([]*domain.Payment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var list []*domain.Payment
	for _, p := range m.data {
		if p.ApplicantID == applicantID {
			clone := *p
			list = append(list, &clone)
		}
	}
	return list, nil
}

func (m *MemoryPaymentRepo) GetLatestByApplicantID(ctx context.Context, applicantID uuid.UUID) (*domain.Payment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var latest *domain.Payment
	for _, p := range m.data {
		if p.ApplicantID == applicantID {
			if latest == nil || !p.UploadedAt.Before(latest.UploadedAt) {
				clone := *p
				latest = &clone
			}
		}
	}
	if latest == nil {
		return nil, domain.ErrNotFound
	}
	return latest, nil
}

func (m *MemoryPaymentRepo) CheckDuplicateTransRef(ctx context.Context, transRef string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.transRefs[transRef], nil
}

func (m *MemoryPaymentRepo) CheckDuplicateSlipHash(ctx context.Context, slipHash string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.slipHashes[slipHash], nil
}

func (m *MemoryPaymentRepo) Verify(ctx context.Context, paymentID uuid.UUID, approved bool, adminID int64, note string, audit *domain.AuditEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	p, ok := m.data[paymentID]
	if !ok {
		return domain.ErrNotFound
	}
	if p.Status != domain.PaymentPending {
		return domain.ErrPaymentAlreadyVerified
	}
	// A refunded, rejected, withdrawn or deleted application has left the camp: its slip can no
	// longer be settled. The applicant store stays locked from this check to the status change
	// (like the Postgres row lock), and a refusal leaves payment and applicant untouched.
	if m.appRepo != nil {
		m.appRepo.mu.Lock()
		defer m.appRepo.mu.Unlock()
		a, found := m.appRepo.data[p.ApplicantID]
		if !found || a.DeletedAt != nil || !a.Status.IsActive() {
			return domain.ErrStateConflict
		}
	}

	now := time.Now().UTC()
	newStatus := domain.StatusPassed
	if approved {
		p.Status = domain.PaymentApproved
		newStatus = domain.StatusConfirmed
	} else {
		p.Status = domain.PaymentRejected
		p.RejectionReason = &note
		// Like the partial unique index of migration 000005: a rejected slip no longer holds its
		// hash, so the same image can be sent again.
		if p.SlipHash != nil {
			delete(m.slipHashes, *p.SlipHash)
		}
	}
	p.VerifiedByAdminID = &adminID
	p.AdminNote = &note
	p.VerifiedAt = &now

	if m.appRepo != nil {
		oldStatus, err := m.appRepo.setStatusLocked(p.ApplicantID, newStatus, &adminID, note)
		if err != nil {
			return err
		}
		if audit != nil {
			entry := withDetail(audit, "oldStatus", oldStatus)
			entry.Details["newStatus"] = newStatus
			if err := m.appRepo.audit.Log(ctx, entry); err != nil {
				return err
			}
		}
	}

	return nil
}
