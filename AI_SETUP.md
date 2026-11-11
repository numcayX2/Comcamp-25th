# ให้ AI ช่วยเซตอัพและตรวจโปรเจกต์

ไฟล์นี้เขียนไว้สำหรับทุกคนที่เพิ่งโคลนโปรเจกต์ไปและอยากให้ AI ที่ลงมือทำได้เอง (Claude Code, Codex, Cursor, Gemini CLI, Antigravity ฯลฯ) ช่วยลง dependency ตั้งค่า `.env` เปิดเซิร์ฟเวอร์ และไล่เช็กว่าระบบใช้งานได้จริง

มีสองส่วน ส่วนแรกเป็นข้อความให้ก๊อปไปสั่ง AI ส่วนที่สองเป็นขั้นตอนที่ AI ควรทำตาม

---

## 1. ข้อความที่ก๊อปไปสั่ง AI ได้เลย

เปิดโฟลเดอร์โปรเจกต์ในเครื่องมือของคุณ แล้วเลือกข้อความที่ตรงกับที่ต้องการ

**แบบ A — เร็วที่สุด ไม่ต้องใช้ Docker**
เหมาะกับการดูหน้าเว็บ แกลเลอรี Turnstile และลองสมัครดู

> อ่าน `AI_SETUP.md` แล้วเซตอัพโปรเจกต์แบบโหมด A (In-Memory ไม่ใช้ Docker) ใช้ Cloudflare Turnstile dummy key จาก `.env.example` รันเทสต์ แล้วเปิด Backend (`:8000`) กับ Frontend (`:4321`) สุดท้ายสรุป URL และรหัสเข้า `/admin` ให้หน่อย

**แบบ B — เต็มระบบพร้อม PostgreSQL 16 (ต้องมี Docker)**

> อ่าน `AI_SETUP.md` แล้วเซตอัพโปรเจกต์แบบโหมด B (Docker PostgreSQL 16) รัน migration ให้ครบ สร้างบัญชี `/admin` ใช้ Turnstile dummy key รัน Go test รวมชุดที่ต่อ Postgres แล้วเปิด Backend กับ Frontend ให้พร้อมลองทั้งระบบ

**แบบ C — เปิดเว็บแล้ว อยากให้ช่วยไล่ตรวจ**

> อ่าน `AI_SETUP.md` แล้วไล่ตรวจการทำงานจริงตั้งแต่หน้า `/` (ตัวนับเวลาและแกลเลอรี `#gallery`), การสมัครที่ `/register` พร้อม Turnstile, การส่งสลิปที่ `/status` และการอนุมัติสลิปที่ `/admin` ห้ามแก้โค้ดและห้าม commit `.env`

---

## 2. ขั้นตอนสำหรับ AI

### กติกาก่อนเริ่ม

- ห้าม commit หรือ `git add` ไฟล์ `.env`, `frontend/.env` และอะไรก็ตามใน `backend/uploads/` และห้ามใส่ secret จริงลงใน `.env.example` หรือเอกสาร
- ห้ามแก้ซอร์สโค้ดระหว่างเซตอัพ ยกเว้นผู้ใช้สั่งให้แก้บั๊ก ถ้าเจออะไรผิดปกติให้รายงาน
- ไม่ต้องสร้าง `frontend/.env` แยก Astro อ่านตัวแปร `PUBLIC_*` จาก `.env` ที่ root ให้อยู่แล้ว (ดู `frontend/astro.config.mjs`) ถ้ามี `frontend/.env` อยู่ก่อน ค่าในนั้นจะถูกใช้แทน
- เอกสารที่ควรอ่านประกอบคือ `README.md` กับ `backend/README.md`

### ขั้นที่ 1: เช็กเครื่องมือ

1. `node -v` ต้องเป็น 22.23.4 ขึ้นไป (ตาม `frontend/package.json`)
2. `go version` ต้องรองรับ `go 1.27.3` ตาม `backend/go.mod`
3. `docker --version` และ `docker compose version` ต้องใช้เฉพาะโหมด B ถ้าไม่มี Docker หรือผู้ใช้ไม่ได้ขอโหมด B ให้ใช้โหมด A
4. ถ้ายังไม่มี `frontend/node_modules` ให้ติดตั้งก่อน
   ```bash
   cd frontend
   npm install
   ```

### ขั้นที่ 2: ตั้งค่า `.env` ที่ root

คัดลอก `.env.example` เป็น `.env` (ถ้ายังไม่มี) แล้วตั้งค่าตามนี้

**ค่าที่ใช้ร่วมกันทั้งสองโหมด**

- `APP_ENV=development`
- `FRONTEND_URL=http://localhost:4321`
- `PUBLIC_API_URL=http://localhost:8000/api`
- `PUBLIC_GALLERY_BASE_URL=https://comcamp25-gallery.sokulshop5.workers.dev/`
- `JWT_SECRET` สุ่มสตริงยาวอย่างน้อย 32 ตัว ห้ามใช้ค่าที่ขึ้นต้นด้วย `change_this`

**Turnstile (ขั้นตอนที่ 5 ของ `/register`)**

ถ้าต้องการเห็นวิดเจ็ตจริงและมีอินเทอร์เน็ตเข้า `challenges.cloudflare.com` ได้ ใช้ dummy key ที่ท้าย `.env.example`:

```env
PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

ชุดนี้ผ่านเสมอ ถ้าอยากทดสอบกรณีไม่ผ่าน ให้ใช้ secret `2x0000000000000000000000000000000AA` แทน

ถ้าออฟไลน์หรืออยากข้าม ให้เว้นทั้งสองตัวว่างไว้ ในโหมด development ระบบจะข้ามการตรวจและขึ้นป้าย `[DEV]` ที่หน้าสมัคร

**โหมด A (In-Memory ไม่ใช้ Docker)**

- ตั้ง `DEV_ADMIN_USERNAME=admin`
- ตั้ง `DEV_ADMIN_PASSWORD` เป็นรหัสผ่านทดสอบที่จำง่าย แล้วบอกผู้ใช้ตอนรายงานผล ต้องตั้งเสมอ เพราะถ้าว่าง API จะไม่สร้างบัญชีแอดมินให้ล็อกอิน
- ไม่ต้องห่วงเรื่อง `DB_PASSWORD` ถ้าต่อ PostgreSQL ไม่ได้ในโหมด development backend จะสลับไปเก็บข้อมูลในหน่วยความจำเอง (ข้อมูลหายเมื่อปิดเซิร์ฟเวอร์) และโหมดนี้เปิดรับสมัครไว้ให้ ไม่ต้องรอวันที่ 16 พ.ย.

**โหมด B (Docker PostgreSQL 16)**

1. ตั้ง `DB_USER=comcamp`, `DB_NAME=comcamp_db`, `DB_HOST=127.0.0.1`, `DB_PORT=5432` และตั้ง `DB_PASSWORD` เป็นรหัสผ่านจริง ห้ามใช้ค่า `change_this...`
2. ลบหรือเว้นว่าง `DEV_ADMIN_PASSWORD`
3. สตาร์ตฐานข้อมูลแล้วรอจนพร้อม
   ```bash
   docker compose up -d db
   docker exec comcamp_db pg_isready -U comcamp -d comcamp_db
   ```
4. รัน migration ให้ครบตามลำดับ (`000001` ถึง `000006`)
   - PowerShell
     ```powershell
     Get-ChildItem backend/migrations/*.up.sql | Sort-Object Name | ForEach-Object { Get-Content $_.FullName -Raw } | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
     ```
   - Bash
     ```bash
     cat backend/migrations/*.up.sql | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
     ```
5. สร้างบัญชีแอดมิน รหัสผ่านต้องยาว 12–72 ตัวอักษร
   - PowerShell
     ```powershell
     cd backend
     $env:ADMIN_PASSWORD="<รหัสผ่านอย่างน้อย 12 ตัว>"
     go run ./cmd/create-admin -username admin -name "Staff Admin" -role superadmin
     Remove-Item Env:ADMIN_PASSWORD
     ```
   - Bash
     ```bash
     cd backend
     ADMIN_PASSWORD="<รหัสผ่านอย่างน้อย 12 ตัว>" go run ./cmd/create-admin -username admin -name "Staff Admin" -role superadmin
     ```

### ขั้นที่ 3: build และรันเทสต์

1. Frontend ต้อง build ผ่านครบ 4 หน้า (`/`, `/register`, `/status`, `/admin`) โดยไม่มี error
   ```bash
   cd frontend
   npm run build
   ```
2. Backend
   ```bash
   cd backend
   go vet ./...
   go test -count=1 ./...
   ```
   ในโหมด A ชุด `internal/repository/postgres` จะถูกข้าม (ไม่มี `TEST_DATABASE_DSN`) ให้บอกผู้ใช้ตรงๆ ว่าข้าม ไม่ต้องนับว่าผ่าน

   ในโหมด B ให้รันชุดนั้นกับฐานข้อมูลจริงเพิ่มด้วย โดยใช้ `DB_PASSWORD` ตัวเดียวกับใน `.env`
   - PowerShell
     ```powershell
     cd backend
     $env:TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=<DB_PASSWORD> dbname=comcamp_db sslmode=disable"
     go test -v -count=1 ./internal/repository/postgres/
     Remove-Item Env:TEST_DATABASE_DSN
     ```
   - Bash
     ```bash
     cd backend
     TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=<DB_PASSWORD> dbname=comcamp_db sslmode=disable" go test -v -count=1 ./internal/repository/postgres/
     ```

### ขั้นที่ 4: เปิด Backend และ Frontend

เปิดแยกสองโปรเซส ถ้าแก้ `.env` ทีหลัง ให้รีสตาร์ตทั้งคู่ เพราะค่า `PUBLIC_*` และ `TURNSTILE_SECRET_KEY` อ่านตอนสตาร์ต

1. Backend (`:8000`)
   ```bash
   cd backend
   go run ./cmd/api
   ```
   - `GET http://localhost:8000/api/health` ต้องตอบ 200
   - ดู log ตอนสตาร์ตว่าใช้ฐานข้อมูลแบบไหน (In-Memory หรือ PostgreSQL) และ Turnstile เปิดอยู่หรือไม่ (ถ้าเปิดจะเห็น `Cloudflare Turnstile verification is ON`)
2. Frontend (`:4321`)
   ```bash
   cd frontend
   npm run dev
   ```
   - `http://localhost:4321` ต้องเปิดได้

### ขั้นที่ 5: ไล่ตรวจหน้าเว็บ

เมื่อเซิร์ฟเวอร์ขึ้นแล้ว ให้ตรวจเองหรือบอกผู้ใช้ให้เปิดเบราว์เซอร์ตรวจตามนี้

1. **หน้าแรก `/` และแกลเลอรี `/#gallery`**
   - ตัวนับเวลาถอยหลังตรงกับเวลาจาก `/api/settings/public`
   - รูป `g01.jpg`–`g43.jpg` โหลดจาก `https://comcamp25-gallery.sokulshop5.workers.dev/` ได้ (ต้องมีเน็ต โฟลเดอร์ `/assets/gallery/` ในเครื่องไม่ได้อยู่ใน Git)
2. **หน้าสมัคร `/register`**
   - โหมด B ที่ทดสอบก่อน 16 พ.ย. 2569: ฐานข้อมูลตั้งเวลาเปิดรับไว้ที่วันนั้น หน้าสมัครจะขึ้นว่ายังไม่เปิด ให้ล็อกอิน `/admin` แล้วเลื่อนเวลาเปิดในหน้าตั้งค่าก่อน (โหมด A เปิดอยู่แล้ว)
   - ที่ขั้นตอนที่ 5 วิดเจ็ต Turnstile ต้องขึ้นเครื่องหมายถูก (ถ้าใช้ dummy site key) และส่งใบสมัครแล้วได้รหัส `CC25-XXXXXX`
3. **หน้าสถานะ `/status`**
   - ค้นหาด้วยเลขบัตร 13 หลัก เบอร์โทร หรือ `CC25-XXXXXX` ข้อมูลส่วนตัวต้องถูกปิดบางส่วน
   - กรอก `verifyCode` (เลข 4 ตัวท้ายของบัตรประชาชน) กดยืนยันเข้าร่วม และอัปโหลดสลิปทดสอบ (JPG, PNG หรือ WebP ไม่เกิน 5 MB) สำเร็จแล้วต้องขึ้นแถบสีเขียวแจ้งว่าอัปโหลดเรียบร้อย
4. **หน้าแอดมิน `/admin`**
   - ล็อกอินด้วยบัญชีที่ตั้งไว้ เปิดดูใบสมัครและสลิป แล้วกดอนุมัติสลิป สถานะต้องเปลี่ยนเป็น `CONFIRMED`

### ขั้นที่ 6: รายงานผลให้ผู้ใช้

พอทำครบแล้ว ให้สรุปเป็นข้อๆ ว่า

- ตอนนี้รันโหมดไหน (In-Memory หรือ PostgreSQL) และ Turnstile เป็นแบบไหน (dummy key หรือข้ามการตรวจ)
- URL ที่ใช้ได้: เว็บ `http://localhost:4321`, API `http://localhost:8000/api`, Swagger `http://localhost:8000/swagger`
- ชื่อผู้ใช้และรหัสผ่าน `/admin` ที่ตั้งไว้ในเครื่องนี้
- ผลของ `npm run build`, `go vet`, `go test` และผลไล่ตรวจหน้าเว็บ ถ้าชุด `postgres` ถูกข้ามให้บอกตรงๆ
- สิ่งที่ตรวจไม่ได้หรือไม่ได้ทำ (เช่น ไม่มีเน็ตเลยเทสต์ Turnstile กับแกลเลอรีไม่ได้)
