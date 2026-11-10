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
| **`/register` (ฟอร์มสมัคร)** | `POST /api/applications` | ส่งใบสมัครใหม่ (ตรวจเลขบัตร 13 หลัก, เบอร์ 10 หลัก, คุมโควตาตาม `maxCapacity` ค่าเริ่มต้น 30 ที่นั่ง แอดมินปรับได้ที่ `PATCH /api/admin/settings`) |
| **`/status` (ตรวจสถานะ)** | `GET /api/applications/status?q={query}` | ค้นหาใบสมัครด้วยเลขบัตรประชาชน 13 หลัก, เบอร์โทร, หรือรหัสใบสมัคร (`CC25-xxxxxx`) |
| **`/status` (ยืนยันสิทธิ์)** | `POST /api/applications/:id/confirm` | กดยืนยันการเข้าร่วมค่าย (ทำได้เมื่อสถานะเป็น `PASSED` หรือ `CONFIRMED`) body `{ "confirmed": true, "verifyCode": "<เลข 4 ตัวท้ายบัตรประชาชน>" }` |
| **`/status` (แนบสลิป)** | `POST /api/applications/:id/slip` | อัปโหลดรูปภาพสลิปโอนเงิน (multipart: `verifyCode` + `slip`, จำกัด 5MB และ 4096×4096 px พร้อมระบบตรวจจับสลิปซ้ำผ่าน SHA-256) |
| **`/admin` (เข้าสู่ระบบ)** | `POST /api/auth/login` | รับ JWT Bearer Token สำหรับเข้าใช้งานระบบหลังบ้าน |
| **`/admin` (รายชื่อผู้สมัคร)** | `GET /api/admin/applications` | ดึงรายชื่อผู้สมัครทั้งหมดแบบข้อมูลเต็ม พร้อมสถานะสลิป (`Bearer <token>`) |
| **`/admin` (ปรับสถานะ)** | `PATCH /api/admin/applications/:id` | ประกาศผลผู้ผ่านการคัดเลือก เช่น ปรับเป็น `PASSED` หรือ `RESERVE` |
| **`/admin` (ตรวจสลิป)** | `PATCH /api/admin/applications/:id/verify-slip` | พี่ค่ายกดอนุมัติสลิปโอนเงิน เพื่อเปลี่ยนสถานะเป็น `CONFIRMED` สมบูรณ์ |
| **`/admin` (ดูรูปสลิป)** | `GET /api/admin/applications/:id/slip` | ส่งรูปสลิปล่าสุดให้พี่ค่ายที่ login แล้วเท่านั้น (`Bearer <token>`) หน้าบ้านโหลดเป็น blob ไม่มี URL สาธารณะของสลิป |
| **`/admin` (ดูการตั้งค่าค่าย)** | `GET /api/admin/settings` | ดึงข้อมูลกำหนดการ, โควตารับสมัคร (maxCapacity), ค่าค่าย และสถานะระบบ (`Bearer <token>`) |
| **`/admin` (ปรับแก้โควตา/เวลา)** | `PATCH /api/admin/settings` | แก้ไขโควตาจำนวนรับ (`maxCapacity` ค่าเริ่มต้น 30 ระบบปฏิเสธใบสมัครเมื่อเต็ม `409 QUOTA_FULL`), วันเปิด-ปิดรับสมัคร, วันประกาศผล (`Bearer <token>`) |

---

## 3. สถาปัตยกรรมและโครงสร้างโฟลเดอร์ (Clean Architecture)

Backend พัฒนาด้วยภาษา **Go 1.22+** ออกแบบตามหลัก **Clean / Layered Architecture** และ **Standard Go Project Layout**:

```
backend/
├── cmd/
│   └── api/
│   │   └── main.go                 # Entrypoint: Config (fail closed), Repositories, Graceful Shutdown
│   └── create-admin/
│       └── main.go                 # สร้าง/รีเซ็ตบัญชีพี่ค่าย (bcrypt)
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
│   ├── middleware/                 # CORS, Client IP, Rate Limit, Body Limit, Access Log, JWT Auth Guard
│   ├── server/                     # Router + security middleware chain (ใช้ทั้ง main และ E2E tests)
│   ├── docs/                       # Embedded OpenAPI 3.0 Specification
│   └── pkg/
│       └── response/               # Standardized JSON Response Helper
├── migrations/                     # Database Migrations (PostgreSQL 16)
│   ├── 000001_init_schema.up.sql   # สร้าง Tables, Constraints, และ Indexes ทั้งหมด
│   ├── 000001_init_schema.down.sql # Rollback Schema
│   ├── 000002_security_hardening.up.sql   # audit_logs, idempotency_key, unique slip_hash
│   ├── 000002_security_hardening.down.sql
│   ├── 000003_soft_delete_identity.up.sql # national ID / phone / email unique among live rows only
│   └── 000003_soft_delete_identity.down.sql
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

# 3. รันสคริปต์ Migration ตามลำดับ (ต้องรัน 000002 ด้วย ไม่อย่างนั้น API จะ query ไม่ผ่าน)
Get-Content backend/migrations/000001_init_schema.up.sql -Raw | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
Get-Content backend/migrations/000002_security_hardening.up.sql -Raw | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
```

> **ย้ายจาก compose เวอร์ชันเก่า:** ไฟล์เดิม mount volume ไว้ที่ `/var/lib/pgsql/data` ซึ่งไม่ใช่ที่เก็บข้อมูลของ `postgres:16-alpine` ข้อมูลจึงไปอยู่ใน anonymous volume ตอนนี้แก้เป็น `/var/lib/postgresql/data` แล้ว ครั้งแรกที่ `docker compose up` จะได้ฐานข้อมูลว่าง ถ้ามีข้อมูลที่ต้องเก็บ ให้ `pg_dump` ออกมาก่อนอัปเดต แล้ว restore กลับ

*(หมายเหตุ: โหมด In-Memory ใช้ได้เฉพาะ `APP_ENV=development` เมื่อฐานข้อมูลยังไม่พร้อม ข้อมูลจะหายเมื่อรีสตาร์ต ใน `production` ถ้าต่อฐานข้อมูลไม่ได้ เซิร์ฟเวอร์จะไม่เริ่มทำงาน)*

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

### 4.4 บัญชีแอดมิน (ไม่มีรหัสผ่านเริ่มต้น)
* **PostgreSQL (dev/production):** สร้างบัญชีด้วยคำสั่งด้านล่าง ระบบรับรหัสผ่านทาง stdin หรือ `ADMIN_PASSWORD` และ hash ด้วย bcrypt
  ```bash
  cd backend
  go run ./cmd/create-admin -username pee_somchai -name "พี่สมชาย" -role superadmin
  ```
  รันซ้ำด้วยชื่อเดิมเพื่อรีเซ็ตรหัสผ่าน หากต้องการระงับบัญชี ให้ใช้ `UPDATE admins SET is_active = false WHERE username = '...'` บัญชีที่ถูกระงับจะใช้ token เดิมไม่ได้ทันที
* **In-Memory (`APP_ENV=development` และยังไม่มีฐานข้อมูล):** ตั้ง `DEV_ADMIN_PASSWORD` ใน `.env` แล้ว login ด้วย `DEV_ADMIN_USERNAME` (ค่าเริ่มต้น `admin`) ถ้าตั้งตัวแปรนี้ใน production เซิร์ฟเวอร์จะไม่ยอมเริ่ม

---

## 5. ระบบตรวจสอบสลิปและป้องกันการโกง (Payment & Anti-Fraud Architecture)

ระบบการเงินถูกออกแบบเป็น **Hybrid Architecture** รองรับทั้งการตรวจสอบด้วยคนและการต่อ API อัตโนมัติในอนาคต:

1. **การจัดเก็บไฟล์จริง (File Persistence):**
   * ไฟล์รูปภาพสลิปทุกใบจะถูกบันทึกจริงลงในดิสก์ที่ `uploads/slips/{รหัสใบสมัคร}-{uuid}.{jpg|png|webp}` (สิทธิ์ `0600`) ฐานข้อมูลเก็บเฉพาะ path
   * ไม่มี URL สาธารณะ แอดมินเปิดดูผ่าน `GET /api/admin/applications/:id/slip` (ต้องมี token และถูกบันทึกใน audit log)
2. **ระบบตรวจจับสลิปซ้ำขั้นต้น (Built-in Anti-Fraud):**
   * คำนวณ **SHA-256 Hash ของ Binary รูปภาพ** ลงคอลัมน์ `slip_hash` (CHAR 64)
   * หากมีการนำภาพสลิปเดิมมาอัปโหลดซ้ำ ระบบจะปฏิเสธด้วย `HTTP 409 Conflict: this slip has already been uploaded` และมี unique index ที่ฐานข้อมูลกันกรณีอัปโหลดพร้อมกัน
3. **ความพร้อมสำหรับต่อ 3rd-party Slip Verification API:**
   * ตาราง `payments` มีคอลัมน์ `trans_ref VARCHAR(100) UNIQUE` และ `transfer_at TIMESTAMPTZ` เตรียมไว้แล้ว
   * เมื่อมี API Key ของ **SlipOK** หรือ **EasySlip** สามารถนำ Client มาเสียบเข้าที่ `internal/service/payment_service.go` เพื่ออ่าน QR Code จากสลิปและอนุมัติสิทธิ์อัตโนมัติได้ทันทีโดยไม่ต้องแก้ Database Schema

---

## 6. การทดสอบและการวัดประสิทธิภาพ (Testing & Benchmarks)

รันชุดทดสอบทั้งหมดทั้ง **Unit Tests, E2E HTTP API Tests, และ Real Database Integration Tests**:

```bash
cd backend
go test ./...

# Integration tests กับ PostgreSQL จริง (ต้องรัน migration 000001 + 000002 แล้ว) จะ skip ถ้าไม่ได้ตั้งตัวแปรนี้
TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=... dbname=comcamp_db sslmode=disable" go test ./internal/repository/postgres/
```

Security regression tests อยู่ที่ `internal/handler/security_test.go` (ทดสอบผ่าน router จริงของ production)

### ผลการวัดประสิทธิภาพ (Benchmarks):
* **การส่งใบสมัคร (`SubmitApplication`):** ~238,000 ops/sec (เฉลี่ยเพียง **6.4 ไมโครวินาทีต่อใบสมัคร**)
* **การค้นหาสถานะ (`QueryStatus`):** ~1,000,000 ops/sec (เฉลี่ยเพียง **1.05 ไมโครวินาทีต่อครั้ง**)

---

## 7. ความปลอดภัย (Security, AGENTS.md §13)

| หัวข้อ | สิ่งที่ระบบทำ |
|---|---|
| **Fail closed** | `APP_ENV` ค่าเริ่มต้นคือ `production`: ถ้าไม่มี `JWT_SECRET` (≥ 32 ตัว), `DB_PASSWORD`, `FRONTEND_URL` หรือยังใช้ค่า `change_this…` จาก `.env.example` เซิร์ฟเวอร์จะไม่ยอมเริ่ม และถ้าต่อ PostgreSQL ไม่ได้จะหยุดทันที (ไม่สลับไป In-Memory ที่ข้อมูลหายเมื่อรีสตาร์ต) |
| **ไม่มีรหัสผ่าน/Secret ในโค้ด** | ไม่มี fallback secret และไม่มีบัญชีแอดมินเริ่มต้น สร้างบัญชีด้วย `cmd/create-admin` (bcrypt cost 12) |
| **สลิปไม่เปิดสาธารณะ** | ไม่มี `/uploads` แบบ static แล้ว ไฟล์ชื่อสุ่ม สิทธิ์ `0600` เปิดดูได้เฉพาะ `GET /api/admin/applications/:id/slip` (ต้องมี token และถูกบันทึกใน audit log) |
| **จำกัดขนาด Request** | สลิปสูงสุด 5 MB ถูกตัดระหว่างอ่าน (`http.MaxBytesReader`) ไม่โหลดทั้งก้อนเข้า RAM, JSON สูงสุด 64 KB → `413` |
| **ตรวจไฟล์จาก Magic Bytes** | รับเฉพาะ JPEG / PNG / WebP ไม่สนนามสกุลจากผู้ใช้ |
| **กัน Image Bomb** | อ่านเฉพาะ header ของภาพ (`image.DecodeConfig` สำหรับ JPEG/PNG, parser RIFF `VP8 `/`VP8L`/`VP8X` สำหรับ WebP ไม่ใช้ cgo) กว้างหรือสูงเกิน 4096 px → `400 INVALID_IMAGE_DIMENSIONS` ก่อนคำนวณ hash หรือเขียนดิสก์ |
| **เขียนไฟล์สองจังหวะ** | เขียนไฟล์ + `Sync()` ให้เสร็จก่อนบันทึกแถว `payments` ถ้าบันทึกฐานข้อมูลไม่สำเร็จจะ `os.Remove()` ไฟล์ทิ้งทันที |
| **ยืนยันตัวตนที่ `/status`** | `POST /:id/confirm` (JSON `verifyCode`) และ `POST /:id/slip` (multipart `verifyCode`) ต้องส่งเลข 4 ตัวท้ายของบัตรประชาชน ไม่ส่ง → `400`, ไม่ตรง → `403 INVALID_VERIFY_CODE` ไม่รับเลขท้ายเบอร์โทร เพราะหน้าสถานะแสดงเลขนั้นอยู่แล้ว |
| **ทำความสะอาดข้อมูลที่ก๊อปจากแชต** | ตัดอักขระล่องหน (U+200B–U+200D, U+2060, U+FEFF) ขีดคั่น และช่องว่างออกจากเลขบัตร/เบอร์ทั้งตอนสมัครและตอนค้นสถานะ รหัสใบสมัครพิมพ์ตัวเล็กหรือไม่มีขีดก็ค้นเจอ |
| **สลิปซ้ำ** | SHA-256 + unique index `uq_payments_slip_hash` (กันกรณีอัปโหลดพร้อมกัน) → `409 DUPLICATE_SLIP` |
| **โควตา 30 ที่นั่ง** | นับและบันทึกใน transaction เดียวกับ `pg_advisory_xact_lock` ช่วงคนแห่สมัครตอนเที่ยงคืนจึงไม่เกินโควตา รอ lock ได้ไม่เกิน `lock_timeout = '3s'` ถ้าเกินตอบ `503` + `Retry-After` (ยังไม่บันทึก ส่งซ้ำด้วย key เดิมได้) Connection pool: สูงสุด 40, เปิดค้างไว้ 20 |
| **อนุมัติสลิปชนกัน** | `SELECT … FOR UPDATE` + `UPDATE … WHERE status = 'PENDING'` ตรวจ `RowsAffected() == 1` พี่ค่ายสองคนกดพร้อมกัน สำเร็จได้คนเดียว อีกคนได้ `409 ALREADY_VERIFIED` |
| **Idempotency** | `X-Idempotency-Key` (UUID) ส่งซ้ำได้ปลอดภัย: ครั้งแรก `201`, ส่งซ้ำได้ `200` + `Idempotent-Replayed: true` |
| **Masking** | `/applications/status`, `/confirm` และผลการสมัคร ส่งเลขบัตร `1-5099-XXXXX-XX-X`, เบอร์ `XXX-XXX-5678`, อีเมล `s***@…` เท่านั้น ข้อมูลเต็มอยู่ใน `/api/admin/*` |
| **บัญชีแอดมิน** | ตรวจ `is_active` ทุก request (ระงับบัญชีแล้ว token ใช้ไม่ได้ทันที), token อายุ 8 ชม., login ผิดทุกกรณีตอบข้อความเดียวกัน |
| **Rate limit (ต่อ IP)** | login 10 ครั้ง/5 นาที, ค้นสถานะ 60/นาที, ส่งใบสมัคร 20/นาที, ยืนยันสิทธิ์/อัปโหลดสลิป 20/นาที → `429` + `Retry-After` |
| **IP จริงของผู้ใช้** | เชื่อ `X-Forwarded-For` เฉพาะจาก `TRUSTED_PROXIES` เท่านั้น (ปลอม IP เพื่อหลบ rate limit หรือ audit log ไม่ได้) |
| **Audit log** | ตาราง `audit_logs` (`admin_id`, `action`, `details`, `ip_address`, `created_at`) บันทึกใน transaction เดียวกับการเปลี่ยนสถานะ/อนุมัติสลิป รวมถึง login สำเร็จ/ล้มเหลว และการเปิดดูสลิป |
| **Log ไม่มีข้อมูลส่วนบุคคล** | access log ไม่บันทึก query string (`?q=` อาจเป็นเลขบัตรประชาชน) และ error ภายในตอบ `500 internal server error` เท่านั้น |
| **Header** | `/api/*` ส่ง `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, CSP; CORS อนุญาตเฉพาะ `FRONTEND_URL` |

### Environment Variables สำหรับ Production

```dotenv
APP_ENV=production
JWT_SECRET=<openssl rand -hex 32>
DB_PASSWORD=<รหัสผ่านจริง>
FRONTEND_URL=https://<โดเมนเว็บไซต์>
TRUSTED_PROXIES=127.0.0.1        # ถ้ามี nginx/Caddy อยู่หน้า API บนเครื่องเดียวกัน
```

ตั้ง HTTPS และ `Strict-Transport-Security` ที่ reverse proxy และให้ Go API ฟังเฉพาะ loopback/network ภายในหลัง proxy
