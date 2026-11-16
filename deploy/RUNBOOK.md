# คู่มือติดตั้งและดูแลระบบ Production — ComCamp #25 (CS MJU)

คู่มือนี้ใช้สำหรับนำระบบรับสมัครค่าย **ComCamp #25** ขึ้นใช้งานจริงบนเซิร์ฟเวอร์ของสาขาวิชาวิทยาการคอมพิวเตอร์ (Linux + Docker Compose v2) โดยแยกคอนเทนเนอร์ เครือข่าย และ Volume ออกจากไฟล์พัฒนาบนเครื่อง ([`docker-compose.yml`](../docker-compose.yml)) อย่างสมบูรณ์

> **[อ่านก่อน deploy ที่ภาควิชา]** คู่มือฉบับนี้เขียนแบบสมมติ Docker rootful (`sudo`, `127.0.0.1:8080`, `/opt`) แต่เซิร์ฟเวอร์จริงต้องการ **rootless + พอร์ต 6000** — ดู [`FACULTY-ROOTLESS.md`](FACULTY-ROOTLESS.md) ซึ่งเป็นความจริงที่ทับค่าตัวอย่างในฉบับนี้

---

## ภาพรวมสถาปัตยกรรม Production

```text
Internet / Campus HTTPS (Host Nginx / Caddy / Cloudflare Tunnel)
   └─▶ 127.0.0.1:8080 (edge-proxy: nginx:1.27-alpine, read_only)
          ├─▶ ^/api(/|$)     ──▶ backend:8000 (Go API + /app/create-admin, UID 10001, read_only)
          │                        ├─▶ db:5432 (PostgreSQL 16, db_internal_net [internal: true])
          │                        └─▶ uploads_data (/var/lib/cc25/uploads)
          ├─▶ /(swagger|docs) ──▶ 404 Not Found
          └─▶ /               ──▶ frontend:4321 (Astro static + Nginx security headers, read_only)
```

> **หมายเหตุด้านความปลอดภัย:** พอร์ต PostgreSQL (`5432`) **ไม่ถูกเปิดออกสู่เครื่องโฮสต์** และอยู่ในเครือข่ายปิด `db_internal_net` เท่านั้น

---

## ขั้นตอนที่ 1: ตรวจสอบเวลาและพื้นที่ของเซิร์ฟเวอร์

ระบบกำหนดเวลาเปิดรับสมัครอัตโนมัติที่ `2026-11-16 00:00:00+07:00` ควรตรวจสอบว่าเวลาของเครื่องโฮสต์ซิงค์กับ NTP และตั้งเขตเวลาถูกต้อง:

```bash
timedatectl status
# หาก Timezone ยังไม่ใช่ Asia/Bangkok หรือ NTP ยังไม่เปิด:
sudo timedatectl set-timezone Asia/Bangkok
sudo timedatectl set-ntp true
date -R
```

---

## ขั้นตอนที่ 2: เตรียมไฟล์ตั้งค่าและสิทธิ์ไฟล์หลัง Clone (บนเซิร์ฟเวอร์ Linux)

### 2.1 คัดลอก `.env.prod` และสร้างรหัสลับ

```bash
cd /path/to/Comcamp-site   # แก้เป็นพาธที่ clone โปรเจกต์จริง
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

สร้างค่าความลับแบบสุ่มสำหรับ `.env.prod`:

```bash
# สร้างรหัสผ่านฐานข้อมูล (DB_PASSWORD)
openssl rand -base64 32

# สร้างคีย์ลงนาม JWT (JWT_SECRET, ต้องยาวอย่างน้อย 32 ตัวอักษร)
openssl rand -hex 32
```

เปิดแก้ไข `.env.prod` และตรวจรายการสำคัญต่อไปนี้ให้ครบก่อนสั่ง Build:

| ตัวแปร | คำอธิบายและการตั้งค่าบนเซิร์ฟเวอร์ภาควิชา |
|---|---|
| `COMPOSE_PROJECT_NAME` | ค่าเริ่มต้น `comcamp25` (ช่วยล็อกชื่อ Container/Volume ไม่ให้เพี้ยนตามชื่อโฟลเดอร์ หรือเปลี่ยนเมื่อรันหลายโปรเจกต์) |
| `DB_PASSWORD`, `JWT_SECRET` | **ต้องเปลี่ยน** จาก `CHANGE_ME_...` มิฉะนั้น Go Backend จะปฏิเสธการสตาร์ต (Fail-closed) |
| `FRONTEND_URL` | Origin สาธารณะจริง **ไม่มี `/` ปิดท้าย** เช่น `https://comcamp.cs.science.ac.th` |
| `TURNSTILE_SECRET_KEY`, `PUBLIC_TURNSTILE_SITE_KEY` | คีย์จริงจาก Cloudflare Dashboard (ห้ามใช้ Dummy Key `1x000...` — Image Frontend และ Backend จะปฏิเสธโดยอัตโนมัติ) และต้องเพิ่มโดเมนใน Cloudflare Turnstile Widget ให้ตรงกับ `FRONTEND_URL` |
| `APP_NET_SUBNET`, `TRUSTED_PROXIES` | ค่าเริ่มต้น `172.28.0.0/24` หากชนกับวง Docker Bridge เดิมบนเครื่องภาควิชา ให้เปลี่ยนเป็นวงอื่นที่ว่าง (เช่น `172.29.0.0/24`) แล้วตั้ง `TRUSTED_PROXIES` ให้ครอบคลุมวงนั้น |
| `EDGE_BIND_IP`, `EDGE_HTTP_PORT` | ค่าเริ่มต้น `127.0.0.1:8080` หากพอร์ต `8080` มีบริการอื่นของภาควิชาใช้อยู่แล้ว ให้เปลี่ยน `EDGE_HTTP_PORT` (เช่น `18080`) |

> **กรณีเปลี่ยน Origin ภายนอก:** ค่าเริ่มต้นใช้ `PUBLIC_API_URL=/api` ผ่าน `edge-proxy` จึงไม่ต้องแก้ไข CSP แต่หากปรับ `PUBLIC_API_URL` หรือ `PUBLIC_GALLERY_BASE_URL` ไปใช้โดเมนอื่น อย่าลืมเพิ่ม Origin นั้นใน `connect-src` / `img-src` ของ [`frontend/nginx/snippets/security-headers.conf`](../frontend/nginx/snippets/security-headers.conf) ก่อน Build

### 2.2 ป้องกันปัญหา CRLF และสิทธิ์ไฟล์สคริปต์ Migration

```bash
sed -i 's/\r$//' deploy/postgres-init/01-run-up-migrations.sh deploy/nginx/edge.conf
chmod +x deploy/postgres-init/01-run-up-migrations.sh
```

---

## ขั้นตอนที่ 3: สั่ง Build และเปิดระบบครั้งแรก

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

ตรวจสอบสถานะ Healthcheck และ Log การรัน Migration (`000001`–`000007`):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
docker compose -f docker-compose.prod.yml --env-file .env.prod logs db
```

ใน Log ของ `db` ควรเห็นลำดับ `Applying migration: 000001_init_schema.up.sql` จนถึง `000008_update_registration_schedule.up.sql` และผล Query `settings` (`id = 1`) แสดงเวลาเปิดรับ `2026-11-18 00:00:00` (จาก commit `5eb8b14`)

*(หมายเหตุ: สคริปต์ใน `/docker-entrypoint-initdb.d/` จะทำงานเฉพาะตอนสร้าง Volume `pgdata_prod` ครั้งแรกที่ฐานข้อมูลยังว่างอยู่เท่านั้น)*

---

## ขั้นตอนที่ 4: สร้างบัญชีผู้ดูแลระบบ (`create-admin`)

ระบบ Production **ไม่มีรหัสผ่านตั้งต้น** และจะปฏิเสธการตั้ง `DEV_ADMIN_PASSWORD` ให้สร้างบัญชีแอดมินผ่านไบนารี `/app/create-admin` ภายในคอนเทนเนอร์ `backend` (รหัสผ่านต้องยาว **12–72 ตัวอักษร**):

**วิธีที่แนะนำ (พิมพ์รหัสผ่านแบบโต้ตอบผ่าน stdin เพื่อไม่ให้ค้างใน shell history):**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -it backend \
  /app/create-admin -username admin_staff -name "พี่ค่ายดูแลระบบ" -role admin
```

หรือกรณีส่งผ่านตัวแปรสภาพแวดล้อมชั่วคราว (เช่น ในสคริปต์อัตโนมัติ):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec \
  -e ADMIN_PASSWORD="รหัสผ่านอย่างน้อย_12_ถึง_72_ตัวอักษร" \
  backend /app/create-admin -username admin_staff -name "พี่ค่ายดูแลระบบ" -role admin
```

*(ระบบรับเฉพาะบทบาท `-role admin` และบันทึก `admin.cli.upsert` ลงตาราง `audit_logs` อัตโนมัติ)*

---

## ขั้นตอนที่ 5: ตั้งค่า Reverse Proxy / TLS บนเซิร์ฟเวอร์ภาควิชา

เนื่องจาก `edge-proxy` ผูกพอร์ตที่ `127.0.0.1:8080` (HTTP) บนเครื่องโฮสต์ ให้ต่อ Reverse Proxy หลักของภาควิชา (เช่น Host Nginx + Let's Encrypt / Cloudflare Tunnel) เข้ามาที่ `127.0.0.1:8080` โดยตั้งค่าสำคัญ 3 จุด:

1. **`client_max_body_size 10m;`** — ป้องกัน Host Proxy บล็อกไฟล์สลิปขนาด `1–5 MB` ด้วยค่าเริ่มต้น `1m`
2. **ส่งต่อ Header IP จริง (`X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`)**
3. **ตั้ง `TRUSTED_PROXIES` / `set_real_ip_from`** ให้ตรงกัน เพื่อไม่ให้ Go RateLimiter มองผู้ใช้ทุกคนเป็น IP เดียวกัน

ตัวอย่าง Virtual Host สำหรับ **Host Nginx** (ปรับโดเมนและพาธใบรับรอง TLS ตามจริง):

```nginx
server {
    listen 443 ssl http2;
    server_name comcamp.cs.science.ac.th;

    ssl_certificate     /etc/letsencrypt/live/comcamp.cs.science.ac.th/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/comcamp.cs.science.ac.th/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }
}
```

> **วิธีแก้หากใน Log เห็น IP เดียวกันทุกเครื่อง:**
> คลายคอมเมนต์ `set_real_ip_from` (เช่น `127.0.0.1/32` หรือ CIDR ของ Reverse Proxy คณะ) ใน [`deploy/nginx/edge.conf`](nginx/edge.conf) **หรือ** เพิ่ม CIDR ของ Proxy ชั้นหน้าเข้าไปใน `TRUSTED_PROXIES` ของ `.env.prod` (คั่นด้วยลูกน้ำ) แล้วสั่ง `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`

### ทดสอบแยก Client IP จริง 2 เครือข่าย

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f backend edge-proxy
```

1. เข้าหน้าเว็บจาก **เครื่องที่ 1 (Wi-Fi มหาวิทยาลัย)** และ **เครื่องที่ 2 (เน็ตมือถือ 4G/5G)**
2. ยืนยันว่าใน Log ของ `backend` / `edge-proxy` แสดง IP สาธารณะของทั้งสองเครื่องแยกกันชัดเจน (ไม่ใช่ `172.28.0.x` หรือ `127.0.0.1` ซ้ำกัน)

---

## ขั้นตอนที่ 6: รายการตรวจเช็กก่อนเปิดใช้งาน (Pre-Launch Checklist)

เปิดเบราว์เซอร์ไปยังโดเมนจริงและตรวจผ่าน Developer Tools (`F12` → Console & Network):

- [ ] ตรวจเส้นทางหลัก **`/`**, `/register`, `/status`, `/admin` *(หมายเหตุ: เว็บใช้ **`/`** เป็นหน้าหลัก ไม่มีเส้นทาง `/home`)*
- [ ] หน้า `/register` **ต้องไม่มีแถบ `[DEV MODE]`** และวิดเจ็ต Turnstile โหลดขึ้นปกติ (กรณีเปิดรับสมัครแล้ว)
- [ ] แท็บ **Console** ไม่มี Error เรื่อง `Content-Security-Policy` (ฟอนต์, โมเดล 3D `/draco/gltf/`, GSAP CDN, Turnstile และรูปแกลเลอรีทำงานครบ)
- [ ] แท็บ **Network** หน้า `/register`, `/status`, `/admin` และ `/api/*` มี Header `Cache-Control: no-store` ส่วนไฟล์ใน `/_astro/*` มี `Cache-Control: public, max-age=31536000, immutable`
- [ ] ทดสอบเปิด `/swagger`, `/docs`, `/api/swagger`, `/api/docs` ต้องคืน `404 Not Found`
- [ ] ทดสอบล็อกอิน `/admin` ด้วยบัญชีที่สร้างจาก `create-admin` สำเร็จ

---

## ขั้นตอนที่ 7: การสำรองข้อมูลอัตโนมัติ (Backup) และการกู้คืน (Restore)

> [!CAUTION]
> **ห้ามสั่ง `docker compose -f docker-compose.prod.yml down -v` หรือ `docker volume prune` บนเซิร์ฟเวอร์จริงโดยเด็ดขาด** เพราะจะลบทั้งฐานข้อมูล (`pgdata_prod`) และสลิปโอนเงิน (`uploads_data`) ทิ้งถาวร

### 7.1 สคริปต์สำรองข้อมูล (`/opt/cc25-backups/backup.sh`)

```bash
sudo mkdir -p /opt/cc25-backups/db /opt/cc25-backups/slips
sudo chmod 700 /opt/cc25-backups
```

สร้างไฟล์ `/opt/cc25-backups/backup.sh` (แก้ `PROJECT_DIR` ให้ตรงกับพาธจริงของโปรเจกต์):

```sh
#!/bin/sh
set -eu

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
PROJECT_DIR="/path/to/Comcamp-site"
BACKUP_DIR="/opt/cc25-backups"

set -a
. "$PROJECT_DIR/.env.prod"
set +a

PROJECT_SLUG="${COMPOSE_PROJECT_NAME:-comcamp25}"
DB_CONTAINER="${PROJECT_SLUG}_db"
UPLOADS_VOLUME="${PROJECT_SLUG}_uploads_data"

# 1. สำรองฐานข้อมูล PostgreSQL แบบ Custom/Compressed
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -F c \
    > "$BACKUP_DIR/db/cc25_db_${TIMESTAMP}.dump"
chmod 600 "$BACKUP_DIR/db/cc25_db_${TIMESTAMP}.dump"

# 2. สำรองไฟล์สลิปโอนเงินจาก Named Volume แบบ Read-Only
docker run --rm \
    -v "${UPLOADS_VOLUME}:/uploads:ro" \
    -v "$BACKUP_DIR/slips:/backup" \
    alpine:3.21 \
    tar -czf "/backup/cc25_slips_${TIMESTAMP}.tar.gz" -C /uploads .
chmod 600 "$BACKUP_DIR/slips/cc25_slips_${TIMESTAMP}.tar.gz"

# 3. ลบไฟล์สำรองที่เก่าเกิน 14 วัน
find "$BACKUP_DIR/db" -type f -name "*.dump" -mtime +14 -delete
find "$BACKUP_DIR/slips" -type f -name "*.tar.gz" -mtime +14 -delete
```

ตั้งสิทธิ์และใส่ใน `crontab -e` ให้สำรองทุกชั่วโมงตลอดช่วงเปิดรับสมัคร:

```bash
sudo chmod 700 /opt/cc25-backups/backup.sh
# ใน crontab -e เพิ่มบรรทัดนี้:
0 * * * * /opt/cc25-backups/backup.sh >> /var/log/cc25-backup.log 2>&1
```

### 7.2 การกู้คืนข้อมูลฉุกเฉิน (Restore)

```bash
# 1. กู้คืน PostgreSQL จากไฟล์ .dump (หยุด backend ชั่วคราวก่อนคืนค่าเพื่อกันเขียนทับ)
docker compose -f docker-compose.prod.yml --env-file .env.prod stop backend
docker exec -i comcamp25_db pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists < /opt/cc25-backups/db/cc25_db_YYYYMMDD_HHMMSS.dump

# 2. กู้คืนไฟล์สลิปเข้า Volume (กรณีต้องย้ายเครื่อง)
docker run --rm \
    -v comcamp25_uploads_data:/uploads \
    -v /opt/cc25-backups/slips:/backup:ro \
    alpine:3.21 \
    tar -xzf /backup/cc25_slips_YYYYMMDD_HHMMSS.tar.gz -C /uploads

docker compose -f docker-compose.prod.yml --env-file .env.prod start backend
```

---

## การอัปเดตโค้ดและรีสตาร์ตเมื่อมีการแก้ไข

```bash
cd /path/to/Comcamp-site
git pull origin main
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```
