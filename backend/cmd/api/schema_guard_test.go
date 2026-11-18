package main

import (
	"errors"
	"testing"
)

func TestCheckSchemaForStartup(t *testing.T) {
	probe := errors.New("connection reset")
	cases := []struct {
		name        string
		present     bool
		err         error
		production  bool
		wantFatal   bool
		wantWarning bool
	}{
		{"migrated production", false, nil, true, false, false},
		{"migrated development", false, nil, false, false, false},
		{"old schema production refuses", true, nil, true, true, false},
		{"old schema development warns", true, nil, false, false, true},
		{"probe error production refuses", false, probe, true, true, false},
		{"probe error development warns", false, probe, false, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fatal, warning := checkSchemaForStartup(tc.present, tc.err, tc.production)
			if (fatal != nil) != tc.wantFatal {
				t.Fatalf("fatal = %v, want fatal %v", fatal, tc.wantFatal)
			}
			if (warning != "") != tc.wantWarning {
				t.Fatalf("warning = %q, want warning %v", warning, tc.wantWarning)
			}
		})
	}
	if fatal, _ := checkSchemaForStartup(true, nil, true); !errors.Is(fatal, errSchemaBehind) {
		t.Fatalf("old schema in production must return errSchemaBehind, got %v", fatal)
	}
}
