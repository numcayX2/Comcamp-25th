import { CircleCheck, TriangleAlert } from 'lucide-react';
import { ApiHttpError, normalizeThaiDigits, stripZeroWidth } from '../../lib/api';
import { DANGER, INK, SUCCESS, SURFACE_SUBTLE } from '../admin-ui';

/** Shared pieces of the /admin sponsor inquiry, donation and notify-email panels. */

export type Notice = { kind: 'ok' | 'error'; text: string } | null;

export const UNKNOWN_ERROR = 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';

/** Thai message for an API failure. `validation` replaces the generic VALIDATION_ERROR text. */
export function sponsorErrorText(
  err: unknown,
  fallback: string,
  opts: { context?: 'list' | 'item'; validation?: string } = {},
): string {
  if (err instanceof ApiHttpError) {
    if (err.status === 401 || err.status === 403) return 'เซสชันหมดอายุหรือไม่เพียงพอ กรุณาเข้าสู่ระบบใหม่';
    if (err.code === 'PAYLOAD_TOO_LARGE' || err.status === 413) return 'ไฟล์ใหญ่เกิน 8 MB';
    if (err.code === 'INVALID_IMAGE_DIMENSIONS') return 'ขนาดรูปไม่ถูกต้อง (ต้องไม่เกิน 10000×10000 px)';
    if (err.code === 'NOT_FOUND' || err.status === 404) {
      return opts.context === 'list'
        ? 'โหลดข้อมูลไม่สำเร็จ (เซิร์ฟเวอร์ยังไม่รองรับหรือบริการไม่พร้อม) ลองรีเฟรชหน้าหรือแจ้งผู้ดูแลระบบ'
        : 'ไม่พบรายการนี้ อาจถูกลบไปแล้ว ระบบโหลดรายการใหม่แล้ว';
    }
    if (err.status === 429) {
      return err.retryAfterSeconds
        ? `ส่งคำขอบ่อยเกินไป กรุณารอ ${err.retryAfterSeconds} วินาทีแล้วลองใหม่`
        : 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
    if (err.code === 'VALIDATION_ERROR') return opts.validation ?? 'ข้อมูลไม่ถูกต้องตามเงื่อนไข';
    if (err.status >= 500) return 'เซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่';
  }
  if (err instanceof Error && err.name === 'AbortError') return 'หมดเวลาเชื่อมต่อ กรุณาลองใหม่';
  if (err instanceof Error && (err.message.includes('fetch') || err.message.includes('network'))) {
    return 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสัญญาณอินเทอร์เน็ต';
  }
  return fallback;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiHttpError && (err.code === 'NOT_FOUND' || err.status === 404);
}

/** Moves focus once React has committed the next render (the target may not exist yet). */
export function focusLater(id: string, fallbackId?: string) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el && !el.disabled && !el.closest('[hidden]')) el.focus();
    else if (fallbackId) document.getElementById(fallbackId)?.focus();
  });
}

export function NoticeBanner({ notice }: { notice: NonNullable<Notice> }) {
  return (
    <p
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className="flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm leading-6"
      style={{
        borderColor: notice.kind === 'error' ? DANGER : SUCCESS,
        backgroundColor: SURFACE_SUBTLE,
        color: notice.kind === 'error' ? DANGER : INK,
      }}
    >
      {notice.kind === 'ok' ? (
        <CircleCheck aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: SUCCESS }} />
      ) : (
        <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: DANGER }} />
      )}
      <span>{notice.text}</span>
    </p>
  );
}

const BANGKOK_DATETIME = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  dateStyle: 'medium',
  timeStyle: 'short',
});
const BANGKOK_DATE = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' });
const BANGKOK_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });

export function formatBangkokDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : BANGKOK_DATETIME.format(d);
}

/** "YYYY-MM-DD" (a calendar date, no zone) → short Thai date; "" stays "". */
export function formatYmdShort(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  // Noon UTC is the same calendar day in Bangkok.
  return BANGKOK_DATE.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)));
}

/** Today's calendar date in Bangkok as "YYYY-MM-DD". */
export function todayBangkokYmd(): string {
  return BANGKOK_YMD.format(new Date());
}

/** Decimal string → satang as BigInt; null when it is not a plain non-negative decimal. */
export function toSatang(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/** Satang → "1,200" or "1,500.50" (two decimals only when there are satang). */
export function formatSatang(satang: bigint): string {
  const baht = (satang / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = satang % 100n;
  return rest === 0n ? baht : `${baht}.${rest.toString().padStart(2, '0')}`;
}

/** Decimal amount string from the API → "1,200"; unparsable values are shown as given. */
export function formatAmount(amount: string): string {
  const s = toSatang(amount);
  return s === null ? amount : formatSatang(s);
}

/** Stored digits → readable groups: mobile 081-234-5678, Bangkok 02-123-4567, provincial 053-873-000. */
export function formatPhone(digits: string): string {
  if (/^0\d{9}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (/^02\d{7}$/.test(digits)) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
  if (/^0\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

/** Typed amount → plain decimal string ("1,200.50" → "1200.50"): Thai digits, commas, spaces removed. */
export function normalizeAmountInput(raw: string): string {
  return normalizeThaiDigits(stripZeroWidth(raw)).replace(/[,\s]/g, '').replace(/^0+(?=\d)/, '');
}

/** Control characters other than tab/newline (the API rejects them in free text). */
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const runeLength = (s: string) => [...s].length;
