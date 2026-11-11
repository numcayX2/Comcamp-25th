package handler_test

import (
	"bytes"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"comcamp25-backend/internal/server"
)

// Each public mutation has its own bucket. Behind one school or carrier NAT many students share an
// address: a class uploading slips and editing profiles must not stop a classmate from confirming
// attendance or withdrawing.

type mutationEndpoint struct {
	name, method, path string
}

var mutationEndpoints = []mutationEndpoint{
	{"slip", http.MethodPost, "/api/applications/CC25-NOONE1/slip"},
	{"confirm", http.MethodPost, "/api/applications/CC25-NOONE1/confirm"},
	{"withdraw", http.MethodPost, "/api/applications/CC25-NOONE1/withdraw"},
	{"profile", http.MethodPatch, "/api/applications/CC25-NOONE1/profile"},
}

func (a *testApp) hit(t *testing.T, e mutationEndpoint) int {
	t.Helper()
	// The limiter runs before the handler, so an empty body (answered with 4xx) counts the same.
	return a.do(t, e.method, e.path, bytes.NewBufferString(`{}`), nil).Code
}

func TestMutationRateLimits_AreIndependentPerEndpoint(t *testing.T) {
	for _, exhausted := range mutationEndpoints {
		t.Run(exhausted.name, func(t *testing.T) {
			app := setupTestApp(t) // default limits
			for i := 1; i <= 20; i++ {
				if code := app.hit(t, exhausted); code == http.StatusTooManyRequests {
					t.Fatalf("%s request %d was limited before the 20 per minute allowance", exhausted.name, i)
				}
			}
			if code := app.hit(t, exhausted); code != http.StatusTooManyRequests {
				t.Fatalf("%s request 21 must be 429, got %d", exhausted.name, code)
			}
			for _, other := range mutationEndpoints {
				if other.name == exhausted.name {
					continue
				}
				if code := app.hit(t, other); code == http.StatusTooManyRequests {
					t.Fatalf("exhausting %s must not rate limit %s", exhausted.name, other.name)
				}
			}
		})
	}
}

// The case that motivated it: slip uploads and profile edits from one address used up the shared
// allowance, and a classmate at the same address could no longer confirm attendance.
func TestMutationRateLimits_ProfileFloodDoesNotBlockConfirm(t *testing.T) {
	app := setupTestApp(t)
	mine := app.submit(t, validTestNationalID(301), "0810000301", "nat1@example.com")
	friend := app.submit(t, validTestNationalID(302), "0810000302", "nat2@example.com")

	// 20 profile edits and 20 slip uploads from the same address, then the limit is reached.
	body := fmt.Sprintf(`{"verifyCode":%q,"nickname":"a","school":"b","province":"c","grade":"ม.6","shirtSize":"M"}`, app.verifyCodes[mine.ID])
	var profileLimited bool
	for i := 0; i < 25; i++ {
		rec := app.do(t, http.MethodPatch, "/api/applications/"+mine.ID+"/profile", strings.NewReader(body), nil)
		if rec.Code == http.StatusTooManyRequests {
			profileLimited = true
		}
	}
	if !profileLimited {
		t.Fatal("25 profile edits within a minute must hit the profile limiter")
	}
	for i := 0; i < 22; i++ {
		app.uploadSlipWithCode(t, mine.ID, "0000", "slip.png", []byte("not an image"))
	}

	rec := app.confirmWith(t, friend.ID, app.verifyCodes[friend.ID])
	if rec.Code != http.StatusOK {
		t.Fatalf("a classmate behind the same address must still be able to confirm, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestDefaultRateLimits_EveryPublicMutationHasItsOwnLimiter(t *testing.T) {
	// A shared pointer would reintroduce the problem without any request-level test noticing.
	l := server.DefaultRateLimits()
	seen := map[any]string{}
	for name, rl := range map[string]any{"slip": l.Slip, "confirm": l.Confirm, "withdraw": l.Withdraw, "profile": l.Profile, "submit": l.Submit, "status": l.StatusQuery, "login": l.Login} {
		if rl == nil {
			t.Fatalf("%s limiter is missing", name)
		}
		if prev, dup := seen[rl]; dup {
			t.Fatalf("%s and %s share one limiter", prev, name)
		}
		seen[rl] = name
	}
}
