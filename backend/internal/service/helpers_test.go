package service_test

import "fmt"

// testPhone builds a valid 10-digit mobile number ("08" + 8 digits) for seq. Distinct seq values
// (below 100,000,000) give distinct numbers, so the applicants of one test never collide on the
// live-phone uniqueness rule.
func testPhone(seq int) string {
	return fmt.Sprintf("08%08d", seq%100_000_000)
}
