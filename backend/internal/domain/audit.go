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
	AuditPaymentExpired  AuditAction = "application.expire.unpaid"
	AuditApplicantDelete AuditAction = "application.delete"
	// Confirmation email lifecycle events (no admin; Details use maskedEmail only).
	AuditEmailRegistrationSent   AuditAction = "application.email.registration.sent"
	AuditEmailRegistrationFailed AuditAction = "application.email.registration.failed"
	AuditEmailConfirmedSent      AuditAction = "application.email.confirmed.sent"
	AuditEmailConfirmedFailed    AuditAction = "application.email.confirmed.failed"
	// Staff notice about a new application, one per staff address (Details: maskedEmail only).
	AuditEmailStaffRegistrationSent AuditAction = "application.email.staff_notice.sent"
	AuditEmailStaffRegistrationFail AuditAction = "application.email.staff_notice.failed"
	// AuditApplicantWithdrawSelf is the applicant withdrawing their own application (no admin).
	AuditApplicantWithdrawSelf AuditAction = "application.withdraw.self"
	// AuditApplicantPurge is staff permanently deleting a self-withdrawn application (test or
	// duplicate sign-ups). Details carry no personal data: the row they described is gone.
	AuditApplicantPurge AuditAction = "application.purge"
	// AuditProfileUpdate is a staff edit of an application; AuditProfileUpdateSelf is the
	// applicant editing their own secondary fields (no admin).
	AuditProfileUpdate     AuditAction = "application.profile.update"
	AuditProfileUpdateSelf AuditAction = "application.profile.update.self"
	AuditSlipVerify        AuditAction = "payment.slip.verify"
	AuditSlipViewed        AuditAction = "payment.slip.view"
	AuditSettingsUpdate    AuditAction = "settings.update"
	// AuditAdminCLIUpsert is an account created or reset with `go run ./cmd/create-admin`.
	AuditAdminCLIUpsert AuditAction = "admin.cli.upsert"
	// AuditAttendanceConfirm is the applicant answering the attendance question on /status
	// (no admin). Details carry confirmed true/false.
	AuditAttendanceConfirm AuditAction = "application.attendance.confirm"
	// AuditApplicantExportCSV is staff downloading the applicant list as CSV from the dashboard.
	AuditApplicantExportCSV AuditAction = "application.export.csv"
	AuditTargetApplicant                = "applicant"
	AuditTargetAdmin                    = "admin"
	AuditTargetSettings                 = "settings"
	// Sponsor management events (written in the same transaction as the sponsor change).
	AuditSponsorCreate  AuditAction = "sponsor.create"
	AuditSponsorUpdate  AuditAction = "sponsor.update"
	AuditSponsorDelete  AuditAction = "sponsor.delete"
	AuditSponsorReorder AuditAction = "sponsor.reorder"
	AuditTargetSponsor              = "sponsor"
)

// Sponsor inquiry / donation events (migration 000015). Mutations are written in the same
// transaction as the change; details never carry personal data beyond what is listed per action.
const (
	AuditSponsorInquiryCreate    AuditAction = "sponsor.inquiry.create"
	AuditSponsorInquiryUpdate    AuditAction = "sponsor.inquiry.update"
	AuditSponsorInquiryDelete    AuditAction = "sponsor.inquiry.delete"
	AuditSponsorInquiryFileView  AuditAction = "sponsor.inquiry.file.view"
	AuditSponsorInquirySlipView  AuditAction = "sponsor.inquiry.slip.view"
	AuditSponsorNotifyUpdate     AuditAction = "sponsor.notify.update"
	AuditSponsorDonationCreate   AuditAction = "sponsor.donation.create"
	AuditSponsorDonationUpdate   AuditAction = "sponsor.donation.update"
	AuditSponsorDonationDelete   AuditAction = "sponsor.donation.delete"
	AuditSponsorDonationFileUp   AuditAction = "sponsor.donation.file.upload"
	AuditSponsorDonationFileView AuditAction = "sponsor.donation.file.view"
	AuditSponsorDonationFileDel  AuditAction = "sponsor.donation.file.delete"
	AuditEmailSponsorInquirySent AuditAction = "email.sponsor_inquiry.sent"
	AuditEmailSponsorInquiryFail AuditAction = "email.sponsor_inquiry.failed"
	AuditTargetSponsorInquiry                = "sponsor_inquiry"
	AuditTargetSponsorDonation               = "sponsor_donation"
)

// AuditSlipSuperseded is an applicant uploading a new slip that replaced one still waiting for
// review (no admin). The replaced slip's row and file are deleted.
const AuditSlipSuperseded AuditAction = "payment.slip.superseded"

// Application-code guessing events (AGENTS.md §13.5, service.CodeGuard), written without an admin.
const (
	// AuditCodeGuessLockout is one client (IP, or IPv6 /64) refused for a while after naming too many
	// application codes that do not exist.
	AuditCodeGuessLockout AuditAction = "application.code.lockout"
	// AuditCodeGuessCeiling is the unknown codes of all clients together reaching a global ceiling.
	AuditCodeGuessCeiling AuditAction = "application.code.ceiling"
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
