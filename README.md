# ComCamp #25 — Web Application & API System

> **โครงการค่ายยุวชนคอมพิวเตอร์ ครั้งที่ 25 (ComCamp #25)**  
> **สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้**  
> **Repository:** [https://github.com/numcayX2/Comcamp-25th.git](https://github.com/numcayX2/Comcamp-25th.git)

---

## 📌 ภาพรวมโครงการ (Project Overview)

ระบบเว็บแอปพลิเคชันสำหรับงานค่าย **ComCamp ครั้งที่ 25** แบ่งออกเป็น 2 ส่วนหลัก:
1. **Frontend (`frontend/`):** พัฒนาด้วย Astro, React, Tailwind CSS และ Lucide Icons รองรับหน้าจอ Landing Page, Countdown Timer, ระบบส่งใบสมัคร, ตรวจสอบสถานะ และหน้าแดชบอร์ดพี่ค่าย
2. **Backend (`backend/`):** พัฒนาด้วย Go 1.22+ (Chi Router, pgxpool v5, JWT, Swagger UI) ออกแบบตาม Clean Architecture รองรับการประมวลผลสูง ป้องกันการโกงสลิป และเปิดให้ปรับแก้การตั้งค่าค่าย/โควตาได้แบบไดนามิก

---

## 🚀 โครงสร้างโปรเจกต์ (Repository Structure)

```text
Comcamp-25th/
├── backend/                  # Go Backend API Service
│   ├── cmd/api/main.go       # Entrypoint & Router
│   ├── internal/             # Domain, Service, Repository, Handler, Middleware
│   ├── migrations/           # Database Schema (PostgreSQL 16)
│   ├── internal/docs/        # OpenAPI 3.0 Specification
│   └── README.md             # คู่มือการพัฒนา Backend และ Swagger
├── frontend/                 # Astro + React + Tailwind Frontend
│   ├── src/                  # Components, Pages, Layouts
│   └── README.md             # คู่มือการพัฒนา Frontend
├── docker-compose.yml        # PostgreSQL 16 Service
├── .env.example              # ตัวอย่างตัวแปรสภาพแวดล้อม
└── README.md                 # เอกสารภาพรวมโครงการ
```

---

## ⚡ เริ่มต้นใช้งานอย่างรวดเร็ว (Quick Start)

### 1. ติดตั้งและเริ่มฐานข้อมูล (PostgreSQL 16)

```bash
# คัดลอก Environment Variables
cp .env.example .env

# เริ่มต้น Docker Container สำหรับ PostgreSQL
docker compose up -d db

# รัน Migration
Get-Content backend/migrations/000001_init_schema.up.sql -Raw | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
```

*(หมายเหตุ: หากไม่มี Docker ระบบ Backend มี Thread-Safe In-Memory Fallback ให้นักพัฒนา Front-end สามารถรันเซิร์ฟเวอร์ทดสอบได้ทันที)*

### 2. รัน Backend API Service

```bash
cd backend
go run ./cmd/api
```
- API Base URL: `http://localhost:8000/api`
- Interactive Swagger UI: `http://localhost:8000/swagger`
- OpenAPI JSON Spec: `http://localhost:8000/api/docs/openapi.json`

### 3. รัน Frontend

```bash
cd frontend
npm install
npm run dev
```
- Web Application: `http://localhost:4321`

---

## 🔑 บัญชีผู้ดูแลระบบ (Admin Accounts)

ระบบ **ไม่มีบัญชีหรือรหัสผ่านเริ่มต้น** ในโค้ด (AGENTS.md §13.7)

* **Production / PostgreSQL:** สร้างบัญชีด้วยคำสั่งด้านล่าง ระบบจะถามรหัสผ่าน (อย่างน้อย 12 ตัวอักษร) และเก็บเป็น bcrypt
  ```bash
  cd backend
  go run ./cmd/create-admin -username <ชื่อผู้ใช้> -name "<ชื่อที่แสดง>" -role superadmin
  ```
* **Development (In-Memory, ไม่มี PostgreSQL):** ตั้ง `DEV_ADMIN_USERNAME` และ `DEV_ADMIN_PASSWORD` ใน `.env` ของเครื่องตัวเอง (ไม่ถูกใช้ในโหมด production)

---

## 📋 แผนผัง API หลัก (Key Endpoints)

| Method | Endpoint | สิทธิ์การเข้าถึง | วัตถุประสงค์ |
|---|---|---|---|
| `GET` | `/api/health` | Public | ตรวจสอบสถานะของเซิร์ฟเวอร์ |
| `GET` | `/api/settings/public` | Public | ดึงกำหนดการและเวลาปัจจุบันเพื่อป้องกัน Clock Tampering |
| `POST` | `/api/applications` | Public | ส่งใบสมัครใหม่ (ล็อกโควตาตาม maxCapacity ค่าเริ่มต้น 30 ที่นั่ง แอดมินปรับได้ เต็มแล้วตอบ 409 QUOTA_FULL) |
| `GET` | `/api/applications/status?q={query}` | Public | ตรวจสอบสถานะใบสมัคร (ค้นหาด้วยเลขบัตร 13 หลัก, เบอร์โทร หรือรหัส) |
| `POST` | `/api/applications/:id/confirm` | Public | กดยืนยันสิทธิ์เข้าร่วมค่าย (สำหรับผู้ผ่านการคัดเลือก) |
| `POST` | `/api/applications/:id/slip` | Public | อัปโหลดสลิปโอนเงิน (ระบบตรวจจับสลิปซ้ำผ่าน SHA-256) |
| `POST` | `/api/auth/login` | Public | เข้าสู่ระบบผู้ดูแลเพื่อรับ JWT Token |
| `GET` | `/api/admin/applications` | Admin | รายชื่อผู้สมัครทั้งหมดและรูปสลิป |
| `PATCH` | `/api/admin/applications/:id` | Admin | ปรับสถานะผู้สมัคร (เช่น PASSED, RESERVE, REJECTED) |
| `PATCH` | `/api/admin/applications/:id/verify-slip` | Admin | ตรวจสอบและอนุมัติสลิปเพื่อปรับสถานะเป็น CONFIRMED |
| `GET` | `/api/admin/settings` | Admin | ดูการตั้งค่าค่าย โควตา และกำหนดการทั้งหมด |
| `PATCH` | `/api/admin/settings` | Admin | ปรับเปลี่ยนโควตารับสมัคร (maxCapacity), กำหนดการ หรือปิดรับสมัครฉุกเฉิน |

---

## 🧪 การทดสอบระบบ (Testing & Quality Assurance)

```bash
# Backend Automated Tests & Integration Suite
cd backend
go test -v ./...
```
- E2E Lifecycle Test Suite: ผ่านครบทุกขั้นตอน
- Repository Integration with PostgreSQL 16: ผ่านครบทุกขั้นตอน
- Unit Validation & Business Logic Tests: ผ่านครบ 100%
