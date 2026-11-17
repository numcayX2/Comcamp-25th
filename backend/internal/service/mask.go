package service

import "strings"

// Masking for public responses (AGENTS.md §13.5). Masking happens on the server: the public
// status API is reachable by anyone who knows a phone number, so hiding digits only in the UI
// would still leak them in the JSON.

// MaskName keeps the first character of each name part: "สมชาย", "ใจดี" → "ส*** ใ***". It is the
// name shown to someone who looked an application up by phone number only.
func MaskName(first, last string) string {
	part := func(s string) string {
		r := []rune(strings.TrimSpace(s))
		if len(r) == 0 {
			return ""
		}
		return string(r[0]) + "***"
	}
	f, l := part(first), part(last)
	switch {
	case f == "":
		return l
	case l == "":
		return f
	}
	return f + " " + l
}

// MaskPhone renders 0812345678 as XXX-XXX-5678.
func MaskPhone(phone string) string {
	if len(phone) < 4 {
		return "XXX-XXX-XXXX"
	}
	return "XXX-XXX-" + phone[len(phone)-4:]
}

// MaskEmail renders somchai@example.com as s***@example.com.
func MaskEmail(email string) string {
	if email == "" {
		return "" // email is optional: nothing to mask, and the status page hides the row
	}
	local, domain, ok := strings.Cut(email, "@")
	if !ok || local == "" {
		return "***"
	}
	return string([]rune(local)[0]) + "***@" + domain
}
