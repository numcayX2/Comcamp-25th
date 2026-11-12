package domain

import "errors"

var (
	ErrApplicantNotFound      = errors.New("applicant not found")
	ErrDuplicateApplicant     = errors.New("national ID, phone, or email already registered")
	ErrDuplicateApplicationNo = errors.New("application number already exists")
	ErrPaymentNotFound        = errors.New("payment not found")
	ErrDuplicateSlip          = errors.New("duplicate slip detected")
	ErrDuplicateTransRef      = errors.New("duplicate transaction reference")
	ErrPaymentAlreadyVerified = errors.New("payment has already been verified")
	ErrQuotaExceeded          = errors.New("camp capacity quota reached")
	ErrAdminNotFound          = errors.New("admin not found")
	ErrDuplicateAdmin         = errors.New("admin username already exists")
	ErrSettingsNotFound       = errors.New("settings not found")
	ErrInvalidStatus          = errors.New("invalid application status")
)
