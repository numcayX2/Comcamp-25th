package service

import (
	"encoding/binary"
	"testing"
)

func riff(chunk string, payload []byte) []byte {
	b := []byte("RIFF\x00\x00\x00\x00WEBP" + chunk + "\x00\x00\x00\x00")
	binary.LittleEndian.PutUint32(b[4:8], uint32(4+8+len(payload)))
	binary.LittleEndian.PutUint32(b[16:20], uint32(len(payload)))
	return append(b, payload...)
}

func TestWebpDimensions(t *testing.T) {
	// Lossy: frame tag, start code 9D 01 2A, 14-bit width/height (upper 2 bits are scale).
	vp8 := []byte{0x30, 0x01, 0x00, 0x9D, 0x01, 0x2A, 0, 0, 0, 0}
	binary.LittleEndian.PutUint16(vp8[6:8], 640|0xC000) // scale bits must be ignored
	binary.LittleEndian.PutUint16(vp8[8:10], 480)

	// Lossless: 0x2F, then (w-1) in 14 bits and (h-1) in the next 14 bits.
	vp8l := []byte{0x2F, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(vp8l[1:5], uint32(1079)|uint32(2399)<<14)

	// Extended: 24-bit (w-1) at offset 4, 24-bit (h-1) at offset 7.
	vp8x := make([]byte, 10)
	vp8x[4], vp8x[5], vp8x[6] = 0x87, 0x13, 0x00 // 4999
	vp8x[7], vp8x[8], vp8x[9] = 0x0F, 0x27, 0x00 // 9999

	cases := []struct {
		name   string
		data   []byte
		w, h   int
		wantOK bool
	}{
		{"vp8", riff("VP8 ", vp8), 640, 480, true},
		{"vp8l", riff("VP8L", vp8l), 1080, 2400, true},
		{"vp8x", riff("VP8X", vp8x), 5000, 10000, true},
		{"bad start code", riff("VP8 ", []byte{0, 0, 0, 1, 2, 3, 0, 0, 0, 0}), 0, 0, false},
		{"bad vp8l signature", riff("VP8L", []byte{0x2E, 0, 0, 0, 0}), 0, 0, false},
		{"truncated", riff("VP8X", []byte{0, 0}), 0, 0, false},
		{"unknown chunk", riff("ALPH", make([]byte, 10)), 0, 0, false},
		{"not riff", []byte("RIFX\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00"), 0, 0, false},
	}
	for _, c := range cases {
		w, h, err := webpDimensions(c.data)
		if (err == nil) != c.wantOK || (c.wantOK && (w != c.w || h != c.h)) {
			t.Errorf("%s: got %d×%d err=%v, want %d×%d ok=%v", c.name, w, h, err, c.w, c.h, c.wantOK)
		}
	}
}

func TestValidSlipDimensions(t *testing.T) {
	for _, c := range []struct {
		w, h int
		ok   bool
	}{{1, 1, true}, {4096, 4096, true}, {4097, 1, false}, {1, 4097, false}, {0, 10, false}, {10, -1, false}} {
		if got := validSlipDimensions(c.w, c.h); got != c.ok {
			t.Errorf("%d×%d: got %v, want %v", c.w, c.h, got, c.ok)
		}
	}
}

func TestInputCleaning(t *testing.T) {
	for in, want := range map[string]string{
		"\uFEFF1-5099-00112-23-3\u200B": "1509900112233",
		"081\u2010234–5678":             "0812345678", // Unicode hyphen and en dash
		"081 234 5678":                  "0812345678",
		"\u200C08\u200D12\u20603":       "08123",
		"08a1":                          "08a1", // letters are left for validation to reject
	} {
		if got := cleanNumber(in); got != want {
			t.Errorf("cleanNumber(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{
		"1-5099-00112-23-3": "1509900112233",
		" 081-234-5678 ":    "0812345678",
		"cc25-e85b53":       "CC25-E85B53",
		"CC25E85B53":        "CC25-E85B53",
		"\u200BCC25-E85B53": "CC25-E85B53",
		"CC25-E85B53\uFEFF": "CC25-E85B53",
		"not-an-id":         "NOT-AN-ID",
	} {
		if got := normalizeLookupQuery(in); got != want {
			t.Errorf("normalizeLookupQuery(%q) = %q, want %q", in, got, want)
		}
	}
}
