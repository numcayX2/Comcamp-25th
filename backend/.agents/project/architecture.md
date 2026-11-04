# Architecture: ComCamp #25 Backend

## Layers & Responsibilities

1. **`cmd/api/main.go`**
   - Application entrypoint, environment configuration loading, HTTP router initialization, and graceful shutdown handling.

2. **`internal/domain/`**
   - Pure domain models (`Applicant`, `Payment`, `Admin`, `Settings`).
   - Domain status enums (`ApplicationStatus`, `PaymentStatus`, `AdminRole`).
   - Repository interfaces (`ApplicantRepository`, `PaymentRepository`, `AdminRepository`, `SettingRepository`).
   - Absolutely zero external dependencies or framework coupling.

3. **`internal/repository/`**
   - Database implementation layer interacting with PostgreSQL 16.
   - Handles transactions and queries with `pgx`/`database/sql`.

4. **`internal/service/`**
   - Business use cases:
     - Application submission with concurrency / quota limit checks (`max_capacity`).
     - Payment slip submission and anti-fraud duplication checks (`slip_hash`, `trans_ref`).
     - Admin verification and status transitions.

5. **`internal/handler/`**
   - HTTP transport controllers (JSON parsing, request validation, calling services, returning standardized responses).

6. **`internal/middleware/`**
   - CORS, Request Logger, Recoverer, and JWT Bearer Authentication.

7. **`migrations/`**
   - SQL migration files (`000001_init_schema.up.sql` and `down.sql`).
