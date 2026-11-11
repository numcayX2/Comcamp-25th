# คู่มือให้ Agentic AI ช่วย Set up และทดสอบโปรเจกต์ (AI Setup & QA Playbook)

ไฟล์นี้ออกแบบมาให้ **รุ่นพี่ที่โคลนโปรเจกต์ไปใหม่** ใช้สั่ง **Agentic AI** (เช่น **Claude Code, Antigravity, Codex, Cursor, Gemini CLI, Hermes**) ให้ติดตั้ง ตั้งค่า `.env` เปิดเซิร์ฟเวอร์ และทดสอบระบบให้จนพร้อมใช้งาน

---

## 1. สำหรับรุ่นพี่: ก๊อปปี้คำสั่งด้านล่างไปสั่ง AI ได้เลย

เปิดโฟลเดอร์โปรเจกต์ในเครื่องมือ AI ของคุณ แล้วเลือกส่ง 1 คำสั่งตามต้องการ:

### แบบที่ A — รันไว ไม่ต้องลง/เปิด Docker (แนะนำสำหรับตรวจหน้าเว็บ, แกลเลอรี, Turnstile, Flow รับสมัคร)
> อ่าน `AI_SETUP.md` แล้วช่วยเซตอัพโปรเจกต์แบบ **โหมด A (In-Memory ไม่ใช้ Docker)** พร้อมเปิดใช้ Cloudflare Turnstile ด้วย Dummy Test Keys (always-pass) จาก `.env.example` จากนั้นรันการทดสอบ สตาร์ต Backend (`:8000`) และ Frontend (`:4321`) แล้วสรุป URL กับรหัสเข้า `/admin` ให้หน่อย

### แบบที่ B — รันเต็มระบบพร้อม PostgreSQL 16 (ต้องมี Docker)
> อ่าน `AI_SETUP.md` แล้วช่วยเซตอัพโปรเจกต์แบบ **โหมด B (Docker PostgreSQL 16)** รัน migration ครบทุกไฟล์ สร้างบัญชี `/admin` เปิดใช้ Cloudflare Turnstile ด้วย Dummy Test Keys รัน Go tests รวม Postgres integration tests และเปิด Backend/Frontend ให้พร้อมทดสอบครบวงจร

### แบบที่ C — สั่งให้ AI ช่วยตรวจสอบหลังเปิดเว็บแล้ว (QA / E2E Check)
> อ่าน `AI_SETUP.md` แล้วตรวจเช็กการทำงานจริงตั้งแต่หน้า `/` (Countdown และแกลเลอรี `#gallery` จาก `workers.dev`), Flow สมัคร `/register` พร้อม Turnstile, `/status` อัปสลิป, และ `/admin` อนุมัติสลิป โดยห้ามแก้โค้ดหรือ commit `.env`

---

## 2. Playbook สำหรับ Agentic AI (ปฏิบัติตามขั้นตอนนี้เมื่อได้รับคำสั่ง)

> **กฎเหล็ก (Guardrails):**
> - **ห้าม** commit หรือเพิ่ม `.env`, `frontend/.env`, หรือไฟล์ใน `backend/uploads/` เข้า Git และห้ามใส่ secret จริงลงใน `.env.example` หรือเอกสารใดๆ
> - **อย่า** แก้ไขซอร์สโค้ดของโปรเจกต์ระหว่างเซตอัพ ยกเว้นผู้ใช้ร้องขอให้แก้บั๊ก
> - โปรเจกต์นี้ตั้งค่า fallback ใน [`frontend/astro.config.mjs`](frontend/astro.config.mjs) ให้ดึงตัวแปร `PUBLIC_*` จาก `.env` ที่ root อัตโนมัติแล้ว จึง **ไม่จำเป็นต้องสร้าง `frontend/.env` แยก** (หากมี `frontend/.env` อยู่ก่อน ค่าใน `frontend/.env` จะถูกใช้ก่อน)
> - หมายเหตุ: `AGENTS.md` ถูกยกเว้นใน `.gitignore` และไม่ได้รวมอยู่ใน public repo ให้ยึดคู่มือในไฟล์นี้, [`README.md`](README.md), [`backend/README.md`](backend/README.md) และ [`ComCamp.md`](ComCamp.md) เป็นหลัก

### ขั้นที่ 1: ตรวจสอบเครื่องมือที่ต้องใช้ (Prerequisites)
1. ตรวจ `node -v` — ต้องเป็น **`>= 22.23.4`** (ตาม `frontend/package.json`)
2. ตรวจ `go version` — ต้องเป็น **Go 1.22+** (โมดูลปัจจุบันใช้ `go 1.27.3` ใน `backend/go.mod`)
3. ตรวจ `docker --version` และ `docker compose version` (จำเป็นเฉพาะ **โหมด B**; หากไม่มี Docker หรือไม่ได้ขอโหมด B ให้ใช้ **โหมด A**)
4. หาก `node_modules` ยังไม่มี ให้ติดตั้งใน `frontend/`:
   ```bash
   cd frontend
   npm install
   ```

### ขั้นที่ 2: สร้างและตั้งค่า `.env` ที่ root ของโปรเจกต์
คัดลอก `.env.example` เป็น `.env` (ถ้ายังไม่มี) แล้วตั้งค่าตามโหมดที่เลือก:

#### ค่าเริ่มต้นที่ใช้ร่วมกันใน `.env` (โหมดทดสอบบนเครื่อง)
- `APP_ENV=development`
- `FRONTEND_URL=http://localhost:4321`
- `PUBLIC_API_URL=http://localhost:8000/api`
- `PUBLIC_GALLERY_BASE_URL=https://comcamp25-gallery.sokulshop5.workers.dev/`
- `JWT_SECRET`: สร้างสตริงสุ่มความยาวอย่างน้อย 32 ตัวอักษร (ห้ามใช้ค่า `change_this...`)
- **Cloudflare Turnstile (สำหรับทดสอบ `/register` ขั้นตอนที่ 5):**
  - ถ้าผู้ใช้ต้องการเห็น/เทสต์ Widget Turnstile (ต้องมีอินเทอร์เน็ตเข้าถึง `challenges.cloudflare.com`): ใช้ **Cloudflare Dummy Keys** จากท้าย `.env.example`:
    ```env
    PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
    TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
    ```
    *(เคส always-fail สำหรับทดสอบ error ใช้ site key `2x00000000000000000000AB` หรือ secret `2x0000000000000000000000000000000AA`)*
  - ถ้าออฟไลน์หรืออยากข้าม Turnstile: เว้น `PUBLIC_TURNSTILE_SITE_KEY=` และ `TURNSTILE_SECRET_KEY=` ว่างไว้ (ในโหมด `development` ระบบจะข้ามให้พร้อมขึ้นป้าย `[DEV]`)

#### ตั้งค่าเพิ่มเติมเฉพาะ **โหมด A (In-Memory ไม่มี Docker)**
- ตั้ง `DEV_ADMIN_USERNAME=admin`
- ตั้ง `DEV_ADMIN_PASSWORD=<รหัสผ่านทดสอบที่จำง่ายและแจ้งผู้ใช้ตอนจบ>` (**จำเป็นต้องตั้ง** เพราะถ้าเว้นว่าง API จะไม่ seed บัญชีแอดมินสำหรับล็อกอิน `/admin`)
- `DB_PASSWORD` จะปล่อยไว้หรือเว้นว่างก็ได้ เพราะใน `APP_ENV=development` เมื่อต่อ PostgreSQL ไม่สำเร็จ Backend จะสลับไปใช้ In-Memory repository ให้อัตโนมัติ (ข้อมูลจะรีเซ็ตเมื่อปิดเซิร์ฟเวอร์)

#### ตั้งค่าเพิ่มเติมเฉพาะ **โหมด B (Docker PostgreSQL 16)**
1. ตั้ง `DB_USER=comcamp`, `DB_NAME=comcamp_db`, `DB_HOST=127.0.0.1`, `DB_PORT=5432` และตั้ง `DB_PASSWORD` เป็นรหัสผ่านจริง (ห้ามใช้ `change_this...` มิฉะนั้นบางการตั้งค่าจะไม่ผ่าน validation)
2. ลบหรือเว้นว่าง `DEV_ADMIN_PASSWORD=`
3. สตาร์ต PostgreSQL และรอให้พร้อม:
   ```bash
   docker compose up -d db
   docker exec comcamp_db pg_isready -U comcamp -d comcamp_db
   ```
4. รัน SQL migrations ตามลำดับครบทุกไฟล์ (`000001` ถึง `000004`):
   - **PowerShell (Windows):**
     ```powershell
     Get-ChildItem backend/migrations/*.up.sql | Sort-Object Name | ForEach-Object { Get-Content $_.FullName -Raw } | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
     ```
   - **Bash (macOS / Linux):**
     ```bash
     cat backend/migrations/*.up.sql | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
     ```
5. สร้างบัญชีแอดมินลง PostgreSQL (รหัสผ่านต้องมี 12–72 ตัวอักษร, ส่งผ่าน `ADMIN_PASSWORD` ได้เลย):
   - **PowerShell:**
     ```powershell
     cd backend
     $env:ADMIN_PASSWORD="<ตั้งรหัสผ่านอย่างน้อย12ตัว>"
     go run ./cmd/create-admin -username admin -name "Staff Admin" -role superadmin
     Remove-Item Env:ADMIN_PASSWORD
     ```
   - **Bash:**
     ```bash
     cd backend
     ADMIN_PASSWORD="<ตั้งรหัสผ่านอย่างน้อย12ตัว>" go run ./cmd/create-admin -username admin -name "Staff Admin" -role superadmin
     ```

### ขั้นที่ 3: รันการตรวจสอบอัตโนมัติ (Build & Tests)
1. **Frontend Build Check:**
   ```bash
   cd frontend
   npm run build
   ```
   ต้องผ่านและ build ครบ 4 routes (`/`, `/register`, `/status`, `/admin`) โดยไม่มี error
2. **Backend Go Vet & Test Suite:**
   ```bash
   cd backend
   go vet ./...
   go test -count=1 ./...
   ```
   - ใน **โหมด B** ให้รัน Integration Tests กับ PostgreSQL จริงเพิ่มเติมด้วย (ใช้ `DB_PASSWORD` เดียวกับใน `.env`):
     - **PowerShell:**
       ```powershell
       cd backend
       $env:TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=<DB_PASSWORD> dbname=comcamp_db sslmode=disable"
       go test -v -count=1 ./internal/repository/postgres/
       Remove-Item Env:TEST_DATABASE_DSN
       ```
     - **Bash:**
       ```bash
       cd backend
       TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=<DB_PASSWORD> dbname=comcamp_db sslmode=disable" go test -v -count=1 ./internal/repository/postgres/
       ```

### ขั้นที่ 4: เปิดเซิร์ฟเวอร์ Backend และ Frontend
รันแยก 2 โปรเซส/เทอร์มินัล (หากแก้ `.env` ภายหลัง ให้รีสตาร์ตทั้งคู่เพื่อให้ค่า `PUBLIC_*` และ `TURNSTILE_SECRET_KEY` อัปเดต):
1. **Backend (`:8000`):**
   ```bash
   cd backend
   go run ./cmd/api
   ```
   - ตรวจ `GET http://localhost:8000/api/health` ต้องได้ HTTP `200`
   - ตรวจ log ตอนเริ่มรันเพื่อยืนยันสถานะ DB (In-Memory vs PostgreSQL) และ Turnstile (`Cloudflare Turnstile verification is ON`)
2. **Frontend (`:4321`):**
   ```bash
   cd frontend
   npm run dev
   ```
   - ตรวจ `http://localhost:4321` ต้องเปิดได้ HTTP `200`

### ขั้นที่ 5: รายการตรวจเช็กหน้าเว็บและ Flow หลัก (Smoke QA Checklist)
เมื่อเซิร์ฟเวอร์เปิดแล้ว ให้ AI (หรือแนะนำผู้ใช้เปิดเบราว์เซอร์) ตรวจให้ครบ:
1. **หน้าแรก (`/`) และแกลเลอรี (`/#gallery`):**
   - ตัวนับเวลาถอยหลังซิงค์เวลาจาก `/api/settings/public`
   - รูปแกลเลอรี `g01.jpg`–`g43.jpg` โหลดจาก `https://comcamp25-gallery.sokulshop5.workers.dev/` ได้ (ต้องมีเน็ต; โฟลเดอร์ local `/assets/gallery/` ไม่ได้อยู่ใน Git)
2. **หน้าสมัครค่าย (`/register`):**
   - **หมายเหตุสำคัญสำหรับโหมด B หากทดสอบก่อนวันที่ `2026-11-16`:** ฐานข้อมูล PostgreSQL เริ่มต้นตั้ง `registration_open_at = '2026-11-16 00:00:00+07'` หน้า `/register` จะขึ้นสถานะยังไม่เปิดรับสมัคร ให้ล็อกอิน `/admin` แล้วปรับเวลาเปิดรับสมัครในส่วนตั้งค่าก่อนทดสอบส่งใบสมัคร (ส่วนโหมด A In-Memory เปิดให้อัตโนมัติอยู่แล้ว)
   - ในขั้นตอนที่ 5 ตรวจว่า Turnstile widget ขึ้นเครื่องหมายถูก (ถ้าตั้ง Dummy site key `1x...AA`) และกดส่งใบสมัครสำเร็จได้รหัส `CC25-XXXXXX`
3. **หน้าตรวจสอบสถานะ (`/status`):**
   - ค้นหาด้วยเลขบัตร 13 หลัก / เบอร์โทร / `CC25-XXXXXX` แล้วข้อมูลส่วนบุคคลถูก mask อย่างถูกต้อง
   - ใช้ `verifyCode` (เลข 4 ตัวท้ายบัตรประชาชน) กดยืนยันเข้าร่วมและอัปโหลดรูปสลิปทดสอบ (JPG/PNG/WebP ≤ 5MB) → แสดงแถบสีเขียวแจ้งเตือนสำเร็จ
4. **หน้าแอดมิน (`/admin`):**
   - ล็อกอินด้วยบัญชีที่ตั้งไว้ ตรวจดูใบสมัคร เปิดดูสลิปผ่านปุ่มดูสลิป กดอนุมัติสลิป → สถานะเปลี่ยนเป็น `CONFIRMED`

### ขั้นที่ 6: สรุปผลส่งคืนให้รุ่นพี่
หลังทำครบ ให้ AI รายงานเป็นข้อๆ อย่างชัดเจน:
- โหมดที่เปิดใช้งานอยู่ (In-Memory หรือ PostgreSQL) และสถานะ Turnstile (Dummy Widget หรือ Bypass)
- URL ใช้งาน: หน้าเว็บ `http://localhost:4321`, API `http://localhost:8000/api`, Swagger `http://localhost:8000/swagger`
- ชื่อผู้ใช้และรหัสผ่าน `/admin` ที่ตั้งไว้สำหรับทดสอบเครื่องนี้
- ผลคำสั่ง `npm run build`, `go vet`, `go test` (ระบุให้ชัดถ้าชุด `postgres` ถูกข้ามในโหมด A) และผลตรวจหน้าเว็บจริง
