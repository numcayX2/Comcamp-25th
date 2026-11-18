/**
 * The 77 provinces of Thailand (76 provinces plus Bangkok), official names in Thai dictionary
 * order. The backend accepts only these names (backend/internal/service/provinces.go holds the
 * same list and the same short forms), so keep the two in sync.
 */
export const PROVINCES = [
  'กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี',
  'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด',
  'ตาก', 'นครนายก', 'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี',
  'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี',
  'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์',
  'แพร่', 'ภูเก็ต', 'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง',
  'ระยอง', 'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล',
  'สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย',
  'สุพรรณบุรี', 'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ',
  'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี',
] as const;

const PROVINCE_SET: ReadonlySet<string> = new Set(PROVINCES);

/** Common short forms, expanded to the official name (same as the backend). */
const ALIASES: Record<string, string> = {
  'กทม': 'กรุงเทพมหานคร',
  'กทม.': 'กรุงเทพมหานคร',
  'กรุงเทพ': 'กรุงเทพมหานคร',
  'กรุงเทพฯ': 'กรุงเทพมหานคร',
  'อยุธยา': 'พระนครศรีอยุธยา',
  'โคราช': 'นครราชสีมา',
};

/** Search key: no zero-width characters, spaces, or "จังหวัด" / "จ." prefix. */
function keyOf(s: string): string {
  return s
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/^(จังหวัด|จ\.)/, '')
    .replace(/\s+/g, '');
}

export function isProvince(s: string): boolean {
  return PROVINCE_SET.has(s);
}

/** The official name for a typed value ("จ. ลำปาง", "กทม"), or null when it names no province. */
export function canonicalProvince(s: string): string | null {
  const key = keyOf(s);
  if (PROVINCE_SET.has(key)) return key;
  return ALIASES[key] ?? null;
}

/** Provinces matching a search: names that start with it first, then names that contain it. */
export function searchProvinces(query: string): string[] {
  const key = keyOf(query);
  if (!key) return [...PROVINCES];
  const alias = Object.entries(ALIASES)
    .filter(([short]) => short.startsWith(key))
    .map(([, name]) => name);
  const starts = PROVINCES.filter((p) => p.startsWith(key));
  const contains = PROVINCES.filter((p) => !p.startsWith(key) && p.includes(key));
  return [...new Set([...alias, ...starts, ...contains])];
}
