/**
 * Thai 13-digit national ID / juristic tax ID validation & formatting, postcode validation, and
 * structured Thai address formatting for /sponsor and /admin#sponsors.
 * Pure functions, no DOM: unit-tested with `node --test`.
 */

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const SEPARATORS_RE = /[-\u2010-\u2015\u2212\s]/g;

function normalizeThaiDigitsLocal(raw: string): string {
  return raw.replace(/[\u0E50-\u0E59]/g, (ch) => String(ch.charCodeAt(0) - 0x0e50));
}

/**
 * Strips zero-width chars, converts Thai digits (๐–๙) to ASCII, and removes hyphens/spaces.
 * Letters and other characters are kept so callers reject invalid input rather than stripping them.
 */
export function normalizeThaiTaxId(raw: string): string {
  return normalizeThaiDigitsLocal(raw.replace(ZERO_WIDTH_RE, '')).replace(SEPARATORS_RE, '');
}

/**
 * Validates a 13-digit Thai national ID or juristic tax ID (both share the same modulo-11 rule):
 * sum(d[i] * (13 - i), i = 0..11), check = (11 - sum % 11) % 10 === d[12].
 */
export function isValidThaiTaxId(raw: string): boolean {
  const digits = normalizeThaiTaxId(raw);
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += (digits.charCodeAt(i) - 48) * (13 - i);
  }
  const check = (11 - (sum % 11)) % 10;
  return check === digits.charCodeAt(12) - 48;
}

/** Formats 13 digits into the standard X-XXXX-XXXXX-XX-X groups; returns raw unchanged otherwise. */
export function formatThaiTaxId(raw: string): string {
  const digits = normalizeThaiTaxId(raw);
  if (!/^\d{13}$/.test(digits)) return raw;
  return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
}

/** Trims, strips zero-width chars, and converts Thai digits to ASCII without removing internal symbols. */
export function normalizePostcode(raw: string): string {
  return normalizeThaiDigitsLocal(raw.replace(ZERO_WIDTH_RE, '')).trim();
}

export function isValidPostcode(raw: string): boolean {
  return /^\d{5}$/.test(normalizePostcode(raw));
}

export interface ThaiAddressParts {
  addressLine?: string;
  subdistrict?: string;
  district?: string;
  province?: string;
  postcode?: string;
}

/**
 * Joins structured Thai address fields into one readable line:
 * - Bangkok uses แขวง / เขต and bare "กรุงเทพมหานคร".
 * - Other provinces use ต. / อ. / จ. unless the field already carries a Thai administrative prefix.
 * Returns "" when every part is empty.
 */
export function formatThaiAddress(parts: ThaiAddressParts): string {
  const line = (parts.addressLine ?? '').trim();
  const sub = (parts.subdistrict ?? '').trim();
  const dist = (parts.district ?? '').trim();
  const prov = (parts.province ?? '').trim();
  const post = (parts.postcode ?? '').trim();

  const isBangkok = prov === 'กรุงเทพมหานคร';
  const out: string[] = [];
  if (line) out.push(line);
  if (sub) {
    out.push(/^(แขวง|ต\.|ตำบล)/.test(sub) ? sub : `${isBangkok ? 'แขวง' : 'ต.'}${sub}`);
  }
  if (dist) {
    out.push(/^(เขต|อ\.|อำเภอ)/.test(dist) ? dist : `${isBangkok ? 'เขต' : 'อ.'}${dist}`);
  }
  if (prov) {
    out.push(isBangkok || /^(จ\.|จังหวัด)/.test(prov) ? prov : `จ.${prov}`);
  }
  if (post) out.push(post);
  return out.join(' ');
}
