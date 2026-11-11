package service

import "testing"

func TestIsValidGrade(t *testing.T) {
	cases := map[string]bool{
		"ม.5":   true,
		"ปวช.3": true,
		"ปวส.1": true, // free text
		"กำลังรอเข้าเรียน": true,
		"":                      false,
		"ก":                     false, // too short
		"อื่นๆ":                 false, // the form's placeholder option is never a real value
		"123456789012345678901": false, // 21 runes
		"ม.\x00":                false,
	}
	for in, want := range cases {
		if got := isValidGrade(in); got != want {
			t.Errorf("isValidGrade(%q) = %v, want %v", in, got, want)
		}
	}
}
