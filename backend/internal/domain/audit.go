package domain

import (
	"context"
	"time"
)

// AuditAction names an auditable staff action (AGENTS.md §13.6).
type AuditAction string

const (
	AuditLoginSuccess    AuditAction = "admin.login.success"
	AuditLoginFailure    AuditAction = "admin.login.failure"
	AuditStatusUpdate    AuditAction = "application.status.update"
	AuditApplicantDelete AuditAction = "application.delete"
	// AuditApplicantWithdrawSelf is the applicant withdrawing their own application (no admin).
	AuditApplicantWithdrawSelf AuditAction = "application.withdraw.self"
	AuditSlipVerify            AuditAction = "payment.slip.verify"
	AuditSlipViewed            AuditAction = "payment.slip.view"
	AuditSettingsUpdate        AuditAction = "settings.update"
	AuditTargetApplicant                   = "applicant"
	AuditTargetAdmin                       = "admin"
	AuditTargetSettings                    = "settings"
)

// AuditEntry is one row of the append-only audit_logs table.
type AuditEntry struct {
	ID         int64          `json:"id"`
	AdminID    *int64         `json:"adminId,omitempty"`
	Action     AuditAction    `json:"action"`
	TargetType string         `json:"targetType,omitempty"`
	TargetID   string         `json:"targetId,omitempty"`
	Details    map[string]any `json:"details,omitempty"`
	IPAddress  string         `json:"ipAddress,omitempty"`
	CreatedAt  time.Time      `json:"createdAt"`
}

// AuditRepository writes standalone audit events (e.g. logins). Actions that change data
// write their audit row inside the same transaction through the owning repository instead.
type AuditRepository interface {
	Log(ctx context.Context, entry *AuditEntry) error
}
