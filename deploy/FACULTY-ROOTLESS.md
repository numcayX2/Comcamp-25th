# Faculty deployment — rootless Docker, port 6000

เอกสารฉบับนี้คือความจริงสำหรับเซิร์ฟเวอร์ภาควิชา (`202.28.37.1`, user `comclub`) และ**ทับค่าตัวอย่างใน `RUNBOOK.md`** เฉพาะจุดที่ขัดกัน (rootful, `127.0.0.1:8080`, `sudo`, `/opt`) ทุกอย่างอื่นใน RUNBOOK ยังใช้ได้

> **GO-LIVE: `2026-11-18 00:00:00+07:00`** — เปิดรับสมัครพรุ่งนี้ ให้ commit & push งาน Round 1 ที่แก้ไขไว้ในเครื่องก่อน จากนั้นทำข้อ 1–5 ใน TL;DR ก่อนเป็นอันดับแรก ส่วนข้อมูลที่ยังรอคอนเฟิร์ม (เลขห้อง/หอพัก/เบอร์ติดต่อ Staff/ยอดสุทธิ) ค่อยอัปเดตตามใน Round 2 หลังเว็บออนไลน์ได้
>
> **พอร์ต 6000 ยืนยันจากอาจารย์แล้ว** ("ปรับให้ container รับ request ทาง port เบอร์ 6000") — สิ่งที่ยังไม่รู้ไม่ใช่เลขพอร์ต แต่คือ **proxy ชั้นหน้าชี้มาที่พอร์ตนี้แล้วหรือยัง** และ **TLS ทำที่ไหน** (ข้อ 1–2 ด้านล่าง) วันเปิดรับไม่ได้บอกคำตอบของสองข้อนี้ ต้องถามอาจารย์ตรง ๆ

**ลำดับที่ต้องทำเอง (TL;DR):**
1. เปลี่ยนรหัส SSH + ตั้ง SSH key (ข้อ 1)
2. SSH เข้า `comclub@202.28.37.1` → ติดตั้ง rootless Docker + `loginctl enable-linger` (ข้อ 2)
3. clone repo → `cp .env.prod.example .env.prod` → `chmod 600` → ใส่ค่า (ข้อ 3)
4. เช็ก + ลบ container hello-world (ข้อ 4)
5. `docker compose up -d --build` → สร้างบัญชีแอดมิน (ข้อ 4)
6. `curl` ตรวจ `/api/health` และโดเมน + ทดสอบ 2 เครือข่าย (ข้อ 5)

---

## 0. ตอบอาจารย์ให้ครบก่อนลงมือ

| # | คำถาม | ทำไมต้องรู้ก่อน |
|---|---|---|
| 1 | `https://comcampdev.csmju.com` ถูกทำ TLS ที่ไหน — proxy ระดับคณะ/มหาวิทยาลัย หรือต้องทำบนเครื่องนี้เอง? | ถ้าทำบนเครื่องนี้ rootless จะผูก 443 ไม่ได้โดยตรง ต้องทราบก่อนเลือกสถาปัตยกรรม |
| 2 | proxy ชั้นหน้าชี้มาที่ `202.28.37.1:6000` ตรง ๆ หรือยังไม่ได้ตั้ง? | กำหนด `EDGE_BIND_IP` — ใช้ `0.0.0.0` ถ้า proxy อยู่คนละเครื่อง, `127.0.0.1` ถ้าอยู่เครื่องเดียวกัน |
| 3 | `comcampdev.csmju.com` เป็นโดเมนทดสอบชั่วคราวหรือโดเมนสุดท้าย? | เปลี่ยนโดเมนทีหลังต้อง rebuild + เปลี่ยน `FRONTEND_URL` + ออก Turnstile key ใหม่ |
| 4 | อีเมล `comclub@csmju.com` ใช้กับส่วนไหนของระบบ? | ตอนนี้ Go backend ไม่มีโค้ด SMTP เลย — block `MAIL_*` ที่อาจารย์ให้เป็นตัวอย่าง Laravel จึงเป็นแค่ข้อมูล server ต้องตัดสินใจว่าเพิ่มโค้ดส่งเมลหรือใช้บริการภายนอก |

---

## 1. ความปลอดภัยขั้นต้น (ทำก่อน SSH เข้าเซิร์ฟเวอร์)

- เปลี่ยนรหัส SSH ของ `comclub` — อาจารย์ระบุให้เปลี่ยนอยู่แล้ว
- เปลี่ยนรหัส portal `mail.csmju.com` — ถูกแชร์มาในข้อความเดียวกัน ถือว่าต้อง rotate
- เปลี่ยนเป็น **SSH key login** แล้วปิด password auth ถ้าทำได้ จะได้ไม่มีรหัสผ่านค้างใน shell history
- สร้าง **mail app key** ใน portal `mail.csmju.com` เอง — ห้ามแปะรหัส/คีย์ในแชทหรือ commit ลง repo
- เก็บความลับทั้งหมดใน `.env.prod` บนเซิร์ฟเวอร์ด้วย `chmod 600` (ไฟล์นี้ถูก gitignore อยู่แล้ว)

---

## 2. ติดตั้ง rootless Docker (รันเป็น `comclub`)

ติดตั้งแพ็กเกจต้องใช้ `sudo` — ถ้า `comclub` ไม่มีสิทธิ์ sudo ให้ขออาจารย์ติดตั้งให้:

```bash
sudo apt-get update
sudo apt-get install -y docker-ce-rootless-extras dbus-user-session uidmap slirp4netns fuse-overlayfs

dockerd-rootless-setuptool.sh install
sudo loginctl enable-linger comclub   # สำคัญ: ถ้าไม่ใช้ sudo มักติด Access denied; ไม่งั้น dockerd ตายตอน logout
loginctl show-user comclub -p Linger  # ต้องแสดง Linger=yes
```

ออกจาก SSH แล้วเข้าใหม่ (หรือ `source ~/.bashrc` ถ้า installer เพิ่ม `PATH`/`DOCKER_HOST` ไว้ให้) แล้วตรวจสอบ:

```bash
systemctl --user enable --now docker
systemctl --user status docker --no-pager
docker info --format '{{json .SecurityOptions}}'   # ต้องมี "rootless"
docker context ls                                 # ถ้ามี context ชื่อ rootless ค่อยสลับ; ระวังอย่าให้ DOCKER_HOST ชนกับ context
docker context use rootless                       # ข้ามได้ถ้ามีแค่ default ตัวเดียวและ docker info ขึ้น rootless แล้ว
```

หมายเหตุ: rootless ผูกพอร์ตได้เฉพาะ **> 1024** โดยปริยาย — พอร์ต 6000 ปลอดภัย ไม่ต้องแต่ง `ip_unprivileged_port_start`

---

## 3. เตรียมโปรเจกต์และ `.env.prod`

```bash
mkdir -p ~/comcamp25 && cd ~/comcamp25
git clone https://github.com/numcayX2/Comcamp-25th.git .

cp .env.prod.example .env.prod
chmod 600 .env.prod

# กัน CRLF และให้สคริปต์ migration รันได้
sed -i 's/\r$//' deploy/postgres-init/01-run-up-migrations.sh deploy/nginx/edge.conf
chmod +x deploy/postgres-init/01-run-up-migrations.sh
```

ค่าใน `.env.prod` ที่ต้องเปลี่ยนจากตัวอย่าง (สร้างความลับด้วย `openssl rand -base64 32` / `openssl rand -hex 32`):

| ตัวแปร | ค่าสำหรับเซิร์ฟเวอร์นี้ |
|---|---|
| `DB_PASSWORD`, `JWT_SECRET` | สุ่มใหม่ ห้ามใช้ `CHANGE_ME_...` (backend ปฏิเสธสตาร์ตอยู่แล้ว) |
| `FRONTEND_URL` | `https://comcampdev.csmju.com` (ไม่มี `/` ปิดท้าย) |
| `EDGE_HTTP_PORT` | `6000` |
| `EDGE_BIND_IP` | `0.0.0.0` ถ้า proxy อยู่คนละเครื่อง / `127.0.0.1` ถ้าอยู่เครื่องเดียวกัน |
| `TURNSTILE_SECRET_KEY`, `PUBLIC_TURNSTILE_SITE_KEY` | ต้องเป็น key จริงของโดเมน `comcampdev.csmju.com` — ยังไม่พบหลักฐานว่า gen แล้ว (dummy ถูกปฏิเสธ) |
| `APP_NET_SUBNET`, `TRUSTED_PROXIES` | ใช้ `172.28.0.0/24` ได้ถ้าไม่ชน ถ้าชนให้เปลี่ยนเป็นวงอื่นแล้วอัปเดต `TRUSTED_PROXIES` ให้ตรง |
| `COMPOSE_PROJECT_NAME` | `comcamp25` (ล็อกชื่อ container/volume) |

---

## 4. ลบ hello-world แล้ว deploy

```bash
# ดูก่อน — อย่าลบ container อื่นของภาควิชา (หมายเหตุ: rootless เห็นเฉพาะ container ของ comclub ถ้า hello-world ถูกรันด้วย sudo/rootful ให้แจ้งอาจารย์หรือตรวจผ่าน default context ก่อน)
docker ps -a --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'

docker rm -f <hello-world-name>   # hello-world ส่วนใหญ่มัก Exited แล้ว ใช้ rm ได้เลย

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
docker compose -f docker-compose.prod.yml --env-file .env.prod logs db
```

ใน log ของ `db` ต้องเห็น migration `000001` → `000008_update_registration_schedule.up.sql` → `000009_update_shirt_sizes.up.sql` (ขยายไซส์เสื้อเป็น `SSS–4XL` — ถ้าเปิด DB volume เก่าที่มีอยู่แล้ว ต้องรัน `000008` และ `000009` เพิ่มเอง ไม่อย่างนั้นวันเปิดรับที่ 18 พ.ย. จะเพี้ยนและไซส์ `SSS`/`SS`/`4XL` จะ insert ไม่ผ่าน)

สร้างบัญชีแอดมินแบบโต้ตอบ (รหัสผ่านพิมพ์ผ่าน stdin ไม่ค้างใน history):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -it backend \
  /app/create-admin -username admin_staff -name "พี่ค่ายดูแลระบบ" -role admin
```

---

## 5. ตรวจสอบหลัง deploy

```bash
# ถ้าตั้ง EDGE_BIND_IP=0.0.0.0 หรือ 127.0.0.1 ใช้ 127.0.0.1:6000 ได้; ถ้าผูกเจาะจง IP 202.28.37.1 ให้เปลี่ยนเป็น 202.28.37.1:6000
curl -fsS http://127.0.0.1:6000/api/health
curl -sSI https://comcampdev.csmju.com | head -n 1
```

- เปิด `/`, `/register`, `/status`, `/admin` — ต้องไม่มีแถบ `[DEV MODE]` และ Turnstile โหลดได้
- `/swagger`, `/docs` ต้องคืน `404`
- ทดสอบจาก Wi-Fi มหาวิทยาลัยและเน็ตมือถือ แล้วดู log ว่า IP คนละตัวกัน (ไม่งั้นแก้ `TRUSTED_PROXIES`)
- `client_max_body_size 10m;` บน proxy ชั้นหน้า — ไม่งั้นอัปโหลดสลิปจะถูกบล็อก

---

## 6. สิ่งที่ RUNBOOK เดิมใช้ไม่ได้กับ rootless

- ทุกคำสั่ง `sudo docker ...` → ใช้ `docker ...` ตรง ๆ
- `/opt/cc25-backups` → ใช้ `$HOME/cc25-backups` (comclub ไม่มีสิทธิ์เขียน `/opt`) และใส่ crontab ของ comclub แทน root
- `sudo timedatectl` / `/etc/letsencrypt` → ต้องขออาจารย์จัดการให้ หรือยืนยันว่า proxy ชั้นหน้าทำ TLS อยู่แล้ว
- **ห้าม** `docker compose ... down -v` หรือ `docker volume prune` — จะลบ `pgdata_prod` และสลิปถาวร

---

## 7. สถานะงานแอปก่อนเปิดรับสมัคร (อ้างอิงจาก `5eb8b14` + งานเตรียม Go-Live บนเครื่อง)

เสร็จแล้วใน working tree (อย่าลืม `commit & push` ก่อน `git clone` บนเซิร์ฟเวอร์): กำหนดการ `18 พ.ย.–18 ธ.ค. 2569` + migration `000008`, ฟิลด์ผู้ปกครองครบทั้ง stack, reverify สลิป, ตาราง admin 6 คอลัมน์, วันจัดค่าย `5–7 ก.พ. 2570` บนหน้าเว็บ, กล่องเตือน 4 ข้อใน `/register` Step 01 + นโยบายไม่คืนเงินทุกกรณี, ระบบคืนที่นั่งอัตโนมัติเกิน 72 ชม. (`ExpireOverdueUnpaid`), ตัวเลือกด่วนแพ้อาหาร/ไม่ทานหมู (`DIETARY_QUICK_OPTIONS`), ไซส์เสื้อ `SSS–4XL` + migration `000009`, และ QR เข้า LINE OpenChat หลังส่งสลิป

ยังรอข้อมูลจริง/ตัดสินใจ (Round 2 หลังออนไลน์): Turnstile key จริงของ `comcampdev.csmju.com`, คำตอบอาจารย์ 4 ข้อในหมวด 0 (DNS/proxy พอร์ต 6000, ตำแหน่งทำ TLS, โดเมนสุดท้าย, SMTP), และข้อมูล TBD (ชื่ออาคาร/หอพัก/เบอร์ติดต่อ Staff & อาจารย์/คอนเฟิร์มยอดสุทธิ)
