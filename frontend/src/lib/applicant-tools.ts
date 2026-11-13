/**
 * Pure helpers for the /admin ledger: search matching, the CSV export and shared labels.
 * Kept out of the component so they can be checked without rendering React.
 */
import {
  hasSlip,
  sanitizeDigits,
  stripZeroWidth,
  type Application,
  type ApplicationStatus,
  type SlipStatus,
} from './api';

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอพิจารณา',
  PASSED: 'ได้สิทธิ์แล้ว',
  RESERVE: 'ตัวสำรอง',
  CONFIRMED: 'ยืนยันสิทธิ์สมบูรณ์',
  REJECTED: 'ไม่ผ่าน',
  REFUND_PENDING: 'รอคืนเงิน',
  REFUNDED: 'คืนเงินแล้ว',
};

/** Payment-slip state as staff read it. */
export const SLIP_LABELS: Record<SlipStatus, string> = {
  PENDING: 'รอตรวจ',
  APPROVED: 'อนุมัติแล้ว',
  REJECTED: 'ถูกปฏิเสธ',
};

export const NO_SLIP_LABEL = 'ยังไม่มีสลิป';

/** Slip column text: a missing slip is reported as such, not as a pending one. */
export function slipLabel(app: Application): string {
  if (!hasSlip(app)) return NO_SLIP_LABEL;
  return SLIP_LABELS[app.slipStatus ?? 'PENDING'];
}

/**
 * Case-insensitive match on the fields staff search by: ID, name, nickname, phone, email, school,
 * province and (when unmasked) national ID. Zero-width characters, Thai numerals and surrounding
 * spaces are normalised. A query made only of digits, spaces and hyphens also matches phone and
 * unmasked national ID written without them (081-234 finds 0812345678).
 */
export function matchesApplicantQuery(app: Application, rawQuery: string): boolean {
  const q = stripZeroWidth(rawQuery).trim().toLowerCase();
  if (!q) return true;

  const fields = [
    app.id,
    app.fullName,
    app.nickname ?? '',
    app.phone,
    app.email ?? '',
    app.school,
    app.province ?? '',
  ];
  if (fields.some((f) => stripZeroWidth(f).toLowerCase().includes(q))) return true;

  const digits = sanitizeDigits(q);
  if (digits.length > 0 && /^[\d๐-๙\s-]+$/.test(q)) {
    const phoneMatch = sanitizeDigits(app.phone).includes(digits);
    const nidMatch = !/x/i.test(app.nationalId) && sanitizeDigits(app.nationalId).includes(digits);
    return phoneMatch || nidMatch;
  }
  return false;
}

/* ── CSV export ───────────────────────────────────────────────────────── */

export const CSV_HEADERS = [
  'รหัสใบสมัคร',
  'ชื่อ-นามสกุล',
  'ชื่อเล่น',
  'เลขประจำตัวประชาชน',
  'เบอร์โทรศัพท์',
  'อีเมล',
  'โรงเรียน',
  'ระดับชั้น',
  'จังหวัด',
  'ไซส์เสื้อ',
  'สถานะ',
  'ยืนยันสิทธิ์',
  'สถานะสลิป',
  'วันที่สมัคร',
  'เหตุผลการสมัคร',
] as const;

/** A leading = + - @ or tab/CR makes Excel evaluate the cell as a formula (CSV injection). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV text field, quoted when needed. Formula-like text gets a leading apostrophe. */
function csvField(value: string): string {
  let s = stripZeroWidth(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Phone and national ID are digit strings that Excel would otherwise mangle: the leading 0 of a
 * phone disappears and a 13-digit ID becomes 1.5099E+12. Writing them as ="…" keeps them as text.
 */
function csvDigits(value: string): string {
  const d = sanitizeDigits(value);
  return d ? `"=""${d}"""` : '';
}

/**
 * The national ID column. If a masked value (1-5099-XXXXX-XX-X) is ever passed, stripping that down
 * to its digits would export the misleading number 15099, so a value with a mask in it is written
 * as the text it is.
 */
function csvNationalId(value: string): string {
  return /x/i.test(value) ? csvField(value) : csvDigits(value);
}

const BANGKOK_DATETIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatCreated(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : BANGKOK_DATETIME.format(t);
}

/**
 * Builds the export. The string starts with a UTF-8 BOM (U+FEFF) so Excel on Windows reads the
 * Thai text as UTF-8 instead of guessing a code page. Rows end in CRLF, which Excel expects.
 */
export function buildApplicantsCsv(rows: Application[]): string {
  const lines: string[] = [CSV_HEADERS.map(csvField).join(',')];
  for (const a of rows) {
    lines.push(
      [
        csvField(a.id),
        csvField(a.fullName),
        csvField(a.nickname ?? ''),
        csvNationalId(a.nationalId),
        csvDigits(a.phone),
        csvField(a.email ?? ''),
        csvField(a.school),
        csvField(a.grade),
        csvField(a.province ?? ''),
        csvField(a.shirtSize),
        csvField(STATUS_LABELS[a.status]),
        csvField(a.attendanceConfirmed ? 'ยืนยันแล้ว' : 'ยังไม่ยืนยัน'),
        csvField(slipLabel(a)),
        csvField(formatCreated(a.createdAt)),
        csvField(a.motivation ?? ''),
      ].join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** comcamp25-applicants-YYYY-MM-DD.csv, dated by the staff member's clock. */
export function csvFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `comcamp25-applicants-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}

/** Saves the content as a file through a temporary link. */
export function downloadCsv(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
