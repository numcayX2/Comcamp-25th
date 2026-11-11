import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  ListOrdered,
  Pencil,
  Receipt,
  RotateCcw,
  Ticket,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  ApiHttpError,
  getApplicationStatus,
  confirmAttendance,
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
  FB_URL,
  GRADES,
  GRADE_OTHER,
  GRADE_OTHER_MAX,
  SHIRT_SIZES,
  SIZE_CHEST,
  gradeValue,
  splitGrade,
  validateGradeFields,
} from './register/model';
import { describeApiError as describeError } from '../lib/slip-upload';
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
      <span aria-hidden="true" className="text-[10px] leading-none" style={{ color }}>
        ●
      </span>
      {children}
    </span>
  );
}

function StatusTag({ status }: { status: ApplicationStatus }) {
  return (
    <DotPill color={STATUS_DOT[status]}>
      {STATUS_LABELS[status] || status}
      <span className="font-mono text-[11px] font-medium tabular-nums" style={{ color: INK_SUBTLE }}>
        {status}
      </span>
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
  /** Offer the staff Facebook page. */
  contact?: boolean;
}

/** One place that decides the headline for every status / slip combination. */
function describeHighlight(app: Application): Highlight {
  const slip = hasSlip(app) ? (app.slipStatus ?? 'PENDING') : null;

  switch (app.status) {
    case 'CONFIRMED':
      return confirmedHighlight();
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
        title: 'ใบสมัครนี้ไม่ผ่านการคัดเลือก',
        body: 'ที่นั่งของใบสมัครนี้ถูกปล่อยคืนแล้ว หากคิดว่าเกิดความผิดพลาด กรุณาติดต่อทีมงาน',
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

  // PASSED: what happens next depends on the slip.
  if (slip === 'APPROVED') return confirmedHighlight();
  if (slip === 'PENDING') {
    return {
      tone: 'warning',
      icon: Clock,
      badge: 'รอตรวจสลิป',
      title: 'ได้รับสลิปแล้ว กำลังรอเจ้าหน้าที่ตรวจสอบ',
      body: 'ทีมงานจะตรวจสอบและยืนยันสิทธิ์ให้โดยเร็วที่สุด ไม่ต้องส่งสลิปซ้ำ และกลับมาดูสถานะในหน้านี้ได้ทุกเมื่อ',
    };
  }
  if (slip === 'REJECTED') {
    return {
      tone: 'danger',
      icon: TriangleAlert,
      badge: 'สลิปไม่ผ่าน',
      title: 'สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดสลิปใหม่',
      body: 'โปรดตรวจสอบยอดโอน 1,000 บาทและความชัดเจนของรูป แล้วอัปโหลดสลิปใหม่ที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่าง',
      toSlip: true,
      contact: true,
    };
  }
  return {
    tone: 'tech',
    icon: Ticket,
    badge: 'ได้รับสิทธิ์แล้ว',
    title: 'ผ่านการคัดเลือก ได้ที่นั่งในค่ายแล้ว',
    body: 'ใครสมัครก่อนได้สิทธิ์ก่อน และน้องได้ที่นั่งแล้ว ขั้นต่อไปคือโอนค่าสมัคร 1,000 บาท แล้วอัปโหลดสลิปที่หัวข้อ “หลักฐานการชำระเงิน” ด้านล่างเพื่อยืนยันสิทธิ์',
    toSlip: true,
  };
}

function confirmedHighlight(): Highlight {
  return {
    tone: 'success',
    icon: CircleCheck,
    badge: 'สลิปผ่านการตรวจสอบ',
    title: 'ยืนยันสิทธิ์เข้าร่วมค่ายสมบูรณ์แล้ว',
    body: 'น้องมีที่นั่งในค่าย ComCamp #25 เรียบร้อย ไม่ต้องดำเนินการอะไรเพิ่ม รอรับข่าวสารจากทีมงานได้เลย',
  };
}

const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-tech)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-card)]';

/**
 * Full-width banner above the record. The tint is the tone mixed into the card colour, the
 * headline stays in the ink colour (AA in both themes), and the colour is never the only cue:
 * icon, badge text and headline all say the same thing.
 */
function StatusHighlight({ app }: { app: Application }) {
  const h = describeHighlight(app);
  const color = TONE_COLOR[h.tone];
  const Icon = h.icon;
  return (
    <section
      role="status"
      aria-labelledby="status-highlight-title"
      data-status={app.status}
      data-tone={h.tone}
      className="rounded-2xl border p-5 sm:p-6"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 12%, ${SURFACE})`,
        borderColor: `color-mix(in srgb, ${color} 40%, ${SURFACE})`,
      }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-full"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 20%, ${SURFACE})`, color }}
        >
          <Icon size={26} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <span
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-semibold"
            style={{ borderColor: `color-mix(in srgb, ${color} 45%, ${SURFACE})`, color: INK, backgroundColor: SURFACE }}
          >
            <span aria-hidden="true" className="text-[10px] leading-none" style={{ color }}>
              ●
            </span>
            {h.badge}
          </span>
          <h2 id="status-highlight-title" className="mt-3 text-balance text-xl font-bold leading-[1.4] sm:text-2xl" style={{ color: INK }}>
            {h.title}
          </h2>
          <p className="mt-2 max-w-[62ch] text-base leading-7" style={{ color: INK_MUTED }}>
            {h.body}
          </p>
          {(h.toSlip || h.contact) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {h.toSlip && (
                <a
                  href="#slip-section"
                  className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 ${FOCUS_RING}`}
                  style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                >
                  ไปส่งหลักฐานการชำระเงิน
                </a>
              )}
              {h.contact && (
                <a
                  href={FB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors ${FOCUS_RING}`}
                  style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                >
                  ติดต่อทีมงานทาง Facebook
                </a>
              )}
            </div>
          )}
        </div>
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
  if (!f.nickname.trim()) e.nickname = 'กรุณากรอกชื่อเล่น';
  if (!f.school.trim()) e.school = 'กรุณากรอกชื่อโรงเรียนหรือสถานศึกษา';
  if (!f.province.trim()) e.province = 'กรุณากรอกจังหวัด';
  const g = validateGradeFields(f.grade, f.gradeOther);
  if (g) e[f.grade === GRADE_OTHER ? 'gradeOther' : 'grade'] = g;
  if (!f.shirtSize) e.shirtSize = 'กรุณาเลือกไซส์เสื้อ';
  return e;
}

export function StatusSection() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [app, setApp] = useState<Application | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A wrong verify code reported by the slip upload, shown beneath the shared #verify-code field. */
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [acctCopy, setAcctCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  /** Last 4 digits of the national ID (AGENTS.md §13.5). Kept in memory only, never stored. */
  const [verifyCode, setVerifyCode] = useState('');
  const codeReady = verifyCode.length === 4;
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  /** Set after a successful withdrawal; the record is cleared and this notice replaces it. */
  const [withdrawnId, setWithdrawnId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [edit, setEdit] = useState<EditForm>({ nickname: '', school: '', province: '', grade: '', gradeOther: '', shirtSize: '' });
  const [editErrors, setEditErrors] = useState<EditErrors>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaved, setEditSaved] = useState(false);
  const editToggleRef = useRef<HTMLButtonElement>(null);
  const editNicknameRef = useRef<HTMLInputElement>(null);
  const editRestore = useRef(false);
  const withdrawToggleRef = useRef<HTMLButtonElement>(null);
  const withdrawConfirmRef = useRef<HTMLButtonElement>(null);
  const withdrawnRef = useRef<HTMLDivElement>(null);
  /** Focus goes back to the toggle only when the panel was closed by the user. */
  const withdrawRestore = useRef(false);

  useEffect(() => {
    if (withdrawOpen) withdrawConfirmRef.current?.focus();
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

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    // Zero-width characters and hyphens from a LINE copy-paste are removed (§9.2.2).
    const query = normalizeLookupQuery(q);
    if (!query) return;
    setBusy(true);
    setError(null);
    setVerifyError(null);
    setVerifyCode('');
    setWithdrawOpen(false);
    setWithdrawnId(null);
    setEditOpen(false);
    setEditSaved(false);
    setEditError(null);
    setEditErrors({});
    try {
      const res = await getApplicationStatus(query);
      setApp(res.data);
      setSource(res.source);
    } catch (err) {
      setError(describeError(err, 'ไม่พบข้อมูลใบสมัครที่ค้นหา'));
      setApp(null);
    } finally {
      setBusy(false);
    }
  }

  async function setAttendance(confirmed: boolean) {
    if (!app || !codeReady) return;
    setConfirmBusy(true);
    setError(null);
    try {
      const res = await confirmAttendance(app.id, confirmed, verifyCode);
      setApp(res.data);
      setSource(res.source);
    } catch (err) {
      setError(describeError(err, confirmed ? 'ยืนยันสิทธิ์ไม่สำเร็จ' : 'ยกเลิกการยืนยันไม่สำเร็จ'));
    } finally {
      setConfirmBusy(false);
    }
  }

  function openEdit() {
    if (!app) return;
    setEdit(formFromApp(app));
    setEditErrors({});
    setEditError(null);
    setEditSaved(false);
    setEditOpen(true);
  }

  function closeEdit() {
    if (editBusy) return;
    editRestore.current = true;
    setEditOpen(false);
  }

  function setEditField<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setEdit((f) => ({ ...f, [key]: value }));
    // Clear the message of the field being fixed; the others stay until the next save.
    setEditErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  async function onSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!app || editBusy) return;
    const errors = validateEdit(edit);
    setEditErrors(errors);
    setEditError(null);
    const firstBad = (['nickname', 'school', 'province', 'grade', 'gradeOther', 'shirtSize'] as const).find((k) => errors[k]);
    if (firstBad) {
      document.getElementById(`edit-${firstBad}`)?.focus();
      return;
    }
    if (!codeReady) return;
    setEditBusy(true);
    try {
      const res = await updateOwnProfile(app.id, verifyCode, {
        nickname: edit.nickname.trim(),
        school: edit.school.trim(),
        province: edit.province.trim(),
        grade: gradeValue(edit),
        shirtSize: edit.shirtSize as ShirtSize,
      });
      setApp(res.data);
      setSource(res.source);
      setEditSaved(true);
      editRestore.current = true;
      setEditOpen(false);
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 409) {
        setEditError('ใบสมัครนี้อยู่ในสถานะที่แก้ไขเองไม่ได้ กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ');
      } else if (err instanceof ApiHttpError && err.code === 'VALIDATION_ERROR') {
        setEditError('ข้อมูลที่กรอกยังไม่ถูกต้อง กรุณาตรวจสอบทุกช่องแล้วลองอีกครั้ง');
      } else {
        setEditError(describeError(err, 'บันทึกข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง'));
      }
    } finally {
      setEditBusy(false);
    }
  }

  function closeWithdraw() {
    if (withdrawBusy) return;
    withdrawRestore.current = true;
    setWithdrawOpen(false);
  }

  async function onWithdraw() {
    if (!app || !codeReady || withdrawBusy) return;
    setWithdrawBusy(true);
    setError(null);
    try {
      await withdrawApplication(app.id, verifyCode);
      const id = app.id;
      setApp(null);
      setSource(null);
      setVerifyCode('');
      setWithdrawOpen(false);
      setVerifyError(null);
      setWithdrawnId(id);
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 409) {
        setError('ใบสมัครนี้ยกเลิกเองไม่ได้ (ยืนยันสิทธิ์แล้ว ส่งสลิปแล้ว หรือปิดรายการแล้ว) กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการเพื่อขอยกเลิกและคืนเงิน');
      } else if (err instanceof ApiHttpError && err.status === 404) {
        setError('ไม่พบใบสมัครนี้ในระบบ อาจถูกยกเลิกไปแล้ว ลองค้นหาอีกครั้ง');
      } else {
        setError(describeError(err, 'ยกเลิกใบสมัครไม่สำเร็จ'));
      }
    } finally {
      setWithdrawBusy(false);
    }
  }

  const onConfirm = () => setAttendance(true);
  const onCancelConfirm = () => setAttendance(false);

  async function onCopyAccount() {
    const ok = await copyText(PAY_ACCOUNT_DIGITS);
    setAcctCopy(ok ? 'copied' : 'failed');
    window.setTimeout(() => setAcctCopy('idle'), ok ? 2200 : 5000);
  }

  const slipUploaded = hasSlip(app);
  // slipStatus comes from the server; older responses without it fall back to the applicant status.
  const slipApproved = app?.slipStatus ? app.slipStatus === 'APPROVED' : app?.status === 'CONFIRMED';
  const slipRejected = app?.slipStatus === 'REJECTED';
  const isEligibleForPayment = app && (app.status === 'PASSED' || app.status === 'CONFIRMED');
  const seatHeld = Boolean(app && holdsSeat(app.status));
  // A slip waiting for review or already approved means money has moved: the row must stay in the
  // staff ledger so a refund can be recorded, so only staff can cancel from then on. A slip staff
  // rejected is not money held. A missing slipStatus on an uploaded slip counts as waiting.
  const slipState = slipUploaded ? (app?.slipStatus ?? 'PENDING') : null;
  const moneyHeld = slipState === 'PENDING' || slipState === 'APPROVED';
  const canWithdraw = Boolean(app && seatHeld && app.status !== 'CONFIRMED' && !moneyHeld);
  // Cancelling is staff-only: say so, with the way to reach them.
  const mustAskStaffToCancel = seatHeld && !canWithdraw;
  // Secondary fields stay editable while the application holds a seat (also once CONFIRMED).
  const canEditProfile = seatHeld;
  // The code is asked for only while there is something left to do on this application.
  const needsVerifyCode = Boolean(isEligibleForPayment && (app?.status === 'PASSED' || !slipApproved)) || canWithdraw || canEditProfile;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      {/* ── 01 · Masthead ─────────────────────────────────── */}
      <header className="border-t-4 pt-4" style={{ borderColor: INK }}>
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium uppercase tabular-nums" style={{ color: INK_SUBTLE }}>
              ComCamp #25 — Status / 02
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

        <form onSubmit={onSearch} className="border bg-[var(--bg-card)] p-6 sm:p-8 md:col-span-7" style={{ borderColor: INK, backgroundColor: SURFACE }}>
          <label className="mb-1.5 block text-sm font-semibold" style={{ color: INK }} htmlFor="status-q">
            เลขบัตรประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัคร
          </label>
          <input
            id="status-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="เช่น 1103701234512 หรือ CC25-XXXXXX"
            className="w-full rounded-none border bg-[var(--bg-card)] px-3 py-2.5 text-base outline-none transition-colors focus:border-[var(--color-tech)]"
            style={{ borderColor: BORDER_INPUT }}
          />
          <button
            type="submit"
            disabled={busy || !q.trim()}
            className="mt-4 w-full rounded-full px-4 py-3 text-base font-semibold transition-opacity disabled:opacity-50"
            style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
          >
            {busy ? 'กำลังค้นหา…' : 'ค้นหาข้อมูล'}
          </button>
        </form>
      </section>

      {/* ── Alerts: 1px hairline border, status dot, editorial typography ── */}
      {error && (
        <div
          role="alert"
          className="mt-6 flex items-baseline justify-between gap-4 rounded-xl border bg-[var(--bg-card)] px-4 py-3.5"
          style={{ borderColor: RULE }}
        >
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span aria-hidden="true" className="mr-2 text-[10px]" style={{ color: 'var(--color-danger)' }}>
              ●
            </span>
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 rounded-full px-2.5 py-0.5 text-sm underline underline-offset-4 transition-opacity hover:opacity-80"
            style={{ color: INK_MUTED }}
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
          className="mt-6 flex items-baseline justify-between gap-4 rounded-xl border bg-[var(--bg-card)] px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-tech)]"
          style={{ borderColor: RULE }}
        >
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span aria-hidden="true" className="mr-2 text-[10px]" style={{ color: 'var(--color-success)' }}>
              ●
            </span>
            ใบสมัครนี้ถูกยกเลิกแล้ว (<span className="font-mono tabular-nums">{withdrawnId}</span>) คืนที่นั่งว่างเรียบร้อย
            {' '}หากเปลี่ยนใจ{' '}
            <a href="/register" className="font-semibold underline underline-offset-4" style={{ color: INK }}>
              สมัครใหม่ได้ที่หน้าสมัครค่าย
            </a>{' '}
            หากยังมีที่นั่งว่าง
          </p>
          <button
            type="button"
            onClick={() => setWithdrawnId(null)}
            className="shrink-0 rounded-full px-2.5 py-0.5 text-sm underline underline-offset-4 transition-opacity hover:opacity-80"
            style={{ color: INK_MUTED }}
          >
            ปิด
          </button>
        </div>
      )}

      {app && (
        <div className="mt-8 space-y-8">
          <StatusHighlight app={app} />

          {/* ── 03 · Application record ─────────────────────── */}
          <section className="border bg-[var(--bg-card)] p-6 sm:p-8" style={{ borderColor: INK, backgroundColor: SURFACE }}>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: INK }}>
              <div>
                <p className="font-mono text-xs font-medium uppercase" style={{ color: INK_SUBTLE }}>
                  Record / Application No.
                </p>
                <p className="mt-1 font-mono text-2xl font-semibold tabular-nums" style={{ color: INK }}>{app.id}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusTag status={app.status} />
                {source && (
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
                { k: 'เลขบัตรประชาชน', v: app.nationalId, mono: true },
                { k: 'เบอร์โทรศัพท์ติดต่อ', v: app.phone, mono: true },
                { k: 'โรงเรียน', v: app.school, mono: false },
                { k: 'ระดับชั้น / ไซส์เสื้อ', v: `${app.grade} / ${app.shirtSize}`, mono: false },
                ...(app.email ? [{ k: 'อีเมล', v: app.email, mono: false }] : []),
                ...(app.province ? [{ k: 'จังหวัด', v: app.province, mono: false }] : []),
              ].map((row) => (
                <div key={row.k} className="border-b py-3" style={{ borderColor: RULE }}>
                  <dt className="font-mono text-[11px] font-medium uppercase" style={{ color: INK_SUBTLE }}>{row.k}</dt>
                  <dd className={`mt-0.5 text-base leading-7 ${row.mono ? 'font-mono tabular-nums' : 'font-medium'}`} style={{ color: INK }}>
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>

            {/* Second factor (AGENTS.md §13.5): an application ID or a phone number alone is not
                enough to confirm or send a slip. The phone's digits are not accepted on purpose:
                the record above shows them. */}
            {needsVerifyCode && (
              <div className="mt-6 border-t pt-4" style={{ borderColor: INK }}>
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
                  hint="ใช้ยืนยันว่าเป็นเจ้าของใบสมัครก่อนยืนยันสิทธิ์ ส่งสลิป แก้ไขข้อมูล หรือยกเลิกใบสมัคร"
                />
              </div>
            )}

            {/* Attendance confirmation */}
            {app.status === 'PASSED' && (
              <div className="mt-6 border-t pt-4" style={{ borderColor: INK }}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold leading-7" style={{ color: INK }}>การยืนยันสิทธิ์เข้าร่วมค่าย</h3>
                    <p className="text-sm leading-7" style={{ color: INK_MUTED }}>
                      {app.attendanceConfirmed
                        ? 'กดยืนยันสิทธิ์เข้าร่วมค่ายเรียบร้อยแล้ว'
                        : 'โปรดยืนยันสิทธิ์เข้าร่วมค่ายและอัปโหลดหลักฐานการโอนเงิน'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onConfirm}
                      disabled={confirmBusy || app.attendanceConfirmed || !codeReady}
                      aria-describedby={!codeReady && !app.attendanceConfirmed ? 'verify-code-hint' : undefined}
                      className="rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity disabled:opacity-50"
                      style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                    >
                      {confirmBusy ? 'กำลังดำเนินการ…' : app.attendanceConfirmed ? '✓ ยืนยันสิทธิ์แล้ว' : 'ยืนยันสิทธิ์'}
                    </button>
                    {app.attendanceConfirmed && (
                      <button
                        type="button"
                        onClick={onCancelConfirm}
                        disabled={confirmBusy || !codeReady}
                        aria-describedby={!codeReady ? 'verify-code-hint' : undefined}
                        className="rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
                        style={{ borderColor: RULE, color: INK_MUTED, backgroundColor: SURFACE }}
                      >
                        ยกเลิก
                      </button>
                    )}
                  </div>
                </div>
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
                      แก้ไขได้เฉพาะชื่อเล่น โรงเรียน จังหวัด ระดับชั้น และไซส์เสื้อ หากต้องการเปลี่ยนชื่อ-นามสกุล เลขบัตรประชาชน เบอร์โทรศัพท์ หรืออีเมล
                      กรุณา{' '}
                      <a href={FB_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-4" style={{ color: INK }}>
                        ติดต่อทีมงานทางเพจ Facebook
                      </a>{' '}
                      ของโครงการ
                    </p>

                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
                      <EditField id="edit-shirtSize" label="ไซส์เสื้อ" error={editErrors.shirtSize}>
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
                              {size}
                              {SIZE_CHEST[size] !== null ? ` · รอบอก ${SIZE_CHEST[size]} นิ้ว` : ''}
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
                              placeholder="เช่น ปวส.1, ม.3"
                              aria-invalid={editErrors.gradeOther ? true : undefined}
                              aria-describedby={editErrors.gradeOther ? 'edit-gradeOther-err' : undefined}
                              className={INPUT_CLS}
                              style={{ borderColor: BORDER_INPUT, color: INK }}
                            />
                          </EditField>
                        </div>
                      )}
                    </div>

                    {!codeReady && (
                      <p className="mt-3 text-sm leading-7" style={{ color: INK_MUTED }}>
                        กรอกเลข <span className="font-mono tabular-nums">4</span> ตัวท้ายของบัตรประชาชนด้านบนก่อนบันทึก
                      </p>
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
                        className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-opacity disabled:opacity-50 ${FOCUS_RING}`}
                        style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                      >
                        {editBusy ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}
                      </button>
                      <button
                        type="button"
                        onClick={closeEdit}
                        disabled={editBusy}
                        className={`rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${FOCUS_RING}`}
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
                      aria-expanded={false}
                      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${FOCUS_RING}`}
                      style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                    >
                      <Pencil aria-hidden="true" size={16} strokeWidth={1.5} />
                      แก้ไขข้อมูลทั่วไป
                    </button>
                    {editSaved && (
                      <p role="status" className="text-sm leading-7" style={{ color: INK }}>
                        <span aria-hidden="true" className="mr-2 text-[10px]" style={{ color: 'var(--color-success)' }}>
                          ●
                        </span>
                        บันทึกข้อมูลเรียบร้อยแล้ว
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Self-service withdrawal: frees the seat; reuses the verify code above. */}
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
                      หากยกเลิก ใบสมัคร <span className="font-mono tabular-nums">{app.id}</span> จะถูกนำออกจากระบบและคืนที่นั่งว่างทันที ยกเลิกแล้วกู้คืนไม่ได้
                      {slipUploaded && ' หากโอนเงินไปแล้ว กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ'}
                    </p>
                    {!codeReady && (
                      <p className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>
                        กรอกเลข <span className="font-mono tabular-nums">4</span> ตัวท้ายของบัตรประชาชนด้านบนก่อนยืนยัน
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        ref={withdrawConfirmRef}
                        type="button"
                        onClick={onWithdraw}
                        disabled={withdrawBusy || !codeReady}
                        aria-busy={withdrawBusy || undefined}
                        aria-describedby={codeReady ? 'withdraw-warn' : 'withdraw-warn verify-code-hint'}
                        className="rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
                        style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', backgroundColor: SURFACE }}
                      >
                        {withdrawBusy ? 'กำลังยกเลิก…' : 'ยืนยันยกเลิกใบสมัคร'}
                      </button>
                      <button
                        type="button"
                        onClick={closeWithdraw}
                        disabled={withdrawBusy}
                        className="rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
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
                    aria-expanded={false}
                    className="rounded-full py-1 text-sm font-semibold underline underline-offset-4"
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
                  หากต้องการสละสิทธิ์และขอคืนเงิน กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ พร้อมแจ้งรหัสใบสมัคร{' '}
                  <span className="font-mono tabular-nums">{app.id}</span>
                </p>
                <a
                  href={FB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`mt-3 inline-block rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${FOCUS_RING}`}
                  style={{ borderColor: RULE, color: INK, backgroundColor: SURFACE }}
                >
                  ติดต่อทีมงานทาง Facebook
                </a>
              </div>
            )}
          </section>

          {/* ── 04 · Payment slip ───────────────────────────── */}
          {isEligibleForPayment && (
            <section
              id="slip-section"
              tabIndex={-1}
              className="scroll-mt-24 border bg-[var(--bg-card)] p-6 outline-none sm:p-8"
              style={{ borderColor: INK, backgroundColor: SURFACE }}
            >
              {/* One container. Its zones are told apart by whitespace and 1px rules, never by inner boxes. */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold leading-8" style={{ color: INK }}>หลักฐานการชำระเงิน</h2>
                  <p className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>
                    ค่าธรรมเนียมยืนยันสิทธิ์ <span className="font-mono tabular-nums">1,000</span> บาท
                  </p>
                </div>
                {slipUploaded ? (
                  slipApproved ? (
                    <DotPill color="var(--color-success)">อนุมัติสลิปแล้ว</DotPill>
                  ) : slipRejected ? (
                    <DotPill color="var(--color-danger)">สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดใหม่</DotPill>
                  ) : (
                    <DotPill color="var(--color-warning)">รอเจ้าหน้าที่ตรวจสอบ</DotPill>
                  )
                ) : (
                  <DotPill color="var(--color-ink-subtle)">ยังไม่ได้ส่งสลิป</DotPill>
                )}
              </div>

              {!slipApproved && (
                <div className="mt-6 border-t pt-5" style={{ borderColor: RULE }} aria-label="ข้อมูลการโอนเงิน" role="group">
                  <p className="text-sm leading-7" style={{ color: INK_MUTED }}>
                    โอนค่าสมัคร <span className="font-mono tabular-nums">1,000</span> บาท · {PAY_ACCOUNT.bank}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <p className="font-mono text-2xl font-medium tabular-nums" style={{ color: INK }}>{PAY_ACCOUNT.number}</p>
                    <button
                      type="button"
                      onClick={onCopyAccount}
                      className="inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors hover:border-[var(--color-ink)]"
                      style={{ borderColor: BORDER_INPUT, color: INK }}
                    >
                      {acctCopy === 'copied' ? 'คัดลอกเลขบัญชีแล้ว' : 'คัดลอกเลขบัญชี'}
                    </button>
                  </div>
                  <p role="status" aria-live="polite" className="min-h-[1.4em] text-sm" style={{ color: INK_MUTED }}>
                    {acctCopy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่เลขบัญชีแล้วเลือกคัดลอก'}
                  </p>
                  <p className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>
                    ชื่อบัญชี {PAY_ACCOUNT.name} ({PAY_ACCOUNT.holders})
                  </p>
                  <p className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>{NO_QR_NOTE}</p>
                </div>
              )}

              <div className="mt-6 border-t pt-5" style={{ borderColor: RULE }}>
                <SlipUploadPanel
                  key={app.id}
                  appId={app.id}
                  slip={slipApproved ? 'APPROVED' : slipState}
                  verifyCode={verifyCode}
                  codeInputId="verify-code"
                  onCodeInvalid={setVerifyError}
                  submitLabel="ยืนยันและส่งหลักฐานสลิป"
                  onUploaded={(status, _message, src) => {
                    setSource(src);
                    setApp((prev) => (prev ? { ...prev, hasSlip: true, slipStatus: status } : null));
                  }}
                />
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
