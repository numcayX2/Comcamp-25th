package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"fmt"
	htmltmpl "html/template"
	"log"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"sync"
	texttmpl "text/template"
	"time"

	"comcamp25-backend/internal/domain"
)

const (
	defaultMailerQueueSize   = 64
	defaultMailerPace        = 500 * time.Millisecond
	defaultMailerSendTimeout = 10 * time.Second

	campLineOpenChatURL = "https://line.me/ti/g2/SqThbtY8Q_FiT7AA61RNn5LrFsjz9bHjYvmcIQ?utm_source=invitation&utm_medium=QR_code&utm_campaign=default"
	campDormName        = "เรือนพักสมาคมศิษย์เก่าแม่โจ้ (ภายใน ม.แม่โจ้ แยกโซนชาย-หญิง)"
	campDormMapsURL     = "https://maps.app.goo.gl/oKP6J7gn3VXLXn7z7"
	campBankName        = "ธนาคารกรุงเทพ สาขาแม่โจ้"
	campBankNumber      = "587-0-84106-0"
	campBankAccountName = "ชมรมคอมพิวเตอร์ (นาย ภานุวัฒน์ เมฆะ และ นาย อรรถวิท ชังคมานนท์ และ นาย ปวีณ เขื่อนแก้ว)"
	campFBPageURL       = "https://www.facebook.com/CCCSMJU"
	campStaffContact    = "080-993-8214 นายบูรพา มหัทธีรนางกูร (พูล) / 063-784-4515 นางสาวธมล นวลหมวก (แอมมี่)"
)

var bangkokZone = time.FixedZone("Asia/Bangkok", 7*60*60)

// RegistrationEmailData holds fields rendered into the Stage 1 (PASSED) email.
type RegistrationEmailData struct {
	ApplicationNo string
	FullName      string
	Nickname      string
	Email         string
	CampFee       string
	CreatedAt     time.Time
}

// ConfirmedEmailData holds fields rendered into the Stage 2 (CONFIRMED) email.
type ConfirmedEmailData struct {
	ApplicationNo string
	FullName      string
	Nickname      string
	Email         string
	ShirtSize     string
}

// EmailNotifier dispatches registration and confirmation emails asynchronously.
type EmailNotifier interface {
	EnqueueRegistration(data RegistrationEmailData)
	EnqueueConfirmed(data ConfirmedEmailData)
	Shutdown(ctx context.Context) error
}

// SMTPConfig configures AsyncSMTPMailer. When Host is empty (and SendFn is nil),
// outbound email sending is cleanly disabled as a no-op logger.
type SMTPConfig struct {
	Host        string
	Port        string
	Username    string
	Password    string
	From        string
	FrontendURL string
	Pace        time.Duration
	SendTimeout time.Duration
	// QueueSize overrides the queue capacity (0 = 64); tests that enqueue past a cap raise it.
	QueueSize int
	// SendFn overrides actual network SMTP delivery in tests.
	SendFn func(ctx context.Context, addr, from, to string, raw []byte) error
}

type emailKind int

const (
	emailKindRegistration emailKind = iota + 1
	emailKindConfirmed
	emailKindSponsorInquiry
	emailKindStaffRegistration
)

// SponsorInquiryEmailsPerHour caps staff notification emails about sponsor inquiries process-wide,
// so a flood of form submissions cannot turn the SMTP account into a spam source.
const SponsorInquiryEmailsPerHour = 30

// StaffRegistrationNoticesPerHour caps how many new applications per hour are announced to staff
// (each notice goes to every staff address). Seats are limited, so this is only hit by abuse.
const StaffRegistrationNoticesPerHour = 40

// hourlyCap counts the events of one kind of staff email within the last hour.
type hourlyCap struct {
	mu   sync.Mutex
	sent []time.Time
}

// allow reports whether another event fits within limit per hour and, if so, counts it.
func (c *hourlyCap) allow(now time.Time, limit int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	cutoff := now.Add(-time.Hour)
	keep := c.sent[:0]
	for _, t := range c.sent {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	c.sent = keep
	if len(c.sent) >= limit {
		return false
	}
	c.sent = append(c.sent, now)
	return true
}

type emailJob struct {
	kind    emailKind
	appNo   string // application code, or the inquiry id for emailKindSponsorInquiry
	to      string
	subject string
	raw     []byte
}

// AsyncSMTPMailer sends transactional emails on a single paced background worker so
// midnight registration bursts never exhaust MTA burst limits or block PostgreSQL commits.
type AsyncSMTPMailer struct {
	enabled     bool
	addr        string
	host        string
	port        string
	username    string
	password    string
	fromHeader  string
	fromAddr    string
	statusURL   string
	adminURL    string // sponsor desk (/admin#sponsors)
	appsURL     string // applications ledger (/admin#applications)
	pace        time.Duration
	sendTimeout time.Duration
	auditRepo   domain.AuditRepository
	sendFn      func(ctx context.Context, addr, from, to string, raw []byte) error

	mu         sync.RWMutex
	closed     bool
	queue      chan emailJob
	workerDone chan struct{}
	closeOnce  sync.Once

	sponsorCap  hourlyCap
	staffRegCap hourlyCap
}

// NewAsyncSMTPMailer initializes a bounded async email dispatcher and starts its background
// worker when SMTP host (or a test SendFn) is configured.
func NewAsyncSMTPMailer(cfg SMTPConfig, auditRepo domain.AuditRepository) *AsyncSMTPMailer {
	port := strings.TrimSpace(cfg.Port)
	if port == "" {
		port = "587"
	}
	host := strings.TrimSpace(cfg.Host)
	pace := cfg.Pace
	if pace < 0 {
		pace = 0
	} else if pace == 0 && cfg.SendFn == nil {
		pace = defaultMailerPace
	}
	sendTimeout := cfg.SendTimeout
	if sendTimeout <= 0 {
		sendTimeout = defaultMailerSendTimeout
	}

	fromHeader := stripCRLF(strings.TrimSpace(cfg.From))
	if fromHeader == "" {
		fromHeader = stripCRLF(strings.TrimSpace(cfg.Username))
	}
	fromAddr := extractBareAddress(fromHeader)
	if fromAddr == "" {
		fromAddr = "noreply@comcamp.local"
	}
	if fromHeader == "" {
		fromHeader = fromAddr
	}

	enabled := host != "" || cfg.SendFn != nil
	m := &AsyncSMTPMailer{
		enabled:     enabled,
		addr:        net.JoinHostPort(host, port),
		host:        host,
		port:        port,
		username:    strings.TrimSpace(cfg.Username),
		password:    cfg.Password,
		fromHeader:  fromHeader,
		fromAddr:    fromAddr,
		statusURL:   buildStatusURL(cfg.FrontendURL),
		adminURL:    buildFrontendURL(cfg.FrontendURL, "/admin#sponsors"),
		appsURL:     buildFrontendURL(cfg.FrontendURL, "/admin#applications"),
		pace:        pace,
		sendTimeout: sendTimeout,
		auditRepo:   auditRepo,
		sendFn:      cfg.SendFn,
	}
	if !enabled {
		return m
	}

	if m.sendFn == nil {
		m.sendFn = m.sendViaSMTP
	}
	queueSize := cfg.QueueSize
	if queueSize <= 0 {
		queueSize = defaultMailerQueueSize
	}
	m.queue = make(chan emailJob, queueSize)
	m.workerDone = make(chan struct{})
	go m.runWorker()
	return m
}

func buildStatusURL(frontendURL string) string {
	return buildFrontendURL(frontendURL, "/status")
}

// buildFrontendURL joins the first FRONTEND_URL origin with path (path alone when unset).
func buildFrontendURL(frontendURL, path string) string {
	first := strings.TrimSpace(strings.Split(frontendURL, ",")[0])
	return strings.TrimRight(first, "/") + path
}

func extractBareAddress(raw string) string {
	if raw == "" {
		return ""
	}
	if addr, err := mail.ParseAddress(raw); err == nil && addr.Address != "" {
		return addr.Address
	}
	return strings.TrimSpace(raw)
}

func stripCRLF(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}

// EnqueueRegistration formats and queues the Stage 1 (PASSED) registration email.
func (m *AsyncSMTPMailer) EnqueueRegistration(data RegistrationEmailData) {
	if m == nil || !m.enabled || strings.TrimSpace(data.Email) == "" {
		return
	}
	fee := strings.TrimSpace(data.CampFee)
	if fee == "" {
		fee = "1,200"
	}
	createdAt := data.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	deadline := createdAt.In(bangkokZone).Add(UnpaidExpiryWindow)
	view := struct {
		ApplicationNo string
		FullName      string
		Nickname      string
		CampFee       string
		DeadlineText  string
		BankName      string
		BankNumber    string
		BankAccount   string
		StatusURL     string
		FBPageURL     string
		StaffContact  string
	}{
		ApplicationNo: stripCRLF(data.ApplicationNo),
		FullName:      stripCRLF(data.FullName),
		Nickname:      stripCRLF(data.Nickname),
		CampFee:       stripCRLF(fee),
		DeadlineText:  formatBangkokThaiDateTime(deadline),
		BankName:      campBankName,
		BankNumber:    campBankNumber,
		BankAccount:   campBankAccountName,
		StatusURL:     m.statusURL + "?q=" + urlQueryEscape(data.ApplicationNo),
		FBPageURL:     campFBPageURL,
		StaffContact:  campStaffContact,
	}

	subject := fmt.Sprintf("[ComCamp #25] แจ้งรับใบสมัคร %s และขั้นตอนการชำระเงินภายใน 5 วัน", view.ApplicationNo)
	raw, err := buildMultipartMIME(m.fromHeader, stripCRLF(data.Email), subject, regTextTmpl, regHTMLTmpl, view)
	if err != nil {
		log.Printf("mailer: failed to render registration email (%s): %v", data.ApplicationNo, err)
		return
	}

	m.enqueue(emailJob{
		kind:    emailKindRegistration,
		appNo:   data.ApplicationNo,
		to:      stripCRLF(data.Email),
		subject: subject,
		raw:     raw,
	})
}

// EnqueueConfirmed formats and queues the Stage 2 (CONFIRMED) seat-confirmation email.
func (m *AsyncSMTPMailer) EnqueueConfirmed(data ConfirmedEmailData) {
	if m == nil || !m.enabled || strings.TrimSpace(data.Email) == "" {
		return
	}
	view := struct {
		ApplicationNo string
		FullName      string
		Nickname      string
		ShirtSize     string
		DormName      string
		DormMapsURL   string
		LineURL       string
		StatusURL     string
		FBPageURL     string
		StaffContact  string
	}{
		ApplicationNo: stripCRLF(data.ApplicationNo),
		FullName:      stripCRLF(data.FullName),
		Nickname:      stripCRLF(data.Nickname),
		ShirtSize:     stripCRLF(data.ShirtSize),
		DormName:      campDormName,
		DormMapsURL:   campDormMapsURL,
		LineURL:       campLineOpenChatURL,
		StatusURL:     m.statusURL + "?q=" + urlQueryEscape(data.ApplicationNo),
		FBPageURL:     campFBPageURL,
		StaffContact:  campStaffContact,
	}

	subject := fmt.Sprintf("[ComCamp #25] ยืนยันสิทธิ์เข้าร่วมค่ายสมบูรณ์ (%s) · 5–7 ก.พ. 2570", view.ApplicationNo)
	raw, err := buildMultipartMIME(m.fromHeader, stripCRLF(data.Email), subject, confTextTmpl, confHTMLTmpl, view)
	if err != nil {
		log.Printf("mailer: failed to render confirmed email (%s): %v", data.ApplicationNo, err)
		return
	}

	m.enqueue(emailJob{
		kind:    emailKindConfirmed,
		appNo:   data.ApplicationNo,
		to:      stripCRLF(data.Email),
		subject: subject,
		raw:     raw,
	})
}

// sponsorKindLabels are the Thai labels of the inquiry kinds.
var sponsorKindLabels = map[string]string{
	"money": "เงิน (โอน/เงินสด)",
	"goods": "สิ่งของ",
}

// formatBahtAmount renders a canonical decimal amount ("1500.5") with thousands separators and two
// decimals when it has a fraction ("1,500.50"); whole amounts stay without decimals ("1,500").
func formatBahtAmount(canonical string) string {
	intPart, frac, hasFrac := strings.Cut(canonical, ".")
	var b strings.Builder
	for i, r := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if hasFrac {
		if len(frac) == 1 {
			frac += "0"
		}
		b.WriteString("." + frac)
	}
	return b.String()
}

// EnqueueSponsorInquiry formats and queues one staff notification about a new sponsor inquiry.
// Beyond SponsorInquiryEmailsPerHour per hour the email is skipped (the inquiry row is kept).
func (m *AsyncSMTPMailer) EnqueueSponsorInquiry(data SponsorInquiryEmailData) {
	to := stripCRLF(strings.TrimSpace(data.To))
	if m == nil || !m.enabled || to == "" {
		return
	}
	if !m.sponsorCap.allow(time.Now(), SponsorInquiryEmailsPerHour) {
		log.Printf("mailer: sponsor inquiry %d email to %s skipped (hourly cap %d reached)", data.InquiryID, MaskEmail(to), SponsorInquiryEmailsPerHour)
		return
	}
	createdAt := data.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	kind := sponsorKindLabels[data.Kind]
	if kind == "" {
		kind = data.Kind
	}
	email, details := data.Email, data.Details
	if email == "" {
		email = "-"
	}
	if details == "" {
		details = "-"
	}
	file := "-"
	switch {
	case data.FileMIME == "application/pdf":
		file = "แบบฟอร์มบริจาคที่กรอกแล้ว (PDF) เปิดดูได้ในหน้าแอดมิน"
	case data.FileMIME != "":
		file = "แบบฟอร์มบริจาคที่กรอกแล้ว (รูปภาพ) เปิดดูได้ในหน้าแอดมิน"
	}
	slip := ""
	if data.HasSlip {
		slip = "แนบสลิปโอนเงินแล้ว เปิดดูได้ในหน้าแอดมิน"
	}
	amount := ""
	if data.Amount != nil {
		amount = formatBahtAmount(*data.Amount) + " บาท"
	}
	view := struct {
		Name, Phone, Email, Kind, Amount, Details, File, Slip, Time, AdminURL string
	}{
		Name: data.Name, Phone: data.Phone, Email: email, Kind: kind, Amount: amount, Details: details, File: file, Slip: slip,
		Time: formatBangkokThaiDateTime(createdAt), AdminURL: m.adminURL,
	}
	subject := "[ComCamp #25] มีผู้สนใจสนับสนุนค่าย: " + truncateRunes(stripCRLF(data.Name), 60)
	raw, err := buildMultipartMIME(m.fromHeader, to, subject, sponsorInquiryTextTmpl, sponsorInquiryHTMLTmpl, view)
	if err != nil {
		log.Printf("mailer: failed to render sponsor inquiry email (%d): %v", data.InquiryID, err)
		return
	}
	m.enqueueStaff(emailJob{
		kind:    emailKindSponsorInquiry,
		appNo:   fmt.Sprintf("%d", data.InquiryID),
		to:      to,
		subject: subject,
		raw:     raw,
	})
}

// StaffRegistrationEmailData announces one new application to staff. It deliberately carries no
// application code, phone, email, guardian or health data: the email says who applied (what
// /applicants shows anyway) and links to /admin for everything else.
type StaffRegistrationEmailData struct {
	To            []string
	ApplicationNo string // audit target only, never rendered
	FullName      string
	Nickname      string
	School        string
	Province      string
	Grade         string
	SeatsTaken    int // < 0 when the count could not be read
	MaxCapacity   int
	CreatedAt     time.Time
}

// EnqueueStaffRegistration queues one notice per staff address about a new application. Beyond
// StaffRegistrationNoticesPerHour applications per hour the notice is skipped (the application
// itself is unaffected).
func (m *AsyncSMTPMailer) EnqueueStaffRegistration(data StaffRegistrationEmailData) {
	if m == nil || !m.enabled || len(data.To) == 0 {
		return
	}
	if !m.staffRegCap.allow(time.Now(), StaffRegistrationNoticesPerHour) {
		log.Printf("mailer: staff notice for %s skipped (hourly cap %d reached)", data.ApplicationNo, StaffRegistrationNoticesPerHour)
		return
	}
	createdAt := data.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	seats := "-"
	if data.SeatsTaken >= 0 && data.MaxCapacity > 0 {
		seats = fmt.Sprintf("%d/%d", data.SeatsTaken, data.MaxCapacity)
	}
	dash := func(s string) string {
		if s = strings.TrimSpace(s); s == "" {
			return "-"
		}
		return s
	}
	view := struct {
		FullName, Nickname, School, Province, Grade, Time, Seats, AdminURL string
	}{
		FullName: dash(data.FullName), Nickname: dash(data.Nickname), School: dash(data.School),
		Province: dash(data.Province), Grade: dash(data.Grade), Time: formatBangkokThaiDateTime(createdAt),
		Seats: seats, AdminURL: m.appsURL,
	}
	subject := fmt.Sprintf("[ComCamp #25] มีผู้สมัครใหม่ (ที่นั่ง %s): %s", seats, truncateRunes(stripCRLF(view.FullName), 60))
	for _, raw := range data.To {
		to := stripCRLF(strings.TrimSpace(raw))
		if to == "" {
			continue
		}
		msg, err := buildMultipartMIME(m.fromHeader, to, subject, staffRegTextTmpl, staffRegHTMLTmpl, view)
		if err != nil {
			log.Printf("mailer: failed to render staff notice for %s: %v", data.ApplicationNo, err)
			return
		}
		m.enqueueStaff(emailJob{
			kind:    emailKindStaffRegistration,
			appNo:   data.ApplicationNo,
			to:      to,
			subject: subject,
			raw:     msg,
		})
	}
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

func (m *AsyncSMTPMailer) enqueue(job emailJob) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed || m.queue == nil {
		return
	}
	select {
	case m.queue <- job:
	default:
		log.Printf("mailer: queue full, dropping email for %s (%s)", job.appNo, MaskEmail(job.to))
	}
}

// enqueueStaff queues a staff notification only while the queue is less than half full, so staff
// copies never take the room that applicants' own registration / confirmation emails need.
func (m *AsyncSMTPMailer) enqueueStaff(job emailJob) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed || m.queue == nil {
		return
	}
	if len(m.queue) >= cap(m.queue)/2 {
		log.Printf("mailer: queue busy, skipping staff email for %s (%s)", job.appNo, MaskEmail(job.to))
		return
	}
	select {
	case m.queue <- job:
	default:
		log.Printf("mailer: queue full, dropping staff email for %s (%s)", job.appNo, MaskEmail(job.to))
	}
}

// Shutdown closes the queue and waits until all queued emails drain or ctx expires.
func (m *AsyncSMTPMailer) Shutdown(ctx context.Context) error {
	if m == nil || !m.enabled {
		return nil
	}
	m.closeOnce.Do(func() {
		m.mu.Lock()
		m.closed = true
		close(m.queue)
		m.mu.Unlock()
	})
	select {
	case <-m.workerDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *AsyncSMTPMailer) runWorker() {
	defer close(m.workerDone)
	var lastSent time.Time
	for job := range m.queue {
		if m.pace > 0 && !lastSent.IsZero() {
			if wait := m.pace - time.Since(lastSent); wait > 0 {
				time.Sleep(wait)
			}
		}
		m.deliverJob(job)
		lastSent = time.Now()
	}
}

func (m *AsyncSMTPMailer) deliverJob(job emailJob) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("mailer: panic recovered while sending to %s (%s): %v", job.appNo, MaskEmail(job.to), r)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), m.sendTimeout)
	defer cancel()

	start := time.Now()
	err := m.sendFn(ctx, m.addr, m.fromAddr, job.to, job.raw)
	durationMs := time.Since(start).Milliseconds()

	masked := MaskEmail(job.to)
	targetType := domain.AuditTargetApplicant
	var action domain.AuditAction
	switch job.kind {
	case emailKindConfirmed:
		action = domain.AuditEmailConfirmedSent
		if err != nil {
			action = domain.AuditEmailConfirmedFailed
		}
	case emailKindSponsorInquiry:
		targetType = domain.AuditTargetSponsorInquiry
		action = domain.AuditEmailSponsorInquirySent
		if err != nil {
			action = domain.AuditEmailSponsorInquiryFail
		}
	case emailKindStaffRegistration:
		action = domain.AuditEmailStaffRegistrationSent
		if err != nil {
			action = domain.AuditEmailStaffRegistrationFail
		}
	default:
		action = domain.AuditEmailRegistrationSent
		if err != nil {
			action = domain.AuditEmailRegistrationFailed
		}
	}

	details := map[string]any{
		"maskedEmail": masked,
		"durationMs":  durationMs,
	}
	if err != nil {
		details["error"] = truncateString(err.Error(), 240)
		log.Printf("mailer: send failed app=%s to=%s durationMs=%d err=%v", job.appNo, masked, durationMs, err)
	} else {
		log.Printf("mailer: sent app=%s to=%s action=%s durationMs=%d", job.appNo, masked, action, durationMs)
	}

	if m.auditRepo != nil {
		actx, acancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer acancel()
		_ = m.auditRepo.Log(actx, &domain.AuditEntry{
			Action:     action,
			TargetType: targetType,
			TargetID:   job.appNo,
			Details:    details,
		})
	}
}

func (m *AsyncSMTPMailer) sendViaSMTP(ctx context.Context, addr, from, to string, raw []byte) error {
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	var client *smtp.Client
	if m.port == "465" {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = tlsConn.Close()
			return err
		}
		client, err = smtp.NewClient(tlsConn, m.host)
	} else {
		client, err = smtp.NewClient(conn, m.host)
	}
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer func() { _ = client.Close() }()

	if m.port != "465" {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12}); err != nil {
				return err
			}
		} else {
			return errors.New("smtp server does not advertise STARTTLS")
		}
	}

	if m.username != "" && m.password != "" {
		if err := client.Auth(smtp.PlainAuth("", m.username, m.password, m.host)); err != nil {
			return err
		}
	}

	if err := client.Mail(from); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(raw); err != nil {
		_ = w.Close()
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func truncateString(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func urlQueryEscape(s string) string {
	return strings.ReplaceAll(stripCRLF(s), " ", "+")
}

func formatBangkokThaiDateTime(t time.Time) string {
	months := []string{"", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."}
	bkk := t.In(bangkokZone)
	return fmt.Sprintf("%d %s %d เวลา %02d:%02d น.", bkk.Day(), months[int(bkk.Month())], bkk.Year()+543, bkk.Hour(), bkk.Minute())
}

func encodeQuotedPrintable(raw []byte) ([]byte, error) {
	var out bytes.Buffer
	qp := quotedprintable.NewWriter(&out)
	if _, err := qp.Write(raw); err != nil {
		return nil, err
	}
	if err := qp.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func formatAddressHeader(raw string) string {
	clean := stripCRLF(raw)
	if parsed, err := mail.ParseAddress(clean); err == nil && parsed.Address != "" {
		return (&mail.Address{Name: parsed.Name, Address: parsed.Address}).String()
	}
	return clean
}

func buildMessageID(fromHeader string) string {
	bare := extractBareAddress(fromHeader)
	domainPart := "comcamp.local"
	if at := strings.LastIndex(bare, "@"); at >= 0 && at+1 < len(bare) {
		domainPart = stripCRLF(bare[at+1:])
	}
	var rnd [8]byte
	_, _ = rand.Read(rnd[:])
	return fmt.Sprintf("<cc25-%d.%x@%s>", time.Now().UTC().UnixNano(), rnd, domainPart)
}

func buildMultipartMIME(fromHeader, to, subject string, txt *texttmpl.Template, htm *htmltmpl.Template, data any) ([]byte, error) {
	var textBuf, htmlBuf bytes.Buffer
	if err := txt.Execute(&textBuf, data); err != nil {
		return nil, err
	}
	if err := htm.Execute(&htmlBuf, data); err != nil {
		return nil, err
	}

	textQP, err := encodeQuotedPrintable(textBuf.Bytes())
	if err != nil {
		return nil, err
	}
	htmlQP, err := encodeQuotedPrintable(htmlBuf.Bytes())
	if err != nil {
		return nil, err
	}

	boundary := fmt.Sprintf("cc25-%d", time.Now().UnixNano())
	encodedSubject := mime.BEncoding.Encode("UTF-8", stripCRLF(subject))

	var msg bytes.Buffer
	msg.WriteString("Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n")
	msg.WriteString("From: " + formatAddressHeader(fromHeader) + "\r\n")
	msg.WriteString("To: " + formatAddressHeader(to) + "\r\n")
	msg.WriteString("Subject: " + encodedSubject + "\r\n")
	msg.WriteString("Message-ID: " + buildMessageID(fromHeader) + "\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
	msg.WriteString("\r\n")
	msg.WriteString("--" + boundary + "\r\n")
	msg.WriteString("Content-Type: text/plain; charset=\"UTF-8\"\r\n")
	msg.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	msg.Write(textQP)
	msg.WriteString("\r\n--" + boundary + "\r\n")
	msg.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n")
	msg.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	msg.Write(htmlQP)
	msg.WriteString("\r\n--" + boundary + "--\r\n")
	return msg.Bytes(), nil
}

var regTextTmpl = texttmpl.Must(texttmpl.New("regText").Parse(`สวัสดีน้อง {{.Nickname}} ({{.FullName}})

ระบบได้รับใบสมัคร ComCamp #25 ของคุณเรียบร้อยแล้ว
รหัสใบสมัคร: {{.ApplicationNo}}
สถานะปัจจุบัน: จองที่นั่งชั่วคราว (PASSED · รอชำระเงินและตรวจสอบสลิป)

โปรดเก็บรหัสใบสมัครนี้ไว้ให้ดีและไม่ส่งต่อให้ผู้อื่น รหัสนี้คือกุญแจส่วนตัวของคุณบนหน้าตรวจสอบสถานะ ใช้สำหรับแนบสลิปและจัดการใบสมัคร
(การค้นหาด้วยเบอร์โทรจะแสดงเพียงสถานะโดยย่อ หากลืมรหัส ติดต่อพี่ค่ายตามช่องทางด้านล่าง)

ขั้นตอนสำคัญ (กรุณาดำเนินการภายใน 5 วัน):
- ยอดค่าสมัคร: {{.CampFee}} บาท (รวมที่พัก 2 คืน ณ เรือนพักสมาคมศิษย์เก่าแม่โจ้, อาหารหลัก 6 มื้อ, เบรก 5 มื้อ, เสื้อค่าย, กระเป๋าพร้อมปั๊มลาย, เอกสารอบรม และเกียรติบัตร)
- ช่องทางโอนเงิน: {{.BankName}} เลขที่บัญชี {{.BankNumber}}
- ชื่อบัญชี: {{.BankAccount}}
- กำหนดโอนและแนบสลิปภายในวันที่: {{.DeadlineText}} (120 ชั่วโมงหลังสมัคร เกินกำหนดระบบคืนที่นั่งว่างอัตโนมัติ)
- ก่อนโอน ให้ผู้ปกครองอ่านและลงนามใบขออนุญาตผู้ปกครอง ดาวน์โหลดได้ที่หน้าตรวจสอบสถานะ (ค้นหาด้วยรหัสใบสมัคร) แล้วนำใบตัวจริงมาส่งในวันลงทะเบียนเข้าค่าย

อัปโหลดสลิปและตรวจสอบสถานะได้ที่: {{.StatusURL}}
(หลังส่งสลิปบนหน้าเว็บ จะได้รับ QR Code และปุ่มเข้ากลุ่ม LINE OpenChat ทันที)

ติดต่อสอบถาม: {{.FBPageURL}}
โทรพี่ค่าย: {{.StaffContact}}
อาจารย์ผู้รับผิดชอบโครงการ: ผศ.ปวีณ เขื่อนแก้ว · สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้
`))

var regHTMLTmpl = htmltmpl.Must(htmltmpl.New("regHTML").Parse(`<!DOCTYPE html>
<html lang="th"><body style="font-family:sans-serif;color:#121316;line-height:1.65;max-width:600px;margin:0 auto;padding:20px;">
<h2 style="margin:0 0 12px;">แจ้งรับใบสมัคร ComCamp #25</h2>
<p>สวัสดีน้อง <strong>{{.Nickname}}</strong> ({{.FullName}})</p>
<p>ระบบบันทึกใบสมัครและจองที่นั่งชั่วคราวให้เรียบร้อยแล้ว (<strong>ยังไม่ใช่สถานะยืนยันสิทธิ์สมบูรณ์</strong> จนกว่าจะชำระเงินและทีมงานตรวจสลิปอนุมัติ)</p>
<div style="border:1px solid #d4d4d8;padding:14px 16px;margin:16px 0;background:#f9f8f4;">
  <p style="margin:0 0 6px;"><strong>รหัสใบสมัคร:</strong> <code style="font-size:1.1em;">{{.ApplicationNo}}</code></p>
  <p style="margin:0 0 10px;font-size:0.95em;color:#4a4d55;">โปรดเก็บรหัสใบสมัครนี้ไว้ให้ดีและไม่ส่งต่อให้ผู้อื่น รหัสนี้คือกุญแจส่วนตัวของคุณบนหน้าตรวจสอบสถานะ ใช้สำหรับแนบสลิปและจัดการใบสมัคร (การค้นหาด้วยเบอร์โทรจะแสดงเพียงสถานะโดยย่อ หากลืมรหัส ติดต่อพี่ค่ายตามช่องทางด้านล่าง)</p>
  <p style="margin:0 0 6px;"><strong>ค่าสมัคร:</strong> {{.CampFee}} บาท (รวมที่พัก 2 คืน, อาหาร 6 มื้อ + เบรก 5 มื้อ, เสื้อค่าย, กระเป๋าพร้อมปั๊มลาย, เอกสารอบรม, เกียรติบัตร)</p>
  <p style="margin:0 0 6px;"><strong>โอนเข้าบัญชี:</strong> {{.BankName}} · <code>{{.BankNumber}}</code></p>
  <p style="margin:0 0 6px;"><strong>ชื่อบัญชี:</strong> {{.BankAccount}}</p>
  <p style="margin:0 0 6px;color:#9a4608;"><strong>กำหนดโอนและแนบสลิปภายใน:</strong> {{.DeadlineText}} (ภายใน 5 วัน / 120 ชั่วโมงหลังสมัคร เกินกำหนดคืนที่นั่งว่างอัตโนมัติ)</p>
  <p style="margin:0;"><strong>ใบขออนุญาตผู้ปกครอง:</strong> ก่อนโอน ให้ผู้ปกครองอ่านและลงนาม ดาวน์โหลดได้ที่<a href="{{.StatusURL}}">หน้าตรวจสอบสถานะ</a> (ค้นหาด้วยรหัสใบสมัคร) แล้วนำใบตัวจริงมาส่งในวันลงทะเบียนเข้าค่าย</p>
</div>
<p><a href="{{.StatusURL}}" style="display:inline-block;padding:10px 20px;border-radius:9999px;background:#121316;color:#f5f4ef;text-decoration:none;font-weight:600;">ไปหน้าตรวจสอบสถานะและแนบสลิป</a></p>
<p style="font-size:0.9em;color:#4a4d55;">สามารถแนบสลิปบนหน้าเว็บไซต์ได้ทันทีโดยไม่ต้องรออีเมลนี้ และหลังส่งสลิปบนเว็บจะมี QR Code สำหรับเข้ากลุ่ม LINE OpenChat แสดงให้ทันที<br/>อาจารย์ผู้รับผิดชอบโครงการ: ผศ.ปวีณ เขื่อนแก้ว · สอบถามเพิ่มเติม: <a href="{{.FBPageURL}}">เพจ Facebook ComCamp MJU</a> · โทรพี่ค่าย: <a href="tel:0809938214">080-993-8214</a> นายบูรพา มหัทธีรนางกูร (พูล) / <a href="tel:0637844515">063-784-4515</a> นางสาวธมล นวลหมวก (แอมมี่)</p>
</body></html>`))

var confTextTmpl = texttmpl.Must(texttmpl.New("confText").Parse(`สวัสดีน้อง {{.Nickname}} ({{.FullName}})

สลิปการชำระเงินของใบสมัคร {{.ApplicationNo}} ผ่านการตรวจสอบแล้ว
สถานะปัจจุบัน: ยืนยันสิทธิ์เข้าร่วมค่ายสมบูรณ์ (CONFIRMED)

ข้อมูลสำคัญก่อนเข้าค่าย ComCamp #25:
- วันจัดค่าย: 5–7 กุมภาพันธ์ 2570 (3 วัน 2 คืน) ณ อาคาร 60 ปี แม่โจ้ ชั้น 6 (สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้)
- สิทธิพิเศษ: หากผ่านการเข้าค่ายจะได้รับพิจารณาเป็นพิเศษเมื่อสมัครเรียนต่อที่สาขาวิชาวิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้
- ที่พัก: {{.DormName}}
- แผนที่ที่พัก (Google Maps): {{.DormMapsURL}}
- ไซส์เสื้อที่บันทึกไว้: {{.ShirtSize}}
- เข้าร่วมกลุ่ม LINE OpenChat สำหรับผู้ยืนยันสิทธิ์: {{.LineURL}}

สิ่งที่ต้องเตรียมมาค่าย:
1. เอกสารและยาประจำตัว: บัตรประจำตัว (บัตรประชาชน/บัตรชมพู) หรือบัตรนักเรียน, ยาประจำตัว และใบขออนุญาตผู้ปกครองตัวจริงที่ลงนามแล้ว (ดาวน์โหลดได้ที่หน้าตรวจสอบสถานะ ส่งในวันลงทะเบียนเข้าค่าย)
2. เสื้อผ้าสุภาพ 3 วัน 2 คืน (แนะนำกางเกงขายาวและรองเท้าผ้าใบ/หุ้มส้นเข้าห้องแล็บ), ชุดนอน, เสื้อกันหนาว, ผ้าเช็ดตัวและของใช้ส่วนตัว (มีเสื้อค่ายแจกให้)
3. สมาร์ตโฟนพร้อมสายชาร์จ/แบตสำรอง (ใช้เชื่อมต่อ Wi-Fi บอร์ด ESP8266; โน้ตบุ๊กไม่บังคับ)

ตรวจสอบสถานะและรายละเอียดเพิ่มเติม: {{.StatusURL}}
สอบถามเพิ่มเติม: {{.FBPageURL}}
โทรพี่ค่าย: {{.StaffContact}}
อาจารย์ผู้รับผิดชอบโครงการ: ผศ.ปวีณ เขื่อนแก้ว · สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้
`))

var confHTMLTmpl = htmltmpl.Must(htmltmpl.New("confHTML").Parse(`<!DOCTYPE html>
<html lang="th"><body style="font-family:sans-serif;color:#121316;line-height:1.65;max-width:600px;margin:0 auto;padding:20px;">
<h2 style="margin:0 0 12px;color:#047857;">ยืนยันสิทธิ์เข้าร่วมค่าย ComCamp #25 สมบูรณ์แล้ว</h2>
<p>สวัสดีน้อง <strong>{{.Nickname}}</strong> ({{.FullName}})</p>
<p>ทีมงานตรวจสอบสลิปของใบสมัคร <strong>{{.ApplicationNo}}</strong> เรียบร้อยแล้ว ที่นั่งของคุณได้รับการยืนยันสมบูรณ์ (<code>CONFIRMED</code>)</p>
<div style="border:1px solid #d4d4d8;padding:14px 16px;margin:16px 0;background:#f9f8f4;">
  <p style="margin:0 0 6px;"><strong>วันจัดค่าย:</strong> 5–7 กุมภาพันธ์ 2570 (3 วัน 2 คืน) · อาคาร 60 ปี แม่โจ้ ชั้น 6 (สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้)</p>
  <p style="margin:0 0 6px;"><strong>สิทธิพิเศษ:</strong> หากผ่านการเข้าค่ายจะได้รับพิจารณาเป็นพิเศษเมื่อสมัครเรียนต่อที่สาขาวิชาวิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้</p>
  <p style="margin:0 0 6px;"><strong>สถานที่พัก:</strong> {{.DormName}} (<a href="{{.DormMapsURL}}">ดูแผนที่ Google Maps</a>)</p>
  <p style="margin:0;"><strong>ไซส์เสื้อค่าย:</strong> {{.ShirtSize}}</p>
</div>
<p><a href="{{.LineURL}}" style="display:inline-block;padding:10px 20px;border-radius:9999px;background:#03b800;color:#121316;text-decoration:none;font-weight:700;">เข้ากลุ่ม LINE OpenChat ค่าย ComCamp #25</a></p>
<h3>สิ่งที่ต้องเตรียมมาค่าย</h3>
<ul>
  <li><strong>เอกสารและยาประจำตัว:</strong> บัตรประจำตัว (บัตรประชาชน/บัตรชมพู) หรือบัตรนักเรียน ยาประจำตัว (ถ้ามี) และใบขออนุญาตผู้ปกครองตัวจริงที่ลงนามแล้ว (ดาวน์โหลดได้ที่<a href="{{.StatusURL}}">หน้าตรวจสอบสถานะ</a> ส่งในวันลงทะเบียนเข้าค่าย)</li>
  <li><strong>เครื่องแต่งกายและของใช้ส่วนตัว (3 วัน 2 คืน):</strong> ชุดลำลองสุภาพ (แนะนำกางเกงขายาวและรองเท้าผ้าใบ/หุ้มส้นเข้าห้องแล็บ), ชุดนอน, เสื้อกันหนาว, ผ้าเช็ดตัวและของใช้ส่วนตัว (มีเสื้อค่ายแจกให้)</li>
  <li><strong>อุปกรณ์อิเล็กทรอนิกส์:</strong> สมาร์ตโฟนพร้อมสายชาร์จ/แบตสำรอง (ใช้ทดลองเชื่อมบอร์ด ESP8266; โน้ตบุ๊กส่วนตัวไม่บังคับ)</li>
</ul>
<p style="font-size:0.9em;color:#4a4d55;">ดูข้อมูลใบสมัครได้ที่ <a href="{{.StatusURL}}">หน้าตรวจสอบสถานะ</a> · อาจารย์ผู้รับผิดชอบโครงการ: ผศ.ปวีณ เขื่อนแก้ว<br/>สอบถามเพิ่มเติม: <a href="{{.FBPageURL}}">เพจ Facebook ComCamp MJU</a> · โทรพี่ค่าย: <a href="tel:0809938214">080-993-8214</a> นายบูรพา มหัทธีรนางกูร (พูล) / <a href="tel:0637844515">063-784-4515</a> นางสาวธมล นวลหมวก (แอมมี่)</p>
</body></html>`))

var sponsorInquiryTextTmpl = texttmpl.Must(texttmpl.New("sponsorText").Parse(`มีผู้แจ้งความประสงค์สนับสนุนค่าย ComCamp #25 ผ่านหน้าเว็บไซต์

ชื่อ: {{.Name}}
เบอร์โทร: {{.Phone}}
อีเมล: {{.Email}}
ประเภท: {{.Kind}}
{{if .Amount}}จำนวนเงิน: {{.Amount}}
{{end}}รายละเอียด: {{.Details}}
ไฟล์แนบ: {{.File}}
{{if .Slip}}สลิปโอนเงิน: {{.Slip}}
{{end}}เวลา: {{.Time}}

ดูและจัดการในหน้าแอดมิน: {{.AdminURL}}
`))

var sponsorInquiryHTMLTmpl = htmltmpl.Must(htmltmpl.New("sponsorHTML").Parse(`<!DOCTYPE html>
<html lang="th"><body style="font-family:sans-serif;color:#121316;line-height:1.65;max-width:600px;margin:0 auto;padding:20px;">
<h2 style="margin:0 0 12px;">มีผู้สนใจสนับสนุนค่าย ComCamp #25</h2>
<div style="border:1px solid #d4d4d8;padding:14px 16px;margin:16px 0;background:#f9f8f4;">
  <p style="margin:0 0 6px;"><strong>ชื่อ:</strong> {{.Name}}</p>
  <p style="margin:0 0 6px;"><strong>เบอร์โทร:</strong> {{.Phone}}</p>
  <p style="margin:0 0 6px;"><strong>อีเมล:</strong> {{.Email}}</p>
  <p style="margin:0 0 6px;"><strong>ประเภท:</strong> {{.Kind}}</p>
  {{if .Amount}}<p style="margin:0 0 6px;"><strong>จำนวนเงิน:</strong> {{.Amount}}</p>{{end}}
  <p style="margin:0 0 6px;white-space:pre-line;"><strong>รายละเอียด:</strong> {{.Details}}</p>
  <p style="margin:0 0 6px;"><strong>ไฟล์แนบ:</strong> {{.File}}</p>
  {{if .Slip}}<p style="margin:0 0 6px;"><strong>สลิปโอนเงิน:</strong> {{.Slip}}</p>{{end}}
  <p style="margin:0;"><strong>เวลา:</strong> {{.Time}}</p>
</div>
<p><a href="{{.AdminURL}}" style="display:inline-block;padding:10px 20px;background:#121316;color:#f5f4ef;text-decoration:none;font-weight:600;">เปิดหน้าแอดมิน</a></p>
</body></html>`))

var staffRegTextTmpl = texttmpl.Must(texttmpl.New("staffRegText").Parse(`มีน้องสมัครค่าย ComCamp #25 เข้ามาใหม่

ชื่อ: {{.FullName}} ({{.Nickname}})
โรงเรียน: {{.School}}
จังหวัด: {{.Province}}
ระดับชั้น: {{.Grade}}
เวลาสมัคร: {{.Time}}
ที่นั่งตอนนี้: {{.Seats}}

ดูรายละเอียดและตรวจสลิปในหน้าแอดมิน: {{.AdminURL}}
`))

var staffRegHTMLTmpl = htmltmpl.Must(htmltmpl.New("staffRegHTML").Parse(`<!DOCTYPE html>
<html lang="th"><body style="font-family:sans-serif;color:#121316;line-height:1.65;max-width:600px;margin:0 auto;padding:20px;">
<h2 style="margin:0 0 12px;">มีน้องสมัครค่าย ComCamp #25 เข้ามาใหม่</h2>
<div style="border:1px solid #d4d4d8;padding:14px 16px;margin:16px 0;background:#f9f8f4;">
  <p style="margin:0 0 6px;"><strong>ชื่อ:</strong> {{.FullName}} ({{.Nickname}})</p>
  <p style="margin:0 0 6px;"><strong>โรงเรียน:</strong> {{.School}}</p>
  <p style="margin:0 0 6px;"><strong>จังหวัด:</strong> {{.Province}}</p>
  <p style="margin:0 0 6px;"><strong>ระดับชั้น:</strong> {{.Grade}}</p>
  <p style="margin:0 0 6px;"><strong>เวลาสมัคร:</strong> {{.Time}}</p>
  <p style="margin:0;"><strong>ที่นั่งตอนนี้:</strong> {{.Seats}}</p>
</div>
<p><a href="{{.AdminURL}}" style="display:inline-block;padding:10px 20px;background:#121316;color:#f5f4ef;text-decoration:none;font-weight:600;">เปิดหน้าแอดมิน</a></p>
</body></html>`))
