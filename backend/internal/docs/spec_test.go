package docs

import (
	"encoding/json"
	"os"
	"testing"
)

// The embedded spec must stay valid JSON, describe the endpoints and statuses the API really has,
// and match the copy in backend/docs.
func TestOpenAPISpec(t *testing.T) {
	var spec struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]struct {
				Properties map[string]struct {
					Enum []string `json:"enum"`
				} `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(OpenAPISpec, &spec); err != nil {
		t.Fatalf("openapi.json is not valid JSON: %v", err)
	}

	for path, method := range map[string]string{
		"/applications/{id}/withdraw":      "post",
		"/applications/{id}/profile":       "patch",
		"/admin/applications/{id}/profile": "patch",
		"/admin/applications/{id}":         "delete",
		"/admin/applications/export-audit": "post",
	} {
		if _, ok := spec.Paths[path][method]; !ok {
			t.Errorf("spec is missing %s %s", method, path)
		}
	}

	// Applicant self-edit is disabled: the operation is documented as deprecated and answers 403.
	var selfEdit struct {
		Deprecated bool                       `json:"deprecated"`
		Responses  map[string]json.RawMessage `json:"responses"`
	}
	if err := json.Unmarshal(spec.Paths["/applications/{id}/profile"]["patch"], &selfEdit); err != nil {
		t.Fatalf("decode the self profile operation: %v", err)
	}
	if !selfEdit.Deprecated {
		t.Error("PATCH /applications/{id}/profile must be marked deprecated")
	}
	if _, ok := selfEdit.Responses["403"]; !ok {
		t.Error("PATCH /applications/{id}/profile must document its 403 response")
	}
	for _, code := range []string{"200", "400", "404", "409"} {
		if _, ok := selfEdit.Responses[code]; ok {
			t.Errorf("PATCH /applications/{id}/profile must not document a %s response any more", code)
		}
	}

	have := map[string]bool{}
	for _, s := range spec.Components.Schemas["ApplicationResponse"].Properties["status"].Enum {
		have[s] = true
	}
	for _, s := range []string{"PENDING", "PASSED", "RESERVE", "CONFIRMED", "REJECTED", "REFUND_PENDING", "REFUNDED"} {
		if !have[s] {
			t.Errorf("ApplicationResponse.status enum is missing %s", s)
		}
	}
	for _, name := range []string{"AdminProfileRequest", "WithdrawRequest"} {
		if _, ok := spec.Components.Schemas[name]; !ok {
			t.Errorf("schema %s is missing", name)
		}
	}

	other, err := os.ReadFile("../../docs/openapi.json")
	if err != nil {
		t.Fatalf("read backend/docs/openapi.json: %v", err)
	}
	if string(other) != string(OpenAPISpec) {
		t.Error("backend/docs/openapi.json and internal/docs/openapi.json differ")
	}
}
