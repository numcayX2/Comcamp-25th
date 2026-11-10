package service

import "strings"

// Masking for public responses (AGENTS.md §13.5). Masking happens on the server: the public
// status API is reachable by anyone who knows a phone number, so hiding digits only in the UI
// would still leak them in the JSON.

// MaskNationalID renders 1509900112233 as 1-5099-XXXXX-XX-X.
func MaskNationalID(id string) string {
	if len(id) != 13 || !isNumeric(id) {
		return "X-XXXX-XXXXX-XX-X"
	}
	return id[0:1] + "-" + id[1:5] + "-XXXXX-XX-X"
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
