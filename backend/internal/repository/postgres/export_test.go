package postgres

// QuotaLockKey exposes the advisory-lock key to the external test package, so a test can hold
// the quota lock and observe lock_timeout.
const QuotaLockKey = quotaLockKey
