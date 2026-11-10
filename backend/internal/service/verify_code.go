package service

import (
	"crypto/subtle"

	"comcamp25-backend/internal/domain"
)

// VerifyCodeLength is the number of trailing national-ID digits asked for on /status.
const VerifyCodeLength = 4

// CheckVerifyCode guards the public actions on an application (confirm attendance, upload a
// slip) against someone who only knows the application ID or the phone number (AGENTS.md §13.5).
//
// Only the national ID is accepted, never the phone: the public status response shows the
// phone's last 4 digits (XXX-XXX-5678), and a classmate who knows the phone number knows them
// too. The national ID mask (1-5099-XXXXX-XX-X) never reveals its last 4 digits.
//
// A missing or malformed code is a 400 (ErrVerifyCodeRequired); a wrong one is ErrInvalidVerifyCode.
func CheckVerifyCode(a *domain.Applicant, code string) error {
	code = cleanNumber(code)
	if len(code) != VerifyCodeLength || !isNumeric(code) {
		return ErrVerifyCodeRequired
	}
	id := a.NationalID
	if len(id) < VerifyCodeLength {
		return ErrInvalidVerifyCode
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(id[len(id)-VerifyCodeLength:])) != 1 {
		return ErrInvalidVerifyCode
	}
	return nil
}
