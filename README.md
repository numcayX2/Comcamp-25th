# ComCamp #25 — เว็บรับสมัครและระบบหลังบ้าน

เว็บไซต์ของค่ายยุวชนคอมพิวเตอร์ ครั้งที่ 25 สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้

น้องๆ เข้ามาดูรายละเอียดค่าย สมัคร เช็กสถานะ และส่งสลิปค่าสมัครได้ที่นี่ ส่วนพี่ค่ายใช้หน้า `/admin` ตรวจสลิป ปรับสถานะ และตั้งค่าโควตา โค้ดแบ่งเป็นสองส่วน:

- **`frontend/`** — Astro + React + Tailwind v4 (หน้าแรก, `/register`, `/status`, `/admin`)
- **`backend/`** — Go (Chi, pgx, JWT) เก็บข้อมูลใน PostgreSQL 16 และมีโหมด In-Memory ไว้ลองเล่นโดยไม่ต้องมีฐานข้อมูล

Repository: <https://github.com/numcayX2/Comcamp-25th>

## สิ่งที่ต้องมีในเครื่อง

- Node.js 22.23.4 ขึ้นไป
- Go (ตาม `backend/go.mod` ตอนนี้คือ 1.27.3)
- Docker เฉพาะเมื่อจะรันกับ PostgreSQL จริง ถ้าแค่อยากดูหน้าเว็บหรือลองสมัคร ไม่ต้องมี

## เริ่มรันบนเครื่อง

ทั้งสองทางเริ่มจากคัดลอกไฟล์ตัวแปรสภาพแวดล้อม ไฟล์เดียวที่ root ใช้ได้ทั้ง backend และ frontend (Astro ดึงตัวแปรที่ขึ้นต้นด้วย `PUBLIC_` จากไฟล์นี้ให้เอง)

```bash
cp .env.example .env
```

เปิด `.env` แล้วเปลี่ยน `JWT_SECRET` เป็นสตริงสุ่มยาวอย่างน้อย 32 ตัว (ค่า `change_this...` จะถูกปฏิเสธ)

### ทางที่ 1: ไม่ใช้ Docker (เร็วที่สุด)

ถ้าต่อ PostgreSQL ไม่ได้ในโหมด `development` backend จะสลับไปเก็บข้อมูลในหน่วยความจำให้เอง ข้อมูลจะหายเมื่อปิดโปรแกรม และโหมดนี้เปิดรับสมัครไว้ให้เลย ไม่ต้องรอวันที่ 16 พ.ย.

ถ้าอยากเข้า `/admin` ให้ตั้งรหัสผ่านทดสอบใน `.env` ก่อน เพราะโค้ดไม่มีบัญชีเริ่มต้น:

```env
DEV_ADMIN_USERNAME=admin
DEV_ADMIN_PASSWORD=<ตั้งเอง>
```

### ทางที่ 2: ใช้ PostgreSQL 16

ตั้ง `DB_PASSWORD` ใน `.env` (compose จะไม่ยอมสตาร์ตถ้าไม่ได้ตั้ง) แล้วรัน:

```powershell
docker compose up -d db

# Windows PowerShell: รัน migration 000001–000004 ตามลำดับ
Get-ChildItem backend/migrations/*.up.sql | Sort-Object Name | ForEach-Object { Get-Content $_.FullName -Raw } | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
```

```bash
# macOS / Linux
cat backend/migrations/*.up.sql | docker exec -i comcamp_db psql -U comcamp -d comcamp_db
```

ฐานข้อมูลตั้งเวลาเปิดรับสมัครเริ่มต้นไว้ที่ 16 พ.ย. 2569 เวลา 00:00 น. ถ้าอยากลองสมัครก่อนวันนั้น ให้ล็อกอิน `/admin` แล้วเลื่อนเวลาเปิดในหน้าตั้งค่า

### สตาร์ตเซิร์ฟเวอร์

เปิดสองเทอร์มินัล:

```bash
cd backend && go run ./cmd/api              # http://localhost:8000
cd frontend && npm install && npm run dev   # http://localhost:4321
```

| ที่อยู่ | คืออะไร |
|---|---|
| `http://localhost:4321` | เว็บไซต์ |
| `http://localhost:8000/api` | API |
| `http://localhost:8000/swagger` | Swagger UI (เปิดเฉพาะโหมด development) |

## Cloudflare Turnstile (กันบอทตอนส่งใบสมัคร)

ขั้นตอนสุดท้ายของ `/register` มี Turnstile และ backend ตรวจ token ทุกครั้งก่อนบันทึกใบสมัคร ตัวแปรมีสองตัว:

- `PUBLIC_TURNSTILE_SITE_KEY` — key สาธารณะ ใช้ฝั่งหน้าเว็บ
- `TURNSTILE_SECRET_KEY` — secret ฝั่งเซิร์ฟเวอร์ ห้ามเอาไปใส่ฝั่งหน้าเว็บหรือ commit

บนเครื่องตัวเองมีสองทางเลือก:

- **เว้นว่างทั้งคู่** ในโหมด development ระบบจะข้ามการตรวจ และหน้าสมัครจะมีป้าย `[DEV]` บอกไว้
- **ใช้ dummy key ของ Cloudflare** (ต้องออนไลน์) ค่าอยู่ท้าย `.env.example` เช่น site key `1x00000000000000000000AA` คู่กับ secret `1x0000000000000000000000000000000AA` จะผ่านเสมอ ส่วนคู่ `2x...` จะไม่ผ่านเสมอ ไว้เทสต์หน้า error

ตอนขึ้น production ต้องใช้ key จริงจาก Cloudflare Dashboard และเพิ่มชื่อโดเมนของเว็บในวิดเจ็ตด้วย dummy secret จะถูกปฏิเสธ

## ตอนขึ้น production

ค่าเริ่มต้นของ `APP_ENV` คือ `production` และ backend จะ **ไม่ยอมสตาร์ต** ถ้าขาดอย่างใดอย่างหนึ่งต่อไปนี้ ซึ่งตั้งใจให้เป็นแบบนั้น เพื่อไม่ให้ระบบรับสมัครทำงานโดยไม่มีการป้องกัน:

- `JWT_SECRET` (อย่างน้อย 32 ตัว)
- `DB_PASSWORD` และต่อฐานข้อมูลได้จริง (ไม่มีการสลับไปโหมด In-Memory)
- `FRONTEND_URL` (ใช้กำหนด CORS และตรวจ hostname ของ Turnstile)
- `TURNSTILE_SECRET_KEY` ที่เป็นของจริง

ถ้า backend อยู่หลัง reverse proxy ให้ใส่ IP ของ proxy ใน `TRUSTED_PROXIES` ไม่อย่างนั้น rate limit จะนับ IP ของ proxy แทน IP ผู้ใช้

## บัญชีผู้ดูแลระบบ

โค้ดไม่มีบัญชีหรือรหัสผ่านเริ่มต้น

- **บน PostgreSQL** สร้างด้วยคำสั่งนี้ ระบบจะถามรหัสผ่าน (12–72 ตัวอักษร) และเก็บเป็น bcrypt
  ```bash
  cd backend
  go run ./cmd/create-admin -username <ชื่อผู้ใช้> -name "<ชื่อที่แสดง>" -role superadmin
  ```
  บทบาทที่ใช้ได้คือ `superadmin`, `staff`, `finance`, `reviewer` ถ้าไม่อยากพิมพ์รหัสผ่านตอนรัน ส่งผ่านตัวแปร `ADMIN_PASSWORD` ได้
- **บนโหมด In-Memory** ใช้ `DEV_ADMIN_USERNAME` / `DEV_ADMIN_PASSWORD` ใน `.env` ตัวแปรนี้ใช้ได้เฉพาะ development ถ้าตั้งไว้ตอนรัน production backend จะไม่ยอมสตาร์ต

## API คร่าวๆ

รายละเอียดเต็มดูที่ Swagger หรือ [`backend/README.md`](backend/README.md) ตารางนี้ไว้ดูภาพรวม

| Method | Endpoint | ใครเรียกได้ | ใช้ทำอะไร |
|---|---|---|---|
| `GET` | `/api/health` | ทุกคน | เช็กว่าเซิร์ฟเวอร์ยังทำงานอยู่ |
| `GET` | `/api/settings/public` | ทุกคน | เวลาเซิร์ฟเวอร์ วันเปิดรับ จำนวนที่นั่งที่ใช้ไป และค่าสมัคร |
| `POST` | `/api/applications` | ทุกคน | ส่งใบสมัคร ต้องแนบ Turnstile token ถ้าที่นั่งเต็มตอบ `409 QUOTA_FULL` |
| `GET` | `/api/applications/status?q=` | ทุกคน | ค้นหาด้วยเลขบัตร เบอร์โทร หรือรหัส `CC25-XXXXXX` ข้อมูลส่วนตัวถูกปิดบางส่วนก่อนส่งกลับ |
| `POST` | `/api/applications/:id/confirm` | ทุกคน + `verifyCode` | ยืนยันสิทธิ์เข้าร่วม |
| `POST` | `/api/applications/:id/slip` | ทุกคน + `verifyCode` | อัปโหลดสลิป (ไม่เกิน 5 MB, 4096×4096 px, สลิปซ้ำถูกปฏิเสธด้วย SHA-256) |
| `POST` | `/api/applications/:id/withdraw` | ทุกคน + `verifyCode` | ยกเลิกใบสมัครเอง ใช้ไม่ได้หลังยืนยันสิทธิ์หรือส่งสลิปแล้ว ต้องติดต่อพี่ค่าย |
| `PATCH` | `/api/applications/:id/profile` | ทุกคน + `verifyCode` | แก้ชื่อเล่น โรงเรียน จังหวัด ระดับชั้น ไซส์เสื้อ (ชื่อ เลขบัตร เบอร์ อีเมล แก้เองไม่ได้) |
| `POST` | `/api/auth/login` | ทุกคน | ล็อกอินพี่ค่ายเพื่อรับ JWT |
| `GET` | `/api/admin/applications` | แอดมิน | รายชื่อผู้สมัครทั้งหมด |
| `PATCH` | `/api/admin/applications/:id` | แอดมิน | เปลี่ยนสถานะ |
| `PATCH` | `/api/admin/applications/:id/profile` | แอดมิน | แก้ข้อมูลผู้สมัครได้ทุกช่อง |
| `GET` | `/api/admin/applications/:id/slip` | แอดมิน | ดูรูปสลิป (ไม่มี URL สาธารณะของสลิป) |
| `PATCH` | `/api/admin/applications/:id/verify-slip` | แอดมิน | อนุมัติหรือปฏิเสธสลิป |
| `GET` / `PATCH` | `/api/admin/settings` | แอดมิน | ดูและแก้โควตา กำหนดการ ค่าสมัคร หรือปิดรับสมัครฉุกเฉิน |

`verifyCode` คือเลข 4 ตัวท้ายของบัตรประชาชน ใช้ยืนยันว่าคนที่กดคือเจ้าของใบสมัคร และไม่ได้เก็บไว้ในเบราว์เซอร์

ผู้สมัครที่ส่งสำเร็จจะได้สถานะ `PASSED` ทันทีตามหลักมาก่อนได้ก่อน (ค่าเริ่มต้น 30 ที่นั่ง แอดมินปรับได้) จากนั้นส่งสลิปให้พี่ค่ายอนุมัติเป็น `CONFIRMED` สถานะทั้งหมดที่ใช้คือ `PENDING`, `PASSED`, `RESERVE`, `CONFIRMED`, `REJECTED`, `REFUND_PENDING`, `REFUNDED`

## การทดสอบ

```bash
cd backend
go vet ./...
go test -count=1 ./...

cd ../frontend
npm run build
```

ชุดทดสอบ backend มี unit test, การยิง API ตั้งแต่สมัครจนอนุมัติสลิป และการยิงพร้อมกันตอนโควตาใกล้เต็ม ชุดที่ต่อ PostgreSQL จริงอยู่ที่ `internal/repository/postgres` และจะรันก็ต่อเมื่อตั้ง `TEST_DATABASE_DSN` ถ้าไม่ตั้งจะถูกข้ามเฉยๆ

## โครงสร้างโฟลเดอร์

```text
backend/
  cmd/api/            จุดเริ่มต้นของ API
  cmd/create-admin/   เครื่องมือสร้างบัญชีแอดมิน
  internal/           config, domain, handler, middleware, repository, service
  migrations/         SQL สำหรับ PostgreSQL (000001–000004)
frontend/
  src/pages/          หน้าเว็บ
  src/components/     คอมโพเนนต์ของแต่ละหน้า
  public/theme/       CSS/JS ของหน้าแรก
docker-compose.yml    PostgreSQL 16 (ผูกที่ 127.0.0.1 เท่านั้น)
AI_SETUP.md           ให้ AI ช่วยเซตอัพและตรวจระบบ
```

## ให้ AI ช่วยเซตอัพ

ถ้าไม่อยากทำเอง เปิดโปรเจกต์ใน Claude Code, Codex, Cursor หรือ Gemini CLI แล้วสั่งว่า

> อ่าน `AI_SETUP.md` แล้วเซตอัพโปรเจกต์แบบโหมด A (ไม่ใช้ Docker) ใช้ Turnstile dummy key รันเทสต์ แล้วเปิด backend กับ frontend ให้หน่อย

รายละเอียดและคำสั่งแบบอื่นอยู่ใน [`AI_SETUP.md`](AI_SETUP.md)

## สิทธิ์การใช้งาน

ดูเงื่อนไขเต็มที่ [LICENSE](LICENSE) (source-available ไม่ใช่โอเพนซอร์ส) โดยสรุป:

- ทีมงานและผู้จัดค่าย ComCamp ของ CS MJU รุ่นถัดไป (เช่น ComCamp #26) นำไปใช้ ดัดแปลง และติดตั้งเพื่อจัดค่ายของสาขาได้ฟรี ขอให้คงเครดิตทีมพัฒนา ComCamp #25 ไว้
- บุคคลภายนอกทีมงานจะคัดลอก ดัดแปลง หรือเผยแพร่ต่อ ต้องได้รับอนุญาตเป็นลายลักษณ์อักษรก่อน
