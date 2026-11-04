# Project Context: ComCamp #25 Backend API Service

## Overview
- **Project:** ComCamp #25 Backend API Service (สาขาวิชาวิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้)
- **Module Name:** `comcamp25-backend`
- **Go Version:** Go 1.22+ (Running go1.27.3)
- **Database:** PostgreSQL 16 (Alpine via Docker Compose, port 5432)
- **HTTP Routing:** `github.com/go-chi/chi/v5`
- **Architecture Pattern:** Clean / Layered Architecture (`cmd/`, `internal/domain`, `internal/repository`, `internal/service`, `internal/handler`, `internal/middleware`, `migrations/`)

## Key Contracts & Policies
- **TDD Requirement:** All handlers, services, and repositories must include unit tests (`go test -v ./...`).
- **Data Integrity:** Strict constraints on unique keys (`national_id`, `email`, `phone`, `trans_ref`).
- **Timezone Standard:** Strict use of `timestamptz` in PostgreSQL and UTC/Asia/Bangkok handling via Go `time.Time`.
- **Git Policy:** `ask` (Require user confirmation before committing changes).
