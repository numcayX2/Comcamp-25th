package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Cloudflare Turnstile server-side verification for POST /api/applications.
//
// Failure model (fail closed, AGENTS.md section 13):
//   - the token is missing, malformed, expired, already used or rejected -> ErrCaptchaFailed (403
//     CAPTCHA_FAILED): the client asks the widget for a fresh token.
//   - Cloudflare cannot be reached, times out, answers non-200 or reports an internal / secret
//     problem -> ErrCaptchaUnavailable (503): nobody is let through unverified, and the client can
//     retry without losing the form.
var (
	ErrCaptchaFailed      = errors.New("captcha verification failed or expired, please verify again")
	ErrCaptchaUnavailable = errors.New("captcha verification is temporarily unavailable, please try again")
)

const (
	// TurnstileSiteverifyURL is Cloudflare's server-side validation endpoint.
	TurnstileSiteverifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	// maxTurnstileTokenLen is the documented upper bound of a Turnstile response token.
	maxTurnstileTokenLen = 2048
)

// TurnstileVerifier checks a Turnstile response token. idempotencyKey (a UUID, optional) lets
// Cloudflare treat a retried siteverify call for the same token as the same request.
type TurnstileVerifier interface {
	Verify(ctx context.Context, token, remoteIP, idempotencyKey string) error
}

// IsTurnstileTestSecret reports whether secret is one of Cloudflare's documented dummy secrets
// (1x / 2x / 3x, then 0s, then AA). Their siteverify answers carry the hostname "example.com", so
// the hostname check cannot apply to them.
func IsTurnstileTestSecret(secret string) bool {
	const tail = "x0000000000000000000000000000000AA"
	return len(secret) == len(tail)+1 && strings.HasSuffix(secret, tail) && strings.ContainsRune("123", rune(secret[0]))
}

type httpTurnstileVerifier struct {
	secret       string
	allowedHosts map[string]bool
	endpoint     string
	client       *http.Client
	checkHost    bool
}

// NewTurnstileVerifier verifies tokens against Cloudflare with a 5 second timeout. When the
// secret is a real key (not a Cloudflare dummy), the hostname in the answer must be one of
// allowedHosts, so a token minted on someone else's site is not accepted.
func NewTurnstileVerifier(secret string, allowedHosts []string) TurnstileVerifier {
	return NewTurnstileVerifierWith(secret, allowedHosts, TurnstileSiteverifyURL, &http.Client{Timeout: 5 * time.Second})
}

// NewTurnstileVerifierWith is NewTurnstileVerifier with an explicit endpoint and client (tests).
func NewTurnstileVerifierWith(secret string, allowedHosts []string, endpoint string, client *http.Client) TurnstileVerifier {
	hosts := make(map[string]bool, len(allowedHosts))
	for _, h := range allowedHosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			hosts[h] = true
		}
	}
	return &httpTurnstileVerifier{
		secret: secret, allowedHosts: hosts, endpoint: endpoint, client: client,
		checkHost: !IsTurnstileTestSecret(secret),
	}
}

type siteverifyResponse struct {
	Success    bool     `json:"success"`
	Hostname   string   `json:"hostname"`
	ErrorCodes []string `json:"error-codes"`
}

func (v *httpTurnstileVerifier) Verify(ctx context.Context, token, remoteIP, idempotencyKey string) error {
	token = strings.TrimSpace(token)
	if token == "" || len(token) > maxTurnstileTokenLen {
		return ErrCaptchaFailed
	}

	form := url.Values{"secret": {v.secret}, "response": {token}}
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}
	if _, err := uuid.Parse(idempotencyKey); err == nil {
		form.Set("idempotency_key", idempotencyKey)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("%w: build request: %v", ErrCaptchaUnavailable, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res, err := v.client.Do(req)
	if err != nil {
		// Never log the request: it holds the secret and the token.
		return fmt.Errorf("%w: %v", ErrCaptchaUnavailable, scrubURLError(err))
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		return fmt.Errorf("%w: siteverify answered HTTP %d", ErrCaptchaUnavailable, res.StatusCode)
	}

	var out siteverifyResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&out); err != nil {
		return fmt.Errorf("%w: undecodable siteverify answer: %v", ErrCaptchaUnavailable, err)
	}

	if !out.Success {
		for _, code := range out.ErrorCodes {
			switch code {
			case "internal-error", "missing-input-secret", "invalid-input-secret":
				// Cloudflare's own failure or our misconfiguration: not the applicant's fault.
				log.Printf("turnstile: siteverify error codes %v (check TURNSTILE_SECRET_KEY)", out.ErrorCodes)
				return fmt.Errorf("%w: %s", ErrCaptchaUnavailable, code)
			}
		}
		return ErrCaptchaFailed
	}

	if v.checkHost && !v.allowedHosts[strings.ToLower(out.Hostname)] {
		log.Printf("turnstile: token minted for unexpected hostname %q", out.Hostname)
		return ErrCaptchaFailed
	}
	return nil
}

// scrubURLError drops the URL from *url.Error so nothing request-specific leaks into logs.
func scrubURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

type remoteIPKey struct{}

// WithRemoteIP attaches the (trusted-proxy aware) client IP for the captcha verification call.
func WithRemoteIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, remoteIPKey{}, ip)
}

func remoteIPFrom(ctx context.Context) string {
	ip, _ := ctx.Value(remoteIPKey{}).(string)
	return ip
}
