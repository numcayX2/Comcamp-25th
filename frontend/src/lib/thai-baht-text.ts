/**
 * Thai money wording and long dates for the printed sponsor donation form (/admin).
 * Pure functions, no DOM: unit-tested with `node --test`.
 */

const DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const UNITS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/**
 * Reads up to six digits (no leading-zero requirement). `afterHigher` is true when a non-zero part
 * is read before this group (e.g. the millions), so a lone trailing 1 becomes "เอ็ด".
 */
function readGroup(digits: string, afterHigher: boolean): string {
  let out = '';
  let seenNonZero = afterHigher;
  const len = digits.length;
  for (let i = 0; i < len; i++) {
    const d = digits.charCodeAt(i) - 48;
    const pos = len - 1 - i;
    if (d === 0) continue;
    if (pos === 0) out += d === 1 && seenNonZero ? 'เอ็ด' : DIGITS[d];
    else if (pos === 1) out += (d === 1 ? '' : d === 2 ? 'ยี่' : DIGITS[d]) + 'สิบ';
    else out += DIGITS[d] + UNITS[pos];
    seenNonZero = true;
  }
  return out;
}

/** Reads a non-negative integer given as a digit string; millions are read recursively. */
function readInteger(digits: string): string {
  const s = digits.replace(/^0+/, '');
  if (!s) return '';
  if (s.length <= 6) return readGroup(s, false);
  const high = s.slice(0, -6);
  const low = s.slice(-6);
  return readInteger(high) + 'ล้าน' + readGroup(low, true);
}

/**
 * Thai wording of a baht amount, e.g. 1200 → "หนึ่งพันสองร้อยบาทถ้วน",
 * 1500.5 → "หนึ่งพันห้าร้อยบาทห้าสิบสตางค์", 0.25 → "ยี่สิบห้าสตางค์".
 * Accepts numbers or decimal strings (commas/spaces ignored); fractions are rounded half-up to
 * satang. Returns "" for empty, negative or non-numeric input.
 */
export function bahtText(amount: string | number): string {
  let raw: string;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount < 0) return '';
    raw = amount.toFixed(2);
  } else {
    raw = amount.replace(/[,\s]/g, '');
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m || (!m[1] && !m[2])) return '';
  const frac = (m[2] ?? '').padEnd(3, '0');
  let cents = BigInt(m[1] || '0') * 100n + BigInt(frac.slice(0, 2));
  if (frac.charCodeAt(2) - 48 >= 5) cents += 1n;

  const baht = (cents / 100n).toString();
  const satang = Number(cents % 100n);
  const bahtWords = readInteger(baht);

  if (satang === 0) return `${bahtWords || DIGITS[0]}บาทถ้วน`;
  const satangWords = `${readGroup(String(satang), false)}สตางค์`;
  return bahtWords ? `${bahtWords}บาท${satangWords}` : satangWords;
}

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

/** "2026-11-21" → "21 พฤศจิกายน 2569" (Buddhist year). "" for anything that is not a real date. */
export function formatThaiLongDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  return `${day} ${THAI_MONTHS[month - 1]} ${year + 543}`;
}
