package handler_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
)

// withExif puts an EXIF APP1 segment (with a fake GPS position) right after the JPEG's SOI.
func withExif(img []byte) []byte {
	payload := []byte("Exif\x00\x00II*\x00GPS=18.8977N,99.0117E")
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:4], uint16(2+len(payload)))
	out := append([]byte{}, img[:2]...)
	out = append(out, seg...)
	out = append(out, payload...)
	return append(out, img[2:]...)
}

// LOW-07: the stored slip has no EXIF, and slip_hash is the hash of exactly the stored bytes.
func TestUploadSlip_StripsExifBeforeHashAndStore(t *testing.T) {
	app := setupTestApp(t)
	a := app.submit(t, validTestNationalID(9301), "0819309301", "exif1@example.com")
	b := app.submit(t, validTestNationalID(9302), "0819309302", "exif2@example.com")

	plain := encodeJPEG(41, 29)
	rec := app.uploadSlip(t, a.ID, "camera.jpg", withExif(plain))
	wantCode(t, rec, http.StatusOK, "")

	files, err := os.ReadDir(app.slipDir)
	if err != nil || len(files) != 1 {
		t.Fatalf("expected one stored slip, got %v (%v)", files, err)
	}
	stored, err := os.ReadFile(filepath.Join(app.slipDir, files[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("Exif\x00\x00")) || bytes.Contains(stored, []byte("GPS=")) {
		t.Fatal("stored slip still carries EXIF / GPS")
	}
	if !bytes.Equal(stored, plain) {
		t.Fatal("stored slip is not the original JPEG minus its EXIF segment")
	}
	pays := app.paymentsOf(t, a.ID)
	sum := sha256.Sum256(stored)
	if len(pays) != 1 || pays[0].SlipHash == nil || *pays[0].SlipHash != hex.EncodeToString(sum[:]) {
		t.Fatal("slip_hash does not match the stored file")
	}

	// The same photo without EXIF is the same slip.
	rec = app.uploadSlip(t, b.ID, "copy.jpg", plain)
	wantCode(t, rec, http.StatusConflict, response.CodeDuplicateSlip)
}

func exportEntries(app *testApp) []domain.AuditEntry {
	var out []domain.AuditEntry
	for _, e := range app.appRepo.Audit().Entries() {
		if e.Action == domain.AuditApplicantExportCSV {
			out = append(out, e)
		}
	}
	return out
}

// LOW-09: the dashboard records a CSV export before building the file.
func TestAdminExportAudit(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	x := app.submit(t, validTestNationalID(9311), "0819309311", "exp1@example.com")
	y := app.submit(t, validTestNationalID(9312), "0819309312", "exp2@example.com")

	body := `{"applicationIds":["` + x.ID + `","` + strings.ToLower(y.ID) + `"],"statusFilter":"PASSED","searchFiltered":true}`
	rec := app.do(t, http.MethodPost, "/api/admin/applications/export-audit", bytes.NewBufferString(body), bearer(token))
	wantCode(t, rec, http.StatusOK, "")
	var res struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || res.Count != 2 {
		t.Fatalf("response %s (%v)", rec.Body.String(), err)
	}

	got := exportEntries(app)
	if len(got) != 1 {
		t.Fatalf("expected 1 export audit entry, got %d", len(got))
	}
	e := got[0]
	ids, _ := e.Details["applicationIds"].([]string)
	if e.AdminID == nil || *e.AdminID != app.adminID || e.IPAddress != "192.0.2.1" || e.Details["count"] != 2 ||
		strings.Join(ids, ",") != x.ID+","+y.ID || e.Details["statusFilter"] != domain.StatusPassed || e.Details["searchFiltered"] != true {
		t.Fatalf("unexpected audit entry %+v", e)
	}

	for name, bad := range map[string]string{
		"phone instead of id": `{"applicationIds":["0819309311"]}`,
		"unknown status":      `{"applicationIds":[],"statusFilter":"NOPE"}`,
		"not json":            `applicationIds=1`,
	} {
		rec := app.do(t, http.MethodPost, "/api/admin/applications/export-audit", bytes.NewBufferString(bad), bearer(token))
		wantCode(t, rec, http.StatusBadRequest, response.CodeValidation)
		_ = name
	}
	if n := len(exportEntries(app)); n != 1 {
		t.Fatalf("refused requests were recorded (%d entries)", n)
	}
}
