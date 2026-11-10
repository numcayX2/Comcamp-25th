package domain

import "errors"

// Sentinel errors returned by repositories. Services and handlers match them with errors.Is
// so that storage details (constraint names, SQL text) never reach API clients.
var (
	ErrNotFound                = errors.New("record not found")
	ErrDuplicateApplicant      = errors.New("an application with this national ID, phone number or email already exists")
	ErrDuplicateApplicationNo  = errors.New("application number collision")
	ErrDuplicateIdempotencyKey = errors.New("idempotency key already used")
	ErrCapacityReached         = errors.New("camp capacity quota reached")
	ErrDuplicateSlipHash       = errors.New("this slip has already been uploaded")
	ErrPaymentAlreadyVerified  = errors.New("this payment slip has already been verified")
	// ErrLockTimeout: a lock was not granted within lock_timeout (the midnight rush). Safe to retry.
	ErrLockTimeout = errors.New("timed out waiting for a database lock")
)
