package service

import (
	"crypto/subtle"
	"errors"

	"comcamp25-backend/internal/domain"
)

// VerifyCodeLength is the number of trailing national-ID digits asked for on /status.
const VerifyCodeLength = 4

var (
	// ErrNationalIDMismatch: the full national ID sent to /withdraw is not this applicant's.
	ErrNationalIDMismatch = errors.New("national ID does not match this application")
	// ErrWithdrawNationalIDRequired: /withdraw needs the full 13-digit national ID, not 4 digits.
	ErrWithdrawNationalIDRequired = newValidationError("nationalId must be the applicant's full 13-digit national ID")
)

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

// CheckNationalID guards self-service withdrawal, which gives a seat away for good. Four digits
// are not enough there: the public status lookup accepts a phone number, so anyone who knows a
// classmate's phone could find the application and then only has to guess 4 digits. Withdrawal
// therefore needs the full 13-digit national ID. nationalID must already be cleaned and pass the
// Mod-11 check (see ParseWithdrawNationalID); a mismatch is ErrNationalIDMismatch.
func CheckNationalID(a *domain.Applicant, nationalID string) error {
	if subtle.ConstantTimeCompare([]byte(nationalID), []byte(a.NationalID)) != 1 {
		return ErrNationalIDMismatch
	}
	return nil
}

// ParseWithdrawNationalID cleans a typed or pasted national ID (zero-width characters, hyphens,
// spaces) and validates it. Anything that is not a valid 13-digit ID is a 400 and is not counted
// as a guess, because it cannot match a stored ID.
func ParseWithdrawNationalID(raw string) (string, error) {
	id := cleanNumber(raw)
	if !isValidThaiNationalID(id) {
		return "", ErrWithdrawNationalIDRequired
	}
	return id, nil
}
