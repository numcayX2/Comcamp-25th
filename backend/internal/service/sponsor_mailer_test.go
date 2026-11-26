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
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func newCapturingMailer(t *testing.T) (*service.AsyncSMTPMailer, *memory.MemoryAuditRepo, func() []capturedMail) {
	t.Helper()
	var (
		mu   sync.Mutex
		sent []capturedMail
	)
	audit := memory.NewMemoryAuditRepo()
	m := service.NewAsyncSMTPMailer(service.SMTPConfig{
		From:        "ComCamp <noreply@example.com>",
		FrontendURL: "https://comcamp.example.com/, https://other.example.com",
		Pace:        -1,
		QueueSize:   256, // staff emails skip once the queue is half full; cap tests enqueue fast
		SendFn: func(_ context.Context, addr, from, to string, raw []byte) error {
			mu.Lock()
			defer mu.Unlock()
			sent = append(sent, capturedMail{addr: addr, from: from, to: to, raw: string(raw)})
			return nil
		},
	}, audit)
	drain := func() []capturedMail {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.Shutdown(ctx); err != nil {
			t.Fatalf("shutdown: %v", err)
		}
		mu.Lock()
		defer mu.Unlock()
		return append([]capturedMail{}, sent...)
	}
	return m, audit, drain
}

func TestSponsorInquiryEmail_MoneyShowsAmount(t *testing.T) {
	m, _, drain := newCapturingMailer(t)
	amount := "1234567.5"
	m.EnqueueSponsorInquiry(service.SponsorInquiryEmailData{
		InquiryID: 7, To: "staff@example.com", Name: "ร้าน", Phone: "0812345678", Kind: "money", Amount: &amount, HasSlip: true,
		CreatedAt: time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC),
	})
	sent := drain()
	if len(sent) != 1 {
		t.Fatalf("sent = %d", len(sent))
	}
	body := decodeMIMEBodies(t, sent[0].raw)
	if !strings.Contains(body, "จำนวนเงิน: 1,234,567.50 บาท") || !strings.Contains(body, "<strong>จำนวนเงิน:</strong> 1,234,567.50 บาท") {
		t.Fatalf("email body is missing the amount line:\n%s", body)
	}
	if !strings.Contains(body, "สลิปโอนเงิน: แนบสลิปโอนเงินแล้ว เปิดดูได้ในหน้าแอดมิน") || !strings.Contains(body, "<strong>สลิปโอนเงิน:</strong> แนบสลิปโอนเงินแล้ว") {
		t.Fatalf("email body is missing the slip line:\n%s", body)
	}
}

func TestSponsorInquiryEmail_RendersEscapedAndAudits(t *testing.T) {
	m, audit, drain := newCapturingMailer(t)
	m.EnqueueSponsorInquiry(service.SponsorInquiryEmailData{
		InquiryID: 42,
		To:        "staff@example.com",
		Name:      "<script>alert(1)</script>\r\nBcc: evil@example.com " + strings.Repeat("ก", 80),
		Phone:     "0812345678",
		Kind:      "goods",
		Details:   "น้ำดื่ม <b>10</b> แพ็ค",
		CreatedAt: time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC),
	})
	sent := drain()
	if len(sent) != 1 || sent[0].to != "staff@example.com" {
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
	if !strings.HasPrefix(subject, "[ComCamp #25] มีผู้สนใจสนับสนุนค่าย: <script>") {
		t.Fatalf("subject = %q", subject)
	}
	if n := len([]rune(strings.TrimPrefix(subject, "[ComCamp #25] มีผู้สนใจสนับสนุนค่าย: "))); n != 60 {
		t.Fatalf("subject name runes = %d, want 60", n)
	}

	body := decodeMIMEBodies(t, sent[0].raw)
	for _, want := range []string{
		"&lt;script&gt;alert(1)&lt;/script&gt;", // HTML part escaped
		"น้ำดื่ม &lt;b&gt;10&lt;/b&gt; แพ็ค",
		"สิ่งของ",
		"0812345678",
		"21 พ.ย. 2569 เวลา 10:00 น.",
		"https://comcamp.example.com/admin#sponsors",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("email body is missing %q", want)
		}
	}
	if strings.Contains(body, "<b>10</b></p>") || strings.Contains(body, "<script>alert(1)</script></p>") {
		t.Fatal("unescaped HTML in the html part")
	}
	if strings.Contains(body, "จำนวนเงิน") || strings.Contains(body, "สลิปโอนเงิน") {
		t.Fatal("goods email must not carry an amount or slip line")
	}

	var found bool
	for _, e := range audit.Entries() {
		if e.Action == domain.AuditEmailSponsorInquirySent {
			found = true
			if e.TargetType != domain.AuditTargetSponsorInquiry || e.TargetID != "42" || e.Details["maskedEmail"] == "staff@example.com" {
				t.Fatalf("audit entry = %+v", e)
			}
		}
	}
	if !found {
		t.Fatal("missing email.sponsor_inquiry.sent audit")
	}
}

func TestSponsorInquiryEmail_HourlyCap(t *testing.T) {
	m, _, drain := newCapturingMailer(t)
	for i := range service.SponsorInquiryEmailsPerHour + 5 {
		m.EnqueueSponsorInquiry(service.SponsorInquiryEmailData{
			InquiryID: int64(i + 1), To: "staff@example.com", Name: "ร้าน", Phone: "0812345678", Kind: "money",
		})
	}
	if got := len(drain()); got != service.SponsorInquiryEmailsPerHour {
		t.Fatalf("sent = %d, want %d", got, service.SponsorInquiryEmailsPerHour)
	}
}
