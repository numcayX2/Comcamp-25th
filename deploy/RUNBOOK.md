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

ระบบกำหนดเวลาเปิด-ปิดรับสมัครอัตโนมัติที่ `19 พ.ย. 2569 09:00 น.–18 ธ.ค. 2569` (`2026-11-19 09:00:00+07:00` ถึง `2026-12-18 23:59:59+07:00`) ควรตรวจสอบว่าเวลาของเครื่องโฮสต์ซิงค์กับ NTP และตั้งเขตเวลาถูกต้อง:

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
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | การส่งอีเมลแจ้งรับสมัครและยืนยันสิทธิ์ (Stage 1 / Stage 2) ผ่าน Go async SMTP mailer — เว้น `SMTP_HOST=` ว่างไว้หากยังไม่เปิดใช้งานอีเมล |
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

ตรวจสอบสถานะ Healthcheck และ Log การรัน Migration (`000001`–`000019`):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
docker compose -f docker-compose.prod.yml --env-file .env.prod logs db
```

ใน Log ของ `db` ควรเห็นลำดับ `Applying migration: 000001_init_schema.up.sql` จนถึง `000016_sponsor_inquiry_file.up.sql` และผล Query `settings` (`id = 1`) แสดงช่วงเปิดรับ `19 พ.ย. 2569 09:00 น.–18 ธ.ค. 2569` (`2026-11-19 09:00:00+07` ถึง `2026-12-18 23:59:59+07`, จาก `000011` — วันปิดจริงปรับต่อได้ใน `/admin`), โควตา `40` ที่นั่ง (`000011`), ไซส์เสื้อ `SSS–4XL` (`000009`), และค่าสมัคร `1,200` บาท (`1200.00` จาก `000010`) — ตาราง `applicants` ต้อง **ไม่มี** คอลัมน์ `national_id` แล้ว และต้องมีคอลัมน์ `referral_sources`, `referral_other`, `deleted_reason` พร้อม CHECK สถานะที่รวม `FORFEITED` (จาก `000013`)

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

1. ในแต่ละเครื่องทดสอบ เปิดเว็บ "what is my IP" (เช่น `https://ifconfig.me` หรือ `https://api.ipify.org`) แล้ว **จด IP สาธารณะจริงของเครื่องนั้นไว้**
2. เข้าหน้าเว็บ (เช่น `/status` แล้วกดค้นหา) จาก **เครื่องที่ 1 (Wi-Fi มหาวิทยาลัย)** และ **เครื่องที่ 2 (เน็ตมือถือ 4G/5G)**
3. ยืนยันว่า IP ใน Log ของ `backend` **ตรงกับ IP สาธารณะที่จดไว้ของแต่ละเครื่องทุกตัว** — ไม่ใช่แค่ "ต่างกัน" (ต้องไม่ใช่ `172.28.0.x`, `127.0.0.1`, IP ของ Proxy คณะ หรือ IP ของ Cloudflare)
4. **ทดสอบการปลอม `X-Forwarded-For`** (ต้องผ่านก่อนเปิดรับสมัคร):
   ```bash
   curl -sS -H 'X-Forwarded-For: 203.0.113.9' https://<โดเมนจริง>/api/health
   docker compose -f docker-compose.prod.yml --env-file .env.prod logs --since 2m backend | grep '/api/health'
   ```
   บรรทัดของคำขอนี้ใน Log ของ `backend` **ต้องไม่แสดง `203.0.113.9`** แต่ต้องเป็น IP จริงของเครื่องที่รัน `curl` ถ้าเห็น `203.0.113.9` แปลว่าผู้โจมตีเลือก IP ที่ระบบเห็นเองได้ — **ห้ามเปิดรับสมัครจนกว่าจะแก้**
5. **ตรวจ Proxy ชั้นหน้า edge (Host Nginx / Traefik / NPM ฯลฯ):** ต้องตั้ง `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (ต่อท้าย IP ที่ต่อเข้ามาจริง) หรือถ้าเป็น **hop แรกที่รับจากอินเทอร์เน็ตโดยตรง** ให้ **เขียนทับ** ด้วย `proxy_set_header X-Forwarded-For $remote_addr;` ห้ามส่งต่อ header ที่ client ส่งมาตรงๆ (เช่น `$http_x_forwarded_for`) และห้ามไม่ตั้งค่าเลยในกรณีที่ Proxy นั้นส่ง header เดิมผ่านไปโดยอัตโนมัติ
6. **ถ้าเว็บอยู่หลัง Cloudflare (Proxy สีส้ม / Tunnel):** IP ที่ต่อเข้าเครื่องเราเป็น IP ของ Cloudflare ให้ทำอย่างใดอย่างหนึ่ง:
   - ที่ Host Nginx: `set_real_ip_from` ทุกช่วงใน <https://www.cloudflare.com/ips-v4> และ <https://www.cloudflare.com/ips-v6>, `real_ip_header CF-Connecting-IP;` แล้ว `proxy_set_header X-Forwarded-For $remote_addr;` (เขียนทับด้วย IP จริงที่แกะแล้ว) **หรือ**
   - ใส่ช่วง IP ที่ Cloudflare ประกาศทั้งหมดเพิ่มใน `TRUSTED_PROXIES` ของ `.env.prod` (คั่นด้วยลูกน้ำ) เพื่อให้ backend ข้าม hop ของ Cloudflare ไปหา IP จริง
   - ช่วง IP ของ Cloudflare เปลี่ยนได้ ให้ตรวจหน้าดังกล่าวอีกครั้งก่อนเปิดรับสมัคร แล้วทำข้อ 3–4 ซ้ำ

> **ทำไมต้องเข้มงวด:** backend เชื่อ `X-Forwarded-For` เมื่อคำขอมาจาก `TRUSTED_PROXIES` เท่านั้น และใช้ IP ขวาสุดที่ไม่ใช่ Proxy ที่เชื่อถือ ค่าเริ่มต้น `172.28.0.0/24` **รวม Gateway ของ Docker Bridge (`172.28.0.1`)** ซึ่งเป็น IP ที่ `edge-proxy` เห็นเมื่อ Host Proxy ต่อเข้า `127.0.0.1:8080` ดังนั้นถ้า Proxy ชั้นหน้าส่ง `X-Forwarded-For` ที่ client ปลอมมาผ่านไปตรงๆ backend จะเชื่อ IP ปลอมนั้น ผู้โจมตีจะ (1) **หลบ Rate Limit / การล็อกการเดารหัส** ได้โดยเปลี่ยน IP ปลอมทุกคำขอ และ (2) **ทำให้ IP ของผู้สมัครคนอื่นถูกล็อก** (เช่น IP ของโรงเรียนหรือเครือข่ายมือถือ) โดยการเดารหัสผิดในนาม IP นั้น

---

## ขั้นตอนที่ 6: รายการตรวจเช็กก่อนเปิดใช้งาน (Pre-Launch Checklist)

เปิดเบราว์เซอร์ไปยังโดเมนจริงและตรวจผ่าน Developer Tools (`F12` → Console & Network):

- [ ] ตรวจเส้นทางหลัก **`/`**, `/register`, `/status`, `/admin` *(หมายเหตุ: เว็บใช้ **`/`** เป็นหน้าหลัก ไม่มีเส้นทาง `/home`)*
- [ ] หน้า `/register` **ต้องไม่มีแถบ `[DEV MODE]`** และวิดเจ็ต Turnstile โหลดขึ้นปกติ (กรณีเปิดรับสมัครแล้ว)
- [ ] แท็บ **Console** ไม่มี Error เรื่อง `Content-Security-Policy` (ฟอนต์, โมเดล 3D `/draco/gltf/`, Turnstile, รูปแกลเลอรี และ Cloudflare Web Analytics ที่ Cloudflare ฝังให้เอง (`static.cloudflareinsights.com` อนุญาตใน CSP แล้ว) ทำงานครบ; GSAP bundle มากับเว็บแล้ว ไม่โหลดจาก CDN)
- [ ] แท็บ **Network** หน้า `/register`, `/status`, `/admin`, `/applicants`, `/guide` และ `/api/*` มี Header `Cache-Control: no-store` ส่วนไฟล์ใน `/_astro/*` มี `Cache-Control: public, max-age=31536000, immutable`
- [ ] ทดสอบเปิด `/swagger`, `/docs`, `/api/swagger`, `/api/docs` ต้องคืน `404 Not Found`
- [ ] ทดสอบล็อกอิน `/admin` ด้วยบัญชีที่สร้างจาก `create-admin` สำเร็จ

---

## ขั้นตอนที่ 7: การสำรองข้อมูลอัตโนมัติ (Backup) และการกู้คืน (Restore)

> [!CAUTION]
> **ห้ามสั่ง `docker compose -f docker-compose.prod.yml down -v` หรือ `docker volume prune` บนเซิร์ฟเวอร์จริงโดยเด็ดขาด** เพราะจะลบทั้งฐานข้อมูล (`pgdata_prod`) และสลิปโอนเงิน (`uploads_data`) ทิ้งถาวร

### 7.1 สคริปต์สำรองข้อมูล (`/opt/cc25-backups/backup.sh` หรือ `$HOME/cc25-backups/backup.sh` สำหรับ rootless)

> **สำหรับเซิร์ฟเวอร์ rootless (เช่น user `comclub`):** ใช้ `BACKUP_DIR="$HOME/cc25-backups"` (สร้างด้วย `mkdir -p "$HOME/cc25-backups/db" "$HOME/cc25-backups/slips" && chmod 700 "$HOME/cc25-backups"` โดยไม่ใช้ `sudo`) และเขียน log ลง `$HOME/cc25-backups/backup.log` ใน crontab ของผู้ใช้แทน `/var/log/cc25-backup.log`

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
# ตรวจทันทีหลังอัปเดต: ต้องได้ 200 (ถ้าได้ 502 ดูหมายเหตุด้านล่าง)
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:${EDGE_HTTP_PORT:-8080}/api/health
```

> **502 ทุกหน้าหลังอัปเดต (เหตุการณ์ 2026-11-24 หลัง deploy `9c20ad9`):** `up -d --build` สร้าง `backend` / `frontend` ใหม่ (ได้ IP ใหม่) แต่ไม่สร้าง `edge-proxy` ใหม่ nginx รุ่นเดิมของ `edge.conf` จำ IP เก่าตั้งแต่ตอนสตาร์ต จึงตอบ 502 จนกว่าจะรีสตาร์ต (log ของ `edge-proxy` มี `connect() failed (111: Connection refused) ... upstream: "http://172.28.0.x:..."`) แก้เฉพาะหน้า: `docker compose -f docker-compose.prod.yml --env-file .env.prod restart edge-proxy` ตั้งแต่ `edge.conf` ใช้ `resolver 127.0.0.11` + `proxy_pass $cc25_backend` / `$cc25_frontend` แล้ว nginx หา IP ใหม่เองทุก 10 วินาที แต่ **ครั้งแรกที่ดึง `edge.conf` รุ่นนี้ต้องตรวจแล้วสร้าง `edge-proxy` ใหม่เอง** เพราะ nginx อ่าน config ตอนสตาร์ตเท่านั้น และไฟล์ที่ bind mount ทีละไฟล์จะไม่เห็นไฟล์ใหม่ที่ `git pull` เขียนทับจนกว่าจะสร้าง container ใหม่:
> ```bash
> docker run --rm -v "$PWD/deploy/nginx/edge.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine nginx -t
> docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps --force-recreate edge-proxy
> ```
> ถ้า `nginx -t` ไม่ผ่าน ห้ามสร้าง `edge-proxy` ใหม่ (container เดิมยังทำงานต่อด้วย config เก่า)

> **ถ้าการอัปเดตมี Migration ใหม่ (เช่น `000011`, `000013`, `000014`, `000015`, `000016`, `000017`, `000018`, `000019`) ห้ามใช้คำสั่งด้านบนตรงๆ** ให้ทำตามบล็อกของ migration นั้นด้านล่าง เพราะ `docker-entrypoint-initdb.d` ไม่รัน Migration บน Volume ที่มีข้อมูลอยู่แล้ว

### Phase 5 deploy (migration `000011`)

`000011_remove_national_id.up.sql` ลบคอลัมน์ `applicants.national_id`, ลบเลขบัตรประชาชนที่ค้างอยู่ใน `audit_logs.details` และย้าย `settings` เป็น `19 พ.ย. 2569 09:00 น.` / `40` ที่นั่ง (เฉพาะเมื่อแถวยังเป็นค่าเก่า) **ต้องทำตามลำดับนี้เท่านั้น:**

```bash
cd /path/to/Comcamp-site
git pull origin main
set -a; . ./.env.prod; set +a   # ให้ $DB_USER / $DB_NAME ใช้ได้ใน shell นี้

# 1. หยุด backend ตัวเก่าก่อน (frontend / edge-proxy / db ทำงานต่อได้ ระหว่างนี้ /api ตอบ 502 ชั่วคราว)
docker compose -f docker-compose.prod.yml --env-file .env.prod stop backend

# 2. รัน 000011 up ด้วย psql ภายในคอนเทนเนอร์ db (ไฟล์เป็น BEGIN/COMMIT เดียว ล้มเหลว = ไม่มีอะไรเปลี่ยน)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T db   psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000011_remove_national_id.up.sql

# 3. ตรวจผล: ต้องได้ 0 แถว (ไม่มีคอลัมน์ national_id) และ 0 (ไม่มีเลขบัตรใน audit_logs)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'applicants' AND column_name = 'national_id';"
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT count(*) FROM audit_logs WHERE details ? 'nationalId' OR details->'changes' ? 'nationalId';"

# 4. Build และเปิด backend ตัวใหม่
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

**ทำไมต้องเรียงแบบนี้:**
- **Build ใหม่บน Schema เก่า:** backend ใหม่ไม่เขียน `national_id` แล้ว แต่คอลัมน์ยังเป็น `NOT NULL` ทุก `POST /api/applications` จะล้มเหลว — ตัว backend ใหม่จึงตรวจ `information_schema.columns` ตอนสตาร์ต ถ้ายังพบ `applicants.national_id` ใน `APP_ENV=production` จะ **ปฏิเสธการสตาร์ต** (log `Refusing to start: applicants.national_id still exists …`) ให้กลับไปทำข้อ 2
- **Build เก่าบน Schema ใหม่:** backend เก่ายังอ่าน/เขียน `national_id` จะพังทุก Query ที่แตะ `applicants` จึงต้องหยุด backend เก่า **ก่อน** รัน Migration
- ห้ามรัน `000011` ระหว่างที่ backend เก่ายังรับสมัครอยู่ และควรทำก่อนเปิดรับสมัคร `19 พ.ย. 2569 09:00 น.`

**หลังรัน `000011` — ล้างเลขบัตรประชาชนที่ยังค้างนอกตาราง (PDPA):**
- **ไฟล์ backup เก่า:** ไฟล์ `pg_dump` รายชั่วโมงใน `/opt/cc25-backups/db/` (หรือ `$HOME/cc25-backups/db/`) ที่สร้าง **ก่อน** รัน `000011` ยังมีคอลัมน์ `national_id` และเลขบัตรใน `audit_logs` อยู่ หลังตรวจข้อ 3 ผ่านและ backup รอบถัดไป (หลัง migration) สร้างสำเร็จแล้ว ให้ลบไฟล์ที่เก่ากว่าเวลารัน migration ทิ้ง:
  ```bash
  # แทน 2026-11-18 20:00 ด้วยเวลาที่รัน 000011 จริง; ดูรายการก่อนลบด้วยคำสั่งแรก
  find /opt/cc25-backups/db -name 'cc25_db_*.dump' ! -newermt '2026-11-18 20:00' -print
  find /opt/cc25-backups/db -name 'cc25_db_*.dump' ! -newermt '2026-11-18 20:00' -delete
  ```
  ถ้าต้องการเก็บไว้เผื่อย้อนกลับ ให้ปล่อยให้สคริปต์ backup ลบเองเมื่อครบ 14 วัน (ข้อ 3 ของ `backup.sh`) แต่ต้องรู้ว่าระหว่างนั้นยังมีเลขบัตรอยู่ในไฟล์ และอย่าคัดลอกไฟล์เหล่านั้นออกนอกเครื่อง
- **Log ของ nginx เก่า:** log ของ `edge-proxy` และ `frontend` ก่อนรุ่นนี้ใช้รูปแบบเริ่มต้นที่บันทึก query string (`/api/applications/status?q=<เลข 13 หลัก>` และ `/status?q=CC25-…`) ให้สร้างคอนเทนเนอร์ใหม่ตอน deploy เพื่อทิ้ง log เก่า (log ของ Docker ถูกลบพร้อมคอนเทนเนอร์) และให้ใช้ `log_format cc25_private` ที่ไม่บันทึก query string:
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build --force-recreate edge-proxy frontend
  ```
  (ข้อความใน `error_log` ของ nginx อาจยังมีบรรทัดคำขอเต็มเมื่อเกิด error เช่น backend ล่ม ซึ่งถูกทิ้งไปพร้อมคอนเทนเนอร์เช่นกัน)
- **(ไม่บังคับ) เขียนหน้า heap ใหม่:** `DROP COLUMN` และ `UPDATE` ไม่ลบข้อมูลเก่าออกจากไฟล์ของ PostgreSQL ทันที ถ้าต้องการให้ข้อมูลเก่าหายจากดิสก์ ให้รันในช่วงที่ไม่มีคนใช้ (ล็อกตารางระหว่างรัน ใช้เวลาไม่นานที่ขนาดนี้):
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "VACUUM FULL applicants, audit_logs;"
  ```

### Migration `000012` (ชื่อจังหวัดทางการ)

`000012_canonical_province.up.sql` แก้เฉพาะข้อมูล `applicants.province` ให้เป็นชื่อทางการของ 77 จังหวัด (ตัด `จังหวัด` / `จ.` และช่องว่าง, แปลง `กทม` / `กรุงเทพฯ` / `อยุธยา` / `โคราช`) ไม่แตะ `updated_at` จึงไม่เลื่อนกำหนดชำระเงิน ค่าที่จับคู่ไม่ได้คงไว้ตามเดิมให้พี่ค่ายแก้ใน `/admin` ไม่มีการเปลี่ยน schema จึงรันได้ขณะ backend ทำงาน (ก่อนหรือหลัง deploy รุ่นใหม่ก็ได้):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T db   psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000012_canonical_province.up.sql
# ดูค่าที่ยังไม่ตรงรายชื่อ (ถ้ามี) เพื่อแก้ใน /admin
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT application_no, province FROM applicants WHERE deleted_at IS NULL ORDER BY province;"
```

### Migration `000013` (ช่องทางที่รู้จักค่าย, สถานะ `FORFEITED`, `deleted_reason`)

`000013_referral_forfeit_withdraw.up.sql` **เพิ่มอย่างเดียว (additive)** และรันซ้ำได้ (idempotent): เพิ่มคอลัมน์ `applicants.referral_sources` (`TEXT[]`, ค่าเริ่มต้น `'{}'`), `referral_other` (`VARCHAR(50)`, ค่าเริ่มต้น `''`), `deleted_reason` (`VARCHAR(20)`, ค่าเริ่มต้น `''`, CHECK `'' | SELF_WITHDRAWN | ADMIN_DELETED`), ขยาย CHECK `status` ให้รับ `FORFEITED`, เติม `deleted_reason` ให้แถวที่ถูกลบไปแล้วจาก `audit_logs` (มี `application.withdraw.self` ที่ไม่มีแอดมิน → `SELF_WITHDRAWN`, ที่เหลือ → `ADMIN_DELETED`) และแปลงแถว `REJECTED` ที่มาจากการตัดสิทธิ์อัตโนมัติ (สถานะล่าสุดไม่มีแอดมินและเหตุผลขึ้นต้น `ตัดสิทธิ์อัตโนมัติ`) เป็น `FORFEITED` พร้อมบันทึกใน `applicant_status_logs` — **ไม่มี DROP/RENAME ข้อมูลเดิม** ทั้งไฟล์เป็น `BEGIN`/`COMMIT` เดียว (ล้มเหลว = ไม่มีอะไรเปลี่ยน)

**หลักการ migration ตั้งแต่ `000013` เป็นต้นไป:** เพิ่มอย่างเดียว (คอลัมน์ใหม่ต้องมี default หรือ nullable, ขยาย CHECK ได้, ห้าม DROP/RENAME ข้อมูลเดิม) เพื่อให้ backend ตัวเดิมทำงานบน schema ใหม่ได้ระหว่าง deploy, **ทำ `pg_dump` ก่อนทุกครั้ง**, และรัน migration **ก่อน** build backend ตัวใหม่ (ต่างจาก `000011` ที่ต้องหยุด backend ก่อน)

```bash
cd /path/to/Comcamp-site
git pull --ff-only origin main
set -a; . ./.env.prod; set +a   # ให้ $DB_USER / $DB_NAME ใช้ได้ใน shell นี้
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
B="$HOME/cc25-backups/db"       # rootful ใช้ /opt/cc25-backups/db

# 1. สำรองฐานข้อมูลก่อนเสมอ (backend เดิมรับสมัครต่อได้ระหว่างนี้)
mkdir -p "$B"
F="$B/cc25_db_pre000013_$(date +%Y%m%d_%H%M%S).dump"
$C exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$F"
chmod 600 "$F"
# ต้องไม่ใช่ไฟล์ว่าง และต้องอ่านสารบัญได้ — ถ้าคำสั่งใดล้มเหลว ห้ามไปข้อ 2
ls -l "$F"
$C exec -T db pg_restore -l < "$F" | head

# 2. รัน 000013 up ขณะ backend เดิมยังทำงาน
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000013_referral_forfeit_withdraw.up.sql

# 3. ตรวจผล: ต้องได้ 3 แถว (คอลัมน์ใหม่), CHECK ต้องมี 'FORFEITED', และแถวที่ถูกลบต้องไม่มี deleted_reason ว่าง
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'applicants' AND column_name IN ('referral_sources','referral_other','deleted_reason');"
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'applicants_status_check';"
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT deleted_reason, count(*) FROM applicants WHERE deleted_at IS NOT NULL GROUP BY deleted_reason;"

# 4. Build และเปิด backend + frontend ตัวใหม่ทันที
$C up -d --build backend frontend

# 5. รัน 000013 up ซ้ำอีกรอบ เพื่อแปลงการตัดสิทธิ์อัตโนมัติที่ backend เดิมเขียนเป็น REJECTED ระหว่างข้อ 2–4 (รอบนี้ปกติได้ UPDATE 0 / INSERT 0 0)
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000013_referral_forfeit_withdraw.up.sql

# 6. ตรวจ API
curl -sS https://<โดเมนจริง>/api/health
curl -sS https://<โดเมนจริง>/api/settings/public
```

**ทำไมต้องเรียงแบบนี้:**
- **Build เก่าบน Schema ใหม่ (ปลอดภัย):** backend เดิมไม่เขียนคอลัมน์ใหม่และอ่านคอลัมน์แบบระบุชื่อ จึงทำงานต่อได้หลังข้อ 2 ข้อจำกัดเดียวคือมันนับแถว `FORFEITED` เป็นผู้ถือที่นั่ง (ทิศทางที่ปลอดภัย: ที่นั่งว่างน้อยลง ไม่มีทางเกิน) จึงต้อง deploy backend ใหม่ต่อทันที (ข้อ 4)
- **Build ใหม่บน Schema เก่า (ห้าม):** backend ใหม่อ่าน/เขียน `referral_sources`, `referral_other`, `deleted_reason` และสถานะ `FORFEITED` ทุก Query ที่แตะ `applicants` จะล้มเหลว และ **ไม่มีการตรวจ schema ตอนสตาร์ตแบบ `000011`** (`schema_check.go` ตรวจเฉพาะ `national_id`) จึงต้องรันข้อ 2 ก่อนข้อ 4 เสมอ
- **ย้อนกลับ:** `000013_referral_forfeit_withdraw.down.sql` แปลง `FORFEITED` กลับเป็น `REJECTED` และ **DROP คอลัมน์ `referral_sources`, `referral_other`, `deleted_reason` (คำตอบช่องทางที่รู้จักค่ายหายถาวร)** — ต้อง deploy backend รุ่นก่อนหน้า **ก่อน** รัน down และใช้เมื่อจำเป็นเท่านั้น; ถ้าต้องการข้อมูลกลับมาครบ ให้กู้จากไฟล์ในข้อ 1 ตามขั้นตอนที่ 7.2

### Migration `000014` (โลโก้ผู้สนับสนุน `sponsors`)

`000014_sponsors.up.sql` **เพิ่มอย่างเดียว** และรันซ้ำได้ (`CREATE TABLE/INDEX IF NOT EXISTS`): สร้างตาราง `sponsors` (ชื่อ ≤ 120, ลิงก์ว่างหรือ `http(s)://` ≤ 500, `show_name`, `sort_order`, path/MIME/SHA-256 ของโลโก้; CHECK MIME เฉพาะ JPEG/PNG/WebP) ไม่แตะตารางเดิม ไฟล์โลโก้เก็บใน volume `uploads_data` ที่ `/var/lib/cc25/uploads/sponsors/` (backend สร้างโฟลเดอร์ `0700` เองตอนสตาร์ต) และเปิดดูได้ผ่าน `GET /api/sponsors/{id}/logo` เท่านั้น

```bash
cd /path/to/Comcamp-site
git pull --ff-only origin main
set -a; . ./.env.prod; set +a
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
B="$HOME/cc25-backups/db"       # rootful ใช้ /opt/cc25-backups/db

# 1. สำรองฐานข้อมูลก่อนเสมอ — ถ้าคำสั่งใดล้มเหลว ห้ามไปข้อ 2
mkdir -p "$B"
F="$B/cc25_db_pre000014_$(date +%Y%m%d_%H%M%S).dump"
$C exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$F"
chmod 600 "$F"; ls -l "$F"
$C exec -T db pg_restore -l < "$F" | head

# 2. รัน 000014 up ขณะ backend เดิมยังทำงาน (backend เดิมไม่รู้จักตารางนี้ จึงไม่กระทบ)
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000014_sponsors.up.sql

# 3. ตรวจ: ต้องเห็นตาราง sponsors (0 แถว)
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT count(*) FROM sponsors;"

# 4. Build และเปิด backend + frontend ตัวใหม่
$C up -d --build backend frontend

# 5. ตรวจ API: ต้องได้ {"sponsors":[]} (ไฟล์ /theme/*.js|css มี ?v=hash แล้ว ไม่ต้อง Purge Cache ใน Cloudflare)
curl -sS https://<โดเมนจริง>/api/sponsors
```

- **Build ใหม่บน Schema เก่า:** `GET /api/sponsors` และเมนูผู้สนับสนุนใน `/admin` ตอบ `500` (ส่วนอื่นทำงานปกติ หน้าแรกซ่อนแถบผู้สนับสนุนเอง) — แก้โดยรันข้อ 2
- **ย้อนกลับ:** deploy backend รุ่นก่อนหน้าก่อน แล้วจึงรัน `000014_sponsors.down.sql` (DROP ตาราง `sponsors` — รายการผู้สนับสนุนหายถาวร ไฟล์โลโก้ใน volume ต้องลบเองถ้าต้องการ)

### Migration `000015` (ผู้สนใจสนับสนุน + รายการบริจาค `sponsor_*`)

`000015_sponsor_donations.up.sql` **เพิ่มอย่างเดียว** และรันซ้ำได้: สร้าง 4 ตาราง — `sponsor_inquiries` (ฟอร์ม "แจ้งความประสงค์สนับสนุน" จากหน้า `/sponsor`), `sponsor_notify_emails` (อีเมลพี่ค่ายที่รับแจ้งเตือน ตั้งใน `/admin` → ผู้สนับสนุน → อีเมลแจ้งเตือน), `sponsor_donations` (รายการบริจาคที่พี่ค่ายบันทึกเพื่อพิมพ์ฟอร์มคณะ — **ไม่มีคอลัมน์เลขผู้เสียภาษี/เลขบัตร**) และ `sponsor_donation_files` (ไฟล์ฟอร์มที่เซ็นแล้ว/สลิปโอน) ไม่แตะตารางเดิม ไฟล์เก็บใน volume `uploads_data` ที่ `/var/lib/cc25/uploads/sponsor-docs/` (`0600`) เปิดดูได้เฉพาะแอดมินผ่าน API

```bash
cd ~/comcamp25
git pull --ff-only origin main
set -a; . ./.env.prod; set +a
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
B="$HOME/cc25-backups/db"

# 1. สำรองฐานข้อมูลก่อนเสมอ — ถ้าคำสั่งใดล้มเหลว ห้ามไปข้อ 2
mkdir -p "$B"
F="$B/cc25_db_pre000015_$(date +%Y%m%d_%H%M%S).dump"
$C exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$F"
chmod 600 "$F"; ls -l "$F"
$C exec -T db pg_restore -l < "$F" | head

# 2. รัน 000015 up ขณะ backend เดิมยังทำงาน (backend เดิมไม่รู้จักตารางเหล่านี้ จึงไม่กระทบ)
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000015_sponsor_donations.up.sql

# 3. ตรวจ: ต้องเห็น 4 ตาราง (0 แถว)
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT (SELECT count(*) FROM sponsor_inquiries) inq, (SELECT count(*) FROM sponsor_notify_emails) mails, (SELECT count(*) FROM sponsor_donations) don, (SELECT count(*) FROM sponsor_donation_files) files;"

# 4. Build และเปิด backend + frontend ตัวใหม่
$C up -d --build backend frontend

# 5. ตรวจหน้า /sponsor ต้องได้ 200
curl -sS -o /dev/null -w '%{http_code}\n' https://comcamp.csmju.com/sponsor
```

- หลัง deploy: เข้า `/admin` → ผู้สนับสนุน → อีเมลแจ้งเตือน ใส่อีเมลพี่ค่าย แล้วลองส่งฟอร์มที่ `/sponsor` 1 ครั้ง ต้องได้อีเมล และเห็นรายการในแท็บ "ผู้สนใจสนับสนุน" (ลบรายการทดสอบทิ้งได้)
- รายการอีเมลเดียวกันนี้ได้รับแจ้งเตือน **ทุกใบสมัครใหม่** ด้วย (ชื่อ ชื่อเล่น โรงเรียน จังหวัด ระดับชั้น จำนวนที่นั่ง + ลิงก์ `/admin#applications` — ไม่มีรหัสใบสมัคร เบอร์ อีเมล หรือข้อมูลสุขภาพ; สูงสุด 40 ใบสมัครต่อชั่วโมง และข้ามเมื่อคิวอีเมลเต็มครึ่งหนึ่งเพื่อกันอีเมลของน้องค้าง) — ดูผลส่งใน `audit_logs` action `application.email.staff_notice.sent` / `.failed`
- **Build ใหม่บน Schema เก่า:** ฟอร์ม `/sponsor` และแท็บผู้สนใจ/รายการบริจาค/อีเมลแจ้งเตือนใน `/admin` ตอบ `500` (ระบบรับสมัครทำงานปกติ) — แก้โดยรันข้อ 2
- **ย้อนกลับ:** deploy backend รุ่นก่อนหน้าก่อน แล้วจึงรัน `000015_sponsor_donations.down.sql` (DROP 4 ตาราง — ข้อมูลผู้สนใจ/รายการบริจาคหายถาวร ไฟล์ใน `sponsor-docs/` ต้องลบเองถ้าต้องการ)

### Migration `000016` (แนบแบบฟอร์มบริจาคจากหน้า `/sponsor`)

`000016_sponsor_inquiry_file.up.sql` **เพิ่มอย่างเดียว** และรันซ้ำได้: เพิ่ม 4 คอลัมน์ใน `sponsor_inquiries` (`file_path`, `file_mime`, `file_size`, `file_sha256` — ว่างทั้งหมดหรือมีครบทั้งหมด ตาม CHECK `sponsor_inquiries_file_check`) สำหรับแบบฟอร์มบริจาคที่ผู้สนับสนุนกรอกแล้วแนบมาแทนการกรอกบนเว็บ (`POST /api/sponsor-inquiries/upload`, PDF/JPG/PNG/WebP ≤ 8 MB) ไฟล์เก็บใน `${UPLOAD_DIR}/sponsor-docs/inquiry-<uuid>.<ext>` (volume `uploads_data` เดียวกับไฟล์รายการบริจาค) เปิดดูได้เฉพาะแอดมินที่ `GET /api/admin/sponsor-inquiries/{id}/file` และถูกลบเมื่อลบรายการผู้สนใจ backend รุ่นก่อนหน้าไม่อ่านคอลัมน์เหล่านี้ จึงรันขณะระบบเดิมทำงานอยู่ได้ (ต้องรัน `000015` มาก่อนแล้ว)

```bash
cd ~/comcamp25
git pull --ff-only origin main
set -a; . ./.env.prod; set +a
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
B="$HOME/cc25-backups/db"

# 1. สำรองฐานข้อมูลก่อนเสมอ — ถ้าคำสั่งใดล้มเหลว ห้ามไปข้อ 2
mkdir -p "$B"
F="$B/cc25_db_pre000016_$(date +%Y%m%d_%H%M%S).dump"
$C exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$F"
chmod 600 "$F"; ls -l "$F"
$C exec -T db pg_restore -l < "$F" | head

# 2. รัน 000016 up ขณะ backend เดิมยังทำงาน
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000016_sponsor_inquiry_file.up.sql

# 3. ตรวจ: ต้องเห็น 4 คอลัมน์ file_*
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -c "\d sponsor_inquiries" | grep file_

# 4. Build และเปิด backend + frontend ตัวใหม่
$C up -d --build backend frontend

# 5. ตรวจ: ไฟล์แบบฟอร์มต้องได้ 200 application/pdf
curl -sSI 'https://comcamp.csmju.com/assets/docs/sponsor-donation-form.pdf?v=1' | grep -iE '^(HTTP|content-type|content-length)'
```

- หลัง deploy: เปิด `/sponsor` → `แจ้งความประสงค์สนับสนุน` → `แนบแบบฟอร์มที่กรอกแล้ว` ส่งไฟล์ทดสอบ 1 ครั้ง ต้องเห็นรายการพร้อมป้าย `แนบแบบฟอร์ม` และปุ่ม `ดูแบบฟอร์ม` ใน `/admin` → ผู้สนับสนุน → ผู้สนใจสนับสนุน (ลบรายการทดสอบทิ้งได้ ไฟล์ถูกลบตาม)
- **Build ใหม่บน Schema เก่า:** แท็บผู้สนใจสนับสนุนใน `/admin` และการส่งฟอร์มที่ `/sponsor` ตอบ `500` (ระบบรับสมัครทำงานปกติ) — แก้โดยรันข้อ 2
- **ย้อนกลับ:** deploy backend รุ่นก่อนหน้าก่อน แล้วจึงรัน `000016_sponsor_inquiry_file.down.sql` (ลบ 4 คอลัมน์ — ไฟล์ `sponsor-docs/inquiry-*` ที่ส่งมาแล้วยังอยู่ ลบเองถ้าต้องการ)

### Migration `000017` (ที่อยู่ + เลขประจำตัวผู้เสียภาษี/เลขบัตรประชาชนของผู้สนับสนุน)

`000017_sponsor_tax_address.up.sql` **เพิ่มอย่างเดียว** และรันซ้ำได้: เพิ่ม 6 คอลัมน์ `TEXT NOT NULL DEFAULT ''` (`tax_id`, `address_line`, `address_subdistrict`, `address_district`, `address_province`, `address_postcode`) ใน `sponsor_inquiries` และ `sponsor_donations` — ฟอร์ม `/sponsor` (บริจาคเงิน + กรอกบนเว็บ) บังคับกรอก เลข 13 หลักตรวจ checksum; แอดมินทุกคนดูได้ใน `/admin` และพิมพ์ลงฟอร์มคณะ; ไม่ออกทาง endpoint สาธารณะ อีเมล หรือค่าใน audit backend รุ่นก่อนหน้าไม่อ่านคอลัมน์เหล่านี้ จึงรันขณะระบบเดิมทำงานอยู่ได้ (ต้องรัน `000016` มาก่อนแล้ว)

```bash
cd ~/comcamp25
git pull --ff-only origin main
set -a; . ./.env.prod; set +a
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
B="$HOME/cc25-backups/db"

# 1. สำรองฐานข้อมูลก่อนเสมอ — ถ้าคำสั่งใดล้มเหลว ห้ามไปข้อ 2
mkdir -p "$B"
F="$B/cc25_db_pre000017_$(date +%Y%m%d_%H%M%S).dump"
$C exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$F"
chmod 600 "$F"; ls -l "$F"
$C exec -T db pg_restore -l < "$F" | head

# 2. รัน 000017 up ขณะ backend เดิมยังทำงาน
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000017_sponsor_tax_address.up.sql

# 3. ตรวจ: ต้องได้ sponsor_donations|6 และ sponsor_inquiries|6
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -Atc "select table_name, count(*) from information_schema.columns where table_name like 'sponsor_%' and column_name in ('tax_id','address_line','address_subdistrict','address_district','address_province','address_postcode') group by 1 order by 1"

# 4. Build และเปิด backend + frontend ตัวใหม่
$C up -d --build backend frontend
curl -fsS http://127.0.0.1:6000/api/health
```

- หลัง deploy: เปิด `/sponsor` → เลือก `เงิน` → `กรอกข้อมูลบนเว็บ` ต้องเห็นกลุ่ม "ข้อมูลสำหรับออกเอกสารลดหย่อนภาษี"; ส่งทดสอบ 1 ครั้งด้วยเลข 13 หลักที่ checksum ถูก แล้วดูใน `/admin` → ผู้สนับสนุน → ผู้สนใจสนับสนุน ว่าเห็นเลขและที่อยู่ (ลบรายการทดสอบทิ้งได้)
- **Build ใหม่บน Schema เก่า:** แท็บผู้สนับสนุนใน `/admin` และการส่งฟอร์มที่ `/sponsor` ตอบ `500` (ระบบรับสมัครทำงานปกติ) — แก้โดยรันข้อ 2
- **ย้อนกลับ:** deploy backend รุ่นก่อนหน้าก่อน แล้วจึงรัน `000017_sponsor_tax_address.down.sql` (ลบ 6 คอลัมน์ทั้งสองตาราง — เลข/ที่อยู่ที่บันทึกแล้วหายถาวร)
- **ไฟล์ backup:** หลัง `000017` ไฟล์ `pg_dump` จะมีเลขบัตรประชาชน/เลขผู้เสียภาษีของผู้สนับสนุน เก็บสิทธิ์ `600` เหมือนเดิม

### Migration `000018` (จำนวนเงินที่ผู้สนใจสนับสนุนแจ้ง)

`000018_sponsor_inquiry_amount.up.sql` **เพิ่มอย่างเดียว** และรันซ้ำได้: เพิ่มคอลัมน์ `amount NUMERIC(12, 2) NULL` (มี `CHECK amount > 0`) ใน `sponsor_inquiries` — ฟอร์ม `/sponsor` เมื่อเลือก `เงิน` บังคับกรอกจำนวนเงินทั้งแบบกรอกบนเว็บและแนบแบบฟอร์ม; รายการเดิมและสิ่งของเป็น `NULL`; แอดมินเห็นใน `/admin` และอีเมลแจ้งทีมงานมีบรรทัดจำนวนเงิน; ไม่ออกทาง endpoint สาธารณะหรือค่าใน audit backend รุ่นก่อนหน้าไม่อ่านคอลัมน์นี้ จึงรันขณะระบบเดิมทำงานอยู่ได้ (ต้องรัน `000017` มาก่อนแล้ว)

```bash
cd ~/comcamp25
git pull --ff-only origin main
set -a; . ./.env.prod; set +a
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
B="$HOME/cc25-backups/db"

# 1. สำรองฐานข้อมูลก่อนเสมอ — ถ้าคำสั่งใดล้มเหลว ห้ามไปข้อ 2
mkdir -p "$B"
F="$B/cc25_db_pre000018_$(date +%Y%m%d_%H%M%S).dump"
$C exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$F"
chmod 600 "$F"; ls -l "$F"
$C exec -T db pg_restore -l < "$F" | head

# 2. รัน 000018 up ขณะ backend เดิมยังทำงาน
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000018_sponsor_inquiry_amount.up.sql

# 3. ตรวจ: ต้องได้ sponsor_inquiries|numeric
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -Atc "select table_name, data_type from information_schema.columns where table_name = 'sponsor_inquiries' and column_name = 'amount'"

# 4. Build และเปิด backend + frontend ตัวใหม่
$C up -d --build backend frontend
curl -fsS http://127.0.0.1:6000/api/health
```

- หลัง deploy: เปิด `/sponsor` → เลือก `เงิน` ต้องเห็นช่อง "จำนวนเงินที่ต้องการสนับสนุน" (หน่วย บาท) ทั้งแบบกรอกบนเว็บและแนบแบบฟอร์ม; ส่งทดสอบ 1 ครั้ง แล้วดูใน `/admin` → ผู้สนับสนุน → ผู้สนใจสนับสนุน ว่าเห็นจำนวนเงิน และปุ่ม `สร้างรายการบริจาค` เติมจำนวนเงินให้ (ลบรายการทดสอบทิ้งได้)
- **Build ใหม่บน Schema เก่า:** แท็บผู้สนับสนุนใน `/admin` และการส่งฟอร์มที่ `/sponsor` ตอบ `500` (ระบบรับสมัครทำงานปกติ) — แก้โดยรันข้อ 2
- **ย้อนกลับ:** deploy backend รุ่นก่อนหน้าก่อน แล้วจึงรัน `000018_sponsor_inquiry_amount.down.sql` (ลบคอลัมน์ `amount` — จำนวนเงินที่บันทึกแล้วหายถาวร ข้อความใน `details` ไม่กระทบ)

### Migration `000019` (สลิปโอนเงินจากผู้สนใจสนับสนุน)

`000019_sponsor_inquiry_slip.up.sql` **เพิ่มอย่างเดียว** และรันซ้ำได้: เพิ่มคอลัมน์ `slip_path`, `slip_mime`, `slip_size`, `slip_sha256` (NULL ทั้งหมดหรือมีค่าครบทั้งหมด, `CHECK sponsor_inquiries_slip_check` รับเฉพาะ JPEG/PNG/WebP) ใน `sponsor_inquiries` — การบริจาค `เงิน` ที่ `/sponsor` เปลี่ยนเป็น "โอนก่อน แล้วส่งฟอร์มพร้อมแนบสลิป" ทั้งแบบกรอกบนเว็บและแนบแบบฟอร์ม (สลิปบังคับ ไม่เกิน 1.5 MB); ไฟล์สลิปเก็บใน `UPLOAD_DIR/sponsor-docs/inquiry-slip-*` (ไม่เปิดสาธารณะ เปิดได้ที่ `/admin` เท่านั้น); รายการเดิมและสิ่งของเป็น `NULL`; ปุ่ม `สร้างรายการบริจาค` คัดลอกสลิปไปเป็นไฟล์สลิปของรายการบริจาคให้อัตโนมัติ backend รุ่นก่อนหน้าไม่อ่านคอลัมน์เหล่านี้ จึงรันขณะระบบเดิมทำงานอยู่ได้ (ต้องรัน `000018` มาก่อนแล้ว)

```bash
cd ~/comcamp25
git pull --ff-only origin main
set -a; . ./.env.prod; set +a
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
B="$HOME/cc25-backups/db"

# 1. สำรองฐานข้อมูลก่อนเสมอ — ถ้าคำสั่งใดล้มเหลว ห้ามไปข้อ 2
mkdir -p "$B"
F="$B/cc25_db_pre000019_$(date +%Y%m%d_%H%M%S).dump"
$C exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -F c > "$F"
chmod 600 "$F"; ls -l "$F"
$C exec -T db pg_restore -l < "$F" | head

# 2. รัน 000019 up ขณะ backend เดิมยังทำงาน
$C exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < backend/migrations/000019_sponsor_inquiry_slip.up.sql

# 3. ตรวจ: ต้องได้ 4 บรรทัด (slip_mime, slip_path, slip_sha256, slip_size) และ 1 บรรทัด sponsor_inquiries_slip_check
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -Atc "select column_name from information_schema.columns where table_name = 'sponsor_inquiries' and column_name like 'slip\_%' order by 1"
$C exec db psql -U "$DB_USER" -d "$DB_NAME" -Atc "select conname from pg_constraint where conname = 'sponsor_inquiries_slip_check'"

# 4. Build และเปิด backend + frontend ตัวใหม่
$C up -d --build backend frontend
curl -fsS http://127.0.0.1:6000/api/health
```

- หลัง deploy: เปิด `/sponsor` → เลือก `เงิน` ต้องเห็นช่อง "สลิปโอนเงิน" ใต้จำนวนเงินทั้งแบบกรอกบนเว็บและแนบแบบฟอร์ม; ส่งทดสอบ 1 ครั้งพร้อมรูปสลิป แล้วดูใน `/admin` → ผู้สนับสนุน → ผู้สนใจสนับสนุน ว่ามีป้าย `แนบสลิป` และปุ่ม `ดูสลิป` เปิดรูปได้; กด `สร้างรายการบริจาค` แล้วรายการใหม่ต้องมีไฟล์สลิปแนบอยู่ (ลบรายการทดสอบทั้งสองฝั่งทิ้งได้ ไฟล์ถูกลบตาม)
- **Build ใหม่บน Schema เก่า:** แท็บผู้สนับสนุนใน `/admin` และการส่งฟอร์มที่ `/sponsor` ตอบ `500` (ระบบรับสมัครทำงานปกติ) — แก้โดยรันข้อ 2
- **ย้อนกลับ:** deploy backend รุ่นก่อนหน้าก่อน แล้วจึงรัน `000019_sponsor_inquiry_slip.down.sql` (ลบ 4 คอลัมน์ — ไฟล์ `inquiry-slip-*` ใน `UPLOAD_DIR/sponsor-docs` ยังอยู่ ลบเองถ้าไม่ต้องการ; สลิปที่คัดลอกไปเป็นไฟล์ของรายการบริจาคแล้วไม่กระทบ) หมายเหตุ: backend รุ่นก่อนหน้ารับเงินผ่าน JSON โดยไม่มีสลิป

### แทนไฟล์ใบขออนุญาตผู้ปกครอง (`parent-consent.pdf`)

ตอนนี้ `frontend/public/assets/docs/parent-consent.pdf` เป็น **placeholder ขนาด 0 byte** และ `DOCS_READY = false` ใน `frontend/src/lib/camp-facts.ts` ทำให้ปุ่ม/ลิงก์ดาวน์โหลดถูกซ่อนทั้ง 3 จุด (ใบตอบรับ Step 06 ของ `/register`, ผลค้นด้วยรหัสใน `/status` เฉพาะใบที่ถือที่นั่ง, และหัวข้อ `เอกสารดาวน์โหลด` ใน `/guide`) ไฟล์ใน `public/` ถูกฝังใน image ของ `frontend` ตอน build จึงต้อง build ใหม่ทุกครั้งที่แทนไฟล์:

1. **บนเครื่องพัฒนา:** วางไฟล์ PDF จริงทับ `frontend/public/assets/docs/parent-consent.pdf` (**ชื่อไฟล์เดิม**)
2. แก้ `frontend/src/lib/camp-facts.ts`:
   - `export const DOCS_READY = true;`
   - เพิ่มเลข `?v=` ใน `PARENT_CONSENT_PDF` ทุกครั้งที่แทนไฟล์ (เช่น `'/assets/docs/parent-consent.pdf?v=1'` → `'?v=2'`) — Cloudflare แคช `/assets` หลายชั่วโมง และ nginx ไม่ได้ตั้ง `no-store` ให้ไฟล์นี้ URL ใหม่จึงเลี่ยงไฟล์ 0 byte ที่ค้างในแคชได้
3. `npm --prefix frontend run build` ต้องผ่านด้วย 0 error แล้ว commit (แปลง CRLF เป็น LF ก่อน) และ push ขึ้น `main`
4. **บนเซิร์ฟเวอร์:** build เฉพาะ `frontend` ใหม่ (ไม่ต้องหยุด backend/db):
   ```bash
   cd /path/to/Comcamp-site
   git pull --ff-only origin main
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build frontend
   ```
5. **ตรวจ:** ไฟล์ต้องได้ `200` และ `Content-Length` มากกว่า 0 (แทน `v=2` ด้วยเลขที่ตั้งในข้อ 2):
   ```bash
   curl -sSI 'https://<โดเมนจริง>/assets/docs/parent-consent.pdf?v=2' | grep -iE '^(HTTP|content-type|content-length)'
   ```
   แล้วเปิด `/guide` ต้องเห็นหัวข้อ `เอกสารดาวน์โหลด` ใน ToC และปุ่มดาวน์โหลดเปิดไฟล์ได้ (หน้า `/guide` เป็น `no-store` จึงเห็นผลทันทีโดยไม่ต้อง purge)

## เฝ้าระวังการเดารหัสใบสมัคร (CodeGuard) และการหยุดตัดสิทธิ์อัตโนมัติ

รหัสใบสมัคร `CC25-XXXXXX` คือหลักฐานของผู้สมัครบนหน้า `/status` (ค้นด้วยรหัส, ส่งสลิป, ยืนยันสิทธิ์) ส่วนการยกเลิกเองต้องใช้รหัสคู่กับเบอร์โทรที่ใช้สมัคร ระบบนับรหัสที่ไม่มีอยู่จริง (และเบอร์ที่ไม่ตรงตอนยกเลิก) ต่อ IP และรวมทั้งระบบ ถ้าครบเพดานรวม 10 ครั้งใน 5 นาที ทุกคำขอที่ใช้รหัสต้องผ่าน Cloudflare Turnstile ก่อนจนจบช่วง 5 นาทีนั้น: หน้า `/status` และใบตอบรับ (`/register` ขั้น 06) เปิดหน้าต่าง "ยืนยันก่อนทำรายการต่อ" ให้เอง เมื่อผ่านแล้วทำรายการเดิมต่อทันที (API ตอบ `429 CAPTCHA_REQUIRED` แล้วรับคำขอเดิมที่แนบ header `X-Turnstile-Token`) ส่วน IP ที่เดาผิดครบ 5 ครั้งเองยังถูกล็อก `429 RATE_LIMITED` ตามเดิม ซึ่ง Turnstile ปลดไม่ได้

- **เฝ้าดู:** แถว `application.code.ceiling` ใน `audit_logs` (โดยเฉพาะ `"level": "hard"`) ถ้าขึ้นต่อเนื่องหลายช่วง แปลว่ามีคนพยายามเดารหัสหรือก่อกวน
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT created_at, details FROM audit_logs WHERE action = 'application.code.ceiling' ORDER BY created_at DESC LIMIT 20;"
  ```
- **ระหว่างนั้นระบบหยุดตัดสิทธิ์เอง:** ถ้าเพดานรวมทำงานภายใน 24 ชั่วโมงล่าสุด ระบบจะ **ไม่** ตัดสิทธิ์ใบสมัครที่ค้างชำระอัตโนมัติ เพราะในช่วงที่ถูกก่อกวน ผู้สมัครต้องผ่าน Turnstile ก่อนส่งสลิป และบางคนอาจผ่านไม่ได้ (เช่น เบราว์เซอร์ในแอปที่โหลด Turnstile ไม่ขึ้น) เมื่อหยุดเกิน 24 ชั่วโมง การตัดสิทธิ์จะกลับมาทำงานเอง (การค้นด้วยเบอร์โทรที่ไม่พบนับต่อ IP เท่านั้น ไม่ทำให้เกิดการหยุดนี้)
  - **รู้ได้อย่างไรว่ากำลังหยุดอยู่:** มีแถว `application.code.ceiling` ที่ `"level": "hard"` ภายใน 24 ชั่วโมงล่าสุด (คำสั่งด้านบน) และ log ของ backend มีบรรทัด `unpaid expiry paused: application-code guess ceiling reached at …` (บันทึก **ครั้งเดียว** ต่อเวลาที่เพดานทำงาน ไม่ใช่ทุกนาที ถ้าเห็นบรรทัดใหม่ แปลว่ามีการโจมตีรอบใหม่ และนับ 24 ชั่วโมงใหม่จากเวลานั้น)
    ```bash
    docker compose -f docker-compose.prod.yml --env-file .env.prod logs backend | grep "unpaid expiry paused"
    ```
  - **สิ่งที่พี่ค่ายต้องทำระหว่างหยุด:** ที่นั่งของผู้ที่ค้างชำระเกินกำหนดจะไม่ถูกคืนเอง ให้ตรวจรายชื่อค้างชำระเองอย่างน้อยวันละครั้ง (ไม่มีสลิปที่รอตรวจหรืออนุมัติแล้ว และเลยกำหนด = `max(สมัคร + 120 ชม., แก้ไขล่าสุด + 24 ชม., สลิปที่ถูกปฏิเสธล่าสุด + 24 ชม.)`) แล้วเปลี่ยนสถานะเป็น `FORFEITED` (`หมดสิทธิ์ (ไม่ชำระตามกำหนด)` — สถานะเดียวกับที่ระบบตั้งเองตั้งแต่ `000013`) ใน `/admin` ทีละราย ควรติดต่อผู้สมัครก่อน เพราะเขาอาจส่งสลิปไม่ได้เพราะการก่อกวน (ถ้าต้องการขยายเวลาให้ ดูข้อถัดไป; ถ้าตัดสิทธิ์ไปแล้วภายหลังพบว่าชำระจริง ใช้ปุ่ม `กู้สิทธิ์` ใน `/admin`) คำสั่งนี้แสดงรายชื่อที่เข้าเงื่อนไขเดียวกับที่ระบบใช้ตัดสิทธิ์อัตโนมัติ:
    ```bash
    docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT application_no, status, created_at, updated_at FROM applicants a WHERE deleted_at IS NULL AND status IN ('PENDING','PASSED','RESERVE') AND created_at <= now() - interval '120 hours' AND updated_at <= now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.applicant_id = a.id AND NOT p.applicant_deleted AND (p.status IN ('PENDING','APPROVED') OR (p.status = 'REJECTED' AND COALESCE(p.verified_at, p.uploaded_at) > now() - interval '24 hours'))) ORDER BY created_at;"
    ```
- **ถ้าต้องการขยายเวลาให้ผู้สมัครรายใดเพิ่ม:** พี่ค่ายแก้ไขข้อมูลผู้สมัครคนนั้นใน `/admin` (แก้โปรไฟล์ พร้อมใส่เหตุผล) การบันทึกจะอัปเดต `updated_at` ทำให้กำหนดชำระขยายออกไปอย่างน้อย 24 ชั่วโมงนับจากเวลาที่แก้
- ถ้ามีการโจมตีต่อเนื่อง ให้ตรวจ IP ใน `application.code.lockout` และพิจารณาบล็อกที่ reverse proxy
- **ถ้าผู้สมัครหลายคนโดน `429` พร้อมกันทั้งที่เพดานรวมไม่ทำงาน:** ดู `details->>'client'` ของแถว `application.code.lockout` ถ้าเป็น IP ของ Cloudflare, `172.28.0.x` หรือ `127.0.0.1` แปลว่า backend แยก IP จริงของผู้ใช้ไม่ได้ (ขั้นตอนที่ 5) การล็อก "IP เดียว" จึงล็อกผู้สมัครทุกคนที่มาทางเดียวกัน ต้องแก้การส่งต่อ IP ก่อน
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT created_at, details->>'client' AS client, details->>'endpoint' AS endpoint FROM audit_logs WHERE action = 'application.code.lockout' ORDER BY created_at DESC LIMIT 20;"
  ```

**ข้อควรรู้เพิ่มเติม (ต้องอ่าน):**
- **(a) สถานะ CodeGuard อยู่ในหน่วยความจำของ backend เท่านั้น:** การรีสตาร์ต backend (รวมถึง `up -d --build`) จะล้างการล็อก IP ทั้งหมดและเวลาที่เพดานรวมทำงานล่าสุด (`lastHard`) ทำให้ **การหยุดตัดสิทธิ์อัตโนมัติสิ้นสุดก่อนครบ 24 ชั่วโมงทันที** และระบบจะคืนที่นั่งค้างชำระที่เลยกำหนดในรอบถัดไป (ภายใน 1 นาที) ถ้ากำลังอยู่ในช่วงหยุด ให้ตรวจรายชื่อค้างชำระ (คำสั่งด้านบน) และขยายเวลาให้ผู้ที่ควรได้รับก่อนรีสตาร์ต
- **(b) รหัสของใบสมัครที่ถูกลบหรือยกเลิกแล้วนับเป็นการเดาผิด:** ผู้ที่เปิดใบตอบรับเก่าหรือลิงก์ในอีเมลเดิมหลังยกเลิกจะถูกนับเป็น miss เหมือนรหัสที่ไม่มีอยู่จริง ไม่เป็นปัญหาที่ขนาด 40 ที่นั่ง แต่ถ้าเห็น lockout จาก IP ของผู้สมัครที่เพิ่งยกเลิก ให้ถือว่าเป็นกรณีนี้
- **(c) ผู้ก่อกวนทำให้การหยุดตัดสิทธิ์อยู่ต่อได้ง่าย:** ใช้การเดาผิดเพียงราว 10 ครั้งต่อ 24 ชั่วโมงก็ทำให้การหยุดไม่สิ้นสุด ดังนั้นตลอดเวลาที่การหยุดยังทำงาน **พี่ค่ายต้องตรวจรายชื่อค้างชำระเกินกำหนดและเปลี่ยนเป็น `FORFEITED` ด้วยตนเองทุกวัน** (ขั้นตอนด้านบน) ห้ามรอให้ระบบตัดสิทธิ์เอง
- **(d) เฝ้าดูการไล่เดาเบอร์โทร:** แถว `application.code.lockout` ที่ `details->>'endpoint' = 'status-phone'` แปลว่ามี IP ค้นด้วยเบอร์ที่ไม่พบซ้ำๆ (อาจกำลังไล่หาเบอร์ของผู้สมัคร) ให้ตรวจ IP และพิจารณาบล็อกที่ reverse proxy
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec db psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT created_at, ip_address, details FROM audit_logs WHERE action = 'application.code.lockout' AND details->>'endpoint' = 'status-phone' ORDER BY created_at DESC LIMIT 20;"
  ```

**ความเสี่ยงที่ยอมรับแล้ว (Known accepted risks):**
- **การโจมตีเพดานรวมของการเดารหัส (R23 — ลดผลกระทบแล้ว 2026-11-23):** ผู้ก่อกวนที่ใช้หลาย IP (อย่างน้อย 6 IP ต่อช่วง 5 นาที) ยังทำให้เพดานรวมทำงานได้ แต่ผู้สมัครไม่ถูกปฏิเสธทั้งหมดอีกต่อไป: ระหว่างนั้น **การส่งสลิป, การค้นสถานะด้วยรหัส, การยืนยันสิทธิ์ และการยกเลิกใบสมัคร** ต้องผ่าน Turnstile ก่อนแล้วทำต่อได้ทันที (การค้นด้วยเบอร์โทรไม่ต้องผ่าน) ความเสี่ยงที่ยังเหลือ: (1) ผู้ที่ Turnstile โหลดไม่ขึ้นยังทำรายการไม่ได้จนจบช่วง (2) การหยุดตัดสิทธิ์อัตโนมัติยังถูกยืดได้ตามข้อ (c) (3) ผู้ที่ยอมจ่ายค่าบริการแก้ Turnstile ทีละครั้งเดารหัสได้เกินเพดานรวม แต่ยังติดการล็อกต่อ IP และสิ่งที่ได้จากรหัสที่เดาถูกมีเพียงข้อมูลแบบ mask, การส่งสลิป (พี่ค่ายตรวจ) และการยืนยันสิทธิ์ (การยกเลิกต้องใช้เบอร์เต็มด้วย)
  - **พี่ค่ายต้องทำ:** เฝ้าดูแถว `application.code.ceiling` (คำสั่งด้านบน) ถ้าเห็น `"level": "hard"` ต่อเนื่อง ให้ตรวจรายชื่อค้างชำระด้วยมือตามข้อ (c) และพิจารณาบล็อก IP ต้นทางที่ reverse proxy ถ้ามีผู้สมัครแจ้งว่าหน้าต่างยืนยันไม่ขึ้น ให้รับสลิปทาง LINE หรือส่งให้พี่ค่ายโดยตรง แล้วพี่ค่ายตรวจและเปลี่ยนสถานะใน `/admin` เอง
