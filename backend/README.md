# ComCamp #25 — Backend API Service & Frontend Integration Guide
> **ค่ายยุวชนคอมพิวเตอร์ ครั้งที่ 25 (ComCamp #25)**  
> สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้  
> **Repository:** [https://github.com/numcayX2/Comcamp-25th.git](https://github.com/numcayX2/Comcamp-25th.git)  
> **Base URL (Local Development):** `http://localhost:8000/api`  
> **Interactive Swagger UI:** [http://localhost:8000/swagger](http://localhost:8000/swagger) หรือ [http://localhost:8000/docs](http://localhost:8000/docs)  
> **OpenAPI 3.0 Spec:** [http://localhost:8000/api/docs/openapi.json](http://localhost:8000/api/docs/openapi.json)  

---

## 1. ข้อมูลสำคัญสำหรับทีม Front-end (Quick Start)

ทีม Front-end สามารถตั้งค่าไฟล์ `.env` ในโฟลเดอร์ `frontend/` เพื่อชี้มายัง Go Backend ได้ทันที:

```bash
PUBLIC_API_URL=http://localhost:8000/api
```

### การเปิดดูเอกสารและการทดสอบแบบ Interactive (Swagger UI)
เมื่อเปิดรัน Go Backend ให้เปิดเบราว์เซอร์ไปที่ **[http://localhost:8000/swagger](http://localhost:8000/swagger)**
* สามารถกดปุ่ม **"Try it out"** เพื่อทดลองยิง Request จริง ดูตัวอย่าง Response และ Schema ได้ทันที
* สำหรับ Endpoint ฝั่งแอดมิน: สามารถกดปุ่ม **"Authorize"** แล้วใส่ Bearer Token ที่ได้จาก `POST /api/auth/login`

---

## 2. แผนผังหน้าจอหน้าบ้าน กับ Backend API (Screen Mapping)

| หน้าจอใน Frontend | HTTP Method & Endpoint | วัตถุประสงค์ & หน้าที่ |
|---|---|---|
| **`/` (Countdown Hero)** | `GET /api/settings/public` | ซิงค์เวลา Server กับตัวนับถอยหลัง ป้องกัน Clock Tampering และเช็คว่าเปิดรับสมัครหรือยัง |
| **`/register` (ฟอร์มสมัคร)** | `POST /api/applications` | ส่งใบสมัครใหม่ (ตรวจเลขบัตร 13 หลัก, เบอร์ 10 หลัก; เปิดรับสมัครทุกคนในช่วงเวลาเพื่อรอคัดกรอง) |
| **`/status` (ตรวจสถานะ)** | `GET /api/applications/status?q={query}` | ค้นหาใบสมัครด้วยเลขบัตรประชาชน 13 หลัก, เบอร์โทร, หรือรหัสใบสมัคร (`CC25-xxxxxx`) |
| **`/status` (ยืนยันสิทธิ์)** | `POST /api/applications/:id/confirm` | กดยืนยันการเข้าร่วมค่าย (ทำได้เมื่อสถานะเป็น `PASSED` หรือ `CONFIRMED`) |
| **`/status` (แนบสลิป)** | `POST /api/applications/:id/slip` | อัปโหลดรูปภาพสลิปโอนเงิน (จำกัด 5MB พร้อมระบบตรวจจับสลิปซ้ำผ่าน SHA-256) |
| **`/admin` (เข้าสู่ระบบ)** | `POST /api/auth/login` | รับ JWT Bearer Token สำหรับเข้าใช้งานระบบหลังบ้าน |
| **`/admin` (รายชื่อผู้สมัคร)** | `GET /api/admin/applications` | ดึงรายชื่อผู้สมัครทั้งหมด พร้อมรูปสลิปและสถานะ (`Bearer <token>`) |
| **`/admin` (ปรับสถานะ)** | `PATCH /api/admin/applications/:id` | ประกาศผลผู้ผ่านการคัดเลือก เช่น ปรับเป็น `PASSED` หรือ `RESERVE` |
| **`/admin` (ตรวจสลิป)** | `PATCH /api/admin/applications/:id/verify-slip` | พี่ค่ายกดอนุมัติสลิปโอนเงิน เพื่อเปลี่ยนสถานะเป็น `CONFIRMED` สมบูรณ์ |
| **`/admin` (ดูการตั้งค่าค่าย)** | `GET /api/admin/settings` | ดึงข้อมูลกำหนดการ, โควตารับสมัคร (maxCapacity), ค่าค่าย และสถานะระบบ (`Bearer <token>`) |
| **`/admin` (ปรับแก้โควตา/เวลา)** | `PATCH /api/admin/settings` | แก้ไขโควตาจำนวนรับ (ยืดหยุ่นตามผู้สมัครจริง ไม่ Hardcode), วันเปิด-ปิดรับสมัคร, วันประกาศผล (`Bearer <token>`) |
| **Static Assets (ดูรูปสลิป)** | `GET /uploads/slips/{filename}` | หน้าบ้านสามารถดึงรูปภาพสลิปต้นฉบับขนาดเต็มมาแสดงผลให้พี่ค่ายดูด้วยตาเปล่าได้ |

---

## 3. สถาปัตยกรรมและโครงสร้างโฟลเดอร์ (Clean Architecture)

Backend พัฒนาด้วยภาษา **Go 1.22+** ออกแบบตามหลัก **Clean / Layered Architecture** และ **Standard Go Project Layout**:

```
backend/
├── cmd/
│   └── api/
│       └── main.go                 # Entrypoint: Setup Router, Config, Static Server, Graceful Shutdown
├── internal/
│   ├── config/                     # โหลด Environment Variables และสร้าง DSN
│   ├── domain/                     # Pure Business Entities, Status Enums, และ Repository Interfaces
│   │   ├── admin.go
│   │   ├── applicant.go
│   │   ├── payment.go
│   │   └── setting.go
│   ├── repository/                 # Data Access Layer
│   │   ├── db.go                   # pgxpool Connection Pool Configuration
│   │   ├── memory/                 # Thread-Safe In-Memory Driver (สำหรับ Test Suite / Zero-dependency Dev)
│   │   └── postgres/               # PostgreSQL 16 Driver (สำหรับ Production)
│   ├── service/                    # Business Logic Layer (Use Cases, Validation, Anti-Fraud, JWT)
│   ├── handler/                    # HTTP Controllers / Delivery Layer (REST Endpoints)
│   ├── middleware/                 # CORS, Logger, Panic Recoverer, JWT Auth Guard
│   ├── docs/                       # Embedded OpenAPI 3.0 Specification
│   └── pkg/
│       └── response/               # Standardized JSON Response Helper
├── migrations/                     # Database Migrations (PostgreSQL 16)
│   ├── 000001_init_schema.up.sql   # สร้าง Tables, Constraints, และ Indexes ทั้งหมด
│   └── 000001_init_schema.down.sql # Rollback Schema
├── go.mod
└── go.sum
```

---

## 4. วิธีการติดตั้งและรันระบบสำหรับนักพัฒนา (Developer Guide)

### 4.1 ความต้องการขั้นต่ำ (Prerequisites)
* **Go 1.22 ขึ้นไป**
* **Docker & Docker Compose** (สำหรับรัน PostgreSQL 16)

### 4.2 เริ่มต้นฐานข้อมูล PostgreSQL
จากโฟลเดอร์หลักของโปรเจกต์ (`Comcamp-25th/`):
```bash
# 1. คัดลอกไฟล์ Environment Variables
cp .env.example .env

# 2. เริ่มต้นฐานข้อมูล PostgreSQL 16 ผ่าน Docker
docker compose up -d db

# 3. รันสคริปต์ Migration เพื่อสร้าง Tables
Get-Content backend/migrations/000001_init_schema.up.sql -Raw | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
```

*(หมายเหตุ: หากไม่มี Docker หรือฐานข้อมูลยังไม่พร้อม Go Backend จะสลับมารันโหมด In-Memory อัตโนมัติ ทำให้ทีม Front-end สามารถรันเซิร์ฟเวอร์เพื่อพัฒนาหน้าเว็บได้ทันทีโดยไม่ติดขัด)*

### 4.3 เริ่มต้นเซิร์ฟเวอร์ Go Backend
```bash
cd backend
go run ./cmd/api
```
เมื่อเซิร์ฟเวอร์เริ่มทำงาน จะแสดงข้อความ:
```text
ComCamp 25 Backend API running on port :8000
Swagger UI documentation available at: http://localhost:8000/swagger
```

### 4.4 ข้อมูลเข้าสู่ระบบเริ่มต้นสำหรับแอดมิน (Default Admin Credentials)
* **Username:** `admin`
* **Password:** `strong_password` (หรือ `admin123` ในโหมดทดสอบ)

---

## 5. ระบบตรวจสอบสลิปและป้องกันการโกง (Payment & Anti-Fraud Architecture)

ระบบการเงินถูกออกแบบเป็น **Hybrid Architecture** รองรับทั้งการตรวจสอบด้วยคนและการต่อ API อัตโนมัติในอนาคต:

1. **การจัดเก็บไฟล์จริง (File Persistence):**
   * ไฟล์รูปภาพสลิปทุกใบจะถูกบันทึกจริงลงในดิสก์ที่ `uploads/slips/{รหัสใบสมัคร}-{timestamp}.jpg`
   * ไม่สูญหาย และเปิดให้หน้าบ้านแอดมินดึงไปเปิดดูผ่าน `GET /uploads/slips/...` ได้ทันที
2. **ระบบตรวจจับสลิปซ้ำขั้นต้น (Built-in Anti-Fraud):**
   * คำนวณ **SHA-256 Hash ของ Binary รูปภาพ** ลงคอลัมน์ `slip_hash` (CHAR 64)
   * หากมีการนำภาพสลิปเดิมมาอัปโหลดซ้ำ ระบบจะปฏิเสธด้วย `HTTP 409 Conflict: this slip has already been uploaded`
3. **ความพร้อมสำหรับต่อ 3rd-party Slip Verification API:**
   * ตาราง `payments` มีคอลัมน์ `trans_ref VARCHAR(100) UNIQUE` และ `transfer_at TIMESTAMPTZ` เตรียมไว้แล้ว
   * เมื่อมี API Key ของ **SlipOK** หรือ **EasySlip** สามารถนำ Client มาเสียบเข้าที่ `internal/service/payment_service.go` เพื่ออ่าน QR Code จากสลิปและอนุมัติสิทธิ์อัตโนมัติได้ทันทีโดยไม่ต้องแก้ Database Schema

---

## 6. การทดสอบและการวัดประสิทธิภาพ (Testing & Benchmarks)

รันชุดทดสอบทั้งหมดทั้ง **Unit Tests, E2E HTTP API Tests, และ Real Database Integration Tests**:

```bash
cd backend
go test -v ./...
```

### ผลการวัดประสิทธิภาพ (Benchmarks):
* **การส่งใบสมัคร (`SubmitApplication`):** ~238,000 ops/sec (เฉลี่ยเพียง **6.4 ไมโครวินาทีต่อใบสมัคร**)
* **การค้นหาสถานะ (`QueryStatus`):** ~1,000,000 ops/sec (เฉลี่ยเพียง **1.05 ไมโครวินาทีต่อครั้ง**)
* **Test Suite:** ผ่านครบ **100% (26 Test Cases)**
