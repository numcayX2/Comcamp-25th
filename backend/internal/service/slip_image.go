package service

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	_ "image/jpeg" // registers the JPEG header decoder for image.DecodeConfig
	_ "image/png"  // registers the PNG header decoder for image.DecodeConfig
)

// MaxSlipDimension caps slip width and height (AGENTS.md §13.4). A few-KB file can declare a
// 50,000 × 50,000 image that needs gigabytes of RAM to decode (a decompression bomb, or "pixel
// flood"), and it is the staff browser that decodes slips. Real slips (bank-app screenshots and
// e-slips) are far below this.
const MaxSlipDimension = 4096

var errUnreadableImage = errors.New("unreadable image header")

// slipDimensions reads only the image header, never the pixel data, so checking a hostile file
// costs a few bytes of work. contentType is the type sniffed from the magic bytes.
func slipDimensions(data []byte, contentType string) (width, height int, err error) {
	if contentType == "image/webp" {
		return webpDimensions(data)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, errUnreadableImage
	}
	return cfg.Width, cfg.Height, nil
}

// webpDimensions parses the RIFF header of a WebP file in pure Go (no cgo, no x/image). Per the
// WebP container spec the first chunk after "WEBP" is one of:
//
//	"VP8 "  lossy:    3-byte frame tag, start code 9D 01 2A, then 14-bit width and height
//	"VP8L"  lossless: signature 0x2F, then 14-bit (width-1) and 14-bit (height-1)
//	"VP8X"  extended: flags + 3 reserved bytes, then 24-bit (width-1) and 24-bit (height-1)
func webpDimensions(b []byte) (width, height int, err error) {
	if len(b) < 20 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return 0, 0, errUnreadableImage
	}
	chunk, d := string(b[12:16]), b[20:]
	switch chunk {
	case "VP8 ":
		if len(d) < 10 || d[3] != 0x9D || d[4] != 0x01 || d[5] != 0x2A {
			return 0, 0, errUnreadableImage
		}
		width = int(binary.LittleEndian.Uint16(d[6:8]) & 0x3FFF)
		height = int(binary.LittleEndian.Uint16(d[8:10]) & 0x3FFF)
	case "VP8L":
		if len(d) < 5 || d[0] != 0x2F {
			return 0, 0, errUnreadableImage
		}
		bits := binary.LittleEndian.Uint32(d[1:5])
		width = int(bits&0x3FFF) + 1
		height = int((bits>>14)&0x3FFF) + 1
	case "VP8X":
		if len(d) < 10 {
			return 0, 0, errUnreadableImage
		}
		width = 1 + (int(d[4]) | int(d[5])<<8 | int(d[6])<<16)
		height = 1 + (int(d[7]) | int(d[8])<<8 | int(d[9])<<16)
	default:
		return 0, 0, errUnreadableImage
	}
	return width, height, nil
}

// validSlipDimensions reports whether a decoded header is within 1..MaxSlipDimension on both axes.
func validSlipDimensions(width, height int) bool {
	return width > 0 && height > 0 && width <= MaxSlipDimension && height <= MaxSlipDimension
}

// exifHeader starts the payload of an APP1 segment that holds EXIF data (JPEG/EXIF 2.3 §4.5.4).
var exifHeader = []byte("Exif\x00\x00")

// stripJPEGExif removes every EXIF APP1 segment (camera model, capture time, GPS position) from a
// JPEG, so a slip photographed with a phone camera does not store the student's home location on
// the server. Only the marker segments before SOS are walked; SOS and the entropy-coded data after
// it are copied byte for byte, and no pixel is decoded or re-encoded. Other APP1 payloads (XMP) and
// every other segment are kept.
//
// Anything that does not follow the standard layout (no SOI, a truncated or zero-length segment, a
// stray byte between segments, EOI or a restart marker before SOS) returns data unchanged: the
// upload's own checks decide about such a file, this helper never makes it worse. Pad 0xFF bytes
// before a marker are allowed by the standard and dropped.
func stripJPEGExif(data []byte) []byte {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return data
	}
	out := make([]byte, 0, len(data))
	out = append(out, 0xFF, 0xD8)
	stripped := false
	i := 2
	for {
		if i+2 > len(data) || data[i] != 0xFF {
			return data
		}
		marker := data[i+1]
		switch {
		case marker == 0xFF: // fill byte before the real marker
			i++
			continue
		case marker == 0xDA: // SOS: the rest is scan data (and any later segments), kept as is
			out = append(out, data[i:]...)
			if !stripped {
				return data
			}
			return out
		case marker == 0x00, marker == 0x01, marker >= 0xD0 && marker <= 0xD9:
			// Stuffed zero, TEM, RSTn, SOI or EOI: none belongs between SOI and SOS.
			return data
		}
		if i+4 > len(data) {
			return data
		}
		segLen := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		end := i + 2 + segLen
		if segLen < 2 || end > len(data) {
			return data
		}
		if marker == 0xE1 && bytes.HasPrefix(data[i+4:end], exifHeader) {
			stripped = true
		} else {
			out = append(out, data[i:end]...)
		}
		i = end
	}
}
