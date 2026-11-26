package docs

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
)

// The documented public list row must be exactly the PDPA allowlist the handler serves.
func TestOpenAPISpec_PublicApplicantsList(t *testing.T) {
	var spec struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]struct {
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(OpenAPISpec, &spec); err != nil {
		t.Fatalf("openapi.json is not valid JSON: %v", err)
	}
	if _, ok := spec.Paths["/applications/public"]["get"]; !ok {
		t.Fatal("spec is missing get /applications/public")
	}
	var props []string
	for k := range spec.Components.Schemas["PublicApplicant"].Properties {
		props = append(props, k)
	}
	sort.Strings(props)
	if got, want := strings.Join(props, ","), "fullName,no,prefix,province,school,status"; got != want {
		t.Fatalf("PublicApplicant properties = %s, want exactly %s", got, want)
	}
}
