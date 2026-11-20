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
  FileDown,
  Hourglass,
  Info,
  ListOrdered,
  MapPin,
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
  withdrawApplication,
  hasSlip,
  holdsSeat,
  isApplicationCodeQuery,
  isPhoneLookup,
  isPhoneQuery,
  normalizeLookupQuery,
  type Application,
  type ApplicationStatus,
  type ApiSource,
  type PhoneLookupResult,
} from '../lib/api';
import {
  DORM_MAPS_URL,
  DORM_NAME,
  FB_URL,
  CAMP_FEE_TEXT,
  LINE_OPENCHAT_QR_SRC,
  LINE_OPENCHAT_URL,
  PROJECT_ADVISOR,
  MAX_CAPACITY,
  SIZE_CHEST,
  SIZE_LENGTH,
  PAYMENT_WINDOW_DAYS,
  PAYMENT_WINDOW_HOURS,
  STAFF_CONTACTS,
  describeApplicantPaymentDeadline,
  formatCampFee,
} from './register/model';
import { clearReceipt, loadReceipt } from './register/storage';
import { WITHDRAW_MISMATCH_COPY, cleanPhoneInput, describeApiError as describeError } from '../lib/slip-upload';
import { NO_QR_NOTE, PAY_ACCOUNT, PAY_ACCOUNT_DIGITS, copyText } from '../lib/payment';
import { DOCS_READY, PARENT_CONSENT_PDF } from '../lib/camp-facts';
import { SlipUploadPanel } from './slip/SlipUploadPanel';

/* Status colours are tokens from global.css, so light and dark both follow the theme. */
const STATUS_DOT: Record<ApplicationStatus, string> = {
  PENDING: 'var(--color-warning)',
  PASSED: 'var(--color-tech)',
  RESERVE: 'var(--color-ink-subtle)',
  CONFIRMED: 'var(--color-success)',
  REJECTED: 'var(--color-danger)',
  REFUND_PENDING: 'var(--color-warning)',
  REFUNDED: 'var(--color-ink-subtle)',
  FORFEITED: 'var(--color-danger)',
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอพิจารณา',
  PASSED: 'ได้รับสิทธิ์แล้ว',
  RESERVE: 'ตัวสำรอง',
  CONFIRMED: 'ยืนยันสิทธิ์สำเร็จ',
  REJECTED: 'ไม่ผ่านการคัดเลือก',
  REFUND_PENDING: 'รอคืนเงิน',
  REFUNDED: 'คืนเงินแล้ว',
  FORFEITED: 'หมดสิทธิ์',
};

const INK = 'var(--color-ink)';
const INK_MUTED = 'var(--color-ink-muted)';
const INK_SUBTLE = 'var(--color-ink-subtle)';
const RULE = 'var(--color-border)';
const SURFACE = 'var(--bg-card)';
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
        badge: 'ไม่ผ่าน',
        title: 'ใบสมัครนี้ไม่ผ่านการพิจารณา',
        body: 'ที่นั่งของใบสมัครนี้ถูกปล่อยคืนแล้ว หากคิดว่าเกิดความผิดพลาดหรือมีข้อสงสัย กรุณาติดต่อทีมงาน',
        contact: true,
      };
    case 'FORFEITED':
      return {
        tone: 'danger',
        icon: CircleX,
        badge: 'หมดสิทธิ์',
        title: 'ใบสมัครนี้หมดสิทธิ์เนื่องจากไม่ได้ชำระเงินตามกำหนด',
        body: `ระบบตัดสิทธิ์อัตโนมัติเพราะไม่ได้ชำระเงินและแนบสลิปภายใน ${PAYMENT_WINDOW_DAYS} วัน (${PAYMENT_WINDOW_HOURS} ชั่วโมง) หลังสมัคร ที่นั่งจึงถูกคืนให้ผู้สมัครคนอื่นแล้ว หากชำระเงินไปแล้วหรือคิดว่าเกิดความผิดพลาด กรุณาติดต่อพี่ค่าย`,
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
  const dl = describeApplicantPaymentDeadline(app.createdAt, app.updatedAt, nowMs);
  if (slip === 'REJECTED') {
    return {
      tone: 'danger',
      icon: TriangleAlert,
      badge: `สลิปไม่ผ่าน · ${dl.remainingText}`,
      title: 'สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดสลิปใหม่',
      body: `โปรดตรวจสอบยอดโอน ${feeText} บาท และความชัดเจนของรูป แล้วอัปโหลดสลิปใหม่ที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่างภายในวันที่ ${dl.deadlineText} (มิฉะนั้นระบบอาจคืนที่นั่งเมื่อพ้นกำหนด)`,
      toSlip: true,
      contact: true,
    };
  }
  return {
    tone: dl.isUrgent ? 'warning' : 'tech',
    icon: Ticket,
    badge: `สมัครทันแล้ว · ${dl.remainingText}`,
    title: 'เย้! ดีใจด้วย คุณสมัครทันแล้ว ได้ที่นั่งในค่าย ComCamp #25',
    body: `ระบบจองที่นั่งให้คุณเรียบร้อยแล้ว (สิทธิ์แบบมาก่อนได้ก่อน จำกัด ${seats} ที่นั่ง) กรุณาโอนค่าสมัคร ${feeText} บาท และอัปโหลดสลิปที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่างภายในวันที่ ${dl.deadlineText} (ภายใน ${PAYMENT_WINDOW_DAYS} วัน / ${PAYMENT_WINDOW_HOURS} ชั่วโมงหลังสมัคร) มิฉะนั้นระบบจะตัดสิทธิ์และคืนที่นั่งว่างอัตโนมัติ`,
    toSlip: true,
  };
}

function confirmedHighlight(): Highlight {
  return {
    tone: 'success',
    icon: CircleCheck,
    badge: 'สลิปค่าสมัครผ่านการตรวจสอบแล้ว',
    title: 'สลิปผ่านการตรวจสอบ / ยืนยันสิทธิ์เข้าร่วมค่ายสมบูรณ์แล้ว',
    body: `น้องมีที่นั่งในค่าย ComCamp #25 วันที่ 5–7 กุมภาพันธ์ 2570 (3 วัน 2 คืน) ณ อาคาร 60 ปี แม่โจ้ ชั้น 6 (สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้) และเข้าพักที่${DORM_NAME}เรียบร้อยแล้ว — กดเข้ากลุ่ม LINE OpenChat ด้านล่างเพื่อรับข่าวสารและกำหนดการวันเข้าค่ายจากพี่ค่ายได้เลย`,
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
  // Seat holders need the signed parent consent; hidden until the real file replaces the placeholder.
  const showConsentPdf = DOCS_READY && holdsSeat(app.status);
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
                <strong style={{ color: INK }}>สถานที่อบรมและที่พัก:</strong> อาคาร 60 ปี แม่โจ้ ชั้น 6 (สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้) · ที่พัก {DORM_NAME} (แยกโซนชาย-หญิง){' '}
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
          {(h.toSlip || h.toLine || h.contact || showConsentPdf) && (
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
              {showConsentPdf && (
                <a
                  href={PARENT_CONSENT_PDF}
                  download
                  className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors sm:w-auto ${FOCUS_RING}`}
                  style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                >
                  <FileDown aria-hidden="true" size={16} strokeWidth={1.5} />
                  ดาวน์โหลดใบขออนุญาตผู้ปกครอง (PDF)
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
                      className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border px-5 py-2 text-sm font-semibold leading-7 transition-colors sm:w-auto sm:gap-1.5 sm:px-4 ${FOCUS_RING}`}
                      style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                    >
                      <Phone aria-hidden="true" size={14} strokeWidth={1.75} />
                      <span className="flex flex-col items-center text-center sm:flex-row sm:gap-1.5">
                        <span className="whitespace-nowrap font-mono tabular-nums">{c.phone}</span>
                        <span className="whitespace-normal font-normal" style={{ color: INK_MUTED }}>
                          <span aria-hidden="true" className="hidden sm:inline">· </span>
                          {c.name}
                        </span>
                      </span>
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

const PHONE_SLIP_LABEL: Record<'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED', string> = {
  NONE: 'ยังไม่ได้ส่งสลิป',
  PENDING: 'ได้รับสลิปแล้ว รอทีมงานตรวจสอบ',
  APPROVED: 'สลิปผ่านการตรวจสอบแล้ว',
  REJECTED: 'สลิปไม่ผ่านการตรวจสอบ ส่งใหม่ได้ด้วยรหัสใบสมัคร',
};

/**
 * Answer to a search by phone number. A phone number is easy to know, so the server sends only a
 * short masked status and never the application code; this card therefore offers NO write action
 * (no slip upload, no withdraw, no copy-code). It points the applicant to the code in their email.
 */
function PhoneLookupCard({
  result,
  source,
  nowMs,
  onSearchByCode,
}: {
  result: PhoneLookupResult;
  source: ApiSource | null;
  nowMs: number;
  onSearchByCode: () => void;
}) {
  const slip = result.hasSlip ? (result.slipStatus ?? 'PENDING') : null;
  const showDeadline = result.status === 'PASSED' && (slip === null || slip === 'REJECTED');
  const dl = showDeadline ? describeApplicantPaymentDeadline(result.createdAt, result.updatedAt, nowMs) : null;
  const rows: { k: string; v: string; mono: boolean }[] = [
    { k: 'เบอร์โทรศัพท์ติดต่อ', v: result.phone, mono: true },
    ...(result.email ? [{ k: 'อีเมล', v: result.email, mono: false }] : []),
    { k: 'สลิปค่าสมัคร', v: PHONE_SLIP_LABEL[slip ?? 'NONE'], mono: false },
    ...(dl ? [{ k: 'กำหนดโอนและแนบสลิป', v: `ภายใน ${dl.deadlineText} (${dl.remainingText})`, mono: false }] : []),
  ];
  return (
    <section className="st-card" aria-labelledby="phone-result-title" data-lookup="phone">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: INK }}>
        <div className="min-w-0">
          <h2 id="phone-result-title" className="text-sm font-bold leading-6" style={{ color: INK_SUBTLE }}>
            สถานะโดยย่อ (ค้นหาด้วยเบอร์โทรศัพท์)
          </h2>
          <p className="mt-1 break-words text-2xl font-semibold leading-9" style={{ color: INK }}>
            {result.fullName}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusTag status={result.status} />
          {import.meta.env.DEV && source && (
            <span className="rounded-sm border px-2 py-0.5 font-mono text-[11px] font-semibold" style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}>
              {source}
            </span>
          )}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.k} className="min-w-0 border-b py-2.5 sm:py-3" style={{ borderColor: RULE }}>
            <dt className="text-xs font-semibold leading-5" style={{ color: INK_SUBTLE }}>{row.k}</dt>
            <dd className={`mt-0.5 break-words [overflow-wrap:anywhere] text-base leading-7 ${row.mono ? 'font-mono tabular-nums' : 'font-medium'}`} style={{ color: INK }}>
              {row.v}
            </dd>
          </div>
        ))}
      </dl>

      <div role="note" className="st-notice mt-6">
        <p className="flex items-start gap-2.5 text-base font-semibold leading-7" style={{ color: INK }}>
          <Info aria-hidden="true" size={18} strokeWidth={1.75} className="mt-1 shrink-0" style={{ color: 'var(--color-tech)' }} />
          <span>
            ส่งสลิปหรือจัดการใบสมัคร ต้องค้นหาด้วยรหัสใบสมัคร{' '}
            <span className="whitespace-nowrap font-mono tabular-nums">CC25-XXXXXX</span>
          </span>
        </p>
        <p className="mt-1.5 max-w-[62ch] text-sm leading-7" style={{ color: INK_MUTED }}>
          รหัสใบสมัครอยู่ในอีเมลที่ได้รับหลังสมัคร (และบนหน้าใบตอบรับหลังกดส่ง) เพื่อความปลอดภัย
          การค้นหาด้วยเบอร์โทรจึงแสดงเพียงสถานะโดยย่อ หากหารหัสไม่พบ กรุณาติดต่อทีมงาน
        </p>
        <p className="mt-1 max-w-[62ch] text-sm leading-7" style={{ color: INK_MUTED }}>
          ไม่พบอีเมล? ลองดูในโฟลเดอร์ Spam / จดหมายขยะ หรือแท็บ Promotions (Gmail)
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onSearchByCode}
            className={`inline-flex min-h-11 w-full items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 sm:w-auto ${FOCUS_RING}`}
            style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
          >
            ค้นหาด้วยรหัสใบสมัคร
          </button>
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
              className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border px-5 py-2 text-sm font-semibold leading-7 transition-colors sm:w-auto sm:gap-1.5 sm:px-4 ${FOCUS_RING}`}
              style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
            >
              <Phone aria-hidden="true" size={14} strokeWidth={1.75} />
              <span className="flex flex-col items-center text-center sm:flex-row sm:gap-1.5">
                <span className="whitespace-nowrap font-mono tabular-nums">{c.phone}</span>
                <span className="whitespace-normal font-normal" style={{ color: INK_MUTED }}>
                  <span aria-hidden="true" className="hidden sm:inline">· </span>
                  {c.name}
                </span>
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Copy for a query that is neither a 10-digit phone nor a CC25 code; it is never sent. */
const BAD_QUERY_COPY = 'ค้นหาได้ด้วยเบอร์โทรศัพท์ 10 หลัก (ขึ้นต้นด้วย 0) หรือรหัสใบสมัคร CC25-XXXXXX เท่านั้น กรุณาตรวจสอบอีกครั้ง';

export function StatusSection() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [app, setApp] = useState<Application | null>(null);
  /** Answer to a phone search: masked, without the code, and never enables a write action. */
  const [phoneResult, setPhoneResult] = useState<PhoneLookupResult | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [seats, setSeats] = useState(MAX_CAPACITY);
  const [feeText, setFeeText] = useState(CAMP_FEE_TEXT);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  /** Seconds left before the per-IP lookup limit allows another search (after a short 429). */
  const [cooldown, setCooldown] = useState(0);
  const [storedNotice, setStoredNotice] = useState<string | null>(null);
  const [acctCopy, setAcctCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [idCopy, setIdCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const acctCopyTimer = useRef<number | undefined>(undefined);
  const idCopyTimer = useRef<number | undefined>(undefined);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawErr, setWithdrawErr] = useState<string | null>(null);
  /** The full registered phone, the second factor for self-withdraw (R24). State only, never stored. */
  const [withdrawPhone, setWithdrawPhone] = useState('');
  const withdrawPhoneReady = /^0\d{9}$/.test(withdrawPhone);
  /** Set after a successful withdrawal; the record is cleared and this notice replaces it. */
  const [withdrawnId, setWithdrawnId] = useState<string | null>(null);
  const withdrawToggleRef = useRef<HTMLButtonElement>(null);
  const withdrawConfirmRef = useRef<HTMLButtonElement>(null);
  const withdrawPhoneRef = useRef<HTMLInputElement>(null);
  /** After a failed attempt the phone field is refocused once it is enabled again. */
  const withdrawRefocus = useRef(false);
  const withdrawnRef = useRef<HTMLDivElement>(null);
  /** Focus goes back to the toggle only when the panel was closed by the user. */
  const withdrawRestore = useRef(false);
  const searchRun = useRef(0);
  const searchBusyRef = useRef(false);
  const withdrawBusyRef = useRef(false);

  const resultAnchorRef = useRef<HTMLDivElement>(null);
  const runSearch = useCallback(async (rawQuery: string, opts?: { fromStoredReceipt?: boolean }) => {
    // Zero-width characters, Thai numerals and hyphens from a LINE copy-paste are removed (§9.2.2).
    const query = normalizeLookupQuery(rawQuery);
    if (!query) return;
    const run = ++searchRun.current;
    setStoredNotice(null);
    setWithdrawOpen(false);
    setWithdrawErr(null);
    setWithdrawPhone('');
    setWithdrawnId(null);
    // Only a 10-digit phone or a CC25 code ever leaves the browser: anything else (for example a
    // 13-digit national ID typed out of habit) is answered here and never sent.
    if (!isPhoneQuery(query) && !isApplicationCodeQuery(query)) {
      searchBusyRef.current = false;
      setBusy(false);
      setApp(null);
      setPhoneResult(null);
      setError(BAD_QUERY_COPY);
      return;
    }
    searchBusyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await getApplicationStatus(query);
      if (run !== searchRun.current) return;
      const data = res.data;
      if (isPhoneLookup(data)) {
        setApp(null);
        setPhoneResult(data);
      } else {
        setPhoneResult(null);
        setApp(data);
      }
      setSource(res.source);
    } catch (err) {
      if (run !== searchRun.current) return;
      if (opts?.fromStoredReceipt && err instanceof ApiHttpError && err.status === 404) {
        clearReceipt();
        setQ('');
        setApp(null);
        setPhoneResult(null);
        setStoredNotice(`ไม่พบข้อมูลใบสมัครที่บันทึกไว้ล่าสุด (${query}) ในระบบ อาจถูกยกเลิกไปแล้ว หากต้องการตรวจสอบ สามารถค้นหาด้วยรหัสใบสมัครจากอีเมล หรือดูสถานะโดยย่อด้วยเบอร์โทรศัพท์ได้ด้านล่าง`);
        return;
      }
      if (err instanceof ApiHttpError && err.status === 429 && err.retryAfterSeconds && err.retryAfterSeconds <= 60) {
        setCooldown(err.retryAfterSeconds);
      }
      setError(describeError(err, 'ไม่พบข้อมูลใบสมัครที่ค้นหา'));
      setApp(null);
      setPhoneResult(null);
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
        /* Fallback to MAX_CAPACITY / CAMP_FEE_TEXT constants when offline. */
      });

    const params = new URLSearchParams(window.location.search);
    const urlQuery = (params.get('q') ?? params.get('id') ?? '').trim();
    if (urlQuery) {
      // The email link carries the code (/status?q=CC25-…). Read it once, then drop it from the
      // address bar so it is not left in the visible URL, a screenshot or a shared link.
      params.delete('q');
      params.delete('id');
      const rest = params.toString();
      try {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
      } catch {
        /* some in-app browsers refuse replaceState; the search still runs */
      }
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
    if (withdrawOpen) withdrawPhoneRef.current?.focus();
    else if (withdrawRestore.current) {
      withdrawRestore.current = false;
      withdrawToggleRef.current?.focus();
    }
  }, [withdrawOpen]);
  useEffect(() => {
    if (withdrawnId) withdrawnRef.current?.focus();
  }, [withdrawnId]);
  useEffect(() => {
    if (!withdrawBusy && withdrawRefocus.current) {
      withdrawRefocus.current = false;
      withdrawPhoneRef.current?.focus();
      withdrawPhoneRef.current?.select();
    }
  }, [withdrawBusy]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    if (busy || searchBusyRef.current || cooldown > 0 || !q.trim()) return;
    void runSearch(q).then(() => {
      // On a phone the outcome lands below the fold; bring it up so the tap visibly did something.
      requestAnimationFrame(() => {
        const el = resultAnchorRef.current;
        if (!el || el.getBoundingClientRect().top < window.innerHeight * 0.7) return;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      });
    });
  }

  /** From the phone-lookup card: put the cursor in the search box for the CC25 code. */
  function focusCodeSearch() {
    setQ('');
    const el = searchInputRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
  }

  function closeWithdraw() {
    if (withdrawBusy || withdrawBusyRef.current) return;
    withdrawRestore.current = true;
    setWithdrawOpen(false);
    setWithdrawPhone('');
    setWithdrawErr(null);
  }

  async function onWithdraw() {
    if (!app || !withdrawPhoneReady || withdrawBusy || withdrawBusyRef.current) return;
    withdrawBusyRef.current = true;
    setWithdrawBusy(true);
    setError(null);
    setWithdrawErr(null);
    try {
      await withdrawApplication(app.id, withdrawPhone);
      const id = app.id;
      if (loadReceipt()?.id === id) clearReceipt();
      setApp(null);
      setSource(null);
      setWithdrawPhone('');
      setWithdrawOpen(false);
      setWithdrawnId(id);
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 429) {
        setWithdrawErr(describeError(err, 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'));
        withdrawRefocus.current = true;
      } else if (err instanceof ApiHttpError && err.status === 404) {
        // An unknown code and a wrong phone are the same 404 on purpose: never say which part was
        // wrong, and keep the stored receipt (the code itself may be fine).
        setWithdrawErr(WITHDRAW_MISMATCH_COPY);
        withdrawRefocus.current = true;
      } else if (err instanceof ApiHttpError && err.status === 409) {
        setWithdrawOpen(false);
        setWithdrawPhone('');
        setError('ใบสมัครนี้ยกเลิกเองไม่ได้ (ยืนยันสิทธิ์แล้ว ส่งสลิปแล้ว หรือปิดรายการแล้ว) กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการเพื่อแจ้งยกเลิก');
        getApplicationStatus(app.id)
          .then((res) => {
            if (isPhoneLookup(res.data)) return;
            setApp(res.data);
            setSource(res.source);
          })
          .catch(() => {});
      } else {
        setError(describeError(err, 'ยกเลิกใบสมัครไม่สำเร็จ'));
      }
    } finally {
      withdrawBusyRef.current = false;
      setWithdrawBusy(false);
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
  const paymentDeadline = app ? describeApplicantPaymentDeadline(app.createdAt, app.updatedAt, nowMs) : null;

  useEffect(() => {
    if (!app || app.status !== 'PASSED' || slipApproved || moneyHeld) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [app, slipApproved, moneyHeld]);
  const canWithdraw = Boolean(app && seatHeld && app.status !== 'CONFIRMED' && !moneyHeld);
  // Cancelling is staff-only: say so, with the way to reach them.
  const mustAskStaffToCancel = seatHeld && !canWithdraw;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      {/* ── Masthead + search: the search field is in the first phone screen ── */}
      <header className="border-t-4 pt-5" style={{ borderColor: INK }}>
        <h1 className="text-balance text-3xl font-bold leading-[1.22] sm:text-5xl" style={{ color: INK }}>
          ตรวจสอบสถานะใบสมัคร
        </h1>
        <p className="mt-3 max-w-[52ch] text-base leading-7" style={{ color: INK_MUTED }}>
          ดูผลการสมัครและส่งสลิปโอนเงินได้ในหน้านี้ โดยไม่ต้องสมัครใหม่
        </p>
      </header>

      <section className="mt-6 grid gap-x-10 gap-y-6 md:mt-10 md:grid-cols-12">
        <div className="hidden md:col-span-5 md:block">
          <h2 className="text-balance text-xl font-bold leading-8" style={{ color: INK }}>
            ค้นหาใบสมัครของน้อง
          </h2>
          <p className="mt-2 max-w-[42ch] text-base leading-7" style={{ color: INK_MUTED }}>
            ค้นหาด้วยรหัสใบสมัคร <span className="whitespace-nowrap font-mono text-sm tabular-nums">CC25-XXXXXX</span>{' '}
            จากอีเมลหรือหน้าใบตอบรับ เพื่อดูรายละเอียดและส่งสลิป หรือใช้เบอร์โทรศัพท์ที่ใช้สมัครเพื่อดูสถานะโดยย่อ
          </p>
        </div>

        <form onSubmit={onSearch} className="st-card md:col-span-7">
          <label className="mb-1.5 block text-sm font-semibold" style={{ color: INK }} htmlFor="status-q">
            รหัสใบสมัคร หรือเบอร์โทรศัพท์
          </label>
          <div className="relative flex items-center">
            <input
              ref={searchInputRef}
              id="status-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="เช่น CC25-1A2B3C หรือ 0812345678"
              autoComplete="off"
              spellCheck={false}
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
            disabled={busy || cooldown > 0 || !q.trim()}
            aria-busy={busy || undefined}
            className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-full px-4 py-3 text-base font-semibold transition-opacity disabled:opacity-50 ${FOCUS_RING}`}
            style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
          >
            {busy ? (
              'กำลังค้นหา…'
            ) : cooldown > 0 ? (
              <span>
                ค้นหาได้อีกครั้งใน <span className="font-mono tabular-nums">{cooldown}</span> วินาที
              </span>
            ) : (
              'ค้นหาข้อมูล'
            )}
          </button>
        </form>
      </section>

      <div ref={resultAnchorRef} aria-hidden="true" className="scroll-mt-24" />

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

      {phoneResult && !app && (
        <div className="mt-8 space-y-8">
          <PhoneLookupCard result={phoneResult} source={source} nowMs={nowMs} onSearchByCode={focusCodeSearch} />
        </div>
      )}

      {app && (
        <div className="mt-8 space-y-8">
          <StatusHighlight app={app} seats={seats} feeText={feeText} nowMs={nowMs} />

          {/* ── Payment: the next task for a PASSED applicant, so it comes before the record ── */}
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
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · ชำระเงินและตรวจสอบสลิปเรียบร้อยแล้ว
                      </>
                    ) : slipState === 'PENDING' ? (
                      <>
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · ได้รับสลิปแล้ว อยู่ระหว่างรอทีมงานตรวจสอบ
                      </>
                    ) : app.status === 'CONFIRMED' ? (
                      <>
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · สถานะยืนยันสิทธิ์แล้ว (หากยังไม่ได้แนบสลิป สามารถอัปโหลดด้านล่าง)
                      </>
                    ) : (
                      <>
                        ค่าสมัครเข้าร่วมค่าย <span className="font-mono tabular-nums">{feeText}</span> บาท · กรุณาโอนและแนบสลิปภายใน{' '}
                        <span className="font-mono tabular-nums">{PAYMENT_WINDOW_DAYS}</span> วัน (<span className="font-mono tabular-nums">{PAYMENT_WINDOW_HOURS}</span> ชั่วโมง) หลังสมัคร
                      </>
                    )}
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
                  aria-label={slipRejected ? 'แจ้งเตือนอัปโหลดสลิปใหม่' : `แจ้งเตือนกำหนดเวลาชำระเงิน ${PAYMENT_WINDOW_DAYS} วัน`}
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
                        <span className="font-mono tabular-nums">{PAYMENT_WINDOW_DAYS}</span> วัน / <span className="font-mono tabular-nums">{PAYMENT_WINDOW_HOURS}</span> ชั่วโมงหลังสมัคร)
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

              <div className="mt-6 border-t pt-5" style={{ borderColor: RULE }}>
                <SlipUploadPanel
                  key={app.id}
                  appId={app.id}
                  slip={slipApproved ? 'APPROVED' : slipState}
                  submitLabel="ยืนยันและส่งหลักฐานสลิป"
                  onUploaded={(status, _message, src) => {
                    setSource(src);
                    setError(null);
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

          {/* ── Application record: details, how to ask staff for a correction, withdrawal ── */}
          <section className="st-card">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: INK }}>
              <div className="min-w-0">
                <h2 className="text-sm font-bold leading-6" style={{ color: INK_SUBTLE }}>
                  ข้อมูลใบสมัคร
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

            <dl className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              {[
                { k: 'ชื่อ – นามสกุล', v: app.fullName, mono: false },
                { k: 'ชื่อเล่น', v: app.nickname || '–', mono: false },
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
                  <dt className="text-xs font-semibold leading-5" style={{ color: INK_SUBTLE }}>{row.k}</dt>
                  <dd className={`mt-0.5 select-text break-words [overflow-wrap:anywhere] text-base leading-7 ${row.mono ? 'font-mono tabular-nums' : 'font-medium'}`} style={{ color: INK }}>
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>

            {/* Corrections are staff-only: the applicant self-edit was switched off (the QR code lives in the contacts column below). */}
            <div id="status-correction" className="mt-6 border-t pt-4" style={{ borderColor: RULE }}>
              <h3 className="text-base font-bold leading-7" style={{ color: INK }}>
                ต้องการแก้ไขข้อมูล?
              </h3>
              <p className="mt-1 max-w-[62ch] text-sm leading-7" style={{ color: INK_MUTED }}>
                หากต้องการแก้ไขข้อมูล (เช่น ชื่อเล่น โรงเรียน จังหวัด ระดับชั้น ไซส์เสื้อ) กรุณาติดต่อทีมงาน พร้อมแจ้งรหัสใบสมัคร{' '}
                <span className="select-all whitespace-nowrap font-mono tabular-nums">{app.id}</span>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
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
                    className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border px-5 py-2 text-sm font-semibold leading-7 transition-colors sm:w-auto sm:gap-1.5 sm:px-4 ${FOCUS_RING}`}
                    style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                  >
                    <Phone aria-hidden="true" size={14} strokeWidth={1.75} />
                    <span className="flex flex-col items-center text-center sm:flex-row sm:gap-1.5">
                      <span className="whitespace-nowrap font-mono tabular-nums">{c.phone}</span>
                      <span className="whitespace-normal font-normal" style={{ color: INK_MUTED }}>
                        <span aria-hidden="true" className="hidden sm:inline">· </span>
                        {c.name}
                      </span>
                    </span>
                  </a>
                ))}
              </div>
              <p className="mt-2 text-sm leading-7" style={{ color: INK_MUTED }}>
                สแกน QR เพจ Facebook ได้ที่หัวข้อ{' '}
                <a href="#status-info-title" className={`font-semibold underline underline-offset-4 ${FOCUS_RING}`} style={{ color: INK }}>
                  ข้อมูลค่ายและช่องทางติดต่อ
                </a>{' '}
                ด้านล่างของหน้านี้
              </p>
            </div>

            {/* Self-service withdrawal: frees the seat. Needs the code this record was found by AND the full registered phone (R24). */}
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
                      <label htmlFor="withdraw-phone" className="block text-sm font-semibold leading-7" style={{ color: INK }}>
                        เบอร์โทรที่ใช้สมัคร
                      </label>
                      <input
                        id="withdraw-phone"
                        ref={withdrawPhoneRef}
                        value={withdrawPhone}
                        // Digits only, max 10: Thai digits become 0-9; dashes, spaces and zero-width characters go (§9.2.2).
                        onChange={(e) => {
                          setWithdrawPhone(cleanPhoneInput(e.target.value));
                          if (withdrawErr) setWithdrawErr(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void onWithdraw();
                          }
                        }}
                        type="tel"
                        inputMode="tel"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="08XXXXXXXX"
                        disabled={withdrawBusy}
                        aria-invalid={withdrawErr ? true : undefined}
                        aria-describedby={withdrawErr ? 'withdraw-warn withdraw-phone-hint withdraw-err' : 'withdraw-warn withdraw-phone-hint'}
                        className={`mt-1 w-full rounded-xl border bg-[var(--bg-card)] px-3.5 py-2.5 font-mono text-base leading-7 tabular-nums outline-none transition-colors placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-tech)] focus-visible:ring-2 focus-visible:ring-[var(--color-tech)]/30 disabled:opacity-60`}
                        style={{ borderColor: withdrawErr ? 'var(--color-danger)' : BORDER_INPUT, color: INK }}
                      />
                      <p id="withdraw-phone-hint" className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>
                        กรอกเบอร์โทรศัพท์ <span className="font-mono tabular-nums">10</span> หลักที่ใช้สมัคร แล้วกดยืนยันเพื่อยกเลิกใบสมัครนี้ ระบบไม่บันทึกเบอร์นี้ไว้ในเครื่อง
                      </p>
                    </div>
                    {withdrawErr && (
                      <p id="withdraw-err" role="alert" className="mt-1 max-w-[60ch] text-sm font-semibold leading-7" style={{ color: 'var(--color-danger)' }}>
                        {withdrawErr}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        ref={withdrawConfirmRef}
                        type="button"
                        onClick={onWithdraw}
                        disabled={withdrawBusy || !withdrawPhoneReady}
                        aria-busy={withdrawBusy || undefined}
                        aria-describedby={withdrawErr ? 'withdraw-warn withdraw-err' : 'withdraw-warn'}
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
                  <span className="select-all whitespace-nowrap font-mono tabular-nums">{app.id}</span> (กรณีโอนเงินแล้วหรือยืนยันสิทธิ์แล้ว กรุณาติดต่อคุยกับทีมงานโดยตรง)
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

        </div>
      )}
      {/* ── 05 · Camp details & staff contacts ──────────────── */}
      <section aria-labelledby="status-info-title" className="mt-12 border-t pt-8" style={{ borderColor: RULE }}>
        <h2 id="status-info-title" className="text-xl font-bold leading-8" style={{ color: INK }}>
          ข้อมูลค่ายและช่องทางติดต่อ
        </h2>
        <div className="mt-4 grid gap-8 md:grid-cols-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold leading-7" style={{ color: INK }}>
              กำหนดการและที่พัก
            </h3>
            <p className="mt-1.5 text-sm leading-7" style={{ color: INK_MUTED }}>
              ค่ายจัดวันที่ <strong className="tabular-nums" style={{ color: INK }}>5–7 กุมภาพันธ์ 2570</strong> (<span className="tabular-nums">3</span> วัน <span className="tabular-nums">2</span> คืน)
              ณ อาคาร 60 ปี แม่โจ้ ชั้น 6 (สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้) · พักค้างคืนที่ {DORM_NAME} (แยกโซนชาย-หญิง)
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
            <p className="mt-3 text-sm leading-7" style={{ color: INK_MUTED }}>
              <strong style={{ color: INK }}>สิทธิพิเศษ:</strong> หากผ่านการเข้าค่ายจะได้รับพิจารณาเป็นพิเศษเมื่อสมัครเรียนต่อที่สาขาวิชาวิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้
            </p>
          </div>

          <div className="min-w-0">
            <h3 className="text-base font-bold leading-7" style={{ color: INK }}>
              ค่าสมัครและอีเมลแจ้งผล
            </h3>
            <p className="mt-1.5 text-sm leading-7" style={{ color: INK_MUTED }}>
              ค่าสมัคร <strong className="font-mono tabular-nums" style={{ color: INK }}>{feeText}</strong> บาท (โอนภายใน <span className="font-mono tabular-nums">{PAYMENT_WINDOW_DAYS}</span> วันหลังสมัคร)
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
                    className={`inline-flex min-h-11 max-w-full flex-wrap items-center gap-x-1.5 underline underline-offset-4 ${FOCUS_RING}`}
                    style={{ color: INK }}
                  >
                    <Phone aria-hidden="true" size={14} strokeWidth={1.75} />
                    <span className="whitespace-nowrap font-mono font-semibold tabular-nums">{c.phone}</span>
                    <span className="min-w-0" style={{ color: INK_MUTED }}>· {c.name}</span>
                  </a>
                </li>
              ))}
            </ul>
            <figure className="mt-3 flex items-center gap-3">
              <img
                src="/assets/facebook-page-qr.svg"
                width={120}
                height={120}
                loading="lazy"
                decoding="async"
                alt="QR Code เพจ Facebook ComCamp (CCCSMJU)"
                className="shrink-0 rounded-xl border p-2"
                style={{ backgroundColor: '#FFFFFF', borderColor: RULE }}
              />
              <figcaption className="text-sm leading-7" style={{ color: INK_MUTED }}>
                สแกนเพื่อเข้าเพจ Facebook
              </figcaption>
            </figure>
          </div>
        </div>
      </section>
    </div>
  );
}
