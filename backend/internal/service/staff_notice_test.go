package service_test

import (
	"context"
	"mime"
	"net/mail"
	"strings"
	"sync"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/service"
)

func TestStaffRegistrationEmail_OnePerStaffWithoutCodeOrContact(t *testing.T) {
	m, audit, drain := newCapturingMailer(t)
	m.EnqueueStaffRegistration(service.StaffRegistrationEmailData{
		To:            []string{"a@staff.example", "b@staff.example"},
		ApplicationNo: "CC25-ABC123",
		FullName:      "สมชาย <b>ใจดี</b>\r\nBcc: evil@example.com",
		Nickname:      "ชาย",
		School:        "โรงเรียนแม่โจ้วิทยาคม",
		Province:      "เชียงใหม่",
		Grade:         "ม.5",
		SeatsTaken:    3,
		MaxCapacity:   40,
	})
	sent := drain()
	if len(sent) != 2 || sent[0].to != "a@staff.example" || sent[1].to != "b@staff.example" {
		t.Fatalf("sent = %+v", sent)
	}
	msg, err := mail.ReadMessage(strings.NewReader(sent[0].raw))
	if err != nil {
		t.Fatal(err)
	}
	if msg.Header.Get("Bcc") != "" {
		t.Fatal("header injection through the name")
	}
	subject, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(subject, "[ComCamp #25] มีผู้สมัครใหม่ (ที่นั่ง 3/40): สมชาย") {
		t.Fatalf("subject = %q", subject)
	}
	body := decodeMIMEBodies(t, sent[0].raw)
	for _, want := range []string{"โรงเรียนแม่โจ้วิทยาคม", "เชียงใหม่", "ม.5", "3/40", "https://comcamp.example.com/admin#applications"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q", want)
		}
	}
	// The application code is the applicant's credential for /status; staff look it up in /admin.
	if strings.Contains(body, "CC25-ABC123") || strings.Contains(subject, "CC25-ABC123") {
		t.Fatal("staff notice leaks the application code")
	}
	if strings.Contains(body, "</strong> สมชาย <b>") || !strings.Contains(body, "สมชาย &lt;b&gt;ใจดี&lt;/b&gt;") {
		t.Fatal("unescaped HTML in the html part")
	}

	var n int
	for _, e := range audit.Entries() {
		if e.Action == domain.AuditEmailStaffRegistrationSent && e.TargetID == "CC25-ABC123" {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("staff_notice.sent audits = %d, want 2", n)
	}
}

func TestStaffRegistrationEmail_HourlyCapCountsApplications(t *testing.T) {
	m, _, drain := newCapturingMailer(t)
	for range service.StaffRegistrationNoticesPerHour + 5 {
		m.EnqueueStaffRegistration(service.StaffRegistrationEmailData{
			To: []string{"a@staff.example", "b@staff.example"}, ApplicationNo: "CC25-000001", FullName: "ก ข",
		})
	}
	if got, want := len(drain()), 2*service.StaffRegistrationNoticesPerHour; got != want {
		t.Fatalf("sent = %d, want %d", got, want)
	}
}

// Staff copies must never take the queue room an applicant's own email (with the application
// code and payment steps) needs.
func TestStaffRegistrationEmail_SkippedWhenQueueBusy(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var (
		mu sync.Mutex
		to []string
	)
	m := service.NewAsyncSMTPMailer(service.SMTPConfig{
		Pace:      -1,
		QueueSize: 4,
		SendFn: func(_ context.Context, _, _, rcpt string, _ []byte) error {
			select {
			case started <- struct{}{}:
				<-release
			default:
			}
			mu.Lock()
			to = append(to, rcpt)
			mu.Unlock()
			return nil
		},
	}, nil)
	reg := func(email string) {
		m.EnqueueRegistration(service.RegistrationEmailData{ApplicationNo: "CC25-000001", FullName: "ก ข", Email: email})
	}
	reg("first@example.com")
	<-started // the worker holds the first email; the queue is empty
	reg("second@example.com")
	reg("third@example.com") // queue holds 2 of 4: half full
	m.EnqueueStaffRegistration(service.StaffRegistrationEmailData{To: []string{"staff@example.com"}, ApplicationNo: "CC25-000003"})
	reg("fourth@example.com")
	close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if got := strings.Join(to, ","); got != "first@example.com,second@example.com,third@example.com,fourth@example.com" {
		t.Fatalf("sent to %s", got)
	}
}

type recordingStaffNotifier struct {
	ch chan service.StaffRegistrationEmailData
}

func (r *recordingStaffNotifier) EnqueueStaffRegistration(d service.StaffRegistrationEmailData) {
	r.ch <- d
}

func TestApplicantService_Submit_NotifiesStaffList(t *testing.T) {
	svc, _, _ := setupTestServices()
	rec := &recordingStaffNotifier{ch: make(chan service.StaffRegistrationEmailData, 4)}
	svc.WithStaffNotify(rec, func(context.Context) ([]string, error) {
		return []string{"a@staff.example", "b@staff.example"}, nil
	})

	res, err := svc.Submit(context.Background(), service.ApplicationCreateRequest{
		FullName:  "สมชาย ใจดี",
		Nickname:  "ชาย",
		Phone:     "0812345678",
		Email:     "somchai@example.com",
		School:    "โรงเรียนแม่โจ้วิทยาคม",
		Province:  "เชียงใหม่",
		Grade:     "ม.5",
		ShirtSize: "L",
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	select {
	case d := <-rec.ch:
		if strings.Join(d.To, ",") != "a@staff.example,b@staff.example" {
			t.Fatalf("To = %v", d.To)
		}
		if d.ApplicationNo != res.ID || d.FullName != "สมชาย ใจดี" || d.School != "โรงเรียนแม่โจ้วิทยาคม" || d.Province != "เชียงใหม่" {
			t.Fatalf("data = %+v", d)
		}
		if d.SeatsTaken != 1 || d.MaxCapacity <= 0 {
			t.Fatalf("seats = %d/%d, want 1/max", d.SeatsTaken, d.MaxCapacity)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no staff notice queued")
	}
}
