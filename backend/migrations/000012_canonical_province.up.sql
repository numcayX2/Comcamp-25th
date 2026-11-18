-- ComCamp 25th - applicants.province uses the official name of one of the 77 Thai provinces.
--  * The form now offers only the official list (frontend/src/lib/provinces.ts) and the backend
--    accepts only those names (backend/internal/service/provinces.go). Rows typed before that are
--    mapped here with the same rules as the backend: a "จังหวัด" / "จ." prefix and spaces are
--    dropped, and the short forms กทม / กทม. / กรุงเทพ / กรุงเทพฯ / อยุธยา / โคราช are expanded.
--  * A value that matches no province is left exactly as it is: staff can correct it in /admin,
--    and the backend accepts an unchanged stored value on any other edit.
--  * Data only, no schema change: the current and the previous backend build both run on either
--    side of it, so it can be applied while the backend is up.
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000012_canonical_province.up.sql

BEGIN;

WITH official(name) AS (
  VALUES
    ('กรุงเทพมหานคร'), ('กระบี่'), ('กาญจนบุรี'), ('กาฬสินธุ์'), ('กำแพงเพชร'), ('ขอนแก่น'), ('จันทบุรี'),
    ('ฉะเชิงเทรา'), ('ชลบุรี'), ('ชัยนาท'), ('ชัยภูมิ'), ('ชุมพร'), ('เชียงราย'), ('เชียงใหม่'), ('ตรัง'), ('ตราด'),
    ('ตาก'), ('นครนายก'), ('นครปฐม'), ('นครพนม'), ('นครราชสีมา'), ('นครศรีธรรมราช'), ('นครสวรรค์'), ('นนทบุรี'),
    ('นราธิวาส'), ('น่าน'), ('บึงกาฬ'), ('บุรีรัมย์'), ('ปทุมธานี'), ('ประจวบคีรีขันธ์'), ('ปราจีนบุรี'), ('ปัตตานี'),
    ('พระนครศรีอยุธยา'), ('พะเยา'), ('พังงา'), ('พัทลุง'), ('พิจิตร'), ('พิษณุโลก'), ('เพชรบุรี'), ('เพชรบูรณ์'),
    ('แพร่'), ('ภูเก็ต'), ('มหาสารคาม'), ('มุกดาหาร'), ('แม่ฮ่องสอน'), ('ยโสธร'), ('ยะลา'), ('ร้อยเอ็ด'), ('ระนอง'),
    ('ระยอง'), ('ราชบุรี'), ('ลพบุรี'), ('ลำปาง'), ('ลำพูน'), ('เลย'), ('ศรีสะเกษ'), ('สกลนคร'), ('สงขลา'), ('สตูล'),
    ('สมุทรปราการ'), ('สมุทรสงคราม'), ('สมุทรสาคร'), ('สระแก้ว'), ('สระบุรี'), ('สิงห์บุรี'), ('สุโขทัย'),
    ('สุพรรณบุรี'), ('สุราษฎร์ธานี'), ('สุรินทร์'), ('หนองคาย'), ('หนองบัวลำภู'), ('อ่างทอง'), ('อำนาจเจริญ'),
    ('อุดรธานี'), ('อุตรดิตถ์'), ('อุทัยธานี'), ('อุบลราชธานี')
),
alias(short, name) AS (
  VALUES
    ('กทม', 'กรุงเทพมหานคร'), ('กทม.', 'กรุงเทพมหานคร'), ('กรุงเทพ', 'กรุงเทพมหานคร'),
    ('กรุงเทพฯ', 'กรุงเทพมหานคร'), ('อยุธยา', 'พระนครศรีอยุธยา'), ('โคราช', 'นครราชสีมา')
),
keyed AS (
  SELECT id, province,
         replace(regexp_replace(btrim(province), '^(จังหวัด|จ\.)', ''), ' ', '') AS key
  FROM applicants
),
mapped AS (
  SELECT k.id, COALESCE(o.name, a.name) AS name
  FROM keyed k
  LEFT JOIN official o ON o.name = k.key
  LEFT JOIN alias a ON a.short = k.key
  WHERE COALESCE(o.name, a.name) IS NOT NULL AND COALESCE(o.name, a.name) <> k.province
)
UPDATE applicants ap
SET province = m.name
FROM mapped m
WHERE ap.id = m.id;

COMMIT;
