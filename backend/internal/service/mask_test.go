package service

import "testing"

func TestMasking(t *testing.T) {
	cases := []struct{ got, want string }{
		{MaskName("สมชาย", "ใจดี"), "ส*** ใ***"},
		{MaskName("เกียรติ", ""), "เ***"},
		{MaskName("", "ใจดี"), "ใ***"},
		{MaskName(" ", " "), ""},
		{MaskName("Somchai", "Jaidee"), "S*** J***"},
		// Public responses show only the last 2 digits (ruling R25).
		{MaskPhone("0812345678"), "XXX-XXX-XX78"},
		{MaskPhone("12"), "XXX-XXX-XX12"},
		{MaskPhone("1"), "XXX-XXX-XXXX"},
		{MaskPhone(""), "XXX-XXX-XXXX"},
		{MaskEmail("somchai@example.com"), "s***@example.com"},
		{MaskEmail("ก@example.com"), "ก***@example.com"},
		{MaskEmail(""), ""},
		{MaskEmail("no-at-sign"), "***"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("want %q, got %q", c.want, c.got)
		}
	}
}
