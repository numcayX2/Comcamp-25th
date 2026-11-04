package domain

import (
	"context"
	"time"

	"github.com/shopspring/decimal"
)

type Settings struct {
	ID                   int             `db:"id" json:"id"`
	CampName             string          `db:"camp_name" json:"campName"`
	RegistrationOpenAt   time.Time       `db:"registration_open_at" json:"registrationOpenAt"`
	RegistrationCloseAt  time.Time       `db:"registration_close_at" json:"registrationCloseAt"`
	AnnouncementAt       *time.Time      `db:"announcement_at" json:"announcementAt,omitempty"`
	PaymentOpenAt        *time.Time      `db:"payment_open_at" json:"paymentOpenAt,omitempty"`
	PaymentDeadline      *time.Time      `db:"payment_deadline" json:"paymentDeadline,omitempty"`
	CertificateReleaseAt *time.Time      `db:"certificate_release_at" json:"certificateReleaseAt,omitempty"`
	MaxCapacity          int             `db:"max_capacity" json:"maxCapacity"`
	CampFee              decimal.Decimal `db:"camp_fee" json:"campFee"`
	IsManualClosed       bool            `db:"is_manual_closed" json:"isManualClosed"`
	UpdatedByAdminID     *int64          `db:"updated_by_admin_id" json:"updatedByAdminId,omitempty"`
	UpdatedAt            time.Time       `db:"updated_at" json:"updatedAt"`
}

type PublicSettingsResponse struct {
	ServerTime            string           `json:"serverTime"`
	RegistrationOpenAt    string           `json:"registrationOpenAt"`
	IsOpen                bool             `json:"isOpen"`
	CurrentCount          int              `json:"currentCount"`
	MaxCapacity           int              `json:"maxCapacity"`
	CampFee               *decimal.Decimal `json:"campFee"`
	IsCertificateReleased bool             `json:"isCertificateReleased"`
}

type SettingRepository interface {
	Get(ctx context.Context) (*Settings, error)
	Update(ctx context.Context, settings *Settings) error
}
