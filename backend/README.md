# ComCamp 25 — Backend API Service

Backend service for the **ComCamp 25 (25th Computer Science Camp, Maejo University)** registration and management platform.

## Architecture Overview

- **Database:** PostgreSQL 16 (`postgres:16-alpine`) bound strictly to `127.0.0.1:5432` via Docker Compose.
- **API Base URL (Development):** `http://localhost:8000/api`
- **Authentication:** JWT-based authentication (`JWT_SECRET`).

## Local Development Database

From the repository root (`e:\Code_projects\Comcamp-site`), copy `.env.example` to `.env` and start the PostgreSQL container:

```bash
cp .env.example .env
docker compose up -d db
```
