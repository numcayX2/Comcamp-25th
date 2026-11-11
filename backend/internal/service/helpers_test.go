package service_test

import "fmt"

// validTestNationalID builds a 13-digit national ID that passes the Thai Mod-11 check: the
// 12-digit body "15099" + seq (7 digits, zero-padded) plus its computed check digit. Distinct
// seq values give distinct IDs.
func validTestNationalID(seq int) string {
	body := fmt.Sprintf("15099%07d", seq%10_000_000)
	sum := 0
	for i := 0; i < 12; i++ {
		sum += int(body[i]-'0') * (13 - i)
	}
	return body + string(rune('0'+(11-sum%11)%10))
}
