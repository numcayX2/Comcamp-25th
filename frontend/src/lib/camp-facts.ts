/**
 * Confirmed camp facts (AGENTS.md §0.3) — the single build-time fallback for every page.
 *
 * Live values always come from GET /api/settings/public (registrationOpenAt, registrationCloseAt,
 * maxCapacity, campFee); these constants only fill the server-rendered HTML and the offline
 * fallback. public/theme/main.js receives them through window.__CC25_DEFAULTS__ (HomePage.astro).
 */
export const REGISTRATION_OPEN_AT = '2026-11-19T09:00:00+07:00';
// Owner extended the close date in /admin on 2026-11-20 (was 18 ธ.ค. 23:59:59).
export const REGISTRATION_CLOSE_AT = '2026-12-19T23:59:00+07:00';
export const MAX_CAPACITY = 40;
export const CAMP_FEE = 1200;
/** "1,200" — fallback text until the live campFee arrives. */
export const CAMP_FEE_TEXT = CAMP_FEE.toLocaleString('en-US');

/**
 * Downloadable documents in public/assets/docs/ start as empty placeholders. Download buttons stay
 * hidden until the real files replace them (same file name) and this flag is flipped to true.
 * Bump `?v=` whenever the file is replaced: Cloudflare caches /assets for hours.
 */
export const DOCS_READY = false;
export const PARENT_CONSENT_PDF = '/assets/docs/parent-consent.pdf?v=1';

/** Sponsor deck for /sponsor. Same rule as DOCS_READY: the download stays hidden until the file exists. */
export const SPONSOR_DECK_READY = false;
export const SPONSOR_DECK_PDF = '/assets/docs/sponsor-deck.pdf?v=1';

/**
 * Faculty donation form (แบบฟอร์มบริจาคเงิน) for /sponsor: the sponsor fills and signs it, then
 * either sends the file through the inquiry form (POST /api/sponsor-inquiries/upload) or hands it
 * to staff. The real file is in place, so the download is always shown. Bump `?v=` on replace.
 */
export const SPONSOR_FORM_PDF = '/assets/docs/sponsor-donation-form.pdf?v=1';
/** Name the browser saves the form under (the `download` attribute). */
export const SPONSOR_FORM_FILENAME = 'แบบฟอร์มบริจาค-ComCamp25.pdf';

const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

interface BangkokParts {
  day: number;
  month: number;
  beYear: number;
  hour: number;
  minute: number;
}

/** Calendar parts in Asia/Bangkok (UTC+7 all year, no DST). Invalid input falls back to the opening time. */
function bangkokParts(at: string | number): BangkokParts {
  let ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) ms = Date.parse(REGISTRATION_OPEN_AT);
  const d = new Date(ms + BANGKOK_OFFSET_MS);
  return {
    day: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    beYear: d.getUTCFullYear() + 543,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "19 พ.ย." */
export function formatThaiDateNoYear(at: string | number): string {
  const p = bangkokParts(at);
  return `${p.day} ${THAI_MONTHS_SHORT[p.month - 1]}`;
}

/** "19 พ.ย. 69" */
export function formatThaiDateShort(at: string | number): string {
  const p = bangkokParts(at);
  return `${p.day} ${THAI_MONTHS_SHORT[p.month - 1]} ${pad2(p.beYear % 100)}`;
}

/** "19 ธ.ค. 2569" */
export function formatThaiDateFull(at: string | number): string {
  const p = bangkokParts(at);
  return `${p.day} ${THAI_MONTHS_SHORT[p.month - 1]} ${p.beYear}`;
}

/** "19.11.69" */
export function formatThaiDateDot(at: string | number): string {
  const p = bangkokParts(at);
  return `${pad2(p.day)}.${pad2(p.month)}.${pad2(p.beYear % 100)}`;
}

/** "09:00" */
export function formatBangkokTime(at: string | number): string {
  const p = bangkokParts(at);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}
