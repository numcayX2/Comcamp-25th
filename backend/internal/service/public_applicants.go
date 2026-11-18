package service

import (
	"context"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"

	"comcamp25-backend/internal/domain"
)

// Public status labels shown on /applicants. Only PASSED and CONFIRMED are ever listed.
const (
	PublicStatusAwaitingPayment = "รอชำระเงิน"
	PublicStatusConfirmed       = "ยืนยันสิทธิ์แล้ว"
)

// publicListCacheTTL bounds how long one snapshot of the public list is reused. Every mutation
// that changes who is listed or what is shown invalidates it immediately (InvalidatePublicList),
// so the TTL only caps staleness for a path nobody wired, while a burst of page loads (for
// example right after the link is shared in a LINE group) costs one query per window at most.
const publicListCacheTTL = 5 * time.Second

// PublicApplicantEntry is one row of GET /api/applications/public. It is the STRICT PDPA
// allowlist (CLAUDE_REVAMP_HANDOFF.md 5.4): the registration consent discloses exactly name,
// nickname, school and province on this page. Never add a field here without changing that
// consent text, and never serialize domain.Applicant or ApplicationResponse in its place.
type PublicApplicantEntry struct {
	No       int    `json:"no"`
	FullName string `json:"fullName"`
	Nickname string `json:"nickname"`
	School   string `json:"school"`
	Province string `json:"province"`
	Status   string `json:"status"`
}

// PublicApplicantsResponse is the body of GET /api/applications/public. Applicants is never nil
// so the JSON is always an array.
type PublicApplicantsResponse struct {
	Applicants []PublicApplicantEntry `json:"applicants"`
}

// publicListCache is the short cache in front of ListPublic. Its zero value is ready to use, so
// every ApplicantService has one without any wiring.
type publicListCache struct {
	mu        sync.RWMutex
	rows      []PublicApplicantEntry
	expiresAt time.Time
	ver       atomic.Uint64
	group     singleflight.Group
}

// InvalidatePublicList drops the cached public list so the next read queries fresh rows. Bumping
// the version stops an in-flight lookup from writing pre-mutation rows back into the cache. It is
// safe to call from other services (PaymentService reports slip verdicts through it).
func (s *ApplicantService) InvalidatePublicList() {
	c := &s.publicList
	c.ver.Add(1)
	c.mu.Lock()
	c.rows = nil
	c.expiresAt = time.Time{}
	c.mu.Unlock()
}

// ListPublicApplicants returns the public applicants list (live PASSED and CONFIRMED
// applications, oldest first). On a cache miss it first releases overdue unpaid seats, like the
// other public reads. Concurrent misses share one repository read, isolated from any single
// caller's cancellation, and each caller gets its own copy of the rows. When the caller's own
// context ends first, its ctx.Err() (context.Canceled / DeadlineExceeded) is returned.
func (s *ApplicantService) ListPublicApplicants(ctx context.Context) (*PublicApplicantsResponse, error) {
	c := &s.publicList
	c.mu.RLock()
	if c.rows != nil && time.Now().Before(c.expiresAt) {
		out := copyPublicRows(c.rows)
		c.mu.RUnlock()
		return &PublicApplicantsResponse{Applicants: out}, nil
	}
	c.mu.RUnlock()

	// The flight is keyed by the cache version, so a caller arriving after an invalidation starts
	// a fresh read instead of joining one that began before the change.
	startVer := c.ver.Load()
	ch := c.group.DoChan("public-list-"+strconv.FormatUint(startVer, 10), func() (any, error) {
		qCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Same lazy unpaid expiry as QueryStatus, ListAll and Submit, so the public list never
		// shows a seat that /status already reports as expired. It runs on a cache miss only. A
		// release invalidates the cache (notifySeatChange), so the version this read may cache
		// under is taken after it: only a mutation from here on keeps the result out of the cache.
		_, _ = s.ExpireOverdueUnpaid(qCtx, s.currentTime())
		cacheVer := c.ver.Load()

		rows, err := s.appRepo.ListPublic(qCtx)
		if err != nil {
			return nil, err
		}
		entries := make([]PublicApplicantEntry, 0, len(rows))
		for _, r := range rows {
			label, ok := publicStatusLabel(r.Status)
			if !ok {
				// The repository filters by status; a row that slipped through is dropped rather
				// than shown with an internal status code.
				continue
			}
			entries = append(entries, PublicApplicantEntry{
				No:       len(entries) + 1,
				FullName: publicFullName(r.FirstName, r.LastName),
				Nickname: r.Nickname,
				School:   r.School,
				Province: r.Province,
				Status:   label,
			})
		}

		if c.ver.Load() == cacheVer {
			c.mu.Lock()
			if c.ver.Load() == cacheVer {
				c.rows = entries
				c.expiresAt = time.Now().Add(publicListCacheTTL)
			}
			c.mu.Unlock()
		}
		return entries, nil
	})

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		return &PublicApplicantsResponse{Applicants: copyPublicRows(res.Val.([]PublicApplicantEntry))}, nil
	}
}

func copyPublicRows(src []PublicApplicantEntry) []PublicApplicantEntry {
	out := make([]PublicApplicantEntry, len(src))
	copy(out, src)
	return out
}

func publicStatusLabel(s domain.ApplicationStatus) (string, bool) {
	switch s {
	case domain.StatusPassed:
		return PublicStatusAwaitingPayment, true
	case domain.StatusConfirmed:
		return PublicStatusConfirmed, true
	}
	return "", false
}

// publicFullName is first + last name. The title prefix is left out on purpose: the consent
// discloses the name only, and a prefix (นาย / นางสาว) would add gender to a public page.
func publicFullName(first, last string) string {
	if last == "" {
		return first
	}
	return first + " " + last
}
