package service

import "testing"

func TestMasking(t *testing.T) {
	cases := []struct{ got, want string }{
		{MaskNationalID("1509900112233"), "1-5099-XXXXX-XX-X"},
		{MaskNationalID("123"), "X-XXXX-XXXXX-XX-X"},
		{MaskPhone("0812345678"), "XXX-XXX-5678"},
		{MaskPhone("12"), "XXX-XXX-XXXX"},
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
