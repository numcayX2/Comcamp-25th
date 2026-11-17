import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import '../styles/status.css';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Hourglass,
  Info,
  ListOrdered,
  MapPin,
  Pencil,
  Phone,
  Receipt,
  RotateCcw,
  Ticket,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  ApiHttpError,
  fetchPublicSettings,
  getApplicationStatus,
  updateOwnProfile,
  withdrawApplication,
  hasSlip,
  holdsSeat,
  normalizeLookupQuery,
  type Application,
  type ApplicationStatus,
  type ApiSource,
  type ShirtSize,
} from '../lib/api';
import {
  DORM_MAPS_URL,
  DORM_NAME,
  FB_URL,
  FEE_TEXT,
  GRADES,
  GRADE_OTHER,
  GRADE_OTHER_MAX,
  LINE_OPENCHAT_QR_SRC,
  LINE_OPENCHAT_URL,
  NICKNAME_MAX,
  PROJECT_ADVISOR,
  PROVINCE_MAX,
  SCHOOL_MAX,
  SEATS,
  SHIRT_SIZES,
  SIZE_CHEST,
  SIZE_LENGTH,
  STAFF_CONTACTS,
  cleanSingleLine,
  describePaymentDeadline,
  formatCampFee,
  gradeValue,
  isValidThaiNationalID,
  splitGrade,
  validateGradeFields,
} from './register/model';
import { clearReceipt, loadReceipt } from './register/storage';
import { cleanNationalIdInput, describeApiError as describeError, describeVerifyLock } from '../lib/slip-upload';
import { NO_QR_NOTE, PAY_ACCOUNT, PAY_ACCOUNT_DIGITS, copyText } from '../lib/payment';
import { SlipUploadPanel } from './slip/SlipUploadPanel';
import { VerifyCodeField } from './slip/VerifyCodeField';

/* Status colours are tokens from global.css, so light and dark both follow the theme. */
const STATUS_DOT: Record<ApplicationStatus, string> = {
  PENDING: 'var(--color-warning)',
  PASSED: 'var(--color-tech)',
  RESERVE: 'var(--color-ink-subtle)',
  CONFIRMED: 'var(--color-success)',
  REJECTED: 'var(--color-danger)',
  REFUND_PENDING: 'var(--color-warning)',
  REFUNDED: 'var(--color-ink-subtle)',
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอพิจารณา',
  PASSED: 'ได้รับสิทธิ์แล้ว',
  RESERVE: 'ตัวสำรอง',
  CONFIRMED: 'ยืนยันสิทธิ์สำเร็จ',
  REJECTED: 'ไม่ผ่านการคัดเลือก',
  REFUND_PENDING: 'รอคืนเงิน',
  REFUNDED: 'คืนเงินแล้ว',
};

const INK = 'var(--color-ink)';
const INK_MUTED = 'var(--color-ink-muted)';
const INK_SUBTLE = 'var(--color-ink-subtle)';
const RULE = 'var(--color-border)';
const SURFACE = 'var(--bg-card)';
const SURFACE_SUBTLE = 'var(--bg-surface)';
const BORDER_INPUT = 'var(--color-border-input)';
const BTN_DARK = 'var(--color-btn-dark)';
const BTN_DARK_TEXT = 'var(--color-btn-dark-text)';

/**
 * Full-pill badge with a status dot (no side stripe, AGENTS.md section 6.1). Borderless and tinted
 * by the state colour: outlines are kept for clickable buttons. Ink text keeps >=4.5:1 in both themes.
 */
function DotPill({ color, mono, children }: { color: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${mono ? 'font-mono tabular-nums' : ''}`}
      style={{ color: INK, backgroundColor: `color-mix(in srgb, ${color} 16%, ${SURFACE})` }}
    >
      <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

function StatusTag({ status }: { status: ApplicationStatus }) {
  return (
    <DotPill color={STATUS_DOT[status] ?? INK_SUBTLE}>
      {STATUS_LABELS[status] || status}
    </DotPill>
  );
}

/* ── Status highlight: what a student or parent needs to know, at a glance ─────────────── */

type Tone = 'tech' | 'warning' | 'danger' | 'success' | 'neutral';

const TONE_COLOR: Record<Tone, string> = {
  tech: 'var(--color-tech)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  success: 'var(--color-success)',
  neutral: 'var(--color-ink-subtle)',
};

interface Highlight {
  tone: Tone;
  icon: LucideIcon;
  badge: string;
  title: string;
  body: string;
  /** Jump to the payment section. */
  toSlip?: boolean;
  /** Jump to the LINE OpenChat section. */
  toLine?: boolean;
  /** Show camp dates, dorm & Google Maps link (for confirmed seats). */
  showCampDetails?: boolean;
  /** Offer the staff Facebook page and phone numbers. */
  contact?: boolean;
}

/** One place that decides the headline for every status / slip combination. */
function describeHighlight(app: Application, seats: number, feeText: string, nowMs: number): Highlight {
  const slip = hasSlip(app) ? (app.slipStatus ?? 'PENDING') : null;

  switch (app.status) {
    case 'CONFIRMED':
      if (slip === 'APPROVED') return confirmedHighlight();
      if (slip === 'PENDING') {
        return {
          tone: 'warning',
          icon: Clock,
          badge: 'ยืนยันสิทธิ์แล้ว · รอตรวจสลิป',
          title: 'สถานะยืนยันสิทธิ์แล้ว (อยู่ระหว่างรอทีมงานตรวจสลิป)',
          body: 'ทีมงานได้รับสลิปเรียบร้อยแล้ว กำลังตรวจสอบหลักฐานการโอนเงินให้โดยเร็วที่สุด น้องสามารถเข้ากลุ่ม LINE OpenChat ด้านล่างเพื่อรอรับข่าวสารได้เลย',
          toLine: true,
          showCampDetails: true,
        };
      }
      if (slip === 'REJECTED') {
        return {
          tone: 'danger',
          icon: TriangleAlert,
          badge: 'สลิปไม่ผ่าน',
          title: 'สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดสลิปใหม่',
          body: `โปรดตรวจสอบยอดโอน ${feeText} บาท และความชัดเจนของรูป แล้วอัปโหลดสลิปใหม่ที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่าง`,
          toSlip: true,
          contact: true,
        };
      }
      return {
        tone: 'success',
        icon: CircleCheck,
        badge: 'ยืนยันสิทธิ์แล้ว · ยังไม่พบสลิปในระบบ',
        title: 'สถานะยืนยันสิทธิ์แล้ว (ยังไม่พบสลิปค่าสมัครในระบบ)',
        body: `ระบบยังไม่มีสลิปค่าสมัครสำหรับใบสมัครนี้ หากยังไม่ได้ส่งสลิป กรุณาโอนค่าสมัคร ${feeText} บาท และอัปโหลดสลิปที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่าง (หากทีมงานยืนยันสิทธิ์กรณีพิเศษให้แล้ว สามารถเข้ากลุ่ม LINE OpenChat ด้านล่างเพื่อรอรับข่าวสารจากทีมงานได้เลย)`,
        toSlip: true,
        toLine: true,
        showCampDetails: true,
      };
    case 'REFUND_PENDING':
      return {
        tone: 'warning',
        icon: RotateCcw,
        badge: 'รอคืนเงิน',
        title: 'อยู่ระหว่างดำเนินการคืนเงินค่าสมัคร',
        body: 'ที่นั่งของใบสมัครนี้ถูกคืนให้น้องคนอื่นแล้ว ทีมงานกำลังดำเนินการคืนเงินให้ หากมีข้อสงสัยสามารถติดต่อทีมงานได้เลยนะ',
        contact: true,
      };
    case 'REFUNDED':
      return {
        tone: 'neutral',
        icon: Receipt,
        badge: 'คืนเงินแล้ว',
        title: 'ดำเนินการคืนเงินค่าสมัครเรียบร้อยแล้ว',
        body: 'ใบสมัครนี้ปิดรายการแล้ว หากต้องการสมัครอีกครั้งหรือมีข้อสงสัย กรุณาติดต่อทีมงาน',
        contact: true,
      };
    case 'REJECTED':
      return {
        tone: 'danger',
        icon: CircleX,
        badge: 'ไม่ผ่าน / ตัดสิทธิ์อัตโนมัติ',
        title: 'ใบสมัครนี้ไม่ผ่านการคัดเลือกหรือพ้นกำหนดชำระเงิน',
        body: 'ที่นั่งของใบสมัครนี้ถูกปล่อยคืนแล้ว (อาจไม่ผ่านการคัดเลือก หรือถูกตัดสิทธิ์อัตโนมัติเนื่องจากไม่ชำระเงินและแนบสลิปภายใน 3 วัน / 72 ชั่วโมงหลังสมัคร) หากคิดว่าเกิดความผิดพลาด กรุณาติดต่อทีมงาน',
        contact: true,
      };
    case 'RESERVE':
      return {
        tone: 'neutral',
        icon: ListOrdered,
        badge: 'ตัวสำรอง',
        title: 'อยู่ในรายชื่อตัวสำรอง',
        body: 'หากมีที่นั่งว่างทีมงานจะติดต่อกลับ ระหว่างนี้ขอให้น้องคอยติดตามข่าวสารจากเพจของโครงการ',
        contact: true,
      };
    case 'PENDING':
      return {
        tone: 'warning',
        icon: Hourglass,
        badge: 'รอพิจารณา',
        title: 'ใบสมัครอยู่ระหว่างรอทีมงานพิจารณา',
        body: 'ทีมงานกำลังตรวจสอบใบสมัครของน้อง เมื่อมีผลแล้วสถานะจะอัปเดตในหน้านี้ ลองกลับมาตรวจสอบอีกครั้งภายหลังนะ',
      };
    default:
      break;
  }

  // PASSED: single-track flow — register (PASSED) -> pay & upload slip -> staff approve (CONFIRMED).
  if (slip === 'APPROVED') {
    return confirmedHighlight();
  }
  if (slip === 'PENDING') {
    return {
      tone: 'warning',
      icon: Clock,
      badge: 'ได้รับสลิปแล้ว · รอทีมงานตรวจสลิป',
      title: 'ได้รับสลิปแล้ว กำลังรอทีมงานตรวจสอบ',
      body: 'ทีมงานกำลังตรวจสอบสลิปให้โดยเร็วที่สุด ไม่ต้องส่งสลิปซ้ำ เมื่อสลิปผ่านการตรวจสอบ สถานะจะอัปเดตเป็น “ยืนยันสิทธิ์สมบูรณ์” โดยอัตโนมัติ',
    };
  }
  const dl = describePaymentDeadline(app.createdAt, nowMs);
  if (slip === 'REJECTED') {
    return {
      tone: 'danger',
      icon: TriangleAlert,
      badge: `สลิปไม่ผ่าน · ${dl.remainingText}`,
      title: 'สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดสลิปใหม่',
      body: `โปรดตรวจสอบยอดโอน ${feeText} บาท และความชัดเจนของรูป แล้วอัปโหลดสลิปใหม่ที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่างภายในวันที่ ${dl.deadlineText} (มิฉะนั้นระบบอาจคืนที่นั่งเมื่อพ้นกำหนด 3 วัน)`,
      toSlip: true,
      contact: true,
    };
  }
  return {
    tone: dl.isUrgent ? 'warning' : 'tech',
    icon: Ticket,
    badge: `สมัครทันแล้ว · ${dl.remainingText}`,
    title: 'เย้! ดีใจด้วย คุณสมัครทันแล้ว ได้ที่นั่งในค่าย ComCamp #25',
    body: `ระบบจองที่นั่งให้คุณเรียบร้อยแล้ว (สิทธิ์แบบมาก่อนได้ก่อน จำกัด ${seats} ที่นั่ง) กรุณาโอนค่าสมัคร ${feeText} บาท และอัปโหลดสลิปที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่างภายในวันที่ ${dl.deadlineText} (ภายใน 3 วัน / 72 ชั่วโมงหลังสมัคร) มิฉะนั้นระบบจะตัดสิทธิ์และคืนที่นั่งว่างอัตโนมัติ (โอนแล้วสละสิทธิ์ไม่คืนเงินทุกกรณี)`,
    toSlip: true,
  };
}

function confirmedHighlight(): Highlight {
  return {
    tone: 'success',
    icon: CircleCheck,
    badge: 'สลิปค่าสมัครผ่านการตรวจสอบแล้ว',
    title: 'สลิปผ่านการตรวจสอบ / ยืนยันสิทธิ์เข้าร่วมค่ายสมบูรณ์แล้ว',
    body: `น้องมีที่นั่งในค่าย ComCamp #25 วันที่ 5–7 กุมภาพันธ์ 2570 (3 วัน 2 คืน) ณ สาขาวิชาวิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้ และเข้าพักที่${DORM_NAME}เรียบร้อยแล้ว — กดเข้ากลุ่ม LINE OpenChat ด้านล่างเพื่อรับข่าวสารและกำหนดการวันเข้าค่ายจากพี่ค่ายได้เลย`,
    toLine: true,
    showCampDetails: true,
  };
}

const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-tech)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-card)]';

/**
 * Editorial banner above the record: sharp corners, a bold tone-coloured top bar and a 1px frame,
 * like the masthead of sections 01-04. The tint is the tone mixed into the card colour, text stays
 * in ink (AA in both themes), and colour is never the only cue: icon, badge, state token and
 * headline all say the same thing. No side stripe, no icon bubble (AGENTS.md section 6.1).
 */
function StatusHighlight({ app, seats, feeText, nowMs }: { app: Application; seats: number; feeText: string; nowMs: number }) {
  const h = describeHighlight(app, seats, feeText, nowMs);
  const color = TONE_COLOR[h.tone];
  const Icon = h.icon;
  return (
    <section
      role="status"
      aria-labelledby="status-highlight-title"
      data-status={app.status}
      data-tone={h.tone}
      className="st-highlight"
      style={{ '--st-tone': color } as CSSProperties}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-3"
        style={{ borderColor: `color-mix(in srgb, ${color} 28%, ${RULE})` }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="shrink-0" style={{ color }}>
            <Icon size={18} strokeWidth={1.6} />
          </span>
          <span
            className="inline-flex items-center gap-2 rounded-full border-0 px-3 py-1 text-sm font-semibold"
            style={{ color: INK, backgroundColor: `color-mix(in srgb, ${color} 22%, ${SURFACE})` }}
          >
            <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            {h.badge}
          </span>
        </div>
        <span className="text-xs font-semibold" style={{ color: INK_MUTED }}>
          {STATUS_LABELS[app.status] || app.status}
        </span>
      </div>
      <div className="mt-4 min-w-0">
          <h2 id="status-highlight-title" className="text-balance text-2xl font-bold leading-[1.35] sm:text-3xl" style={{ color: INK }}>
            {h.title}
          </h2>
          <p className="mt-3 max-w-[62ch] text-base leading-7" style={{ color: INK_MUTED }}>
            {h.body}
          </p>
          {h.showCampDetails && (
            <div
              className="mt-4 grid gap-2 border-t pt-3 text-sm leading-6 sm:grid-cols-2"
              style={{ borderColor: `color-mix(in srgb, ${color} 24%, ${RULE})`, color: INK_MUTED }}
            >
              <p>
                <strong style={{ color: INK }}>วันจัดค่าย:</strong>{' '}
                <span className="tabular-nums">5–7 กุมภาพันธ์ 2570 (3 วัน 2 คืน)</span>
              </p>
              <p>
                <strong style={{ color: INK }}>อาจารย์ผู้รับผิดชอบ:</strong> {PROJECT_ADVISOR}
              </p>
              <p className="sm:col-span-2">
                <strong style={{ color: INK }}>สถานที่อบรมและที่พัก:</strong> สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ ม.แม่โจ้ · ที่พัก {DORM_NAME} (แยกโซนชาย-หญิง){' '}
                <a
                  href={DORM_MAPS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-1 font-semibold underline underline-offset-4 ${FOCUS_RING}`}
                  style={{ color: INK }}
                >
                  <MapPin aria-hidden="true" size={14} strokeWidth={1.75} />
                  <span>ดูแผนที่เรือนพัก (Google Maps)</span>
                  <ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.75} />
                </a>
              </p>
            </div>
          )}
          {(h.toSlip || h.toLine || h.contact) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {h.toSlip && (
                <a
                  href="#slip-section"
                  className={`inline-flex min-h-11 w-full items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 sm:w-auto ${FOCUS_RING}`}
                  style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                >
                  ไปส่งหลักฐานการชำระเงิน
                </a>
              )}
              {h.toLine && (
                <a
                  href="#line-openchat"
                  className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 sm:w-auto ${FOCUS_RING}`}
                  style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                >
                  <span>ไปเข้ากลุ่ม LINE OpenChat ด้านล่าง</span>
                  <ArrowRight aria-hidden="true" size={16} strokeWidth={1.75} />
                </a>
              )}
              {h.contact && (
                <>
                  <a
                    href={FB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex min-h-11 w-full items-center justify-center rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors sm:w-auto ${FOCUS_RING}`}
                    style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                  >
                    ติดต่อทีมงานทาง Facebook
                  </a>
                  {STAFF_CONTACTS.map((c) => (
                    <a
                      key={c.tel}
                      href={`tel:${c.tel}`}
                      className={`inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors sm:w-auto ${FOCUS_RING}`}
                      style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                    >
                      <Phone aria-hidden="true" size={14} strokeWidth={1.75} />
                      <span className="font-mono tabular-nums">{c.phone}</span>
                      <span className="font-normal" style={{ color: INK_MUTED }}>({c.name})</span>
                    </a>
                  ))}
                </>
              )}
            </div>
          )}
      </div>
    </section>
  );
}

const INPUT_CLS =
  'w-full rounded-xl border bg-[var(--bg-card)] px-3.5 py-2.5 text-base leading-7 outline-none transition-colors placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-tech)] focus-visible:ring-2 focus-visible:ring-[var(--color-tech)]/30';

function EditField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold" style={{ color: INK }}>
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-err`} className="mt-1.5 flex items-start gap-1.5 text-sm leading-6" style={{ color: 'var(--color-danger)' }}>
          <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

interface EditForm {
  nickname: string;
  school: string;
  province: string;
  grade: string;
  gradeOther: string;
  shirtSize: ShirtSize | '';
}

type EditErrors = Partial<Record<keyof EditForm, string>>;

function formFromApp(app: Application): EditForm {
  return {
    nickname: app.nickname ?? '',
    school: app.school,
    province: app.province ?? '',
    ...splitGrade(app.grade),
    shirtSize: app.shirtSize,
  };
}

function validateEdit(f: EditForm): EditErrors {
  const e: EditErrors = {};
  const nickname = cleanSingleLine(f.nickname);
  const school = cleanSingleLine(f.school);
  const province = cleanSingleLine(f.province);
  if (!nickname) e.nickname = 'กรุณากรอกชื่อเล่น';
  else if (nickname.length > NICKNAME_MAX) e.nickname = `ชื่อเล่นต้องไม่เกิน ${NICKNAME_MAX} ตัวอักษร`;
  if (!school) e.school = 'กรุณากรอกชื่อโรงเรียนหรือสถานศึกษา';
  else if (school.length > SCHOOL_MAX) e.school = `ชื่อสถานศึกษาต้องไม่เกิน ${SCHOOL_MAX} ตัวอักษร`;
  if (!province) e.province = 'กรุณากรอกจังหวัด';
  else if (province.length > PROVINCE_MAX) e.province = `ชื่อจังหวัดต้องไม่เกิน ${PROVINCE_MAX} ตัวอักษร`;
  const g = validateGradeFields(f.grade, cleanSingleLine(f.gradeOther));
  if (g) e[f.grade === GRADE_OTHER ? 'gradeOther' : 'grade'] = g;
  if (!f.shirtSize) e.shirtSize = 'กรุณาเลือกไซส์เสื้อ';
  return e;
}

function VerifyCodePrompt({ onFocusCode, action }: { onFocusCode: () => void; action: string }) {
  return (
    <div
      role="note"
      className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-sm leading-6"
      style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE, color: INK_MUTED }}
    >
      <span>กรอกเลข 4 ตัวท้ายบัตรประชาชนด้านบนก่อนจึงจะ{action}ได้</span>
      <button
        type="button"
        onClick={onFocusCode}
        className={`inline-flex min-h-11 items-center rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors hover:border-[var(--color-ink)] ${FOCUS_RING}`}
        style={{ borderColor: BORDER_INPUT, color: INK, backgroundColor: SURFACE }}
      >
        ไปกรอกรหัส 4 ตัวท้ายด้านบน
      </button>
    </div>
  );
}

export function StatusSection() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [app, setApp] = useState<Application | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [seats, setSeats] = useState(SEATS);
  const [feeText, setFeeText] = useState(FEE_TEXT);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [storedNotice, setStoredNotice] = useState<string | null>(null);
  /** A wrong verify code reported by the slip upload or profile edit, shown beneath #verify-code. */
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [acctCopy, setAcctCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [idCopy, setIdCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const acctCopyTimer = useRef<number | undefined>(undefined);
  const idCopyTimer = useRef<number | undefined>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Last 4 digits of the national ID (AGENTS.md §13.5). Kept in memory only, never stored. */
  const [verifyCode, setVerifyCode] = useState('');
  const [autoVerifiedById, setAutoVerifiedById] = useState(false);
  const [showManualVerifyCode, setShowManualVerifyCode] = useState(false);
  const manualCodeFocusRef = useRef(false);
  const codeReady = verifyCode.length === 4;
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  /**
   * The applicant's full 13-digit national ID, typed to confirm a withdrawal (4 digits are not
   * enough to give a seat away, AGENTS.md §13.5). Component state only: never written to
   * localStorage / sessionStorage (§9.2), cleared on close, on a new search and on success.
   */
  const [withdrawNid, setWithdrawNid] = useState('');
  const [withdrawErr, setWithdrawErr] = useState<string | null>(null);
  const withdrawNidComplete = withdrawNid.length === 13;
  const withdrawNidValid = withdrawNidComplete && isValidThaiNationalID(withdrawNid);
  /** Set after a successful withdrawal; the record is cleared and this notice replaces it. */
  const [withdrawnId, setWithdrawnId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [edit, setEdit] = useState<EditForm>({ nickname: '', school: '', province: '', grade: '', gradeOther: '', shirtSize: '' });
  const [editErrors, setEditErrors] = useState<EditErrors>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editLiveSummary, setEditLiveSummary] = useState('');
  const [editSaved, setEditSaved] = useState(false);
  const editToggleRef = useRef<HTMLButtonElement>(null);
  const editNicknameRef = useRef<HTMLInputElement>(null);
  const editRestore = useRef(false);
  const withdrawToggleRef = useRef<HTMLButtonElement>(null);
  const withdrawConfirmRef = useRef<HTMLButtonElement>(null);
  const withdrawNidRef = useRef<HTMLInputElement>(null);
  const withdrawnRef = useRef<HTMLDivElement>(null);
  /** Focus goes back to the toggle only when the panel was closed by the user. */
  const withdrawRestore = useRef(false);
  const searchRun = useRef(0);
  const searchBusyRef = useRef(false);
  const editBusyRef = useRef(false);
  const withdrawBusyRef = useRef(false);

  const runSearch = useCallback(async (rawQuery: string, opts?: { fromStoredReceipt?: boolean }) => {
    // Zero-width characters, Thai numerals and hyphens from a LINE copy-paste are removed (§9.2.2).
    const query = normalizeLookupQuery(rawQuery);
    if (!query) return;
    const digitsOnly = /^\d+$/.test(query) ? query : '';
    const isNationalIdLookup = !opts?.fromStoredReceipt && digitsOnly.length === 13;
    const run = ++searchRun.current;
    searchBusyRef.current = true;
    setBusy(true);
    setError(null);
    setStoredNotice(null);
    setVerifyError(null);
    setShowManualVerifyCode(false);
    setVerifyCode(isNationalIdLookup ? digitsOnly.slice(-4) : '');
    setAutoVerifiedById(isNationalIdLookup);
    setWithdrawOpen(false);
    setWithdrawNid('');
    setWithdrawErr(null);
    setWithdrawnId(null);
    setEditOpen(false);
    setEditSaved(false);
    setEditError(null);
    setEditErrors({});
    setEditLiveSummary('');
    try {
      const res = await getApplicationStatus(query);
      if (run !== searchRun.current) return;
      setApp(res.data);
      setSource(res.source);
    } catch (err) {
      if (run !== searchRun.current) return;
      setAutoVerifiedById(false);
      setVerifyCode('');
      setShowManualVerifyCode(false);
      if (opts?.fromStoredReceipt && err instanceof ApiHttpError && err.status === 404) {
        clearReceipt();
        setQ('');
        setApp(null);
        setStoredNotice(`ไม่พบข้อมูลใบสมัครที่บันทึกไว้ล่าสุด (${query}) ในระบบ อาจถูกยกเลิกไปแล้ว หากต้องการตรวจสอบ สามารถค้นหาด้วยเบอร์โทรศัพท์หรือเลขบัตรประชาชนได้ด้านล่าง`);
        return;
      }
      setError(describeError(err, 'ไม่พบข้อมูลใบสมัครที่ค้นหา'));
      setApp(null);
    } finally {
      if (run === searchRun.current) {
        searchBusyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchPublicSettings()
      .then(({ settings }) => {
        if (!active) return;
        if (settings.maxCapacity && settings.maxCapacity > 0) setSeats(settings.maxCapacity);
        if (settings.campFee !== null && settings.campFee !== undefined) setFeeText(formatCampFee(settings.campFee));
      })
      .catch(() => {
        /* Fallback to SEATS / FEE_TEXT constants when offline. */
      });

    const params = new URLSearchParams(window.location.search);
    const urlQuery = (params.get('q') ?? params.get('id') ?? '').trim();
    if (urlQuery) {
      setQ(urlQuery);
      void runSearch(urlQuery);
    } else {
      const receipt = loadReceipt();
      if (receipt?.id) {
        setQ(receipt.id);
        void runSearch(receipt.id, { fromStoredReceipt: true });
      }
    }

    return () => {
      active = false;
      searchRun.current++;
      window.clearTimeout(acctCopyTimer.current);
      window.clearTimeout(idCopyTimer.current);
    };
  }, [runSearch]);

  useEffect(() => {
    if (withdrawOpen) withdrawNidRef.current?.focus();
    else if (withdrawRestore.current) {
      withdrawRestore.current = false;
      withdrawToggleRef.current?.focus();
    }
  }, [withdrawOpen]);
  useEffect(() => {
    if (withdrawnId) withdrawnRef.current?.focus();
  }, [withdrawnId]);
  useEffect(() => {
    if (editOpen) editNicknameRef.current?.focus();
    else if (editRestore.current) {
      editRestore.current = false;
      editToggleRef.current?.focus();
    }
  }, [editOpen]);
  useEffect(() => {
    if (showManualVerifyCode && manualCodeFocusRef.current) {
      manualCodeFocusRef.current = false;
      const el = document.getElementById('verify-code');
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.select();
      }
    }
  }, [showManualVerifyCode]);

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (busy || searchBusyRef.current || !q.trim()) return;
    void runSearch(q);
  }

  function openEdit() {
    if (!app) return;
    setEdit(formFromApp(app));
    setEditErrors({});
    setEditError(null);
    setEditLiveSummary('');
    setEditSaved(false);
    setEditOpen(true);
  }

  function closeEdit() {
    if (editBusy) return;
    editRestore.current = true;
    setEditLiveSummary('');
    setEditOpen(false);
  }

  function setEditField<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setEdit((f) => ({ ...f, [key]: value }));
    // Clear the message of the field being fixed; the others stay until the next save.
    setEditErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e, [key]: undefined };
      if (!Object.values(next).some(Boolean)) setEditLiveSummary('');
      return next;
    });
  }

  async function onSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!app || editBusy || editBusyRef.current) return;
    const errors = validateEdit(edit);
    setEditErrors(errors);
    setEditError(null);
    const errCount = Object.values(errors).filter(Boolean).length;
    const firstBad = (['nickname', 'school', 'province', 'grade', 'gradeOther', 'shirtSize'] as const).find((k) => errors[k]);
    if (firstBad) {
      const msg = `ข้อมูลยังไม่ครบหรือไม่ถูกต้อง ${errCount} ช่อง กรุณาตรวจสอบช่องที่มีข้อความแจ้งเตือน`;
      setEditLiveSummary((prev) => (prev === msg ? `${msg} ` : msg));
      document.getElementById(`edit-${firstBad}`)?.focus();
      return;
    }
    setEditLiveSummary('');
    if (!codeReady) return;
    editBusyRef.current = true;
    setEditBusy(true);
    try {
      const res = await updateOwnProfile(app.id, verifyCode, {
        nickname: cleanSingleLine(edit.nickname),
        school: cleanSingleLine(edit.school),
        province: cleanSingleLine(edit.province),
        grade: gradeValue({ grade: edit.grade, gradeOther: cleanSingleLine(edit.gradeOther) }),
        shirtSize: edit.shirtSize as ShirtSize,
      });
      setApp(res.data);
      setSource(res.source);
      setEditSaved(true);
      editRestore.current = true;
      setEditOpen(false);
    } catch (err) {
      const locked = describeVerifyLock(err);
      if (locked) {
        setEditError(locked);
        setVerifyError(locked);
        setShowManualVerifyCode(true);
      } else if (err instanceof ApiHttpError && err.code === 'INVALID_VERIFY_CODE') {
        const msg = describeError(err, 'รหัสยืนยัน 4 หลักไม่ถูกต้อง');
        setEditError(msg);
        setVerifyError(msg);
        manualCodeFocusRef.current = true;
        setShowManualVerifyCode(true);
      } else if (err instanceof ApiHttpError && err.status === 409) {
        setEditError('ใบสมัครนี้อยู่ในสถานะที่แก้ไขเองไม่ได้ กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ');
      } else if (err instanceof ApiHttpError && err.code === 'VALIDATION_ERROR') {
        setEditError('ข้อมูลที่กรอกยังไม่ถูกต้อง กรุณาตรวจสอบทุกช่องแล้วลองอีกครั้ง');
      } else {
        setEditError(describeError(err, 'บันทึกข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง'));
      }
    } finally {
      editBusyRef.current = false;
      setEditBusy(false);
    }
  }

  function closeWithdraw() {
    if (withdrawBusy || withdrawBusyRef.current) return;
    withdrawRestore.current = true;
    setWithdrawOpen(false);
    setWithdrawNid('');
    setWithdrawErr(null);
  }

  async function onWithdraw() {
    if (!app || !withdrawNidValid || withdrawBusy || withdrawBusyRef.current) return;
    withdrawBusyRef.current = true;
    setWithdrawBusy(true);
    setError(null);
    setWithdrawErr(null);
    try {
      await withdrawApplication(app.id, withdrawNid);
      const id = app.id;
      if (loadReceipt()?.id === id) clearReceipt();
      setApp(null);
      setSource(null);
      setVerifyCode('');
      setAutoVerifiedById(false);
      setShowManualVerifyCode(false);
      setWithdrawNid('');
      setWithdrawOpen(false);
      setVerifyError(null);
      setWithdrawnId(id);
    } catch (err) {
      // Problems with the typed ID (wrong, malformed, locked) are shown next to the field.
      const locked = describeVerifyLock(err);
      if (locked) {
        setWithdrawErr(locked);
      } else if (err instanceof ApiHttpError && err.code === 'INVALID_VERIFY_CODE') {
        setWithdrawErr('เลขบัตรประชาชนไม่ตรงกับใบสมัครนี้ กรุณาตรวจสอบแล้วลองอีกครั้ง');
      } else if (err instanceof ApiHttpError && err.status === 400) {
        setWithdrawErr('กรุณากรอกเลขบัตรประชาชน 13 หลักของผู้สมัครให้ถูกต้อง');
      } else if (err instanceof ApiHttpError && err.status === 429) {
        setWithdrawErr(describeError(err, 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'));
      } else if (err instanceof ApiHttpError && err.status === 409) {
        setWithdrawOpen(false);
        setWithdrawNid('');
        setError('ใบสมัครนี้ยกเลิกเองไม่ได้ (ยืนยันสิทธิ์แล้ว ส่งสลิปแล้ว หรือปิดรายการแล้ว) กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการเพื่อขอยกเลิกและคืนเงิน');
        getApplicationStatus(app.id)
          .then((res) => {
            setApp(res.data);
            setSource(res.source);
          })
          .catch(() => {});
      } else if (err instanceof ApiHttpError && err.status === 404) {
        if (loadReceipt()?.id === app.id) clearReceipt();
        setError('ไม่พบใบสมัครนี้ในระบบ อาจถูกยกเลิกไปแล้ว ลองค้นหาอีกครั้ง');
      } else {
        setError(describeError(err, 'ยกเลิกใบสมัครไม่สำเร็จ'));
      }
    } finally {
      withdrawBusyRef.current = false;
      setWithdrawBusy(false);
    }
  }

  function focusVerifyCode() {
    const el = document.getElementById('verify-code');
    if (el instanceof HTMLInputElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    }
  }

  async function onCopyAccount() {
    const ok = await copyText(PAY_ACCOUNT_DIGITS);
    setAcctCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(acctCopyTimer.current);
    acctCopyTimer.current = window.setTimeout(() => setAcctCopy('idle'), ok ? 2200 : 5000);
  }

  async function onCopyAppId() {
    if (!app) return;
    const ok = await copyText(app.id);
    setIdCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(idCopyTimer.current);
    idCopyTimer.current = window.setTimeout(() => setIdCopy('idle'), ok ? 2200 : 5000);
  }

  const slipUploaded = hasSlip(app);
  const slipState = slipUploaded ? (app?.slipStatus ?? 'PENDING') : null;
  // Never treat status === 'CONFIRMED' without an approved slip as slipApproved.
  const slipApproved = slipState === 'APPROVED';
  const slipRejected = slipState === 'REJECTED';
  const isEligibleForPayment = app && (app.status === 'PASSED' || app.status === 'CONFIRMED');
  const seatHeld = Boolean(app && holdsSeat(app.status));
  // A slip waiting for review or already approved means money has moved: the row must stay in the
  // staff ledger so a refund can be recorded, so only staff can cancel from then on. A slip staff
  // rejected is not money held. A missing slipStatus on an uploaded slip counts as waiting.
  const moneyHeld = slipState === 'PENDING' || slipState === 'APPROVED';
  const paymentDeadline = app ? describePaymentDeadline(app.createdAt, nowMs) : null;

  useEffect(() => {
    if (!app || app.status !== 'PASSED' || slipApproved || moneyHeld) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [app, slipApproved, moneyHeld]);
  const canWithdraw = Boolean(app && seatHeld && app.status !== 'CONFIRMED' && !moneyHeld);
  // Cancelling is staff-only: say so, with the way to reach them.
  const mustAskStaffToCancel = seatHeld && !canWithdraw;
  // Secondary fields stay editable while the application holds a seat (also once CONFIRMED).
  const canEditProfile = seatHeld;
  // The code is asked for only while there is something left to do on this application.
  const needsVerifyCode = Boolean(isEligibleForPayment && !slipApproved) || canEditProfile;
  const verifyHint = !app
    ? ''
    : slipApproved
      ? 'ใช้ยืนยันตัวตนก่อนแก้ไขข้อมูล'
      : isEligibleForPayment
        ? 'ใช้ยืนยันตัวตนก่อนส่งสลิปหรือแก้ไขข้อมูล'
        : 'ใช้ยืนยันตัวตนก่อนแก้ไขข้อมูล';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      {/* ── 01 · Masthead ─────────────────────────────────── */}
      <header className="border-t-4 pt-4" style={{ borderColor: INK }}>
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium uppercase tabular-nums" style={{ color: INK_SUBTLE }}>
              ComCamp #25 — Status / 01
            </p>
            <h1 className="mt-2 text-balance text-3xl font-bold leading-[1.22] sm:text-5xl" style={{ color: INK }}>
              ตรวจสอบสถานะใบสมัคร
            </h1>
          </div>
          <p className="max-w-[42ch] text-base leading-7" style={{ color: INK_MUTED }}>
            ค้นหาด้วยเลขบัตรประชาชน 13 หลัก เบอร์โทรศัพท์ หรือรหัสใบสมัคร (<span className="font-mono text-sm tabular-nums">CC25-XXXXXX</span>)
          </p>
        </div>
      </header>

      {/* ── 02 · Search strip ─────────────────────────────── */}
      <section className="mt-8 grid gap-10 md:grid-cols-12">
        <div className="md:col-span-5">
          <p className="font-mono text-6xl font-semibold tabular-nums" style={{ color: INK }}>
            02
          </p>
          <h2 className="mt-2 text-balance text-xl font-bold leading-8" style={{ color: INK }}>
            ค้นหาใบสมัครของน้อง
          </h2>
          <p className="mt-2 max-w-[42ch] text-base leading-7" style={{ color: INK_MUTED }}>
            ผลการคัดเลือก การยืนยันสิทธิ์ และการอัปโหลดสลิปโอนเงินทำได้ในหน้าเดียวโดยไม่ต้องสมัครใหม่
          </p>
        </div>

        <form onSubmit={onSearch} className="st-card md:col-span-7">
          <label className="mb-1.5 block text-sm font-semibold" style={{ color: INK }} htmlFor="status-q">
            เลขบัตรประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัคร
          </label>
          <div className="relative flex items-center">
            <input
              ref={searchInputRef}
              id="status-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="เช่น 0812345678, 1103701234512 หรือ CC25-XXXXXX"
              className="min-h-11 w-full rounded-none border bg-[var(--bg-card)] py-2.5 pl-3 pr-12 text-base outline-none transition-colors focus:border-[var(--color-tech)]"
              style={{ borderColor: BORDER_INPUT }}
            />
            {q.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setQ('');
                  searchInputRef.current?.focus();
                }}
                aria-label="ล้างคำค้นหา"
                className={`absolute right-0.5 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition-opacity hover:opacity-75 ${FOCUS_RING}`}
                style={{ color: INK_MUTED }}
              >
                <X aria-hidden="true" size={18} strokeWidth={1.75} />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={busy || !q.trim()}
            aria-busy={busy || undefined}
            className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-full px-4 py-3 text-base font-semibold transition-opacity disabled:opacity-50 ${FOCUS_RING}`}
            style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
          >
            {busy ? 'กำลังค้นหา…' : 'ค้นหาข้อมูล'}
          </button>
        </form>
      </section>

      {storedNotice && (
        <div
          role="status"
          className="st-notice mt-6 flex items-start justify-between gap-4"
        >
          <p className="flex items-start gap-2.5 text-sm leading-7" style={{ color: INK_MUTED }}>
            <Info aria-hidden="true" size={18} strokeWidth={1.75} className="mt-1 shrink-0" style={{ color: 'var(--color-tech)' }} />
            <span>{storedNotice}</span>
          </p>
          <button
            type="button"
            onClick={() => setStoredNotice(null)}
            className={`-my-2 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold underline underline-offset-4 ${FOCUS_RING}`}
            style={{ color: INK }}
          >
            ปิด
          </button>
        </div>
      )}

      {/* ── Alerts: solid semantic bar fill for immediate visibility (AA contrast in light & dark) ── */}
      {error && (
        <div
          role="alert"
          className="st-alert st-alert--error mt-6 flex items-start justify-between gap-4"
        >
          <p className="flex items-start gap-2.5 text-sm font-semibold leading-7">
            <TriangleAlert aria-hidden="true" size={18} strokeWidth={1.75} className="mt-1 shrink-0" />
            <span>{error}</span>
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="-my-2 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold underline underline-offset-4 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-current"
          >
            ปิด
          </button>
        </div>
      )}

      {withdrawnId && (
        <div
          ref={withdrawnRef}
          tabIndex={-1}
          role="status"
          className="st-alert st-alert--success mt-6 flex items-start justify-between gap-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-tech)]"
        >
          <p className="flex items-start gap-2.5 text-sm font-semibold leading-7">
            <CircleCheck aria-hidden="true" size={18} strokeWidth={1.75} className="mt-1 shrink-0" />
            <span>
              ใบสมัครนี้ถูกยกเลิกแล้ว (<span className="select-all whitespace-nowrap font-mono tabular-nums">{withdrawnId}</span>) คืนที่นั่งว่างเรียบร้อย
              {' '}หากเปลี่ยนใจ{' '}
              <a
                href="/register"
                className="font-bold underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-current"
              >
                สมัครใหม่ได้ที่หน้าสมัครค่าย
              </a>{' '}
              หากยังมีที่นั่งว่าง
            </span>
          </p>
          <button
            type="button"
            onClick={() => setWithdrawnId(null)}
            className="-my-2 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold underline underline-offset-4 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-current"
          >
            ปิด
          </button>
        </div>
      )}

      {app && (
        <div className="mt-8 space-y-8">
          <StatusHighlight app={app} seats={seats} feeText={feeText} nowMs={nowMs} />

          {/* ── 03 · Application record ─────────────────────── */}
          <section className="st-card">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: INK }}>
              <div className="min-w-0">
                <h2 className="text-sm font-bold leading-6" style={{ color: INK_SUBTLE }}>
                  ข้อมูลใบสมัคร · รหัสใบสมัคร
                </h2>
                <p className="mt-1 select-all whitespace-nowrap font-mono text-2xl font-semibold tabular-nums" style={{ color: INK }}>{app.id}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusTag status={app.status} />
                {import.meta.env.DEV && source && (
                  <span className="rounded-sm border px-2 py-0.5 font-mono text-[11px] font-semibold" style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}>
                    {source}
                  </span>
                )}
              </div>
            </div>

            {isEligibleForPayment && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-b pb-4" style={{ borderColor: RULE }}>
                <DotPill
                  color={
                    slipApproved
                      ? 'var(--color-success)'
                      : slipRejected
                        ? 'var(--color-danger)'
                        : slipUploaded
                          ? 'var(--color-warning)'
                          : 'var(--color-ink-subtle)'
                  }
                >
                  สลิปค่าสมัคร:{' '}
                  {slipApproved
                    ? 'ผ่านการตรวจสอบแล้ว'
                    : slipRejected
                      ? 'ไม่ผ่าน กรุณาส่งใหม่'
                      : slipUploaded
                        ? 'รอทีมงานตรวจสอบ'
                        : 'ยังไม่ส่งสลิป'}
                </DotPill>
              </div>
            )}

            <dl className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              {[
                { k: 'ชื่อ – นามสกุล', v: app.fullName, mono: false },
                { k: 'ชื่อเล่น', v: app.nickname || '–', mono: false },
                { k: 'เลขบัตรประชาชน', v: app.nationalId, mono: true },
                { k: 'เบอร์โทรศัพท์ติดต่อ', v: app.phone, mono: true },
                { k: 'โรงเรียน', v: app.school, mono: false },
                {
                  k: 'ระดับชั้น / ไซส์เสื้อค่าย',
                  v:
                    SIZE_CHEST[app.shirtSize] && SIZE_LENGTH[app.shirtSize]
                      ? `${app.grade} / ${app.shirtSize} (อก ${SIZE_CHEST[app.shirtSize]}" · ยาว ${SIZE_LENGTH[app.shirtSize]}")`
                      : `${app.grade} / ${app.shirtSize}`,
                  mono: false,
                },
                ...(app.email ? [{ k: 'อีเมล', v: app.email, mono: false }] : []),
                ...(app.province ? [{ k: 'จังหวัด', v: app.province, mono: false }] : []),
              ].map((row) => (
                <div key={row.k} className="min-w-0 border-b py-2.5 sm:py-3" style={{ borderColor: RULE }}>
                  <dt className="font-mono text-[11px] font-medium uppercase" style={{ color: INK_SUBTLE }}>{row.k}</dt>
                  <dd className={`mt-0.5 select-text break-words [overflow-wrap:anywhere] text-base leading-7 ${row.mono ? 'font-mono tabular-nums' : 'font-medium'}`} style={{ color: INK }}>
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>

            {/* Second factor (AGENTS.md §13.5): an application ID or a phone number alone is not
                enough to edit profile or send a slip. The phone's digits are not accepted on purpose:
                the record above shows them. Searching by full 13-digit national ID already proves identity. */}
            {needsVerifyCode && (
              <div className="mt-6 border-t pt-4" style={{ borderColor: INK }}>
                {autoVerifiedById && !showManualVerifyCode ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm leading-6">
                    <p className="inline-flex items-center gap-2 font-medium" style={{ color: INK }}>
                      <CircleCheck aria-hidden="true" size={16} strokeWidth={1.75} className="shrink-0" style={{ color: 'var(--color-success)' }} />
                      <span>ยืนยันตัวตนด้วยเลขบัตรประชาชนแล้ว (ส่งสลิป / แก้ไขข้อมูลได้ทันที)</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        manualCodeFocusRef.current = true;
                        setShowManualVerifyCode(true);
                      }}
                      className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold underline underline-offset-4 transition-opacity hover:opacity-80 ${FOCUS_RING}`}
                      style={{ color: INK_MUTED }}
                    >
                      เปลี่ยนรหัส
                    </button>
                  </div>
                ) : (
                  <VerifyCodeField
                    id="verify-code"
                    value={verifyCode}
                    onChange={(v) => {
                      setVerifyCode(v);
                      if (verifyError) setVerifyError(null);
                    }}
                    error={verifyError}
                    notPhone
                    hintId="verify-code-hint"
                    hint={verifyHint}
                  />
                )}
              </div>
            )}

            {/* Self-service edit of the secondary fields (identity fields are staff-only). */}
            {canEditProfile && (
              <div className="mt-6 border-t pt-4" style={{ borderColor: RULE }}>
                {editOpen ? (
                  <form
                    onSubmit={onSaveProfile}
                    noValidate
                    aria-labelledby="edit-title"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        closeEdit();
                      }
                    }}
                  >
                    <h3 id="edit-title" className="text-base font-bold leading-7" style={{ color: INK }}>
                      แก้ไขข้อมูลทั่วไป
                    </h3>
                    <p className="mt-1 max-w-[62ch] text-sm leading-7" style={{ color: INK_MUTED }}>
                      แก้ไขได้เฉพาะชื่อเล่น โรงเรียน จังหวัด ระดับชั้น และไซส์เสื้อ หากต้องการแก้ไขชื่อ-นามสกุล เลขบัตรประชาชน เบอร์โทรศัพท์ อีเมล ข้อมูลผู้ปกครอง ข้อมูลสุขภาพ/การแพ้อาหาร หรือเหตุผลการสมัคร
                      กรุณา{' '}
                      <a href={FB_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-4" style={{ color: INK }}>
                        ติดต่อทีมงานทางเพจ Facebook
                      </a>{' '}
                      หรือโทร{' '}
                      {STAFF_CONTACTS.map((c, idx) => (
                        <span key={c.tel}>
                          {idx > 0 ? ' / ' : ''}
                          <a href={`tel:${c.tel}`} className="font-mono font-semibold tabular-nums underline underline-offset-4" style={{ color: INK }}>
                            {c.phone}
                          </a>
                        </span>
                      ))}
                    </p>

                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <EditField id="edit-nickname" label="ชื่อเล่น" error={editErrors.nickname}>
                        <input
                          id="edit-nickname"
                          ref={editNicknameRef}
                          value={edit.nickname}
                          onChange={(e) => setEditField('nickname', e.target.value)}
                          autoComplete="nickname"
                          aria-invalid={editErrors.nickname ? true : undefined}
                          aria-describedby={editErrors.nickname ? 'edit-nickname-err' : undefined}
                          className={INPUT_CLS}
                          style={{ borderColor: BORDER_INPUT, color: INK }}
                        />
                      </EditField>
                      <EditField id="edit-province" label="จังหวัด" error={editErrors.province}>
                        <input
                          id="edit-province"
                          value={edit.province}
                          onChange={(e) => setEditField('province', e.target.value)}
                          autoComplete="address-level1"
                          aria-invalid={editErrors.province ? true : undefined}
                          aria-describedby={editErrors.province ? 'edit-province-err' : undefined}
                          className={INPUT_CLS}
                          style={{ borderColor: BORDER_INPUT, color: INK }}
                        />
                      </EditField>
                      <div className="sm:col-span-2">
                        <EditField id="edit-school" label="โรงเรียน / สถานศึกษา" error={editErrors.school}>
                          <input
                            id="edit-school"
                            value={edit.school}
                            onChange={(e) => setEditField('school', e.target.value)}
                            aria-invalid={editErrors.school ? true : undefined}
                            aria-describedby={editErrors.school ? 'edit-school-err' : undefined}
                            className={INPUT_CLS}
                            style={{ borderColor: BORDER_INPUT, color: INK }}
                          />
                        </EditField>
                      </div>
                      <EditField id="edit-grade" label="ระดับชั้น" error={editErrors.grade}>
                        <select
                          id="edit-grade"
                          value={edit.grade}
                          onChange={(e) => setEditField('grade', e.target.value)}
                          aria-invalid={editErrors.grade ? true : undefined}
                          aria-describedby={editErrors.grade ? 'edit-grade-err' : undefined}
                          className={INPUT_CLS}
                          style={{ borderColor: BORDER_INPUT, color: INK }}
                        >
                          <option value="" disabled>
                            เลือกระดับชั้น
                          </option>
                          {GRADES.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                          <option value={GRADE_OTHER}>{GRADE_OTHER} (ระบุเอง)</option>
                        </select>
                      </EditField>
                      <EditField id="edit-shirtSize" label="ไซส์เสื้อค่าย" error={editErrors.shirtSize}>
                        <select
                          id="edit-shirtSize"
                          value={edit.shirtSize}
                          onChange={(e) => setEditField('shirtSize', e.target.value as ShirtSize)}
                          aria-invalid={editErrors.shirtSize ? true : undefined}
                          aria-describedby={editErrors.shirtSize ? 'edit-shirtSize-err' : undefined}
                          className={INPUT_CLS}
                          style={{ borderColor: BORDER_INPUT, color: INK }}
                        >
                          <option value="" disabled>
                            เลือกไซส์เสื้อ
                          </option>
                          {SHIRT_SIZES.map((size) => (
                            <option key={size} value={size}>
                              {size} · รอบอก {SIZE_CHEST[size]}&quot; · ยาว {SIZE_LENGTH[size]}&quot;
                            </option>
                          ))}
                        </select>
                      </EditField>
                      {edit.grade === GRADE_OTHER && (
                        <div className="sm:col-span-2">
                          <EditField id="edit-gradeOther" label="ระบุระดับชั้น" error={editErrors.gradeOther}>
                            <input
                              id="edit-gradeOther"
                              value={edit.gradeOther}
                              onChange={(e) => setEditField('gradeOther', e.target.value)}
                              maxLength={GRADE_OTHER_MAX + 10}
                              placeholder="เช่น เทียบเท่า ม.4–ม.6"
                              aria-invalid={editErrors.gradeOther ? true : undefined}
                              aria-describedby={editErrors.gradeOther ? 'edit-gradeOther-err' : undefined}
                              className={INPUT_CLS}
                              style={{ borderColor: BORDER_INPUT, color: INK }}
                            />
                          </EditField>
                        </div>
                      )}
                    </div>

                    <p
                      role="status"
                      aria-live="polite"
                      className={editLiveSummary.trim() ? 'mt-3 text-sm font-semibold leading-7' : 'sr-only'}
                      style={{ color: 'var(--color-danger)' }}
                    >
                      {editLiveSummary}
                    </p>
                    {!codeReady && (
                      <VerifyCodePrompt onFocusCode={focusVerifyCode} action="บันทึกการแก้ไข" />
                    )}
                    {editError && (
                      <p role="alert" className="mt-3 flex items-start gap-1.5 text-sm leading-7" style={{ color: INK }}>
                        <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1.5 shrink-0" style={{ color: 'var(--color-danger)' }} />
                        <span>{editError}</span>
                      </p>
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="submit"
                        disabled={editBusy || !codeReady}
                        aria-busy={editBusy || undefined}
                        aria-describedby={codeReady ? undefined : 'verify-code-hint'}
                        className={`inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity disabled:opacity-50 ${FOCUS_RING}`}
                        style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                      >
                        {editBusy ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}
                      </button>
                      <button
                        type="button"
                        onClick={closeEdit}
                        disabled={editBusy}
                        className={`inline-flex min-h-11 items-center justify-center rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${FOCUS_RING}`}
                        style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                      >
                        ยกเลิก
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <button
                      ref={editToggleRef}
                      type="button"
                      onClick={openEdit}
                      aria-expanded={editOpen}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors ${FOCUS_RING}`}
                      style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                    >
                      <Pencil aria-hidden="true" size={16} strokeWidth={1.5} />
                      แก้ไขข้อมูลทั่วไป
                    </button>
                    {editSaved && (
                      <p role="status" className="inline-flex items-center gap-1.5 text-sm leading-7" style={{ color: INK }}>
                        <CircleCheck aria-hidden="true" size={16} strokeWidth={1.75} style={{ color: 'var(--color-success)' }} />
                        <span>บันทึกข้อมูลเรียบร้อยแล้ว</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Self-service withdrawal: frees the seat; asks for the full national ID (not the 4-digit code above). */}
            {canWithdraw && (
              <div className="mt-6 border-t pt-4" style={{ borderColor: RULE }}>
                {withdrawOpen ? (
                  <div
                    role="group"
                    aria-labelledby="withdraw-title"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        closeWithdraw();
                      }
                    }}
                  >
                    <h3 id="withdraw-title" className="text-base font-bold leading-7" style={{ color: INK }}>
                      ยืนยันสละสิทธิ์ / ยกเลิกใบสมัคร
                    </h3>
                    <p id="withdraw-warn" className="mt-1 max-w-[60ch] text-sm leading-7" style={{ color: INK_MUTED }}>
                      หากยกเลิก ใบสมัคร <span className="select-all whitespace-nowrap font-mono tabular-nums">{app.id}</span> จะถูกนำออกจากระบบและคืนที่นั่งว่างทันที ยกเลิกแล้วกู้คืนไม่ได้
                      {slipUploaded && ' หากโอนเงินไปแล้ว กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ'}
                    </p>
                    <div className="mt-3 max-w-[22rem]">
                      <label htmlFor="withdraw-nid" className="block text-sm font-semibold leading-7" style={{ color: INK }}>
                        กรอกเลขบัตรประชาชน 13 หลักของผู้สมัครเพื่อยืนยัน
                      </label>
                      <input
                        id="withdraw-nid"
                        ref={withdrawNidRef}
                        value={withdrawNid}
                        // Digits only, max 13: drops dashes and zero-width characters pasted from LINE (§9.2.2).
                        onChange={(e) => {
                          setWithdrawNid(cleanNationalIdInput(e.target.value));
                          if (withdrawErr) setWithdrawErr(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void onWithdraw();
                          }
                        }}
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="1234567890123"
                        disabled={withdrawBusy}
                        aria-invalid={withdrawErr || (withdrawNidComplete && !withdrawNidValid) ? true : undefined}
                        aria-describedby={withdrawErr ? 'withdraw-warn withdraw-nid-hint withdraw-nid-err' : 'withdraw-warn withdraw-nid-hint'}
                        className={`${INPUT_CLS} mt-1 font-mono tabular-nums disabled:opacity-60`}
                        style={{
                          borderColor: withdrawErr || (withdrawNidComplete && !withdrawNidValid) ? 'var(--color-danger)' : BORDER_INPUT,
                          color: INK,
                        }}
                      />
                      <p id="withdraw-nid-hint" className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>
                        {withdrawNidComplete && !withdrawNidValid ? (
                          'เลขบัตรประชาชนนี้ไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง'
                        ) : (
                          <>
                            ใช้เลขเดียวกับที่กรอกตอนสมัคร (<span className="font-mono tabular-nums">{withdrawNid.length}/13</span> หลัก)
                            ระบบไม่บันทึกเลขนี้ไว้ในเครื่อง
                          </>
                        )}
                      </p>
                      {withdrawErr && (
                        <p id="withdraw-nid-err" role="alert" className="mt-1 text-sm font-semibold leading-7" style={{ color: 'var(--color-danger)' }}>
                          {withdrawErr}
                        </p>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        ref={withdrawConfirmRef}
                        type="button"
                        onClick={onWithdraw}
                        disabled={withdrawBusy || !withdrawNidValid}
                        aria-busy={withdrawBusy || undefined}
                        aria-describedby="withdraw-warn withdraw-nid-hint"
                        className={`inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${FOCUS_RING}`}
                        style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', backgroundColor: SURFACE }}
                      >
                        {withdrawBusy ? 'กำลังยกเลิก…' : 'ยืนยันยกเลิกใบสมัคร'}
                      </button>
                      <button
                        type="button"
                        onClick={closeWithdraw}
                        disabled={withdrawBusy}
                        className={`inline-flex min-h-11 items-center justify-center rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${FOCUS_RING}`}
                        style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                      >
                        ไม่ยกเลิก (กลับ)
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    ref={withdrawToggleRef}
                    type="button"
                    onClick={() => setWithdrawOpen(true)}
                    aria-expanded={withdrawOpen}
                    className={`inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-semibold underline underline-offset-4 ${FOCUS_RING}`}
                    style={{ color: INK_MUTED }}
                  >
                    สละสิทธิ์ / ยกเลิกใบสมัคร
                  </button>
                )}
              </div>
            )}

            {/* Once money has moved (or the place is confirmed) only staff can cancel, so the refund
                is recorded instead of the application disappearing. */}
            {mustAskStaffToCancel && (
              <div className="mt-6 border-t pt-4" style={{ borderColor: RULE }}>
                <p className="max-w-[62ch] text-sm leading-7" style={{ color: INK_MUTED }}>
                  {app.status === 'CONFIRMED' || slipState === 'APPROVED'
                    ? 'ใบสมัครนี้ยืนยันสิทธิ์แล้ว จึงยกเลิกเองในหน้านี้ไม่ได้'
                    : 'ใบสมัครนี้ส่งสลิปโอนเงินแล้ว จึงยกเลิกเองในหน้านี้ไม่ได้'}{' '}
                  หากต้องการแจ้งสละสิทธิ์ กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ หรือโทรติดต่อพี่ค่าย พร้อมแจ้งรหัสใบสมัคร{' '}
                  <span className="select-all whitespace-nowrap font-mono tabular-nums">{app.id}</span> (ทั้งนี้ หากโอนเงินค่าสมัครแล้ว สงวนสิทธิ์ไม่คืนเงินทุกกรณี)
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={FB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex min-h-11 items-center rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors ${FOCUS_RING}`}
                    style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                  >
                    ติดต่อทีมงานทาง Facebook
                  </a>
                  {STAFF_CONTACTS.map((c) => (
                    <a
                      key={c.tel}
                      href={`tel:${c.tel}`}
                      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors ${FOCUS_RING}`}
                      style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                    >
                      <Phone aria-hidden="true" size={14} strokeWidth={1.75} />
                      <span className="font-mono tabular-nums">{c.phone}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* ── 04 · Payment slip ───────────────────────────── */}
          {isEligibleForPayment && (
            <section
              id="slip-section"
              tabIndex={-1}
              className="st-card scroll-mt-32 outline-none"
            >
              {/* One container. Its zones are told apart by whitespace and 1px rules, never by inner boxes. */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold leading-8" style={{ color: INK }}>หลักฐานการชำระเงิน</h2>
                  <p className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>
                    {slipApproved ? (
                      <>
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · ชำระเงินและตรวจสอบสลิปเรียบร้อยแล้ว (หากสละสิทธิ์ไม่คืนเงินทุกกรณี)
                      </>
                    ) : slipState === 'PENDING' ? (
                      <>
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · ได้รับสลิปแล้ว อยู่ระหว่างรอทีมงานตรวจสอบ (หากสละสิทธิ์ไม่คืนเงินทุกกรณี)
                      </>
                    ) : app.status === 'CONFIRMED' ? (
                      <>
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · สถานะยืนยันสิทธิ์แล้ว (หากยังไม่ได้แนบสลิป สามารถอัปโหลดด้านล่าง · โอนแล้วสละสิทธิ์ไม่คืนเงินทุกกรณี)
                      </>
                    ) : (
                      <>
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · กรุณาโอนและแนบสลิปภายใน{' '}
                        <span className="font-mono tabular-nums">3</span> วัน (<span className="font-mono tabular-nums">72</span> ชั่วโมง) หลังสมัคร (โอนแล้วสละสิทธิ์ไม่คืนเงินทุกกรณี)
                      </>
                    )}
                  </p>
                  <p className="mt-1 max-w-[68ch] text-xs leading-6" style={{ color: INK_SUBTLE }}>
                    รวม 7 รายการตลอดค่าย: ที่พัก 2 คืน ({DORM_NAME}) · อาหารหลัก 6 มื้อ · อาหารว่าง 5 มื้อ · เสื้อค่าย ComCamp #25 (SSS–4XL) · กระเป๋าพร้อมปั๊มลาย · เอกสารอบรม · เกียรติบัตร (ชุดบอร์ด Arduino/ESP8266 ใช้ฝึกปฏิบัติในห้องแล็บ) · ระบบแจ้งผลทางอีเมล 2 ช่วง (1. หลังสมัคร และ 2. หลังอนุมัติสลิป)
                  </p>
                </div>
                {slipUploaded ? (
                  slipApproved ? (
                    <DotPill color="var(--color-success)">อนุมัติสลิปแล้ว</DotPill>
                  ) : slipRejected ? (
                    <DotPill color="var(--color-danger)">สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดใหม่</DotPill>
                  ) : (
                    <DotPill color="var(--color-warning)">รอทีมงานตรวจสอบ</DotPill>
                  )
                ) : (
                  <DotPill color="var(--color-ink-subtle)">ยังไม่ได้ส่งสลิป</DotPill>
                )}
              </div>

              {!slipApproved && !moneyHeld && app.status !== 'CONFIRMED' && paymentDeadline && (
                <div
                  role="note"
                  aria-label={slipRejected ? 'แจ้งเตือนอัปโหลดสลิปใหม่' : 'แจ้งเตือนกำหนดเวลาชำระเงิน 3 วัน'}
                  className="st-warning mt-5"
                >
                  <p className="flex items-start gap-2 text-sm font-bold leading-6" style={{ color: INK }}>
                    <TriangleAlert
                      aria-hidden="true"
                      size={18}
                      strokeWidth={1.75}
                      className="mt-0.5 shrink-0"
                      style={{ color: slipRejected ? 'var(--color-danger)' : 'var(--color-warning)' }}
                    />
                    <span>
                      {slipRejected ? 'สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดใหม่' : 'ยังไม่ได้ส่งสลิปยืนยันสิทธิ์'} ·{' '}
                      <span className="tabular-nums">{paymentDeadline.remainingText}</span>
                    </span>
                  </p>
                  <p className="mt-1.5 text-sm leading-7" style={{ color: INK_MUTED }}>
                    {slipRejected ? (
                      <>
                        สลิปก่อนหน้าไม่ผ่านการตรวจสอบ กรุณาเช็กยอดโอน <span className="font-mono tabular-nums">{feeText}</span> บาทและความชัดเจนของรูป แล้วอัปโหลดสลิปใหม่โดยเร็วที่สุด (ภายในกำหนด{' '}
                        <strong className="tabular-nums" style={{ color: INK }}>{paymentDeadline.deadlineText}</strong> หรือช่วงผ่อนผัน 24 ชั่วโมงหลังถูกปฏิเสธ) มิฉะนั้นระบบจะตัดสิทธิ์และคืนที่นั่งว่างอัตโนมัติ
                      </>
                    ) : (
                      <>
                        กรุณาโอนเงินและอัปโหลดสลิปภายในวันที่ <strong className="tabular-nums" style={{ color: INK }}>{paymentDeadline.deadlineText}</strong> (ภายใน{' '}
                        <span className="font-mono tabular-nums">3</span> วัน / <span className="font-mono tabular-nums">72</span> ชั่วโมงหลังสมัคร)
                        หากพ้นกำหนดระบบจะตัดสิทธิ์และคืนที่นั่งว่างให้ผู้สมัครคนอื่นโดยอัตโนมัติ
                      </>
                    )}
                  </p>
                </div>
              )}

              {app.status === 'CONFIRMED' && !slipUploaded && (
                <div role="note" className="st-notice mt-5">
                  <p className="flex items-start gap-2 text-sm leading-7" style={{ color: INK_MUTED }}>
                    <Info aria-hidden="true" size={18} strokeWidth={1.75} className="mt-1 shrink-0" style={{ color: 'var(--color-tech)' }} />
                    <span>
                      ใบสมัครนี้ยืนยันสิทธิ์เรียบร้อยแล้ว แต่ยังไม่พบไฟล์สลิปในระบบ — หากน้องโอนเงินค่าสมัครแล้ว สามารถอัปโหลดสลิปด้านล่างเพื่อบันทึกเป็นหลักฐาน หรือกดเข้ากลุ่ม LINE OpenChat ด้านล่างได้ทันที
                    </span>
                  </p>
                </div>
              )}

              {!slipApproved && (
                <div className="mt-6 border-t pt-5" style={{ borderColor: RULE }} aria-label="ข้อมูลการโอนเงิน" role="group">
                  <p className="text-sm leading-7" style={{ color: INK_MUTED }}>
                    โอนค่าสมัคร <span className="font-mono tabular-nums">{feeText}</span> บาท · {PAY_ACCOUNT.bank}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <p className="select-all whitespace-nowrap font-mono text-2xl font-medium tabular-nums" style={{ color: INK }}>
                      {PAY_ACCOUNT.number}
                    </p>
                    <button
                      type="button"
                      onClick={onCopyAccount}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors hover:border-[var(--color-ink)] ${FOCUS_RING}`}
                      style={{ borderColor: BORDER_INPUT, color: INK }}
                    >
                      {acctCopy === 'copied' ? (
                        <Check aria-hidden="true" size={16} strokeWidth={2} />
                      ) : (
                        <Copy aria-hidden="true" size={16} strokeWidth={1.5} />
                      )}
                      <span>{acctCopy === 'copied' ? 'คัดลอกเลขบัญชีแล้ว' : 'คัดลอกเลขบัญชี'}</span>
                    </button>
                  </div>
                  <p role="status" aria-live="polite" className="min-h-[1.4em] text-sm" style={{ color: INK_MUTED }}>
                    {acctCopy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่เลขบัญชีแล้วเลือกคัดลอก'}
                  </p>
                  <p className="mt-1 select-text text-sm leading-7" style={{ color: INK_MUTED }}>
                    ชื่อบัญชี {PAY_ACCOUNT.name} ({PAY_ACCOUNT.holders})
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p className="text-sm leading-7" style={{ color: INK_MUTED }}>
                      อ้างอิงตอนโอน (บันทึกช่วยจำ):{' '}
                      <span className="select-all whitespace-nowrap font-mono font-semibold tabular-nums" style={{ color: INK }}>
                        {app.id}
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={onCopyAppId}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors hover:border-[var(--color-ink)] ${FOCUS_RING}`}
                      style={{ borderColor: BORDER_INPUT, color: INK }}
                    >
                      {idCopy === 'copied' ? (
                        <Check aria-hidden="true" size={16} strokeWidth={2} />
                      ) : (
                        <Copy aria-hidden="true" size={16} strokeWidth={1.5} />
                      )}
                      <span>{idCopy === 'copied' ? 'คัดลอกรหัสใบสมัครแล้ว' : 'คัดลอกรหัสใบสมัคร'}</span>
                    </button>
                  </div>
                  <p role="status" aria-live="polite" className="min-h-[1.4em] text-sm" style={{ color: INK_MUTED }}>
                    {idCopy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่รหัสใบสมัครแล้วเลือกคัดลอก'}
                  </p>
                  <p className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>{NO_QR_NOTE}</p>
                </div>
              )}

              {!slipApproved && !codeReady && (
                <VerifyCodePrompt onFocusCode={focusVerifyCode} action="ส่งหลักฐานสลิป" />
              )}

              <div className="mt-6 border-t pt-5" style={{ borderColor: RULE }}>
                <SlipUploadPanel
                  key={app.id}
                  appId={app.id}
                  slip={slipApproved ? 'APPROVED' : slipState}
                  verifyCode={verifyCode}
                  codeInputId="verify-code"
                  onCodeInvalid={(msg) => {
                    setVerifyError(msg);
                    if (msg) setShowManualVerifyCode(true);
                  }}
                  submitLabel="ยืนยันและส่งหลักฐานสลิป"
                  onUploaded={(status, _message, src) => {
                    setSource(src);
                    setError(null);
                    setVerifyError(null);
                    setApp((prev) => (prev ? { ...prev, hasSlip: true, slipStatus: status } : null));
                  }}
                />
              </div>

              {(moneyHeld || app.status === 'CONFIRMED') && (
                <div id="line-openchat" className="mt-6 scroll-mt-32 border-t pt-5" style={{ borderColor: RULE }}>
                  <h3 className="text-base font-bold leading-7" style={{ color: INK }}>
                    เข้ากลุ่ม LINE OpenChat
                  </h3>
                  <p className="mt-1 text-sm" style={{ color: INK_MUTED }}>
                    {app.status === 'CONFIRMED' && !slipUploaded
                      ? 'สำหรับผู้ที่ยืนยันสิทธิ์เข้าร่วมค่ายแล้ว'
                      : app.status === 'CONFIRMED'
                        ? 'สำหรับผู้ที่ส่งสลิปและยืนยันสิทธิ์แล้ว'
                        : 'สำหรับผู้ที่ส่งสลิปแล้ว'}
                  </p>
                  <div className="mt-4 grid gap-5 sm:grid-cols-[176px_minmax(0,1fr)] sm:items-center">
                    <img
                      src={LINE_OPENCHAT_QR_SRC}
                      alt="QR Code สำหรับเข้ากลุ่ม LINE OpenChat ค่าย ComCamp #25"
                      width={176}
                      height={176}
                      loading="lazy"
                      decoding="async"
                      className="h-44 w-44 rounded-xl bg-white object-contain p-1.5"
                    />
                    <div className="min-w-0 space-y-4">
                      <p className="max-w-[54ch] text-sm leading-7" style={{ color: INK_MUTED }}>
                        สแกน QR หรือกดปุ่มด้านล่างเพื่อเข้ากลุ่ม รับข่าวสารและติดต่อสื่อสารกับพี่ค่ายก่อนวันจัดค่าย
                      </p>
                      <a
                        href={LINE_OPENCHAT_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 sm:w-auto ${FOCUS_RING}`}
                        style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                      >
                        <span>เข้ากลุ่ม LINE OpenChat ทันที</span>
                        <ArrowRight aria-hidden="true" size={16} strokeWidth={1.75} />
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {/* ── 05 · Camp details & staff contacts ──────────────── */}
      <section aria-labelledby="status-info-title" className="mt-12 border-t pt-8" style={{ borderColor: RULE }}>
        <h2 id="status-info-title" className="font-mono text-xs font-semibold uppercase" style={{ color: INK_SUBTLE }}>
          ComCamp #25 — ข้อมูลค่ายและช่องทางติดต่อ
        </h2>
        <div className="mt-4 grid gap-8 md:grid-cols-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold leading-7" style={{ color: INK }}>
              กำหนดการและที่พัก
            </h3>
            <p className="mt-1.5 text-sm leading-7" style={{ color: INK_MUTED }}>
              ค่ายจัดวันที่ <strong className="tabular-nums" style={{ color: INK }}>5–7 กุมภาพันธ์ 2570</strong> (<span className="tabular-nums">3</span> วัน <span className="tabular-nums">2</span> คืน)
              ณ อาคารเรียนสาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้ · พักค้างคืนที่ {DORM_NAME} (แยกโซนชาย-หญิง)
            </p>
            <a
              href={DORM_MAPS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold underline underline-offset-4 ${FOCUS_RING}`}
              style={{ color: INK }}
            >
              <MapPin aria-hidden="true" size={15} strokeWidth={1.75} />
              <span>ดูแผนที่เรือนพัก (Google Maps)</span>
              <ArrowUpRight aria-hidden="true" size={15} strokeWidth={1.75} />
            </a>
          </div>

          <div className="min-w-0">
            <h3 className="text-base font-bold leading-7" style={{ color: INK }}>
              ค่าสมัครและอีเมลแจ้งผล
            </h3>
            <p className="mt-1.5 text-sm leading-7" style={{ color: INK_MUTED }}>
              ค่าสมัคร <strong className="font-mono tabular-nums" style={{ color: INK }}>{feeText}</strong> บาท (โอนภายใน <span className="font-mono tabular-nums">3</span> วันหลังสมัคร · สละสิทธิ์ไม่คืนเงินทุกกรณี)
              รวม 7 รายการ: ที่พัก 2 คืน · อาหารหลัก 6 มื้อ · อาหารว่าง 5 มื้อ · เสื้อค่าย (SSS–4XL) · กระเป๋าพร้อมปั๊มลาย · เอกสารอบรม · เกียรติบัตร
            </p>
            <p className="mt-1.5 text-sm leading-7" style={{ color: INK_MUTED }}>
              ระบบส่งอีเมลแจ้งผลอัตโนมัติ 2 ช่วง (หลังสมัคร <span className="font-mono">PASSED</span> และหลังอนุมัติสลิป <span className="font-mono">CONFIRMED</span>)
            </p>
          </div>

          <div className="min-w-0">
            <h3 className="text-base font-bold leading-7" style={{ color: INK }}>
              ติดต่อพี่ค่ายและอาจารย์
            </h3>
            <p className="mt-1.5 text-sm leading-7" style={{ color: INK_MUTED }}>
              อาจารย์ผู้รับผิดชอบโครงการ: <strong style={{ color: INK }}>{PROJECT_ADVISOR}</strong>
            </p>
            <ul className="mt-2 space-y-1 text-sm leading-7">
              <li>
                <a
                  href={FB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex min-h-11 items-center gap-1.5 font-semibold underline underline-offset-4 ${FOCUS_RING}`}
                  style={{ color: INK }}
                >
                  <span>Facebook: ComCamp CSMJU</span>
                  <ArrowUpRight aria-hidden="true" size={15} strokeWidth={1.75} />
                </a>
              </li>
              {STAFF_CONTACTS.map((c) => (
                <li key={c.tel}>
                  <a
                    href={`tel:${c.tel}`}
                    className={`inline-flex min-h-11 items-center gap-1.5 underline underline-offset-4 ${FOCUS_RING}`}
                    style={{ color: INK }}
                  >
                    <Phone aria-hidden="true" size={14} strokeWidth={1.75} />
                    <span className="font-mono font-semibold tabular-nums">{c.phone}</span>
                    <span style={{ color: INK_MUTED }}>· {c.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
