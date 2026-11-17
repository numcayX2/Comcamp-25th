/** Payment details and the transfer-deadline rule for the camp fee, shared by /register, /status and /admin. */

/** Payment account for the camp fee. There is no QR code: transfer by account number only. */
export const PAY_ACCOUNT = {
  bank: 'ธนาคารกรุงเทพ สาขาแม่โจ้',
  name: 'ชมรมคอมพิวเตอร์',
  holders: 'นาย ภานุวัฒน์ เมฆะ และ นาย อรรถวิท ชังคมานนท์ และ นาย ปวีณ เขื่อนแก้ว',
  number: '587-0-84106-0',
} as const;

/** The only wording about how to pay: no PromptPay, no QR code. */
export const NO_QR_NOTE = 'ไม่มี QR Code สำหรับชำระเงิน โอนผ่านเลขบัญชีด้านบนเท่านั้น';

/** Digits only, so banking apps accept the paste. */
export const PAY_ACCOUNT_DIGITS = PAY_ACCOUNT.number.replace(/\D/g, '');

/** Clipboard API first; fall back to execCommand for Facebook / LINE in-app browsers. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ───────────────────────── Transfer deadline ───────────────────────── */

/**
 * The unpaid-seat rule the server enforces (backend ExpireOverdueUnpaid, UnpaidExpiryWindow and
 * UnpaidGraceWindow): a seat without a slip is released at
 *   max(created + PAYMENT_WINDOW_HOURS, updated + PAYMENT_GRACE_HOURS, last rejected slip + PAYMENT_GRACE_HOURS).
 * Keep these two numbers in step with backend/internal/service/applicant_service.go.
 */
export const PAYMENT_WINDOW_HOURS = 120;
export const PAYMENT_GRACE_HOURS = 24;
export const PAYMENT_WINDOW_DAYS = PAYMENT_WINDOW_HOURS / 24;

const HOUR_MS = 60 * 60 * 1000;
export const PAYMENT_WINDOW_MS = PAYMENT_WINDOW_HOURS * HOUR_MS;
export const PAYMENT_GRACE_MS = PAYMENT_GRACE_HOURS * HOUR_MS;

export interface PaymentDeadlineInfo {
  deadlineText: string;
  remainingText: string;
  isOverdue: boolean;
  isUrgent: boolean;
}

const parseMs = (iso?: string | null): number => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The enforced transfer deadline in epoch ms: max(created + 120h, updated + 24h, rejected slip + 24h).
 * NaN when createdAt is missing or invalid; a missing updatedAt / rejectedAt simply adds no grace.
 */
export function paymentDueMs(
  createdAtIso?: string | null,
  updatedAtIso?: string | null,
  slipRejectedAtIso?: string | null,
): number {
  const created = parseMs(createdAtIso);
  if (!Number.isFinite(created)) return Number.NaN;
  let due = created + PAYMENT_WINDOW_MS;
  for (const t of [parseMs(updatedAtIso), parseMs(slipRejectedAtIso)]) {
    if (Number.isFinite(t)) due = Math.max(due, t + PAYMENT_GRACE_MS);
  }
  return due;
}

/** Formats a deadline (epoch ms) in Asia/Bangkok time with the time left before auto-expiry. */
export function describePaymentDue(deadlineMs: number, nowMs: number = Date.now()): PaymentDeadlineInfo {
  const d = new Date(deadlineMs);
  const datePart = d.toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  });
  const timePart = d.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });
  const deadlineText = `${datePart} เวลา ${timePart} น.`;
  const diffMs = deadlineMs - nowMs;

  if (diffMs <= 0) {
    return {
      deadlineText,
      remainingText: `ครบกำหนด ${PAYMENT_WINDOW_DAYS} วัน (${PAYMENT_WINDOW_HOURS} ชั่วโมง) แล้ว`,
      isOverdue: true,
      isUrgent: true,
    };
  }

  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;

  let remainingText: string;
  if (days > 0) {
    remainingText = hours > 0 ? `เหลือเวลาโอนอีก ${days} วัน ${hours} ชั่วโมง` : `เหลือเวลาโอนอีก ${days} วัน`;
  } else if (hours > 0) {
    remainingText = mins > 0 ? `เหลือเวลาโอนอีก ${hours} ชั่วโมง ${mins} นาที` : `เหลือเวลาโอนอีก ${hours} ชั่วโมง`;
  } else {
    remainingText = `เหลือเวลาโอนอีก ${mins} นาที`;
  }

  return {
    deadlineText,
    remainingText,
    isOverdue: false,
    isUrgent: diffMs <= 24 * HOUR_MS,
  };
}

/**
 * The 120-hour (5-day) transfer/slip deadline counted from registration alone (createdAt, or now
 * when it is missing). Prefer describeApplicantPaymentDeadline when updatedAt is known.
 */
export function describePaymentDeadline(createdAtIso?: string | null, nowMs: number = Date.now()): PaymentDeadlineInfo {
  const created = parseMs(createdAtIso);
  return describePaymentDue((Number.isFinite(created) ? created : nowMs) + PAYMENT_WINDOW_MS, nowMs);
}

/**
 * The deadline the server enforces for an unpaid seat, as far as the public response shows it:
 * 120h after registration, but never earlier than 24h after the last staff change to the
 * application (updatedAt, e.g. a restored seat). A slip rejected by staff adds a further 24h that
 * is not part of the public response, so for that case the real deadline can be later than shown
 * here, never earlier.
 */
export function describeApplicantPaymentDeadline(
  createdAtIso?: string | null,
  updatedAtIso?: string | null,
  nowMs: number = Date.now(),
): PaymentDeadlineInfo {
  const due = paymentDueMs(createdAtIso, updatedAtIso);
  return Number.isFinite(due) ? describePaymentDue(due, nowMs) : describePaymentDeadline(null, nowMs);
}

/**
 * The full enforced deadline for staff, including the 24h grace after a rejected slip
 * (slipRejectedAtIso = the rejection time, or null when the latest slip is not REJECTED).
 */
export function describeStaffPaymentDeadline(
  createdAtIso?: string | null,
  updatedAtIso?: string | null,
  slipRejectedAtIso?: string | null,
  nowMs: number = Date.now(),
): PaymentDeadlineInfo {
  const due = paymentDueMs(createdAtIso, updatedAtIso, slipRejectedAtIso);
  return Number.isFinite(due) ? describePaymentDue(due, nowMs) : describePaymentDeadline(createdAtIso, nowMs);
}
