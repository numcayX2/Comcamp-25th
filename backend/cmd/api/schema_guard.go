package main

import (
	"errors"
	"fmt"
)

// errSchemaBehind marks a database that still has applicants.national_id (migration 000011 not
// applied).
var errSchemaBehind = errors.New("applicants.national_id still exists: apply backend/migrations/000011_remove_national_id.up.sql before starting this build (see deploy/RUNBOOK.md, Phase 5 deploy)")

// checkSchemaForStartup turns the result of the national_id probe into a startup decision.
// fatal != nil means the server must not start; warning != "" is logged and startup continues.
// Production fails closed both when the column is present and when the schema cannot be checked:
// this build fails every POST /api/applications on the old schema (AGENTS.md P0).
func checkSchemaForStartup(columnPresent bool, probeErr error, production bool) (fatal error, warning string) {
	switch {
	case probeErr != nil && production:
		return fmt.Errorf("cannot verify the database schema (migration 000011): %w", probeErr), ""
	case probeErr != nil:
		return nil, fmt.Sprintf("WARNING: cannot verify the database schema (migration 000011): %v", probeErr)
	case columnPresent && production:
		return errSchemaBehind, ""
	case columnPresent:
		return nil, "WARNING: " + errSchemaBehind.Error() + " (development: continuing, but submits will fail)"
	default:
		return nil, ""
	}
}
