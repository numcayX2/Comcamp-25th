package service

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/jpeg"
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

// jpegSegment builds one marker segment: FF <marker> <2-byte length incl. itself> <payload>.
func jpegSegment(marker byte, payload []byte) []byte {
	seg := []byte{0xFF, marker, 0, 0}
	binary.BigEndian.PutUint16(seg[2:4], uint16(2+len(payload)))
	return append(seg, payload...)
}

func testJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewGray(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// withSegmentsAfterSOI inserts segments right after the SOI marker, where cameras put APP1.
func withSegmentsAfterSOI(img []byte, segs ...[]byte) []byte {
	out := append([]byte{}, img[:2]...)
	for _, s := range segs {
		out = append(out, s...)
	}
	return append(out, img[2:]...)
}

func TestStripJPEGExif(t *testing.T) {
	plain := testJPEG(t, 37, 23)
	gps := []byte("GPSLatitude=18.8977N;GPSLongitude=99.0117E;home") // stands in for a GPS IFD
	exif := jpegSegment(0xE1, append([]byte("Exif\x00\x00II*\x00"), gps...))
	xmp := jpegSegment(0xE1, []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta/>"))

	t.Run("EXIF APP1 is removed, image still reads", func(t *testing.T) {
		in := withSegmentsAfterSOI(plain, exif)
		out := stripJPEGExif(in)
		if bytes.Contains(out, []byte("Exif\x00\x00")) || bytes.Contains(out, gps) {
			t.Fatal("EXIF / GPS bytes survived")
		}
		if !bytes.Equal(out, plain) {
			t.Fatalf("expected exactly the JPEG without its EXIF segment (%d bytes), got %d bytes", len(plain), len(out))
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
		if err != nil || format != "jpeg" || cfg.Width != 37 || cfg.Height != 23 {
			t.Fatalf("DecodeConfig = %+v %q %v, want 37x23 jpeg", cfg, format, err)
		}
		if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
			t.Fatalf("stripped JPEG no longer decodes: %v", err)
		}
		if w, h, err := slipDimensions(out, "image/jpeg"); err != nil || w != 37 || h != 23 {
			t.Fatalf("slipDimensions = %d x %d, %v", w, h, err)
		}
	})

	t.Run("every EXIF segment goes, XMP and fill bytes are handled", func(t *testing.T) {
		in := withSegmentsAfterSOI(plain, exif, []byte{0xFF, 0xFF}, xmp, exif)
		out := stripJPEGExif(in)
		if bytes.Contains(out, []byte("Exif\x00\x00")) {
			t.Fatal("a second EXIF segment survived")
		}
		if !bytes.Contains(out, xmp) {
			t.Fatal("a non-EXIF APP1 segment was removed")
		}
		if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
			t.Fatalf("decode: %v", err)
		}
	})

	t.Run("a JPEG without EXIF is returned unchanged", func(t *testing.T) {
		if out := stripJPEGExif(plain); !bytes.Equal(out, plain) {
			t.Fatal("JPEG without EXIF was modified")
		}
	})

	t.Run("the word Exif inside scan data is left alone", func(t *testing.T) {
		// After SOS nothing is parsed: bytes that look like a segment there are image data.
		in := append(append([]byte{}, plain[:len(plain)-2]...), exif...)
		in = append(in, 0xFF, 0xD9)
		if out := stripJPEGExif(in); !bytes.Equal(out, in) {
			t.Fatal("bytes after SOS were changed")
		}
	})

	t.Run("non-standard input is returned unchanged", func(t *testing.T) {
		withExif := withSegmentsAfterSOI(plain, exif)
		truncated := withExif[:2+4+5] // EXIF segment cut short
		overlong := append([]byte{}, withExif...)
		binary.BigEndian.PutUint16(overlong[4:6], 0xFFFF) // length past the end of the file
		zeroLen := append([]byte{}, withExif...)
		binary.BigEndian.PutUint16(zeroLen[4:6], 0)
		stray := withSegmentsAfterSOI(plain, []byte{0x00}, exif) // garbage byte between segments
		eoiFirst := withSegmentsAfterSOI(plain, []byte{0xFF, 0xD9}, exif)
		png := []byte("\x89PNG\r\n\x1a\nExif\x00\x00")
		for name, in := range map[string][]byte{
			"truncated": truncated, "length past end": overlong, "zero length": zeroLen,
			"stray byte": stray, "EOI before SOS": eoiFirst, "not a JPEG": png, "empty": {}, "SOI only": {0xFF, 0xD8},
		} {
			if out := stripJPEGExif(in); !bytes.Equal(out, in) {
				t.Errorf("%s: input was modified", name)
			}
		}
	})
}
