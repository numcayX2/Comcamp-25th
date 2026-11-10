# เอกสารข้อกำหนดและสถาปัตยกรรมระบบ (System Specification — v3.0 Latest)

**โครงการพัฒนาเว็บไซต์รับสมัครค่ายยุวชนคอมพิวเตอร์ ครั้งที่ 25 (ComCamp #25)**  
**สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้ (`comcamp.csmju.com`)**  
**อัปเดตล่าสุด:** 8 พฤศจิกายน 2569 (`2026-11-08`)

เอกสารฉบับนี้จัดทำขึ้นเพื่อเป็นพิมพ์เขียว (Blueprint) และข้อตกลงร่วมกันฉบับสมบูรณ์ระหว่างทีมพัฒนา **Frontend (หน้าบ้าน)** และ **Backend (หลังบ้าน)** รวมถึงการเตรียมระบบเพื่อนำไปติดตั้งบนเซิร์ฟเวอร์ของสาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้ และ Cloudflare CDN

---

## ส่วนที่ 1: ข้อมูลสำคัญและไทม์ไลน์ของโครงการ (Project Overview & Parameters)

1. **วันเปิดรับสมัครอย่างเป็นทางการ:** วันที่ **16 พฤศจิกายน 2569 เวลา 00:00:00 น.** (`2026-11-16T00:00:00+07:00` อ้างอิงเวลา Server Time เสมอ)
   * **ช่วงก่อนถึงวันที่ 16/11/2026:** เว็บไซต์แสดงรายละเอียดประชาสัมพันธ์ค่าย หลักสูตร IoT & AI แถบนับถอยหลัง และล็อกปุ่มรับสมัครไว้ทั้งฝั่งหน้าบ้านและหลังบ้านจนกว่าจะถึงเวลาจริง
2. **จำนวนที่เปิดรับสมัคร (`max_capacity`):** **30 ที่นั่ง** (คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์ First-Come, First-Served และสามารถปรับเพิ่ม/ลดโควตาได้ผ่านระบบตั้งค่าหลังบ้าน)
3. **คุณสมบัติผู้สมัคร:** นักเรียนระดับชั้น **ม.4 – ม.6** และ **ปวช.1 – ปวช.3** ทุกสายการเรียน (ไม่จำเป็นต้องมีพื้นฐานการเขียนโปรแกรมหรือต่อวงจรไฟฟ้ามาก่อน)
4. **ระยะเวลาและรูปแบบกิจกรรม:** ค่ายพักค้างแรม **3 วัน 2 คืน** ณ สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้ จ.เชียงใหม่
5. **ชุดอุปกรณ์ฮาร์ดแวร์ประจำตัวผู้เข้าร่วม (1 ชุดต่อ 1 คน):**
   * บอร์ดไมโครคอนโทรลเลอร์ **Arduino UNO R3** (`ATmega328P`)
   * บอร์ด Wi-Fi IoT **ESP8266 NodeMCU** (`ESP-12E`)
   * ชุดเซนเซอร์และโมดูล: **HC-SR04 Ultrasonic**, **LDR Photoresistor**, **Active Buzzer**, และ **Breadboard**

---

## ส่วนที่ 2: บทเรียนจากปีที่แล้ว (`webcomcamp24`) และสิ่งที่เปลี่ยนใหม่ทั้งหมดใน ComCamp #25

จากการวิเคราะห์ระบบปีที่แล้ว พบคอขวดและช่องโหว่ความปลอดภัยที่ได้แก้ไขใหม่ทั้งหมดในสถาปัตยกรรมปีนี้:

| ปัญหาของระบบปีที่แล้ว (`ComCamp #24`) | สถาปัตยกรรมใหม่ในระบบปีนี้ (`ComCamp #25`) |
| :--- | :--- |
| **1. เซิร์ฟเวอร์ล่ม (RAM เต็ม):** เก็บรูปสลิป (5MB) และเกียรติบัตรเป็น Base64 ยัดลงใน MongoDB เวลาแอดมินดึงรายชื่อ ระบบโหลด Base64 ทุกคนเข้า RAM พร้อมกันจนค้าง | **แยกไฟล์รูปภาพและสลิปออกจาก DB:** เก็บเฉพาะ Path/URL และค่าแฮช `SHA-256` ลงฐานข้อมูล PostgreSQL ส่วนรูปแกลเลอรีค่ายฝากไว้บน **Cloudflare Workers Static Assets CDN** (`comcamp25-gallery.sokulshop5.workers.dev`) |
| **2. ฐานข้อมูลโดนเจาะ (Database Bypass):** ตั้งค่า Docker Port เป็น `0.0.0.0` (Public) และไม่ได้บังคับ Authentication | **ใช้ PostgreSQL 16 + ล็อก Internal IP (`127.0.0.1`):** ผูกพอร์ตฐานข้อมูลไว้กับ `127.0.0.1:5432` หรือภายใน `internal_net` ของ Docker เท่านั้น |
| **3. ช่องโหว่ปลอมตัวเป็น Admin:** มีการใส่ค่า Fallback `'dev_jwt_secret'` ทิ้งไว้ในโค้ด Public Repo | **Go Clean Architecture + Strict JWT Auth:** บังคับตั้งค่า `JWT_SECRET` ผ่าน Environment Variable และแฮชรหัสผ่านแอดมินด้วย `bcrypt` |
| **4. ช่องโหว่อัปโหลดไฟล์สลิปซ้ำ/อันตราย:** เช็กนามสกุลไฟล์แค่หน้าบ้าน | **Strict File Validation & SHA-256 Deduplication:** จำกัดขนาดไฟล์ไม่เกิน 5MB ตรวจสอบชนิดไฟล์จริง และคำนวณ `slip_hash` (SHA-256) ป้องกันการนำสลิปเดิมมาอัปโหลดซ้ำ |
| **5. ค้นหาชื่อไม่เจอและช้า + ติดปัญหา OAuth ในแอป LINE/Facebook:** ค้นหาด้วย Regex ชื่อ-นามสกุลและใช้ Google OAuth ซึ่งถูกบล็อกใน In-App Browser (`disallowed_useragent`) | **In-App Browser Safe Status Lookup:** ค้นหาสถานะด้วย **เลขบัตรประชาชน 13 หลัก, เบอร์โทรศัพท์ 10 หลัก หรือรหัสใบสมัคร (`CC25-XXXXXX`)** ที่มี B-Tree Index รวดเร็วในระดับมิลลิวินาทีโดยไม่ต้องพึ่ง OAuth |

---

## ส่วนที่ 3: สถาปัตยกรรมระบบและ Tech Stack จริง (Monorepo Architecture)

ระบบแบ่งโครงสร้างเป็น Monorepo (`frontend/` และ `backend/`):

```
[ ผู้ใช้งาน / นักเรียน ม.ปลาย-ปวช. / ผู้ปกครอง / พี่ค่าย ]
                      │
                      ▼
[ Cloudflare Proxy, CDN & Static Assets Worker ]
  ├── Web & API Traffic ──► เซิร์ฟเวอร์สาขาวิชาวิทยาการคอมพิวเตอร์ (comcamp.csmju.com)
  └── Gallery Assets    ──► https://comcamp25-gallery.sokulshop5.workers.dev/ (g01.jpg–g43.jpg)
                      │
                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Docker Environment (Internal Network)                                      │
│                                                                            │
│  [ Frontend: Astro 5 + React 19 + Three.js + GSAP 3 ]                      │
│     ├── / , /home   (HomePage.astro + Interactive 3D Board Stage + GSAP)   │
│     ├── /register   (RegisterSection.tsx — 5-Step Registration Flow)       │
│     ├── /status     (StatusSection.tsx — Status Lookup & Slip Upload)      │
│     └── /admin      (AdminSection.tsx — Staff JWT Dashboard & Slip Review) │
│                      │                                                     │
│                      ▼ (/api/*)                                            │
│  [ Backend API: Go (Golang 1.23+ Clean Architecture) :8000 ]               │
│     ├── cmd/api/main.go                                                    │
│     ├── internal/{config,domain,handler,middleware,repository,service}      │
│     └── migrations/000001_init_schema.up.sql                               │
│                      │                                                     │
│                      ▼                                                     │
│  [ PostgreSQL 16 Alpine ] (Bind: 127.0.0.1:5432 only)                      │
└────────────────────────────────────────────────────────────────────────────┘
```

### รายละเอียด Tech Stack:
* **Frontend (`frontend/`):**
  * **Core Framework:** Astro (`^7.4.4`) + React 19 (`^19.3.1`) + Tailwind CSS v4 (`^4.3.3`)
  * **3D Hardware Stage:** Three.js + `GLTFLoader` เรนเดอร์โมเดล 3 มิติของจริง (`/models/ArduinoR3.glb` และ `/models/esp8266.glb`) พร้อม Procedural 3D Mesh ทันทีตั้งแต่เฟรมแรกใน Hero Section
  * **Scroll Choreography:** GSAP 3.12.5 + ScrollTrigger สำหรับส่วน Timeline และ **3D Memory Tunnel Gallery (`#gallery`)**
  * **Typography:** `IBM Plex Sans Thai` (สำหรับภาษาไทย) + `IBM Plex Mono` (`tabular-nums` สำหรับตัวเลข ไอพีแอดเดรส และรหัสใบสมัคร)
* **Backend (`backend/`):**
  * **Language & Architecture:** Go (Golang) พัฒนาตามหลัก Clean Architecture (`domain` -> `repository` -> `service` -> `handler` -> `middleware`)
  * **Database Support:** รองรับทั้ง **PostgreSQL 16** (Production) และ **In-Memory Repository Fallback** (สำหรับการรันทดสอบทันทีโดยไม่ต้องเปิด Docker)
* **Cloud & Static Assets:**
  * **Cloudflare Workers Static Assets:** โฮสต์ภาพบรรยากาศค่ายปีที่แล้วทั้ง 43 รูป (`g01.jpg`–`g43.jpg`) ที่ `https://comcamp25-gallery.sokulshop5.workers.dev/` พร้อมระบบ Automatic Local Fallback (`/assets/gallery/gXX.jpg`)

---

## ส่วนที่ 4: โครงสร้างตารางฐานข้อมูล (PostgreSQL 16 Schema)

อ้างอิงจากไฟล์ Migration จริง [`backend/migrations/000001_init_schema.up.sql`](backend/migrations/000001_init_schema.up.sql):

### 4.1 ตาราง `settings` (ตั้งค่าระบบ — Singleton Row `id = 1`)
| คอลัมน์ | ชนิดข้อมูล | ข้อกำหนด | รายละเอียด |
| :--- | :--- | :--- | :--- |
| `id` | `INT` | `PRIMARY KEY DEFAULT 1` | บังคับมีแถวเดียวด้วย `CHECK (id = 1)` |
| `camp_name` | `VARCHAR(150)` | `NOT NULL DEFAULT 'ComCamp 25th'` | ชื่อโครงการค่าย |
| `registration_open_at` | `TIMESTAMPTZ` | `NOT NULL` | วันเวลาเปิดรับสมัคร (`2026-11-16 00:00:00+07`) |
| `registration_close_at` | `TIMESTAMPTZ` | `NOT NULL` | วันเวลาปิดรับสมัคร (`2026-11-30 23:59:59+07`) |
| `max_capacity` | `INT` | `NOT NULL DEFAULT 30` | โควตารับสมัครสูงสุด (30 ที่นั่ง) |
| `camp_fee` | `DECIMAL(10,2)` | `NOT NULL DEFAULT 0.00` | ค่าธรรมเนียมการเข้าร่วมค่าย |
| `is_manual_closed` | `BOOLEAN` | `NOT NULL DEFAULT false` | สวิตช์ปิดรับสมัครฉุกเฉินโดยแอดมิน |
| `certificate_release_at`| `TIMESTAMPTZ` | `NULLABLE` | วันเวลาเปิดให้ดาวน์โหลดเกียรติบัตร |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | เวลาอัปเดตล่าสุด |

### 4.2 ตาราง `applicants` (ข้อมูลผู้สมัคร)
| คอลัมน์ | ชนิดข้อมูล | ข้อกำหนด | รายละเอียด |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | รหัส UUID อ้างอิงภายใน |
| `application_no` | `VARCHAR(20)` | `UNIQUE, NOT NULL` | รหัสใบสมัครสำหรับผู้ใช้งาน (`CC25-XXXXXX`) |
| `national_id` | `CHAR(13)` | `UNIQUE, NOT NULL` | เลขประจำตัวประชาชน 13 หลัก |
| `prefix` | `VARCHAR(20)` | `NOT NULL` | คำนำหน้าชื่อ |
| `first_name` | `VARCHAR(100)` | `NOT NULL` | ชื่อจริง |
| `last_name` | `VARCHAR(100)` | `NOT NULL` | นามสกุล |
| `nickname` | `VARCHAR(50)` | `NOT NULL` | ชื่อเล่น |
| `birth_date` | `DATE` | `NOT NULL` | วันเกิด (`YYYY-MM-DD` ค.ศ.) |
| `gender` | `VARCHAR(20)` | `NOT NULL` | เพศ |
| `school` | `VARCHAR(150)` | `NOT NULL, INDEX` | ชื่อโรงเรียน / สถาบันการศึกษา |
| `grade` | `VARCHAR(20)` | `NOT NULL` | ระดับชั้น (`ม.4`–`ม.6`, `ปวช.1`–`ปวช.3`) |
| `province` | `VARCHAR(100)` | `NOT NULL` | จังหวัด |
| `phone` | `VARCHAR(20)` | `UNIQUE, NOT NULL` | เบอร์โทรศัพท์มือถือ 10 หลัก |
| `email` | `VARCHAR(150)` | `UNIQUE, NOT NULL` | อีเมลผู้สมัคร |
| `parent_name` | `VARCHAR(150)` | `NULLABLE` | ชื่อ-นามสกุลผู้ปกครอง |
| `parent_relation` | `VARCHAR(50)` | `NULLABLE` | ความสัมพันธ์ของผู้ปกครอง |
| `parent_phone` | `VARCHAR(20)` | `NULLABLE` | เบอร์โทรศัพท์ผู้ปกครอง |
| `emergency_contact` | `VARCHAR(150)` | `NOT NULL` | ชื่อผู้ติดต่อฉุกเฉิน |
| `emergency_phone` | `VARCHAR(20)` | `NOT NULL` | เบอร์โทรศัพท์ฉุกเฉิน |
| `shirt_size` | `VARCHAR(10)` | `NOT NULL` | ขนาดเสื้อ (`XS`, `S`, `M`, `L`, `XL`, `2XL`, `3XL`) |
| `allergies` | `TEXT` | `NULLABLE` | ข้อมูลการแพ้อาหาร / ข้อจำกัดด้านอาหาร |
| `medical_conditions`| `TEXT` | `NULLABLE` | โรคประจำตัว / ยาประจำตัว |
| `has_laptop` | `BOOLEAN` | `NOT NULL DEFAULT false` | สะดวกนำโน้ตบุ๊กส่วนตัวมาหรือไม่ |
| `status` | `VARCHAR(20)` | `NOT NULL DEFAULT 'PENDING'` | `PENDING`, `PASSED`, `RESERVE`, `CONFIRMED`, `REJECTED` |
| `attendance_confirmed`| `BOOLEAN` | `NOT NULL DEFAULT false` | สถานะการกดยืนยันสิทธิ์เข้าร่วมค่าย |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | วันเวลาที่ส่งใบสมัคร |

### 4.3 ตาราง `payments` (ข้อมูลการชำระเงินและสลิป)
| คอลัมน์ | ชนิดข้อมูล | ข้อกำหนด | รายละเอียด |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | รหัสรายการชำระเงิน |
| `applicant_id` | `UUID` | `NOT NULL REFERENCES applicants(id) ON DELETE CASCADE` | ผูกกับผู้สมัครพร้อมลบอัตโนมัติเมื่อลบผู้สมัคร |
| `slip_url` | `TEXT` | `NOT NULL` | พาธหรือ URL ของไฟล์รูปสลิป |
| `amount` | `DECIMAL(10,2)` | `NOT NULL CHECK (amount >= 0)` | ยอดโอนเงิน |
| `status` | `VARCHAR(20)` | `NOT NULL DEFAULT 'PENDING'` | `PENDING`, `APPROVED`, `REJECTED` |
| `slip_hash` | `VARCHAR(64)` | `INDEX, NULLABLE` | ค่าแฮช `SHA-256` ของไฟล์รูปสลิปป้องกันสลิปซ้ำ |
| `admin_note` | `TEXT` | `NULLABLE` | หมายเหตุจากพี่ค่ายผู้ตรวจสอบ |
| `uploaded_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | เวลาที่อัปโหลดสลิป |

### 4.4 ตาราง `admins` และ `audit_logs`
* `admins`: เก็บบัญชีผู้ดูแลระบบ (`id`, `username`, `password_hash`, `full_name`, `role` (`superadmin`, `staff`, `finance`, `reviewer`), `is_active`)
* `audit_logs`: บันทึกประวัติการแก้ไขสถานะและการอนุมัติสลิปของแอดมินทุกครั้ง (`admin_id`, `applicant_id`, `action`, `details`, `ip_address`, `created_at`)

---

## ส่วนที่ 5: ข้อตกลงการเชื่อมต่อ API (Go Backend API Contract)

Base URL: `PUBLIC_API_URL` (ค่าเริ่มต้น: `http://localhost:8000/api`)

### 5.1 ฝั่งสาธารณะ (Public Endpoints)
1. **`GET /api/health`**
   * ตรวจสอบสถานะการทำงานของเซิร์ฟเวอร์ Go (`{ status: "ok", service: "comcamp25-api", time: "..." }`)
2. **`GET /api/settings/public`**
   * คืนค่า: `{ serverTime, registrationOpenAt, isOpen, currentCount, maxCapacity, campFee, isCertificateReleased }`
   * หน้าบ้านใช้ `serverTime` คำนวณ `serverOffsetMs` เสมอเพื่อป้องกันผู้ใช้ตั้งเวลาเครื่องตัวเองล่วงหน้า
3. **`POST /api/applications`**
   * ส่งใบสมัครใหม่ (รองรับ Header `X-Idempotency-Key` ป้องกันการกดส่งซ้ำ)
   * ตรวจสอบเลขบัตรประชาชน 13 หลัก, เบอร์โทร 10 หลัก, ไซส์เสื้อ และเช็กโควตา 30 ที่นั่ง (หากเต็มจะบันทึกเป็นสถานะสำรอง `RESERVE` / `WAITLISTED`)
   * คืนค่ารหัสใบสมัคร `CC25-XXXXXX`
4. **`GET /api/applications/status?q={nationalId|phone|applicationId}`**
   * ค้นหาสถานะใบสมัครด้วยเลขบัตรประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัคร
5. **`POST /api/applications/:id/confirm`**
   * ผู้สมัครกดยืนยันสิทธิ์เข้าร่วมค่าย (`{ confirmed: true }`)
6. **`POST /api/applications/:id/slip`**
   * อัปโหลดไฟล์รูปสลิปโอนเงิน (`multipart/form-data`, ฟิลด์ `slip`, ขนาดไม่เกิน 5MB) พร้อมตรวจ `SHA-256` ป้องกันสลิปซ้ำ

### 5.2 ฝั่งผู้ดูแลระบบพี่ค่าย (Admin Endpoints — Bearer JWT Token)
1. **`POST /api/auth/login`** — รับ `username` และ `password` คืนค่า JWT Token
2. **`GET /api/admin/applications`** — ดึงรายชื่อผู้สมัครทั้งหมดพร้อมสถานะและข้อมูลสลิป
3. **`PATCH /api/admin/applications/:id`** — อัปเดตสถานะผู้สมัครและหมายเหตุแอดมิน
4. **`PATCH /api/admin/applications/:id/verify-slip`** — อนุมัติ (`approved: true` -> เปลี่ยนสถานะเป็น `CONFIRMED`) หรือปฏิเสธสลิป (`approved: false` พร้อมระบุเหตุผล)

---

## ส่วนที่ 6: สถาปัตยกรรมหน้าเว็บไซต์หลัก (`HomePage.astro`) & Design System

หน้าโฮมเพจหลักพัฒนาด้วยระบบธีมสีใหม่ **Lagoon Blue & Bubblegum Pink Palette** (`#78DFF2` Lagoon Blue + `#FCFFFF` Cloud White + `#F285D4` Bubblegum Pink Accent) ที่ให้ความรู้สึกสดใส มีชีวิตชีวา ทันสมัย เหมาะกับค่ายเยาวชน พร้อมคงความชัดเจนของข้อมูลค่ายและฮาร์ดแวร์จริงที่น้องค่ายจะได้ลงมือปฏิบัติ:

* **Lagoon Blue (`#78DFF2`):** ใช้เป็นสีพื้นหลัง Hero Section แบบ Gradient (ไล่เฉดลงสู่ Cloud White), เส้นขอบกล่องการ์ด, และเอฟเฟกต์ Glow ละมุนตา
* **Cloud White (`#FCFFFF` / `#FFFFFF`):** ใช้เป็นสีพื้นผิวการ์ด Bento, พื้นหลังเนื้อหาหลัก, และการ์ดข้อมูลต่างๆ
* **Bubblegum Pink (`#F285D4`):** ใช้เป็นสีปุ่ม Primary CTA (`btn-primary`), หมุดพินสถานะ (`tag-pin`, `hero-date-dot`), จุดสถานะ Stepper และเส้นเน้นสำคัญ
* **Deep Ink (`#0F172A` / `#334155`):** ใช้เป็นสีตัวอักษรหลักเพื่อให้ได้อัตราส่วนคอนทราสต์สูงระดับ AAA บนพื้นสีอ่อนและปุ่มชมพู

### 6.1 โครงสร้าง 7 Sections บนหน้าแรก (`HomePage.astro`)
1. **Navbar & Official Event Logo:**
   * แสดงโลโก้ทางการของ **ComCamp #25** (`/assets/logo/comcamp25-logo-sm.png`) คู่กับชื่อค่าย ลิงก์นำทาง และปุ่มตรวจสอบสถานะ
2. **Section 01 — Hero Section (`#sec-hero`):**
   * **ฝั่งซ้าย (Desktop):** โลโก้ค่าย + Eyebrow *"ComCamp #25 · มหาวิทยาลัยแม่โจ้"*, พาดหัว *"ต่อวงจร เขียนโค้ด สร้างโปรเจกต์ IoT ของตัวเอง"*, คำอธิบายหลักสูตร 3 วัน 2 คืน, ปุ่ม Primary CTA (`ดูรายละเอียดค่าย` ก่อนวันเปิดรับ และเปลี่ยนเป็น `สมัครค่าย` อัตโนมัติเมื่อถึงวันที่ 16 พ.ย. 2569) คู่กับลิงก์ `ตรวจสอบสถานะใบสมัคร →` และบรรทัดสถานะวันเปิดรับสมัคร
   * **ฝั่งขวา (Interactive 3D Hardware Stage `#heroStageCanvas`):** โมเดล 3 มิติแบบหมุนได้ 360° ของบอร์ดจริงที่ใช้เรียนในค่าย มีปุ่มสลับดูระหว่าง **Arduino UNO R3** (`/models/ArduinoR3.glb`) และ **ESP8266 NodeMCU** (`/models/esp8266.glb`) พร้อมป้าย Annotation ชี้จุดพินและชิปประมวลผล และแถบ `HARDWARE KIT` ด้านล่าง
   * **แถบสรุปข้อมูลสำคัญ 4 ช่อง (`hero-facts`):** ระยะเวลา (`3 วัน 2 คืน`), สถานที่ (`ม.แม่โจ้ เชียงใหม่`), จำนวนที่เปิดรับ (`รับ 30 คน`), และกำหนดการรับสมัครพร้อมเวลานับถอยหลังแบบเรียลไทม์
3. **Section 02 — สิ่งที่จะได้ทำจริงในค่าย (`#experience` — Tactile Experience Fan 4 Cards):**
   * แสดงการ์ด 4 โมดูลการเรียนรู้คู่กับภาพผังเทคนิค SVG เฉพาะของแต่ละกิจกรรม (ไม่นำรูปค่ายปีที่แล้วมาปะปน):
     * **01 · ESP8266 Wi-Fi Control:** ผังการปล่อยสัญญาณ `SoftAP / 192.168.4.1` (`SSID: ComCamp25-Node`) เชื่อมต่อกับสมาร์ตโฟนโดยตรง
     * **02 · Arduino UNO R3 & Sensors:** ผังการต่อวงจร Breadboard ร่วมกับเซนเซอร์ `HC-SR04 Ultrasonic`, `LDR A0` และ `Active Buzzer D8`
     * **03 · Live Mobile Web Dashboard:** ผังหน้าจอเว็บ `http://192.168.4.1/dash` แสดงค่าเซนเซอร์เรียลไทม์และปุ่มกดสั่งงาน GPIO
     * **04 · Circuit Sim & AI Workflow:** ผังการจำลองวงจรบน `Autodesk Tinkercad Circuits` ป้องกันการลัดวงจร คู่กับการใช้ AI ช่วยขึ้นโครงสร้างโค้ด
4. **Section 03 — ข้อมูลสำคัญของค่าย (`#essentials` — 2×3 Bento Grid):**
   * สรุป 6 ข้อมูลหลักสำหรับนักเรียนและผู้ปกครอง: คุณสมบัติผู้สมัคร, อุปกรณ์ฮาร์ดแวร์ 1 ชุด/คน, เครื่อง PC ห้องปฏิบัติการ, โควตา 30 ที่นั่ง, สถานที่จัดค่าย และค่าใช้จ่าย
5. **Section 04 — เส้นทางการเรียนรู้ตลอด 3 วัน 2 คืน (`#journey` — 4-Step Progressive Rail):**
   * ไล่เรียงตั้งแต่ `Day 1 Morning (Sense & Simulate)` -> `Day 1 Afternoon (Wired Logic)` -> `Day 2 Full Day (Wireless IoT)` -> `Day 2–3 Finale (Prototype & Main Stage Pitch)`
6. **Section 05 — กำหนดการคัดเลือกและการดูแลผู้เข้าร่วม (`#timeline`):**
   * แสดง 4 ขั้นตอนการสมัครแบบ First-Come, First-Served และการดูแลความปลอดภัยตลอด 24 ชม. (หอพักแยกชาย-หญิง, การดูแลอาหารแพ้/โรคประจำตัว, ช่องทางติดต่ออาจารย์)
7. **Section 06 & 07 — คำถามที่พบบ่อย (`#faq`) และอุโมงค์ภาพความทรงจำ (`#gallery` — 3D Memory Tunnel):**
   * **`#faq`:** ตอบข้อสงสัยเรื่องพื้นฐานการเขียนโค้ด โน้ตบุ๊ก การเดินทาง และเกียรติบัตร
   * **`#gallery` (Memory Tunnel):** แสดงภาพบรรยากาศความทรงจำจากค่ายปีที่แล้ว (ComCamp #24) จำนวน 43 รูป (`g01.jpg`–`g43.jpg`) พุ่งผ่านอวกาศ 3 มิติตามจังหวะการเลื่อนหน้าจอ (โหลดจาก Cloudflare CDN `https://comcamp25-gallery.sokulshop5.workers.dev/`)

---

## ส่วนที่ 7: การตั้งค่าสภาพแวดล้อมและการรันระบบ (Environment & Commands)

### 7.1 ไฟล์ `.env` สำหรับ Frontend (`frontend/.env`)
```env
PUBLIC_API_URL=http://localhost:8000/api
PUBLIC_GALLERY_BASE_URL=https://comcamp25-gallery.sokulshop5.workers.dev/
```

### 7.2 คำสั่งรันระบบสำหรับนักพัฒนา
```bash
# 1. รันฐานข้อมูล PostgreSQL 16 (Optional — หากไม่รัน Go Backend จะสลับไปใช้ In-Memory Store อัตโนมัติ)
docker compose up -d

# 2. รัน Go Backend API (พอร์ต 8000)
cd backend
go run ./cmd/api

# 3. รัน Astro Frontend (พอร์ต 4321)
cd frontend
npm install
npm run dev

# 4. ทดสอบ Production Build ของ Frontend
cd frontend
npm run build
```

---

## ส่วนที่ 8: เช็กลิสต์ก่อนเปิดรับสมัครจริง (Pre-Launch Checklist)

- [x] **หน้าโฮมเพจและ Hero Section:** แสดงโลโก้ ComCamp #25, โมเดล 3D บอร์ด `Arduino UNO R3` และ `ESP8266 NodeMCU` หมุนได้จริง, และผังกิจกรรม SVG ทั้ง 4 การ์ดตรงตามหลักสูตรปีนี้
- [x] **แยกแยะรูปภาพชัดเจน:** รูปค่ายปีที่แล้ว (`g01.jpg`–`g43.jpg`) แสดงเฉพาะในส่วน `#gallery` (Memory Tunnel) เท่านั้น และโหลดผ่าน Cloudflare Workers CDN พร้อม Local Fallback
- [x] **ระบบนับถอยหลังและ State Machine:** ซิงค์เวลากับ `GET /api/settings/public` สู่วันเปิดรับสมัคร `16 พฤศจิกายน 2569 เวลา 00:00:00 น.`
- [x] **ระบบหลังบ้าน Go & PostgreSQL Schema:** รองรับการสมัคร การเช็กสถานะ และการอัปโหลดสลิปพร้อมตรวจ `SHA-256`
- [ ] **ข้อมูลทางการที่รอเติมก่อนวันเปิดรับสมัคร:**
  - วันที่จัดค่ายจริง (3 วัน 2 คืน)
  - ยอดค่าสมัครค่ายและเลขบัญชีธนาคารสำหรับโอนเงินยืนยันสิทธิ์
  - ชื่อห้องปฏิบัติการ อาคารเรียน หอพัก และเบอร์โทรศัพท์ติดต่ออาจารย์ผู้รับผิดชอบโครงการ
