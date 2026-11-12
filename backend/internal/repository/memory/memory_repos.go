package memory

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
)

// MemoryApplicantRepo provides thread-safe in-memory storage for applicants.
type MemoryApplicantRepo struct {
	mu          sync.RWMutex
	data        map[uuid.UUID]*domain.Applicant
	logs        []*domain.ApplicantStatusLog
	settingRepo *MemorySettingRepo
}

func NewMemoryApplicantRepo() *MemoryApplicantRepo {
	return &MemoryApplicantRepo{
		data: make(map[uuid.UUID]*domain.Applicant),
		logs: make([]*domain.ApplicantStatusLog, 0),
	}
}

func (m *MemoryApplicantRepo) SetSettingRepo(settingRepo *MemorySettingRepo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settingRepo = settingRepo
}

func (m *MemoryApplicantRepo) Create(ctx context.Context, a *domain.Applicant) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, existing := range m.data {
		if existing.DeletedAt != nil {
			continue
		}
		if strings.EqualFold(existing.ApplicationNo, a.ApplicationNo) {
			return domain.ErrDuplicateApplicationNo
		}
		if existing.NationalID == a.NationalID {
			return domain.ErrDuplicateApplicant
		}
		if existing.Phone == a.Phone {
			return domain.ErrDuplicateApplicant
		}
		if a.Email != "" && existing.Email != "" && strings.EqualFold(existing.Email, a.Email) {
			return domain.ErrDuplicateApplicant
		}
	}

	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	now := time.Now().UTC()
	a.CreatedAt = now
	a.UpdatedAt = now

	clone := *a
	m.data[a.ID] = &clone
	return nil
}

func (m *MemoryApplicantRepo) GetByID(ctx context.Context, id uuid.UUID) (*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return nil, domain.ErrApplicantNotFound
	}
	clone := *a
	return &clone, nil
}

func (m *MemoryApplicantRepo) GetByApplicationNo(ctx context.Context, appNo string) (*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	trimmed := strings.TrimSpace(appNo)
	for _, a := range m.data {
		if a.DeletedAt == nil && strings.EqualFold(a.ApplicationNo, trimmed) {
			clone := *a
			return &clone, nil
		}
	}
	return nil, domain.ErrApplicantNotFound
}

func (m *MemoryApplicantRepo) GetByNationalID(ctx context.Context, nationalID string) (*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, a := range m.data {
		if a.DeletedAt == nil && a.NationalID == nationalID {
			clone := *a
			return &clone, nil
		}
	}
	return nil, domain.ErrApplicantNotFound
}

func (m *MemoryApplicantRepo) FindByQuery(ctx context.Context, q string) (*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	trimmed := strings.TrimSpace(q)
	for _, a := range m.data {
		if a.DeletedAt != nil {
			continue
		}
		if strings.EqualFold(a.ApplicationNo, trimmed) || a.NationalID == trimmed || a.Phone == trimmed {
			clone := *a
			return &clone, nil
		}
	}
	return nil, domain.ErrApplicantNotFound
}

func (m *MemoryApplicantRepo) FindByIDOrAppNo(ctx context.Context, idOrAppNo string) (*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	trimmed := strings.TrimSpace(idOrAppNo)
	if parsedID, err := uuid.Parse(trimmed); err == nil {
		a, ok := m.data[parsedID]
		if !ok || a.DeletedAt != nil {
			return nil, domain.ErrApplicantNotFound
		}
		clone := *a
		return &clone, nil
	}

	for _, a := range m.data {
		if a.DeletedAt == nil && strings.EqualFold(a.ApplicationNo, trimmed) {
			clone := *a
			return &clone, nil
		}
	}
	return nil, domain.ErrApplicantNotFound
}

func (m *MemoryApplicantRepo) ListAll(ctx context.Context, status *domain.ApplicationStatus) ([]*domain.Applicant, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]*domain.Applicant, 0)
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

	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].ID.String() < result[j].ID.String()
		}
		return result[i].CreatedAt.Before(result[j].CreatedAt)
	})

	return result, nil
}

func (m *MemoryApplicantRepo) UpdateStatus(ctx context.Context, id uuid.UUID, newStatus domain.ApplicationStatus, adminID *int64, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return domain.ErrApplicantNotFound
	}

	oldStatus := a.Status
	if newStatus == domain.StatusConfirmed && oldStatus != domain.StatusConfirmed && m.settingRepo != nil {
		if settings, err := m.settingRepo.Get(ctx); err == nil && settings != nil {
			if m.countConfirmedLocked() >= settings.MaxCapacity {
				return domain.ErrQuotaExceeded
			}
		}
	}

	now := time.Now().UTC()
	a.Status = newStatus
	if newStatus == domain.StatusConfirmed {
		a.AttendanceConfirmed = true
	}
	a.UpdatedAt = now

	var reasonPtr *string
	if reason != "" {
		r := reason
		reasonPtr = &r
	}
	m.logs = append(m.logs, &domain.ApplicantStatusLog{
		ID:               int64(len(m.logs) + 1),
		ApplicantID:      id,
		ChangedByAdminID: adminID,
		OldStatus:        oldStatus,
		NewStatus:        newStatus,
		Reason:           reasonPtr,
		CreatedAt:        now,
	})
	return nil
}

func (m *MemoryApplicantRepo) UpdateAttendance(ctx context.Context, id uuid.UUID, confirmed bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok || a.DeletedAt != nil {
		return domain.ErrApplicantNotFound
	}
	a.AttendanceConfirmed = confirmed
	a.UpdatedAt = time.Now().UTC()
	return nil
}

func (m *MemoryApplicantRepo) CountActive(ctx context.Context) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	count := 0
	for _, a := range m.data {
		if a.Status != domain.StatusRejected && a.DeletedAt == nil {
			count++
		}
	}
	return count, nil
}

func (m *MemoryApplicantRepo) CountConfirmed(ctx context.Context) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.countConfirmedLocked(), nil
}

func (m *MemoryApplicantRepo) countConfirmedLocked() int {
	count := 0
	for _, a := range m.data {
		if a.Status == domain.StatusConfirmed && a.DeletedAt == nil {
			count++
		}
	}
	return count
}

func (m *MemoryApplicantRepo) applyPaymentVerification(applicantID uuid.UUID, approved bool, maxCapacity int, adminID int64, note string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[applicantID]
	if !ok || a.DeletedAt != nil {
		return domain.ErrApplicantNotFound
	}

	prevStatus := a.Status
	now := time.Now().UTC()

	var newStatus domain.ApplicationStatus
	var reason string
	if approved {
		if prevStatus != domain.StatusConfirmed && m.countConfirmedLocked() >= maxCapacity {
			return domain.ErrQuotaExceeded
		}
		newStatus = domain.StatusConfirmed
		a.Status = domain.StatusConfirmed
		a.AttendanceConfirmed = true
		reason = note
		if reason == "" {
			reason = "Payment approved"
		}
	} else {
		newStatus = domain.StatusPassed
		a.Status = domain.StatusPassed
		reason = note
		if reason == "" {
			reason = "Payment rejected"
		}
	}
	a.UpdatedAt = now

	m.logs = append(m.logs, &domain.ApplicantStatusLog{
		ID:               int64(len(m.logs) + 1),
		ApplicantID:      applicantID,
		ChangedByAdminID: &adminID,
		OldStatus:        prevStatus,
		NewStatus:        newStatus,
		Reason:           &reason,
		CreatedAt:        now,
	})
	return nil
}

// MemorySettingRepo provides thread-safe in-memory storage for camp settings.
type MemorySettingRepo struct {
	mu       sync.RWMutex
	settings *domain.Settings
}

func NewMemorySettingRepo() *MemorySettingRepo {
	now := time.Now().UTC()
	openAt := now.Add(-1 * time.Hour)
	closeAt := now.Add(14 * 24 * time.Hour)

	return &MemorySettingRepo{
		settings: &domain.Settings{
			ID:                  1,
			CampName:            "ComCamp 25th",
			RegistrationOpenAt:  openAt,
			RegistrationCloseAt: closeAt,
			MaxCapacity:         30,
			CampFee:             decimal.NewFromFloat(300.00),
			IsManualClosed:      false,
			UpdatedAt:           now,
		},
	}
}

func (m *MemorySettingRepo) Get(ctx context.Context) (*domain.Settings, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.settings == nil {
		return nil, domain.ErrSettingsNotFound
	}
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

// MemoryAdminRepo provides thread-safe in-memory storage for admin accounts.
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
		return nil, domain.ErrAdminNotFound
	}
	clone := *a
	return &clone, nil
}

func (m *MemoryAdminRepo) GetByUsername(ctx context.Context, username string) (*domain.Admin, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	a, ok := m.byUsr[username]
	if !ok {
		return nil, domain.ErrAdminNotFound
	}
	clone := *a
	return &clone, nil
}

func (m *MemoryAdminRepo) UpdateLastLogin(ctx context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.data[id]
	if !ok {
		return domain.ErrAdminNotFound
	}
	now := time.Now().UTC()
	a.LastLoginAt = &now
	return nil
}

func (m *MemoryAdminRepo) Create(ctx context.Context, a *domain.Admin) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.byUsr[a.Username]; ok {
		return domain.ErrDuplicateAdmin
	}
	if a.ID == 0 {
		a.ID = int64(len(m.data) + 1)
	}
	if a.Role == "" {
		a.Role = domain.RoleAdmin
	}
	now := time.Now().UTC()
	a.CreatedAt = now
	a.UpdatedAt = now

	clone := *a
	m.data[a.ID] = &clone
	m.byUsr[a.Username] = &clone
	return nil
}

func (m *MemoryAdminRepo) Count(ctx context.Context) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return len(m.data), nil
}

// MemoryPaymentRepo provides thread-safe in-memory storage for payment slips.
type MemoryPaymentRepo struct {
	mu          sync.RWMutex
	data        map[uuid.UUID]*domain.Payment
	appRepo     *MemoryApplicantRepo
	settingRepo *MemorySettingRepo
	transRefs   map[string]bool
	slipHashes  map[string]bool
}

func NewMemoryPaymentRepo(appRepo *MemoryApplicantRepo) *MemoryPaymentRepo {
	return &MemoryPaymentRepo{
		data:       make(map[uuid.UUID]*domain.Payment),
		appRepo:    appRepo,
		transRefs:  make(map[string]bool),
		slipHashes: make(map[string]bool),
	}
}

func NewMemoryPaymentRepoWithSettings(appRepo *MemoryApplicantRepo, settingRepo *MemorySettingRepo) *MemoryPaymentRepo {
	repo := NewMemoryPaymentRepo(appRepo)
	repo.settingRepo = settingRepo
	return repo
}

func (m *MemoryPaymentRepo) SetSettingRepo(settingRepo *MemorySettingRepo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settingRepo = settingRepo
}

func (m *MemoryPaymentRepo) Create(ctx context.Context, p *domain.Payment) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if p.TransRef != nil && *p.TransRef != "" && m.transRefs[*p.TransRef] {
		return domain.ErrDuplicateTransRef
	}
	if p.SlipHash != nil && *p.SlipHash != "" && m.slipHashes[*p.SlipHash] {
		return domain.ErrDuplicateSlip
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

func (m *MemoryPaymentRepo) GetByID(ctx context.Context, id uuid.UUID) (*domain.Payment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	p, ok := m.data[id]
	if !ok {
		return nil, domain.ErrPaymentNotFound
	}
	clone := *p
	return &clone, nil
}

func (m *MemoryPaymentRepo) GetByApplicantID(ctx context.Context, applicantID uuid.UUID) ([]*domain.Payment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	list := make([]*domain.Payment, 0)
	for _, p := range m.data {
		if p.ApplicantID == applicantID {
			clone := *p
			list = append(list, &clone)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].UploadedAt.After(list[j].UploadedAt)
	})
	return list, nil
}

func (m *MemoryPaymentRepo) GetLatestByApplicantID(ctx context.Context, applicantID uuid.UUID) (*domain.Payment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var latest *domain.Payment
	for _, p := range m.data {
		if p.ApplicantID == applicantID {
			if latest == nil || p.UploadedAt.After(latest.UploadedAt) {
				clone := *p
				latest = &clone
			}
		}
	}
	if latest == nil {
		return nil, domain.ErrPaymentNotFound
	}
	return latest, nil
}

func (m *MemoryPaymentRepo) GetLatestByApplicantIDs(ctx context.Context, applicantIDs []uuid.UUID) (map[uuid.UUID]*domain.Payment, error) {
	result := make(map[uuid.UUID]*domain.Payment, len(applicantIDs))
	if len(applicantIDs) == 0 {
		return result, nil
	}

	wanted := make(map[uuid.UUID]struct{}, len(applicantIDs))
	for _, id := range applicantIDs {
		wanted[id] = struct{}{}
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, p := range m.data {
		if _, ok := wanted[p.ApplicantID]; !ok {
			continue
		}
		existing, found := result[p.ApplicantID]
		if !found || p.UploadedAt.After(existing.UploadedAt) {
			clone := *p
			result[p.ApplicantID] = &clone
		}
	}
	return result, nil
}

func (m *MemoryPaymentRepo) CheckDuplicateTransRef(ctx context.Context, transRef string) (bool, error) {
	if transRef == "" {
		return false, nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.transRefs[transRef], nil
}

func (m *MemoryPaymentRepo) CheckDuplicateSlipHash(ctx context.Context, slipHash string) (bool, error) {
	if slipHash == "" {
		return false, nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.slipHashes[slipHash], nil
}

func (m *MemoryPaymentRepo) Verify(ctx context.Context, paymentID uuid.UUID, approved bool, adminID int64, note string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	p, ok := m.data[paymentID]
	if !ok {
		return domain.ErrPaymentNotFound
	}
	if p.Status != domain.PaymentPending {
		return domain.ErrPaymentAlreadyVerified
	}

	maxCapacity := 30
	if m.settingRepo != nil {
		if settings, err := m.settingRepo.Get(ctx); err == nil && settings != nil {
			maxCapacity = settings.MaxCapacity
		}
	}

	if m.appRepo != nil {
		if err := m.appRepo.applyPaymentVerification(p.ApplicantID, approved, maxCapacity, adminID, note); err != nil {
			return err
		}
	}

	now := time.Now().UTC()
	var notePtr *string
	if note != "" {
		n := note
		notePtr = &n
	}

	if approved {
		p.Status = domain.PaymentApproved
		p.RejectionReason = nil
	} else {
		p.Status = domain.PaymentRejected
		p.RejectionReason = notePtr
	}
	p.VerifiedByAdminID = &adminID
	p.AdminNote = notePtr
	p.VerifiedAt = &now

	return nil
}
