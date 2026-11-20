package service

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// referralCodes are the answers to "where did you hear about the camp" (upgrade_plan.md §2.3), in
// the order the form lists them. Stored values are always a subset of these, in this order.
// Keep in step with REFERRAL_* in frontend/src/lib/api.ts.
var referralCodes = []string{
	"social_facebook", "social_instagram", "social_tiktok",
	"google", "website",
	"word_friend", "word_senior", "word_junior", "word_teacher",
	"parent", "last_year",
	"other",
}

// ReferralOther is the code whose free text goes into referralOther.
const ReferralOther = "other"

const maxReferralOtherRunes = 50

var referralOrder = func() map[string]int {
	m := make(map[string]int, len(referralCodes))
	for i, c := range referralCodes {
		m[c] = i
	}
	return m
}()

// normalizeReferral trims and lower-cases the codes, drops blanks and repeats, sorts them into the
// form's order, and cleans the free text. The text is kept only alongside "other". Unknown codes
// are left in, so validateReferral can refuse them.
func normalizeReferral(codes []string, other string) ([]string, string) {
	seen := make(map[string]bool, len(codes))
	out := make([]string, 0, len(codes))
	for _, c := range codes {
		c = strings.ToLower(strings.TrimSpace(stripZeroWidth(c)))
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	// Known codes first in form order; unknown ones (refused later) after them.
	rank := func(c string) int {
		if i, ok := referralOrder[c]; ok {
			return i
		}
		return len(referralCodes)
	}
	slices.SortStableFunc(out, func(a, b string) int { return rank(a) - rank(b) })
	other = cleanText(other)
	if !seen[ReferralOther] {
		other = ""
	}
	return out, other
}

// validateReferral checks a normalised answer. The question is optional for the API (older clients
// never send it), so an empty list is valid; when "other" is chosen its text is required.
func validateReferral(codes []string, other string) error {
	if len(codes) > len(referralCodes) {
		return newValidationError("too many referral sources")
	}
	for _, c := range codes {
		if _, ok := referralOrder[c]; !ok {
			return newValidationError("invalid referral source")
		}
	}
	if slices.Contains(codes, ReferralOther) && other == "" {
		return newValidationError("referralOther is required when referral source \"other\" is chosen")
	}
	if utf8.RuneCountInString(other) > maxReferralOtherRunes {
		return newValidationError("referralOther is too long (max 50 characters)")
	}
	for _, r := range other {
		if unicode.IsControl(r) {
			return newValidationError("invalid referralOther")
		}
	}
	return nil
}
