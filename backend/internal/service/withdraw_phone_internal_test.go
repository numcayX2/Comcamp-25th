package service

import (
	"errors"
	"testing"

	"comcamp25-backend/internal/repository/memory"
)

func TestSamePhone(t *testing.T) {
	for _, c := range []struct {
		typed, stored string
		want          bool
	}{
		{"0812345678", "0812345678", true},
		{" 081-234-5678 ", "0812345678", true},
		{"๐๘๑ ๒๓๔ ๕๖๗๘", "0812345678", true},
		{"\u200B0812345678\uFEFF", "0812345678", true},
		{"0812345679", "0812345678", false},
		{"081234567", "0812345678", false},
		{"", "0812345678", false},
		{"   ", "0812345678", false},
		{"0812345678", "", false},
	} {
		if got := samePhone(c.typed, c.stored); got != c.want {
			t.Errorf("samePhone(%q, %q) = %v, want %v", c.typed, c.stored, got, c.want)
		}
	}
}

// R24 at the service level: a wrong or missing phone is ErrApplicantNotFound (the unknown-code
// answer) and a miss for the code guard; Thai digits and dashes are accepted.
func TestWithdraw_PhoneSecondFactorService(t *testing.T) {
	appRepo := memory.NewMemoryApplicantRepo()
	guard, clock, _ := newTestCodeGuard(CodeGuardConfig{})
	svc := NewApplicantService(appRepo, memory.NewMemorySettingRepo(), memory.NewMemoryPaymentRepo(appRepo)).
		WithCodeGuard(guard).WithNow(clock.Now)
	ctx := clientCtx("198.51.100.90")
	res, err := svc.Submit(ctx, ApplicationCreateRequest{
		FullName: "สมชาย ทดสอบ", Nickname: "ชาย", Phone: "0830009090", Email: "wp@test.com",
		School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "L",
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	for _, phone := range []string{"0830009091", "", "08300"} {
		if err := svc.Withdraw(ctx, res.ID, phone, "", "198.51.100.90"); !errors.Is(err, ErrApplicantNotFound) {
			t.Fatalf("phone %q: want ErrApplicantNotFound (same as an unknown code), got %v", phone, err)
		}
	}
	guard.mu.Lock()
	misses := guard.clients["198.51.100.90"].misses
	guard.mu.Unlock()
	if misses != 3 {
		t.Fatalf("wrong phones must count as code-guard misses: %d, want 3", misses)
	}
	if err := svc.Withdraw(ctx, res.ID, "๐๘๓-๐๐๐-๙๐๙๐", "", "198.51.100.90"); err != nil {
		t.Fatalf("right phone with Thai digits and dashes: %v", err)
	}
}
