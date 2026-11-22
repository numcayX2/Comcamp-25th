import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  HeartHandshake,
  LayoutDashboard,
  Maximize2,
  Pencil,
  RotateCcw,
  Settings2,
  Shirt,
  Trash2,
  TriangleAlert,
  UserX,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  ApiHttpError,
  adminLogin,
  adminPermissions,
  deleteApplication,
  purgeWithdrawnApplication,
  fetchAdminSlipInfo,
  fetchWithdrawnApplicants,
  hasSlip,
  holdsSeat,
  isAdminRole,
  listApplications,
  recordCsvExport,
  roleFromToken,
  stripZeroWidth,
  updateApplicationStatus,
  verifyPaymentSlip,
  type AdminSettings,
  type Application,
  type ApplicationStatus,
  type ApiSource,
  type SlipStatus,
  type WithdrawnApplicant,
} from '../lib/api';
import {
  SLIP_LABELS,
  STATUS_LABELS,
  buildApplicantsCsv,
  csvFileName,
  downloadCsv,
  formatReferralLabels,
  matchesApplicantQuery,
  matchesWithdrawnQuery,
  slipLabel,
} from '../lib/applicant-tools';
import {
  PAYMENT_WINDOW_DAYS,
  describeStaffPaymentDeadline,
  type PaymentDeadlineInfo,
} from './register/model';
import { AdminProfileEditor } from './AdminProfileEditor';
import { AdminSettingsPanel } from './AdminSettingsPanel';
import { AdminSponsorHub } from './admin/AdminSponsorHub';
import { AdminOverview } from './admin/AdminOverview';
import { AdminLogistics, isMeaningfulNote } from './admin/AdminLogistics';
import { AdminSideMenu } from './admin/AdminSideMenu';
import { AdminFilterTabs } from './admin/AdminFilterTabs';
import { MotionConfig, motion } from 'motion/react';
import { StatefulButton } from './admin/ui/StatefulButton';
import { VanishSearchInput } from './admin/ui/VanishSearchInput';
import { EXPAND, useDoneSignal } from './admin/ui/motion';
import { SlipLightbox } from './slip/SlipLightbox';
import {
  BG_CANVAS,
  BG_CARD,
  BTN_DARK,
  BTN_DARK_TEXT,
  DANGER,
  FOCUS,
  INK,
  INK_2,
  INK_3,
  INPUT_BASE,
  INPUT_BORDER,
  PILL_DANGER,
  PILL_GHOST,
  RULE,
  SUCCESS,
  SURFACE_SUBTLE,
  TECH,
  WARNING,
  AMBER_TEXT,
  AMBER_ON,
} from './admin-ui';

const STATUSES: ApplicationStatus[] = ['PASSED', 'CONFIRMED', 'REJECTED', 'FORFEITED', 'REFUND_PENDING', 'REFUNDED'];
const LEGACY_STATUSES: ApplicationStatus[] = ['PENDING', 'RESERVE'];

type FilterKey = 'ALL' | 'SLIP_PENDING' | 'AWAITING_PAY' | ApplicationStatus | 'WITHDRAWN';
type SortKey = 'newest' | 'slip_queue' | 'updated_desc';

/** Views of the staff dashboard; the active one lives in `location.hash` so refresh and Back keep it. */
type AdminView = 'overview' | 'applications' | 'withdrawn' | 'logistics' | 'sponsors' | 'settings';
const ADMIN_VIEWS: readonly AdminView[] = ['overview', 'applications', 'withdrawn', 'logistics', 'sponsors', 'settings'];

function viewFromHash(): AdminView {
  const h = window.location.hash.replace(/^#/, '');
  return (ADMIN_VIEWS as readonly string[]).includes(h) ? (h as AdminView) : 'overview';
}

/** Raised panel on the warm canvas (home-page elevation tokens; no panel is nested in another). */
const PANEL = 'rounded-[24px] bg-[var(--bg-card)] p-[clamp(20px,2.4vw,28px)] [box-shadow:var(--shadow-card)]';

function ViewHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="mb-5">
      <h2
        tabIndex={-1}
        data-view-heading
        className="text-balance text-[1.375rem] font-bold leading-[1.3] outline-none sm:text-[1.625rem]"
        style={{ color: INK }}
      >
        {title}
      </h2>
      {sub && (
        <p className="mt-1 max-w-[72ch] text-sm leading-[1.7]" style={{ color: INK_2 }}>
          {sub}
        </p>
      )}
    </header>
  );
}

type LocalSlipVerdict = {
  approved: boolean;
  note: string;
  verifiedAt: string;
  paymentId?: string | null;
};

const BANGKOK_DATETIME = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatBangkokDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : BANGKOK_DATETIME.format(d);
}

/** Resolves the admin role from login response or JWT payload; fails closed unless `'admin'`. */
function resolveAdminRole(token: string, explicitRole?: string | null): 'admin' | null {
  if (explicitRole !== undefined && explicitRole !== null) {
    return isAdminRole(explicitRole) ? explicitRole : null;
  }
  const fromJwt = roleFromToken(token);
  if (isAdminRole(fromJwt)) return fromJwt;
  if (import.meta.env.DEV && token === 'mock-jwt-token') return 'admin';
  return null;
}

/* Editorial ledger: no cards, no shadows. Structure comes from whitespace and 1px rules; colour
   appears only as a small status dot (AGENTS §4.1 master tokens). */
const STATUS_DOT: Record<ApplicationStatus, string> = {
  PENDING: WARNING,
  PASSED: TECH,
  RESERVE: INK_3,
  CONFIRMED: SUCCESS,
  REJECTED: DANGER,
  REFUND_PENDING: WARNING,
  REFUNDED: INK_3,
  FORFEITED: DANGER,
};

const SLIP_DOT: Record<SlipStatus, string> = {
  PENDING: WARNING,
  APPROVED: SUCCESS,
  REJECTED: DANGER,
};

/* The admin JWT lives in sessionStorage: it survives a refresh but not closing the tab, so it is
   gone from shared camp-office computers once the browser closes (8h expiry server-side). */
const TOKEN_KEY = 'comcamp-admin-token';
const tokenStore = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* storage blocked: the session lasts until refresh */
    }
  },
  clear: () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY); // older builds kept it in localStorage
    } catch {
      /* ignore */
    }
  },
};

const VERIFY_NOTE_MAX = 500;

/** Separated Approve vs Reject quick notes so staff never pick the wrong verdict wording by mistake. */
function approveNoteTemplates(feeBaht: number | null): string[] {
  return [
    feeBaht === null
      ? 'ยอดเงินถูกต้องครบถ้วน'
      : `ยอดเงิน ${feeBaht.toLocaleString('en-US')} บาท ถูกต้องครบถ้วน`,
    'ตรวจสอบเวลาโอนและบัญชีปลายทางตรงกับระบบแล้ว',
  ];
}

const REJECT_NOTE_TEMPLATES: string[] = [
  'สลิปไม่ชัดเจน กรุณาอัปโหลดใหม่',
  'ยอดเงินในสลิปไม่ตรงกับค่าสมัคร กรุณาตรวจสอบและโอนใหม่',
  'ข้อมูลบัญชีผู้รับหรือวัน-เวลาโอนไม่ถูกต้อง กรุณาอัปโหลดสลิปที่ถูกต้อง',
  'สลิปซ้ำหรือไม่ใช่หลักฐานการโอนเงิน กรุณาอัปโหลดใหม่',
];

function isSlipPending(a: Application): boolean {
  return hasSlip(a) && (a.slipStatus ?? 'PENDING') === 'PENDING';
}

/** Holds a PASSED seat with nothing under review or approved: still owes the transfer + slip. */
function isAwaitingPayment(a: Application): boolean {
  if (a.status !== 'PASSED') return false;
  if (!hasSlip(a)) return true;
  return (a.slipStatus ?? 'PENDING') === 'REJECTED';
}

/**
 * The transfer deadline the server actually enforces (ExpireOverdueUnpaid): 120h (5 days) after
 * registration, but never earlier than 24h after the last staff change (updatedAt, for example a
 * restored seat) or 24h after a slip was rejected (verifiedAt). Computing it from createdAt alone
 * would flag people the sweep deliberately leaves alone, so staff could reject someone who still has time.
 */
function paymentDeadline(a: Application, nowMs: number): PaymentDeadlineInfo {
  return describeStaffPaymentDeadline(
    a.createdAt,
    a.updatedAt,
    a.slipStatus === 'REJECTED' ? a.verifiedAt : null,
    nowMs,
  );
}

function isPaymentOverdue(a: Application, nowMs: number): boolean {
  return isAwaitingPayment(a) && paymentDeadline(a, nowMs).isOverdue;
}

function slipSortTier(a: Application): number {
  if (!hasSlip(a)) return 3;
  const s = a.slipStatus ?? 'PENDING';
  if (s === 'PENDING') return 0;
  if (s === 'REJECTED') return 1;
  return 2;
}

function sortApplications(list: Application[], sortBy: SortKey): Application[] {
  const copy = [...list];
  if (sortBy === 'updated_desc') {
    return copy.sort(
      (x, y) =>
        (y.updatedAt ?? y.createdAt ?? '').localeCompare(x.updatedAt ?? x.createdAt ?? '') ||
        x.id.localeCompare(y.id),
    );
  }
  if (sortBy === 'slip_queue') {
    return copy.sort((x, y) => {
      const tx = slipSortTier(x);
      const ty = slipSortTier(y);
      if (tx !== ty) return tx - ty;
      if (tx === 0) {
        // Pending slips: FIFO (oldest upload/update first) so earliest payers get reviewed first.
        return (
          (x.updatedAt ?? x.createdAt ?? '').localeCompare(y.updatedAt ?? y.createdAt ?? '') ||
          (x.createdAt ?? '').localeCompare(y.createdAt ?? '') ||
          x.id.localeCompare(y.id)
        );
      }
      return (y.updatedAt ?? y.createdAt ?? '').localeCompare(x.updatedAt ?? x.createdAt ?? '') || x.id.localeCompare(y.id);
    });
  }
  // 'newest': newest createdAt first, ties broken by id.
  return copy.sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? '') || x.id.localeCompare(y.id));
}

/** Ledger columns (lg and up); the wide template applies once the ledger itself is >= 68rem, so the
 *  xl sidebar does not squeeze the name and school columns. */
const ROW_GRID =
  'lg:grid-cols-[8rem_minmax(0,1.35fr)_minmax(0,1.1fr)_9rem_10.5rem_12.5rem] @min-[68rem]/ledger:grid-cols-[9rem_minmax(0,1.4fr)_minmax(0,1.15fr)_10.5rem_12rem_14.5rem]';

/** Column template shared by the sticky header and rows of the read-only withdrawn tab (lg and up). */
const WITHDRAWN_GRID =
  'lg:grid-cols-[6.75rem_minmax(0,1.3fr)_minmax(0,1fr)_7.5rem_9.25rem_minmax(0,1fr)_6.5rem] @min-[68rem]/ledger:grid-cols-[6.75rem_minmax(0,1.3fr)_minmax(0,1fr)_8.5rem_9.5rem_minmax(12rem,1fr)_6.75rem]';

/** Rotating hints for the ledger search (the first one is the static, reduced-motion hint). */
const SEARCH_HINTS = [
  'ค้นหารหัส ชื่อ เบอร์ อีเมล โรงเรียน จังหวัด',
  'ค้นหาด้วยรหัส CC25-…',
  'ค้นหาด้วยชื่อ หรือชื่อเล่น',
  'ค้นหาด้วยเบอร์โทร',
  'ค้นหาด้วยโรงเรียน หรือจังหวัด',
];
const WITHDRAWN_SEARCH_HINTS = [
  'ค้นหารหัส ชื่อ ชื่อเล่น เบอร์ โรงเรียน',
  'ค้นหาด้วยรหัส CC25-…',
  'ค้นหาด้วยชื่อ หรือชื่อเล่น',
  'ค้นหาด้วยเบอร์โทร',
];

/**
 * Seat-releasing changes, leaving CONFIRMED, and confirming without a slip review get a warning
 * (red copy and an outlined confirm) in the status confirmation; the others a plain confirm.
 */
function isRiskyTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  const releasesSeat = holdsSeat(from) && !holdsSeat(to);
  return releasesSeat || (from === 'CONFIRMED') !== (to === 'CONFIRMED');
}

/** Picking a value only proposes it (`pending`): the change is saved from the confirmation below the row. */
function StatusSelect({
  app,
  value,
  pending,
  disabled,
  onChange,
}: {
  app: Application;
  value: ApplicationStatus;
  pending: boolean;
  disabled: boolean;
  onChange: (status: ApplicationStatus) => void;
}) {
  return (
    <label className="relative inline-flex w-full items-center sm:max-w-xs lg:max-w-none">
      <span className="sr-only">เปลี่ยนสถานะของ {app.id}</span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-2 -translate-y-1/2 rounded-full"
        style={{ backgroundColor: STATUS_DOT[value] }}
      />
      <select
        id={`status-select-${app.id}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ApplicationStatus)}
        className={`min-h-11 w-full cursor-pointer appearance-none rounded-xl border bg-[var(--bg-card)] py-1.5 pl-7 pr-8 text-sm font-medium leading-6 disabled:opacity-50 lg:min-h-9 ${FOCUS}`}
        style={{ borderColor: pending ? TECH : INPUT_BORDER, color: INK, colorScheme: 'inherit', boxShadow: pending ? `0 0 0 1px ${TECH}` : undefined }}
      >
        {!STATUSES.includes(app.status) && (
          <option key={app.status} value={app.status} disabled>
            {STATUS_LABELS[app.status]} (สถานะเดิม)
          </option>
        )}
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        strokeWidth={1.5}
        size={15}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
        style={{ color: INK_3 }}
      />
    </label>
  );
}

/** Time left on the 5-day transfer window, shown only while the applicant still owes a slip. */
function PaymentDue({ app, nowMs }: { app: Application; nowMs: number }) {
  if (!isAwaitingPayment(app)) return null;
  const d = paymentDeadline(app, nowMs);
  return (
    <span
      className="mt-0.5 block text-xs font-semibold leading-5"
      style={{ color: d.isOverdue ? DANGER : d.isUrgent ? AMBER_TEXT : INK_3 }}
      title={`ครบกำหนดโอน ${d.deadlineText}`}
    >
      {d.isOverdue ? `เกินกำหนดโอน ${PAYMENT_WINDOW_DAYS} วันแล้ว` : d.remainingText.replace('เหลือเวลาโอนอีก', 'เหลือเวลาโอน')}
    </span>
  );
}

/** Payment-slip state as a pill: the dot carries the colour, the text carries the meaning. */
function SlipBadge({ app, nowMs }: { app: Application; nowMs: number }) {
  if (!hasSlip(app)) {
    return (
      <span className="block">
        <span className="text-sm leading-7" style={{ color: INK_3 }}>
          ยังไม่มีสลิป
        </span>
        <PaymentDue app={app} nowMs={nowMs} />
      </span>
    );
  }
  const s: SlipStatus = app.slipStatus ?? 'PENDING';
  return (
    <span className="block">
      <span
        className="inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-xs font-semibold leading-6"
        style={{ borderColor: RULE, color: INK }}
      >
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: SLIP_DOT[s] }} />
        {SLIP_LABELS[s]}
      </span>
      <PaymentDue app={app} nowMs={nowMs} />
    </span>
  );
}

function describeAdminError(err: unknown, fallback: string): string {
  if (err instanceof ApiHttpError) {
    if (err.status === 401 || err.code === 'UNAUTHORIZED') {
      return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
    }
    if (err.status === 403) {
      return 'บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ (admin) กรุณาเข้าสู่ระบบด้วยบัญชีที่มีสิทธิ์';
    }
    if (err.status === 404 || err.code === 'NOT_FOUND') {
      return 'ไม่พบรายการใบสมัครหรือไฟล์สลิปนี้ในระบบ';
    }
    if (err.status === 429 || err.code === 'RATE_LIMITED') {
      return err.retryAfterSeconds
        ? `ทำรายการถี่เกินไป กรุณารอ ${err.retryAfterSeconds} วินาที แล้วลองใหม่`
        : 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
    if (err.code === 'QUOTA_FULL') {
      return 'ที่นั่งเต็มแล้ว จึงคืนใบสมัครนี้กลับเป็นสถานะที่ถือที่นั่งไม่ได้ ต้องมีที่นั่งว่างหรือเพิ่มโควตาก่อน (ใบสมัครยังคงสถานะเดิม)';
    }
    if (err.code === 'DUPLICATE_APPLICATION') {
      return 'เบอร์โทรหรืออีเมลนี้ซ้ำกับผู้สมัครคนอื่นที่ยังอยู่ในระบบ';
    }
    if (err.code === 'SLIP_CHANGED') {
      return 'ผู้สมัครเพิ่งอัปโหลดสลิปใหม่ จึงยังไม่ได้บันทึกผล ระบบโหลดสลิปล่าสุดให้แล้ว กรุณาตรวจสอบอีกครั้ง';
    }
    if (err.code === 'ALREADY_VERIFIED') {
      return 'สลิปนี้ถูกตรวจสอบไปแล้ว รายการถูกโหลดใหม่ให้แล้ว';
    }
    if (err.code === 'DUPLICATE_SLIP') {
      return 'ไม่สามารถอนุมัติสลิปนี้ได้ เนื่องจากรูปสลิปซ้ำกับใบสมัครอื่นที่ยังใช้งานอยู่ในระบบ (สามารถระบุหมายเหตุแล้วปฏิเสธสลิปแทนได้)';
    }
    if (err.status === 409) {
      return 'สถานะของใบสมัครนี้ไม่อนุญาตให้ทำรายการนี้ (ใบสมัครที่รอคืนเงิน คืนเงินแล้ว หรือไม่ผ่านจะอนุมัติหรือปฏิเสธสลิปไม่ได้)';
    }
    if (err.code === 'VALIDATION_ERROR') {
      return 'ข้อมูลที่ส่งไม่ถูกต้องตามเงื่อนไข';
    }
    if (err.status >= 500) {
      return 'ระบบเซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง';
    }
  }
  if (err instanceof Error) {
    if (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('abort')) {
      return 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ต';
    }
  }
  return fallback;
}

export function AdminSection() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  /** The account's role, from the login response or the token payload: a UI hint only. */
  const [role, setRole] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [apps, setApps] = useState<Application[]>([]);
  const [withdrawnApps, setWithdrawnApps] = useState<WithdrawnApplicant[]>([]);
  const [withdrawnError, setWithdrawnError] = useState<string | null>(null);
  const [withdrawnLoading, setWithdrawnLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('ALL');
  const [sortBy, setSortBy] = useState<SortKey>('newest');
  const [query, setQuery] = useState('');
  /** Camp fee in baht from the settings panel; used in the note templates. */
  const [feeBaht, setFeeBaht] = useState<number | null>(null);
  /** Seat quota from the settings panel; null until loaded (the over-capacity warning then omits numbers). */
  const [maxCapacity, setMaxCapacity] = useState<number | null>(null);
  /** Sponsor inquiries not yet contacted (side-menu badge); null until the sponsor view has loaded them. */
  const [sponsorInquiryCount, setSponsorInquiryCount] = useState<number | null>(null);
  /** Minute clock for the 5-day transfer countdowns. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const [settingsRefreshKey, setSettingsRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [patching, setPatching] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ appId: string; step: 1 | 2 | 3 } | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  /** Withdrawn tab: the row whose permanent-delete confirmation is open, and the row being purged. */
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Slip review state (an inline panel under the row). Store id and derive from apps so refreshes
  // keep slipPaymentId and status current.
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [slipRetryNonce, setSlipRetryNonce] = useState(0);
  const [autoAdvanceSlip, setAutoAdvanceSlip] = useState(true);
  const [localSlipVerdicts, setLocalSlipVerdicts] = useState<Record<string, LocalSlipVerdict>>({});

  // Detail drawer/panel and profile editor: inline panels too; at most one panel per row is open.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDirty, setEditingDirty] = useState(false);
  const [pendingDiscardSwitch, setPendingDiscardSwitch] = useState<{ label: string; run: () => void } | null>(null);

  // Confirmation for risky / seat-releasing status transitions.
  const [pendingStatus, setPendingStatus] = useState<{ appId: string; from: ApplicationStatus; to: ApplicationStatus } | null>(null);
  const [statusReason, setStatusReason] = useState('');
  /** The pending change that just failed with QUOTA_FULL (it retakes a seat); offers the over-capacity restore. */
  const [quotaFull, setQuotaFull] = useState<{ appId: string; from: ApplicationStatus; to: ApplicationStatus } | null>(null);
  const [overCapOpen, setOverCapOpen] = useState(false);
  const [overCapReason, setOverCapReason] = useState('');

  // Slip decision & note state: reject uses two-step inline confirmation; approve submits immediately.
  const [verificationNote, setVerificationNote] = useState('');
  const [verifyNoteError, setVerifyNoteError] = useState<string | null>(null);
  const [confirmRejectSlip, setConfirmRejectSlip] = useState(false);
  const [editingSlipVerdict, setEditingSlipVerdict] = useState(false);
  const [verifyingAction, setVerifyingAction] = useState<'approve' | 'reject' | null>(null);
  const [slipImage, setSlipImage] = useState<{
    url: string | null;
    paymentId: string | null;
    error: string | null;
    loading: boolean;
  }>({ url: null, paymentId: null, error: null, loading: false });

  // Focus bookkeeping: avoid ever dropping focus to <body> when panels close or rows filter out.
  const prevSlipId = useRef<string | null>(null);
  const prevDetailId = useRef<string | null>(null);
  const prevEditId = useRef<string | null>(null);
  const prevPendingId = useRef<string | null>(null);
  const deleteTimerRef = useRef<number | null>(null);
  const lastDeleteStepAtRef = useRef(0);
  const refocusDeleteBtnIdRef = useRef<string | null>(null);
  const focusListAfterDelete = useRef(false);
  const focusSlipPanelAfterAdvance = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const filterGroupRef = useRef<HTMLDivElement>(null);
  const emptyStateRef = useRef<HTMLDivElement>(null);
  const slipPanelRef = useRef<HTMLDivElement>(null);
  // Login: the submit button disables while busy, so focus is put back explicitly (password on failure).
  const passwordRef = useRef<HTMLInputElement>(null);
  // Synchronous in-flight locks prevent rapid double-clicks / Enter spam from firing duplicate requests before React re-renders.
  const loginBusyRef = useRef(false);
  const refreshBusyRef = useRef(false);
  const patchingRef = useRef<string | null>(null);
  const verifyingBusyRef = useRef(false);
  const [exportDone, bumpExportDone] = useDoneSignal();
  const deletingRef = useRef<string | null>(null);
  const exportBusyRef = useRef(false);
  const purgingRef = useRef<string | null>(null);

  const inspectingApp = inspectingId ? apps.find((a) => a.id === inspectingId) ?? null : null;
  const verifying = verifyingAction !== null;
  /* Fail closed when role is not `'admin'`. */
  const can = adminPermissions(role);

  const resetDeleteConfirm = useCallback((refocusButton = false) => {
    if (deleteTimerRef.current !== null) {
      window.clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    setDeleteConfirm((cur) => {
      if (cur && refocusButton) {
        refocusDeleteBtnIdRef.current = cur.appId;
      }
      return null;
    });
    setDeleteReason('');
  }, []);

  const resetSessionState = useCallback(() => {
    tokenStore.clear();
    if (deleteTimerRef.current !== null) {
      window.clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    refocusDeleteBtnIdRef.current = null;
    setToken(null);
    setRole(null);
    setSource(null);
    setApps([]);
    setWithdrawnApps([]);
    setWithdrawnError(null);
    setWithdrawnLoading(false);
    setFeeBaht(null);
    setMaxCapacity(null);
    setQuotaFull(null);
    setOverCapOpen(false);
    setOverCapReason('');
    setFilter('ALL');
    setSortBy('newest');
    setQuery('');
    setInspectingId(null);
    setLightboxOpen(false);
    setDetailId(null);
    setEditingId(null);
    setEditingDirty(false);
    setPendingDiscardSwitch(null);
    setDeleteConfirm(null);
    setDeleteReason('');
    setPendingStatus(null);
    setStatusReason('');
    setVerificationNote('');
    setVerifyNoteError(null);
    setConfirmRejectSlip(false);
    setEditingSlipVerdict(false);
    setVerifyingAction(null);
    setLocalSlipVerdicts({});
    setSlipImage({ url: null, paymentId: null, error: null, loading: false });
  }, []);

  /** Expired, deactivated, or unauthorized session: drop the token and show a clear banner on login. */
  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiHttpError && (err.status === 401 || err.status === 403)) {
        resetSessionState();
        setActionSuccess(null);
        setSessionExpired(true);
        setError(
          err.status === 401
            ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
            : 'เซสชันหมดอายุหรือบัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ กรุณาเข้าสู่ระบบใหม่',
        );
        return true;
      }
      return false;
    },
    [resetSessionState],
  );

  // Active dashboard view, mirrored in location.hash (pushState) so Back/refresh keep it.
  const [view, setView] = useState<AdminView>('overview');
  const [viewFocusNonce, setViewFocusNonce] = useState(0);
  const applyView = useCallback((v: AdminView, nextFilter?: FilterKey) => {
    setView(v);
    setFilter((f) => (v === 'withdrawn' ? 'WITHDRAWN' : (nextFilter ?? (f === 'WITHDRAWN' ? 'ALL' : f))));
  }, []);
  useEffect(() => {
    const sync = () => applyView(viewFromHash());
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [applyView]);
  // A view switch from the menu scrolls to the top and moves focus to that view's heading.
  useEffect(() => {
    if (viewFocusNonce === 0) return;
    window.scrollTo({ top: 0 });
    document
      .querySelector<HTMLElement>(`[data-view="${view}"]:not([hidden]) [data-view-heading]`)
      ?.focus({ preventScroll: true });
  }, [viewFocusNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh(t: string, alsoSettings = false) {
    if (refreshBusyRef.current) return;
    refreshBusyRef.current = true;
    setBusy(true);
    setWithdrawnLoading(true);
    if (alsoSettings) {
      setSettingsRefreshKey((k) => k + 1);
    }
    try {
      const [appsRes, withdrawnRes] = await Promise.allSettled([
        listApplications(t),
        fetchWithdrawnApplicants(t),
      ]);

      if (appsRes.status === 'rejected') {
        if (handleAuthError(appsRes.reason)) return;
        setError(describeAdminError(appsRes.reason, 'โหลดรายการใบสมัครไม่สำเร็จ'));
      } else {
        setApps(Array.isArray(appsRes.value.data) ? appsRes.value.data : []);
        setSource(appsRes.value.source);
        setError(null);
      }

      if (withdrawnRes.status === 'fulfilled') {
        setWithdrawnApps(Array.isArray(withdrawnRes.value.data) ? withdrawnRes.value.data : []);
        setWithdrawnError(null);
      } else {
        if (
          withdrawnRes.reason instanceof ApiHttpError &&
          withdrawnRes.reason.status === 401 &&
          handleAuthError(withdrawnRes.reason)
        ) {
          return;
        }
        setWithdrawnError(
          describeAdminError(withdrawnRes.reason, 'โหลดรายชื่อผู้สมัครที่ยกเลิกเองไม่สำเร็จ'),
        );
      }
    } finally {
      refreshBusyRef.current = false;
      setBusy(false);
      setWithdrawnLoading(false);
    }
  }

  function focusPasswordAfterFailure() {
    const el = passwordRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    if (loginBusyRef.current || busy) return;
    loginBusyRef.current = true;
    setBusy(true);
    setError(null);
    setActionSuccess(null);
    setSessionExpired(false);
    try {
      const res = await adminLogin(username.trim(), password);
      setPassword('');
      setShowPassword(false);
      const resolvedRole = resolveAdminRole(res.data.token, res.data.role);
      if (resolvedRole !== 'admin') {
        tokenStore.clear();
        setError('บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ (admin)');
        focusPasswordAfterFailure();
        return;
      }
      setToken(res.data.token);
      setRole(resolvedRole);
      setSource(res.source);
      await refresh(res.data.token);
      // Land keyboard and screen-reader users on the opened view's heading instead of <body>.
      setViewFocusNonce((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiHttpError) {
        if (err.status === 401) {
          setError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง');
        } else if (err.status === 403) {
          setError('บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ (admin)');
        } else {
          setError(describeAdminError(err, 'เข้าสู่ระบบไม่สำเร็จ'));
        }
      } else {
        setError(describeAdminError(err, 'ไม่สามารถเข้าสู่ระบบได้ กรุณาลองใหม่อีกครั้ง'));
      }
      focusPasswordAfterFailure();
    } finally {
      loginBusyRef.current = false;
      setBusy(false);
    }
  }

  function guardProfileEditSwitch(label: string, action: () => void) {
    if (editingId && editingDirty) {
      setPendingDiscardSwitch({ label, run: action });
      return;
    }
    action();
  }

  /** Proposes a status; it is saved only from the confirmation under the row. Picking the current one cancels. */
  function requestStatusChange(app: Application, to: ApplicationStatus) {
    setQuotaFull(null);
    setOverCapOpen(false);
    setOverCapReason('');
    if (to === app.status) {
      setPendingStatus(null);
      setStatusReason('');
      return;
    }
    resetDeleteConfirm(false);
    if (pendingStatus?.appId !== app.id) setStatusReason('');
    setPendingStatus({ appId: app.id, from: app.status, to });
  }

  /** Closes the row's status confirmation (and the over-capacity step); focus returns to the status select. */
  function cancelPendingStatus() {
    setPendingStatus(null);
    setStatusReason('');
    setQuotaFull(null);
    setOverCapOpen(false);
    setOverCapReason('');
  }

  /** Opens the over-capacity warning, prefilled with the reason already typed in the confirm. */
  function openOverCapacity() {
    setOverCapReason(statusReason);
    setOverCapOpen(true);
  }

  async function onStatus(id: string, status: ApplicationStatus, reason?: string, overCapacity = false) {
    if (!token || patchingRef.current === id) return;
    if (overCapacity && !reason) return;
    patchingRef.current = id;
    setPatching(id);
    setError(null);
    setActionSuccess(null);
    const from = apps.find((a) => a.id === id)?.status;
    try {
      const res = await updateApplicationStatus(token, id, status, reason, overCapacity);
      setApps((prev) => prev.map((a) => (a.id === id ? res.data : a)));
      setSource(res.source);
      setPendingStatus(null);
      setStatusReason('');
      setQuotaFull(null);
      setOverCapOpen(false);
      setOverCapReason('');
      setActionSuccess(
        `เปลี่ยนสถานะของ ${id} เป็น ${STATUS_LABELS[status]} สำเร็จ${overCapacity ? ' (รับกลับเกินโควตา)' : ''}`,
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      const retakesSeat = from !== undefined && !holdsSeat(from) && holdsSeat(status);
      if (
        !overCapacity &&
        retakesSeat &&
        can.changeStatus &&
        err instanceof ApiHttpError &&
        err.code === 'QUOTA_FULL'
      ) {
        setQuotaFull({ appId: id, from, to: status });
        setError(
          'ที่นั่งเต็มแล้ว ใบสมัครนี้จึงยังคงสถานะเดิม เพิ่มโควตาก่อน หรือใช้ “รับกลับ (เกินโควตา)” ใต้แถวนี้ (ต้องระบุเหตุผล และจะถูกบันทึกใน audit)',
        );
        return;
      }
      setError(describeAdminError(err, 'เปลี่ยนสถานะไม่สำเร็จ'));
    } finally {
      patchingRef.current = null;
      setPatching(null);
    }
  }

  /* Compute sorted & filtered lists before handlers that need next-pending navigation. */
  const isWithdrawnTab = filter === 'WITHDRAWN';
  const sorted = sortApplications(apps, sortBy);
  const byTab =
    filter === 'ALL'
      ? sorted
      : filter === 'SLIP_PENDING'
        ? sorted.filter((a) => isSlipPending(a))
        : filter === 'AWAITING_PAY'
          ? sorted.filter((a) => isAwaitingPayment(a))
          : filter === 'WITHDRAWN'
            ? []
            : sorted.filter((a) => a.status === filter);
  const visible = byTab.filter((a) => matchesApplicantQuery(a, query));
  const visibleWithdrawn = withdrawnApps.filter((w) => matchesWithdrawnQuery(w, query));
  const searching = stripZeroWidth(query).trim() !== '';

  function findNextPendingSlip(afterId: string, list: Application[]): Application | null {
    const withSlips = list.filter((x) => hasSlip(x) && can.viewSlip);
    const idx = withSlips.findIndex((x) => x.id === afterId);
    const ordered =
      idx >= 0 ? [...withSlips.slice(idx + 1), ...withSlips.slice(0, idx)] : withSlips;
    return ordered.find((x) => x.id !== afterId && isSlipPending(x) && holdsSeat(x.status)) ?? null;
  }

  function switchToSlipApplicant(target: Application, switchFilterToPending = false) {
    if (switchFilterToPending) {
      setFilter('SLIP_PENDING');
    }
    resetDeleteConfirm(false);
    setEditingId(null);
    setDetailId(null);
    setLightboxOpen(false);
    setInspectingId(target.id);
    setVerificationNote('');
    setVerifyNoteError(null);
    setConfirmRejectSlip(false);
    setEditingSlipVerdict(false);
    focusSlipPanelAfterAdvance.current = true;
  }

  const resolvedSlipPaymentId = (slipImage.paymentId ?? inspectingApp?.slipPaymentId ?? '').trim();
  const slipReadyToVerify =
    Boolean(inspectingApp?.hasSlip) &&
    !slipImage.loading &&
    !slipImage.error &&
    Boolean(slipImage.url) &&
    Boolean(resolvedSlipPaymentId);

  function initiateSlipReject() {
    if (!slipReadyToVerify) {
      setError('ยังโหลดสลิปไม่สำเร็จหรือไม่มีรหัสสลิป (paymentId) กรุณาโหลดสลิปใหม่อีกครั้ง');
      return;
    }
    const trimmed = stripZeroWidth(verificationNote).trim();
    if (!trimmed) {
      setVerifyNoteError('กรุณาระบุเหตุผลการปฏิเสธสลิป หรือเลือกข้อความสำเร็จรูปด้านล่าง');
      setConfirmRejectSlip(false);
      document.getElementById('verify-note')?.focus();
      return;
    }
    setVerifyNoteError(null);
    setConfirmRejectSlip(true);
  }

  async function handleVerifySlip(approved: boolean) {
    if (!token || !inspectingApp || verifying || verifyingBusyRef.current) return;
    if (!slipReadyToVerify) {
      setError('ยังโหลดสลิปไม่สำเร็จหรือไม่มีรหัสสลิป (paymentId) กรุณาโหลดสลิปใหม่อีกครั้ง');
      return;
    }
    const trimmed = stripZeroWidth(verificationNote).trim();
    if (!approved && !trimmed) {
      setVerifyNoteError('กรุณาระบุเหตุผลการปฏิเสธสลิป หรือเลือกข้อความสำเร็จรูปด้านล่าง');
      setConfirmRejectSlip(false);
      document.getElementById('verify-note')?.focus();
      return;
    }

    const currentId = inspectingApp.id;
    const nextPendingInView = autoAdvanceSlip ? findNextPendingSlip(currentId, visible) : null;

    verifyingBusyRef.current = true;
    setVerifyingAction(approved ? 'approve' : 'reject');
    setError(null);
    setActionSuccess(null);
    setVerifyNoteError(null);
    try {
      // slipPaymentId pins the verdict to the slip that is on screen: a slip swapped in meanwhile
      // is refused (SLIP_CHANGED) instead of being approved unseen. Prefer X-Slip-Payment-Id from the
      // loaded image response, falling back to the row's slipPaymentId.
      const res = await verifyPaymentSlip(
        token,
        currentId,
        approved,
        trimmed,
        resolvedSlipPaymentId,
      );
      setSource(res.source);

      const newStatus: ApplicationStatus = approved ? 'CONFIRMED' : 'PASSED';
      const newSlip: SlipStatus = approved ? 'APPROVED' : 'REJECTED';
      const recordedNote = trimmed || (approved ? 'ยอดเงินถูกต้องครบถ้วน' : '');
      const verifiedAt = new Date().toISOString();

      setLocalSlipVerdicts((prev) => ({
        ...prev,
        [currentId]: { approved, note: recordedNote, verifiedAt, paymentId: resolvedSlipPaymentId },
      }));
      setApps((prev) =>
        prev.map((a) =>
          a.id === currentId
            ? {
                ...a,
                status: newStatus,
                attendanceConfirmed: approved ? true : a.attendanceConfirmed,
                slipStatus: newSlip,
                adminNote: approved ? recordedNote : (a.adminNote ?? null),
                rejectionReason: approved ? null : recordedNote,
                verifiedAt,
                updatedAt: verifiedAt,
              }
            : a,
        ),
      );

      setActionSuccess(
        `${approved ? 'อนุมัติสลิปสำเร็จ' : 'ปฏิเสธสลิปแล้ว'}: ${currentId}${nextPendingInView ? ` · เปิดคิวถัดไป ${nextPendingInView.id}` : ''}`,
      );
      setLightboxOpen(false);
      setConfirmRejectSlip(false);
      setVerificationNote('');
      setEditingSlipVerdict(false);

      if (nextPendingInView) {
        setInspectingId(nextPendingInView.id);
        focusSlipPanelAfterAdvance.current = true;
      } else {
        setInspectingId(null);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setConfirmRejectSlip(false);
      if (err instanceof ApiHttpError && err.code === 'SLIP_CHANGED') {
        // Keep the panel open, reload list & fetch the newly uploaded slip image without losing staff context.
        setEditingSlipVerdict(false);
        setLocalSlipVerdicts((prev) => {
          const next = { ...prev };
          delete next[currentId];
          return next;
        });
        setSlipRetryNonce((n) => n + 1);
        listApplications(token)
          .then((listRes) => {
            const nextList = Array.isArray(listRes.data) ? listRes.data : [];
            setApps(nextList);
            setSource(listRes.source);
            const refreshed = nextList.find((a) => a.id === currentId);
            if (!refreshed || !hasSlip(refreshed)) {
              setInspectingId(null);
            }
          })
          .catch((reloadErr) => {
            handleAuthError(reloadErr);
          });
      } else if (
        err instanceof ApiHttpError &&
        err.code !== 'DUPLICATE_SLIP' &&
        (err.code === 'ALREADY_VERIFIED' || err.status === 409 || err.status === 404)
      ) {
        setLightboxOpen(false);
        setInspectingId(null);
        setVerificationNote('');
        listApplications(token)
          .then((listRes) => {
            setApps(Array.isArray(listRes.data) ? listRes.data : []);
            setSource(listRes.source);
          })
          .catch((reloadErr) => {
            handleAuthError(reloadErr);
          });
      }
      setError(describeAdminError(err, 'การตรวจสอบสลิปล้มเหลว'));
    } finally {
      verifyingBusyRef.current = false;
      setVerifyingAction(null);
    }
  }

  async function handleDeleteApp(id: string, name: string) {
    if (!token || deletingRef.current === id) return;
    deletingRef.current = id;
    setDeletingId(id);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await deleteApplication(token, id, deleteReason.trim() || undefined);
      setApps((prev) => prev.filter((a) => a.id !== id));
      focusListAfterDelete.current = true;
      if (inspectingId === id) {
        setLightboxOpen(false);
        setInspectingId(null);
      }
      if (detailId === id) setDetailId(null);
      if (editingId === id) {
        setEditingId(null);
        setEditingDirty(false);
      }
      if (pendingStatus?.appId === id) setPendingStatus(null);
      resetDeleteConfirm(false);
      setSource(res.source);
      setActionSuccess(`ลบใบสมัคร ${id} (${name}) สำเร็จ`);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'ลบใบสมัครไม่สำเร็จ'));
    } finally {
      deletingRef.current = null;
      setDeletingId(null);
    }
  }

  /** Moves focus after a withdrawn row is purged: the next row's button, else the view heading. */
  function focusAfterPurge(nextId: string | null) {
    window.requestAnimationFrame(() => {
      const next = nextId ? document.getElementById(`purge-btn-${nextId}`) : null;
      const target =
        next ?? document.querySelector<HTMLElement>('[data-view="withdrawn"] [data-view-heading]') ?? null;
      target?.focus();
    });
  }

  async function handlePurgeWithdrawn(w: WithdrawnApplicant, nextId: string | null) {
    if (!token || purgingRef.current) return;
    purgingRef.current = w.id;
    setPurgingId(w.id);
    setError(null);
    setActionSuccess(null);
    try {
      await purgeWithdrawnApplication(token, w.id);
      setWithdrawnApps((prev) => prev.filter((x) => x.id !== w.id));
      setPurgeConfirmId(null);
      setActionSuccess(`ลบใบสมัคร ${w.id} (${w.fullName}) ออกจากระบบถาวรแล้ว`);
      focusAfterPurge(nextId);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'ลบใบสมัครถาวรไม่สำเร็จ'));
    } finally {
      purgingRef.current = null;
      setPurgingId(null);
    }
  }

  function cancelPurge(id: string) {
    if (purgingRef.current === id) return;
    setPurgeConfirmId(null);
    window.requestAnimationFrame(() => document.getElementById(`purge-btn-${id}`)?.focus());
  }

  /** Minimum gap between delete steps, so a double or triple click cannot run all three confirmations. */
  const DELETE_STEP_GAP_MS = 400;

  function onDeleteButtonClick(a: Application) {
    if (deletingRef.current === a.id || deletingId === a.id) return;
    const now = Date.now();
    if (now - lastDeleteStepAtRef.current < DELETE_STEP_GAP_MS) return;
    lastDeleteStepAtRef.current = now;
    if (!deleteConfirm || deleteConfirm.appId !== a.id) {
      guardProfileEditSwitch(`ลบใบสมัคร ${a.id}`, () => {
        setPendingStatus(null);
        setStatusReason('');
        setDeleteReason('');
        setDeleteConfirm({ appId: a.id, step: 1 });
      });
      return;
    }
    if (deleteConfirm.step === 1) {
      setDeleteConfirm({ appId: a.id, step: 2 });
      return;
    }
    if (deleteConfirm.step === 2) {
      setDeleteConfirm({ appId: a.id, step: 3 });
      return;
    }
    void handleDeleteApp(a.id, a.fullName);
  }

  function openSlip(a: Application) {
    const run = () => {
      resetDeleteConfirm(false);
      setEditingId(null);
      setEditingDirty(false);
      setDetailId(null);
      setLightboxOpen(false);
      setConfirmRejectSlip(false);
      setVerifyNoteError(null);
      setVerificationNote('');
      setEditingSlipVerdict(false);
      setInspectingId((cur) => (cur === a.id ? null : a.id));
    };
    guardProfileEditSwitch(`เปิดตรวจสลิปของ ${a.id}`, run);
  }

  function toggleDetail(a: Application) {
    const run = () => {
      resetDeleteConfirm(false);
      setInspectingId(null);
      setLightboxOpen(false);
      setEditingId(null);
      setEditingDirty(false);
      setDetailId((cur) => (cur === a.id ? null : a.id));
    };
    guardProfileEditSwitch(`ดูรายละเอียดของ ${a.id}`, run);
  }

  function toggleEdit(a: Application) {
    if (editingId === a.id) {
      // Closing the active dirty editor is handled inside AdminProfileEditor itself or guarded here.
      if (editingDirty) {
        setPendingDiscardSwitch({
          label: `ปิดหน้าแก้ไขของ ${a.id}`,
          run: () => {
            setEditingDirty(false);
            setEditingId(null);
          },
        });
        return;
      }
      setEditingId(null);
      return;
    }
    const run = () => {
      resetDeleteConfirm(false);
      setInspectingId(null);
      setLightboxOpen(false);
      setDetailId(null);
      setPendingStatus(null);
      setEditingDirty(false);
      setEditingId(a.id);
    };
    guardProfileEditSwitch(`สลับไปแก้ไขข้อมูลของ ${a.id}`, run);
  }

  function onProfileSaved(updated: Application) {
    setApps((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    setActionSuccess(`บันทึกการแก้ไขข้อมูลของ ${updated.id} เรียบร้อยแล้ว`);
    setEditingDirty(false);
    setEditingId(null);
  }

  function logout() {
    const run = () => {
      resetSessionState();
      setSessionExpired(false);
      setError(null);
      setActionSuccess(null);
    };
    guardProfileEditSwitch('ออกจากระบบ', run);
  }

  /** Records the export in audit_logs first; the file is built only once that succeeded. */
  async function exportCsv() {
    if (!token || exporting || exportBusyRef.current || isWithdrawnTab || visible.length === 0) return;
    const rows = visible;
    exportBusyRef.current = true;
    setExporting(true);
    setActionSuccess(null);
    setError(null);
    try {
      const apiStatusFilter: ApplicationStatus | undefined =
        filter === 'ALL' || filter === 'SLIP_PENDING' || filter === 'AWAITING_PAY'
          ? undefined
          : filter;
      await recordCsvExport(token, {
        applicationIds: rows.map((a) => a.id),
        statusFilter: apiStatusFilter,
        searchFiltered: searching || filter === 'SLIP_PENDING' || filter === 'AWAITING_PAY',
      });
      downloadCsv(csvFileName(), buildApplicantsCsv(rows));
      setActionSuccess(`ส่งออก ${rows.length} รายการเป็นไฟล์ CSV แล้ว (บันทึกประวัติการส่งออกแล้ว)`);
      bumpExportDone();
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'บันทึกประวัติการส่งออกไม่สำเร็จ จึงยังไม่ได้สร้างไฟล์ CSV กรุณาลองใหม่อีกครั้ง'));
    } finally {
      exportBusyRef.current = false;
      setExporting(false);
    }
  }

  function applyNotePreset(preset: string) {
    const approveTemplates = approveNoteTemplates(feeBaht);
    const allTemplates = [...approveTemplates, ...REJECT_NOTE_TEMPLATES];
    const current = verificationNote.trim();
    setVerifyNoteError(null);

    if (!current || allTemplates.includes(current)) {
      setVerificationNote(preset.slice(0, VERIFY_NOTE_MAX));
      return;
    }
    if (current.includes(preset)) {
      return;
    }
    const combined = `${current}; ${preset}`;
    if (combined.length > VERIFY_NOTE_MAX) {
      setVerifyNoteError(`หมายเหตุยาวเกิน ${VERIFY_NOTE_MAX} ตัวอักษร กรุณาย่อข้อความก่อนเพิ่ม`);
      return;
    }
    setVerificationNote(combined);
  }

  useEffect(() => {
    try {
      localStorage.removeItem(TOKEN_KEY); // migrate away from the old persistent token
    } catch {
      /* ignore */
    }
    const saved = tokenStore.get();
    if (saved) {
      const savedRole = resolveAdminRole(saved);
      if (savedRole !== 'admin') {
        tokenStore.clear();
        return;
      }
      setToken(saved);
      setRole(savedRole);
      refresh(saved);
    }
  }, []);

  useEffect(() => {
    if (token) tokenStore.set(token);
  }, [token]);

  /* Auto-dismiss success toast after 6s with proper timer cleanup; errors stay until dismissed. */
  useEffect(() => {
    if (!actionSuccess) return;
    const timer = window.setTimeout(() => setActionSuccess(null), 6000);
    return () => window.clearTimeout(timer);
  }, [actionSuccess]);

  /* Reset slip re-verification edit mode whenever the inspected applicant changes or closes. */
  useEffect(() => {
    setEditingSlipVerdict(false);
  }, [inspectingId]);

  /* Slips are served only to an authenticated admin, so fetch the image with the token and show
     it from an object URL (revoked when the panel closes or retries). */
  useEffect(() => {
    if (!token || !inspectingId) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setSlipImage({ url: null, paymentId: null, error: null, loading: true });
    fetchAdminSlipInfo(token, inspectingId)
      .then(({ url, paymentId }) => {
        if (cancelled) return URL.revokeObjectURL(url);
        objectUrl = url;
        setSlipImage({ url, paymentId, error: null, loading: false });
      })
      .catch((err) => {
        if (cancelled || handleAuthError(err)) return;
        setSlipImage({
          url: null,
          paymentId: null,
          error: describeAdminError(err, 'โหลดรูปสลิปไม่สำเร็จ'),
          loading: false,
        });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      // Drop the revoked URL too, so reopening the panel never renders an <img> pointing at it.
      setSlipImage({ url: null, paymentId: null, error: null, loading: false });
    };
  }, [token, inspectingId, slipRetryNonce, handleAuthError]);

  /* 3-step row delete: 8s idle reset (restarted by click/keydown/input inside button or strip) + outside pointerdown reset. */
  useEffect(() => {
    if (!deleteConfirm || deletingId === deleteConfirm.appId) {
      if (deleteTimerRef.current !== null) {
        window.clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
      return;
    }
    const appId = deleteConfirm.appId;
    const isInside = (node: Node | null): boolean => {
      if (!node) return false;
      const btn = document.getElementById(`delete-btn-${appId}`);
      const strip = document.getElementById(`delete-strip-${appId}`);
      return Boolean(btn?.contains(node) || strip?.contains(node));
    };
    const schedule = () => {
      if (deleteTimerRef.current !== null) {
        window.clearTimeout(deleteTimerRef.current);
      }
      deleteTimerRef.current = window.setTimeout(() => {
        deleteTimerRef.current = null;
        const active = document.activeElement;
        const shouldRefocus = !active || active === document.body || isInside(active);
        resetDeleteConfirm(shouldRefocus);
      }, 8000);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (deletingRef.current === appId) return;
      const target = e.target as Node | null;
      if (isInside(target)) {
        schedule();
        return;
      }
      const active = document.activeElement;
      const strip = document.getElementById(`delete-strip-${appId}`);
      const focusWasInStrip = Boolean(active && strip?.contains(active));
      const targetIsFocusable =
        target instanceof Element &&
        Boolean(target.closest('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'));
      resetDeleteConfirm(focusWasInStrip && !targetIsFocusable);
    };
    const onActivity = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') return;
      if (isInside(e.target as Node | null)) {
        schedule();
      }
    };

    schedule();
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('click', onActivity);
    document.addEventListener('keydown', onActivity);
    document.addEventListener('input', onActivity);

    return () => {
      if (deleteTimerRef.current !== null) {
        window.clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('click', onActivity);
      document.removeEventListener('keydown', onActivity);
      document.removeEventListener('input', onActivity);
    };
  }, [deleteConfirm, deletingId, resetDeleteConfirm]);

  /* Escape closes open inline panels or confirmations (when lightbox/mutation is not active). */
  useEffect(() => {
    if (!inspectingId && !detailId && !deleteConfirm && !pendingStatus && !pendingDiscardSwitch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightboxOpen) return;
        if (pendingDiscardSwitch) {
          setPendingDiscardSwitch(null);
          return;
        }
        if (confirmRejectSlip && !verifying) {
          setConfirmRejectSlip(false);
          return;
        }
        // Delete confirmation resets on Escape only when focus is inside the delete button or strip.
        if (deleteConfirm && !deletingId) {
          const btn = document.getElementById(`delete-btn-${deleteConfirm.appId}`);
          const strip = document.getElementById(`delete-strip-${deleteConfirm.appId}`);
          const active = document.activeElement;
          if (active && (btn?.contains(active) || strip?.contains(active))) {
            e.preventDefault();
            resetDeleteConfirm(true);
            return;
          }
        }
        if (pendingStatus && !patching) {
          setPendingStatus(null);
          setStatusReason('');
          setQuotaFull(null);
          setOverCapOpen(false);
          setOverCapReason('');
          return;
        }
        if (!verifying) setInspectingId(null);
        setDetailId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    inspectingId,
    detailId,
    deleteConfirm,
    pendingStatus,
    pendingDiscardSwitch,
    confirmRejectSlip,
    lightboxOpen,
    verifying,
    deletingId,
    patching,
    resetDeleteConfirm,
  ]);

  /* Keyboard focus should never fall to <body>: returning from closed panels or moving into the next slip. */
  useEffect(() => {
    if (focusSlipPanelAfterAdvance.current && inspectingId) {
      focusSlipPanelAfterAdvance.current = false;
      slipPanelRef.current?.focus();
    }
    if (prevSlipId.current && !inspectingId) {
      const opener = document.getElementById(`slip-btn-${prevSlipId.current}`);
      if (opener) {
        opener.focus();
      } else if (listRef.current && visible.length > 0) {
        listRef.current.focus();
      } else if (emptyStateRef.current) {
        emptyStateRef.current.focus();
      } else {
        filterGroupRef.current?.focus();
      }
    }
    if (prevDetailId.current && !detailId) {
      document.getElementById(`detail-btn-${prevDetailId.current}`)?.focus();
    }
    if (prevEditId.current && !editingId) {
      document.getElementById(`edit-btn-${prevEditId.current}`)?.focus();
    }
    prevSlipId.current = inspectingId;
    prevDetailId.current = detailId;
    prevEditId.current = editingId;
  }, [inspectingId, detailId, editingId, visible.length]);

  /* After a 3-step delete reset (Escape, Cancel, timeout, non-focusable outside click), keep focus on the delete button. */
  useEffect(() => {
    if (!deleteConfirm && refocusDeleteBtnIdRef.current && !focusListAfterDelete.current) {
      const id = refocusDeleteBtnIdRef.current;
      refocusDeleteBtnIdRef.current = null;
      document.getElementById(`delete-btn-${id}`)?.focus();
    }
  }, [deleteConfirm]);

  // A saved or cancelled status confirmation unmounts its buttons: put focus back on that row's select.
  useEffect(() => {
    const id = pendingStatus?.appId ?? null;
    if (prevPendingId.current && !id && (document.activeElement === document.body || !document.activeElement)) {
      document.getElementById(`status-select-${prevPendingId.current}`)?.focus();
    }
    prevPendingId.current = id;
  }, [pendingStatus]);

  // Opening the over-capacity warning moves focus to its required reason field.
  useEffect(() => {
    if (overCapOpen && quotaFull) {
      document.getElementById(`overcap-reason-${quotaFull.appId}`)?.focus();
    }
  }, [overCapOpen, quotaFull]);

  // The toolbar sticks under the site nav (md and up) and the sidebar under it (xl and up). The nav
  // height is published as --admin-nav-h; the page's scroll padding follows nav + toolbar, so rows
  // and panels scrolled into view are not hidden.
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('.site-nav');
    const bar = toolbarRef.current;
    if (!token) return;
    const md = window.matchMedia('(min-width: 768px)');
    const root = document.documentElement;
    const sync = () => {
      const navH = nav ? nav.getBoundingClientRect().height : 0;
      root.style.setProperty('--admin-nav-h', `${navH}px`);
      const barH = bar && md.matches ? bar.offsetHeight : 0;
      root.style.scrollPaddingTop = `${navH + barH + 12}px`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (nav) ro.observe(nav);
    if (bar) ro.observe(bar);
    md.addEventListener('change', sync);
    return () => {
      ro.disconnect();
      md.removeEventListener('change', sync);
      root.style.scrollPaddingTop = '';
      root.style.removeProperty('--admin-nav-h');
    };
  }, [token]);

  useEffect(() => {
    if (!focusListAfterDelete.current) return;
    focusListAfterDelete.current = false;
    if (visible.length > 0) {
      listRef.current?.focus();
    } else {
      emptyStateRef.current?.focus();
    }
  }, [apps, visible.length]);

  const count = (s: ApplicationStatus) => apps.filter((a) => a.status === s).length;
  const pendingSlipCount = apps.filter((a) => isSlipPending(a)).length;
  const awaitingPayCount = apps.filter((a) => isAwaitingPayment(a)).length;
  const overduePayCount = apps.filter((a) => isPaymentOverdue(a, nowMs)).length;
  /** Same rule the server uses for the seat quota: REJECTED, REFUND_PENDING and REFUNDED released theirs. */
  const currentCount = apps.filter((a) => holdsSeat(a.status)).length;
  const activeTotal = isWithdrawnTab ? withdrawnApps.length : byTab.length;
  const activeVisibleCount = isWithdrawnTab ? visibleWithdrawn.length : visible.length;
  const countLabel = searching
    ? `พบ ${activeVisibleCount} จาก ${activeTotal} รายการ`
    : `${activeTotal} รายการ`;
  const navItems: { key: AdminView; label: string; Icon: LucideIcon; n?: number; srCount?: string; alert?: boolean }[] = [
    { key: 'overview', label: 'ภาพรวม', Icon: LayoutDashboard },
    {
      key: 'applications',
      label: 'ใบสมัครและสลิป',
      Icon: ClipboardList,
      n: pendingSlipCount,
      srCount: `สลิปรอตรวจ ${pendingSlipCount} รายการ`,
      alert: pendingSlipCount > 0,
    },
    { key: 'withdrawn', label: 'ยกเลิกเอง', Icon: UserX, n: withdrawnApps.length, srCount: `${withdrawnApps.length} รายการ` },
    { key: 'logistics', label: 'เตรียมงานค่าย', Icon: Shirt },
    {
      key: 'sponsors',
      label: 'ผู้สนับสนุน',
      Icon: HeartHandshake,
      n: sponsorInquiryCount ?? 0,
      srCount: `ผู้สนใจสนับสนุนที่ยังไม่ได้ติดต่อ ${sponsorInquiryCount ?? 0} รายการ`,
      alert: (sponsorInquiryCount ?? 0) > 0,
    },
    { key: 'settings', label: 'ตั้งค่าค่าย', Icon: Settings2 },
  ];

  /** Menu click. Hidden views stay mounted, so unsaved edits survive a switch. */
  function openView(v: AdminView, nextFilter?: FilterKey) {
    resetDeleteConfirm(false);
    applyView(v, nextFilter);
    if (window.location.hash !== `#${v}`) window.history.pushState(null, '', `#${v}`);
    setViewFocusNonce((n) => n + 1);
  }

  const inputCls = `${INPUT_BASE} rounded-xl`;
  const pillGhost = PILL_GHOST;

  const legacyTabs: { key: FilterKey; label: string; n: number }[] = LEGACY_STATUSES
    .filter((s) => count(s) > 0)
    .map((s) => ({ key: s as FilterKey, label: STATUS_LABELS[s], n: count(s) }));

  const tabs: { key: FilterKey; label: string; n: number }[] = [
    { key: 'ALL', label: 'ทั้งหมด', n: apps.length },
    { key: 'SLIP_PENDING', label: 'สลิปรอตรวจ', n: pendingSlipCount },
    { key: 'AWAITING_PAY', label: 'รอโอน / ส่งสลิป', n: awaitingPayCount },
    ...STATUSES.map((s) => ({ key: s as FilterKey, label: STATUS_LABELS[s], n: count(s) })),
    ...legacyTabs,
  ];

  /** Zero-count status tabs are noise: keep the work queues and the active filter, hide the rest. */
  const visibleTabs = tabs.filter(
    (t) => t.n > 0 || t.key === filter || t.key === 'ALL' || t.key === 'SLIP_PENDING' || t.key === 'AWAITING_PAY',
  );

  const visibleWithSlip = visible.filter((x) => hasSlip(x) && can.viewSlip);
  const approvePresets = approveNoteTemplates(feeBaht);

  return (
    <MotionConfig reducedMotion="user">
    <div
      className={`mx-auto w-full max-w-[96rem] select-text px-4 pb-28 selection:bg-[color-mix(in_srgb,var(--color-tech)_25%,transparent)] sm:px-8 ${token ? 'pt-3 sm:pt-5' : 'pt-12 sm:pt-20'}`}
    >
      {/* ── Masthead ─────────────────────────────────────────── */}
      {token ? (
        // A work screen: the title is for assistive tech only; refresh/log-out live with the view menu.
        <h1 className="sr-only">ระบบพี่ค่าย</h1>
      ) : (
        <header>
          <h1 className="text-balance text-[2rem] font-bold leading-[1.22] sm:text-[3.25rem]" style={{ color: INK }}>
            สำหรับพี่ค่าย
          </h1>
          <p className="mt-4 max-w-[46ch] text-base leading-[1.75]" style={{ color: INK_2 }}>
            เข้าสู่ระบบเพื่อตรวจรายชื่อใบสมัคร เปลี่ยนสถานะ และอนุมัติหลักฐานการชำระเงิน
          </p>
        </header>
      )}

      {/* ── Login-screen inline notice (visible immediately above login form on expiry or wrong credentials) ── */}
      {!token && error && (
        <div
          role="alert"
          className="mt-8 flex items-start justify-between gap-4 rounded-xl border px-4 py-3.5"
          style={{
            backgroundColor: sessionExpired ? SURFACE_SUBTLE : DANGER,
            borderColor: sessionExpired ? WARNING : DANGER,
            color: sessionExpired ? INK : 'var(--bg-canvas)',
          }}
        >
          <p className="flex items-start gap-2.5 text-sm font-semibold leading-7">
            <TriangleAlert
              aria-hidden="true"
              size={18}
              strokeWidth={1.75}
              className="mt-1 shrink-0"
              style={sessionExpired ? { color: WARNING } : undefined}
            />
            <span>{error}</span>
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setSessionExpired(false);
            }}
            className="-my-2 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold underline underline-offset-4 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-current"
          >
            ปิด
          </button>
        </div>
      )}

      {/* ── Floating toast feedback bar when logged in (visible anywhere on page without scrolling up) ── */}
      {token && (error || actionSuccess) && (
        <div
          className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:right-6 sm:w-full sm:max-w-lg"
          aria-live="polite"
        >
          {error && (
            <div
              role="alert"
              className="pointer-events-auto flex w-full items-start justify-between gap-4 rounded-xl border px-4 py-3.5 [box-shadow:var(--shadow-float)]"
              style={{ backgroundColor: DANGER, borderColor: DANGER, color: 'var(--bg-canvas)' }}
            >
              <p className="flex items-start gap-2.5 text-sm font-semibold leading-6">
                <TriangleAlert aria-hidden="true" size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
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

          {actionSuccess && (
            <div
              role="status"
              className="pointer-events-auto flex w-full items-start justify-between gap-4 rounded-xl border px-4 py-3.5 [box-shadow:var(--shadow-float)]"
              style={{ backgroundColor: SUCCESS, borderColor: SUCCESS, color: 'var(--color-on-success)' }}
            >
              <p className="flex items-start gap-2.5 text-sm font-semibold leading-6">
                <CircleCheck aria-hidden="true" size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                <span>{actionSuccess}</span>
              </p>
              <button
                type="button"
                onClick={() => setActionSuccess(null)}
                className="-my-2 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold underline underline-offset-4 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-current"
              >
                ปิด
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Unsaved profile edit guard dialog when switching rows / logging out / refreshing ── */}
      {token && pendingDiscardSwitch && (
        <div
          role="alertdialog"
          aria-label="ยืนยันการทิ้งการแก้ไขข้อมูลผู้สมัคร"
          className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-lg rounded-xl border p-4 [box-shadow:var(--shadow-float)]"
          style={{ backgroundColor: BG_CARD, borderColor: WARNING }}
        >
          <p className="flex items-start gap-2 text-sm font-semibold leading-6" style={{ color: INK }}>
            <TriangleAlert aria-hidden="true" size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: WARNING }} />
            <span>
              คุณมีการแก้ไขข้อมูลของ {editingId} ที่ยังไม่บันทึก หาก{pendingDiscardSwitch.label} การแก้ไขจะถูกยกเลิก
            </span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const act = pendingDiscardSwitch.run;
                setPendingDiscardSwitch(null);
                setEditingDirty(false);
                act();
              }}
              className={`inline-flex min-h-11 items-center justify-center rounded-full border px-4 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
              style={{ borderColor: DANGER, color: DANGER }}
            >
              ทิ้งการแก้ไขและดำเนินการต่อ
            </button>
            <button
              type="button"
              onClick={() => {
                const targetId = editingId;
                setPendingDiscardSwitch(null);
                if (targetId) {
                  document.getElementById(`profile-editor-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              }}
              className={pillGhost}
              style={{ borderColor: RULE, color: INK }}
            >
              กลับไปแก้ไขต่อ
            </button>
          </div>
        </div>
      )}

      {!token ? (
        /* ── Login: a single quiet column ─────────────────────── */
        <section className="mt-12 max-w-sm">
          <form onSubmit={onLogin} aria-busy={busy}>
            <div>
              <label className="mb-2 block text-sm font-semibold" style={{ color: INK }} htmlFor="admin-user">
                ชื่อผู้ใช้
              </label>
              <input
                id="admin-user"
                className={inputCls}
                style={{ borderColor: INPUT_BORDER, color: INK }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </div>
            <div className="mt-6">
              <label className="mb-2 block text-sm font-semibold" style={{ color: INK }} htmlFor="admin-pass">
                รหัสผ่าน
              </label>
              <div className="relative">
                <input
                  ref={passwordRef}
                  id="admin-pass"
                  className={`${inputCls} pr-12`}
                  style={{ borderColor: INPUT_BORDER, color: INK }}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                  aria-pressed={showPassword}
                  className={`absolute right-1 top-1/2 inline-flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                  style={{ color: INK_2 }}
                >
                  {showPassword ? (
                    <EyeOff aria-hidden="true" size={18} strokeWidth={1.5} />
                  ) : (
                    <Eye aria-hidden="true" size={18} strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              aria-busy={busy || undefined}
              className={`mt-10 min-h-11 w-full rounded-full px-5 py-3.5 text-base font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
              style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
            >
              {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </button>
          </form>

          <p className="mt-10 border-t pt-4 text-sm leading-[1.75]" style={{ borderColor: RULE, color: INK_3 }}>
            เซสชันอยู่ได้ไม่เกิน 8 ชั่วโมงและสิ้นสุดเมื่อปิดแท็บ ทุกการเปลี่ยนสถานะและการเปิดดูสลิปถูกบันทึกพร้อมบัญชีผู้ใช้และ IP
          </p>
        </section>
      ) : (
        <>
          <div className="mt-3 xl:mt-4 xl:grid xl:grid-cols-[auto_minmax(0,1fr)] xl:items-start xl:gap-8">
            {/* ── View menu: Aceternity floating dock (< xl) and collapsible sidebar (xl and up) ── */}
            <AdminSideMenu
              items={navItems}
              active={view}
              onSelect={(k) => openView(k)}
              onRefresh={() => guardProfileEditSwitch('รีเฟรชรายการ', () => void refresh(token, true))}
              onLogout={logout}
              busy={busy}
            />

            <div className="mt-3 min-w-0 xl:mt-0">
              {view === 'overview' && (
                <div data-view="overview">
                  <AdminOverview
                    apps={apps}
                    withdrawnCount={withdrawnApps.length}
                    maxCapacity={maxCapacity}
                    campFee={feeBaht}
                    pendingSlipCount={pendingSlipCount}
                    awaitingPayCount={awaitingPayCount}
                    overduePayCount={overduePayCount}
                    loading={busy && apps.length === 0}
                    onOpenQueue={(f) => openView('applications', f)}
                  />
                </div>
              )}

              {view === 'logistics' && (
                <div data-view="logistics">
                  <AdminLogistics apps={apps} />
                </div>
              )}

              {/* Settings and sponsors stay mounted while hidden: the fee/quota callback keeps feeding the
                  other views, and unsaved edits survive a menu switch. */}
              <div data-view="settings" hidden={view !== 'settings'}>
                <ViewHeading title="ตั้งค่าค่าย" sub="กำหนดการรับสมัคร โควตาที่นั่ง ค่าสมัคร และการปิดรับฉุกเฉิน ทุกการบันทึกถูกเก็บใน audit" />
                <div className={PANEL}>
                  <AdminSettingsPanel
                    token={token}
                    canEdit={can.editSettings}
                    currentCount={currentCount}
                    refreshSignal={settingsRefreshKey}
                    onAuthError={handleAuthError}
                    onSettings={(s: AdminSettings) => {
                      setFeeBaht(Number(s.campFee));
                      setMaxCapacity(Number.isFinite(Number(s.maxCapacity)) ? Number(s.maxCapacity) : null);
                    }}
                  />
                </div>
              </div>

              <div data-view="sponsors" hidden={view !== 'sponsors'}>
                <ViewHeading
                  title="ผู้สนับสนุน"
                  sub="ผู้แจ้งความประสงค์จาก /sponsor รายการบริจาคและฟอร์มของคณะ โลโก้บนหน้าแรก และอีเมลแจ้งเตือน"
                />
                <div className={PANEL}>
                  <AdminSponsorHub
                    token={token}
                    canEdit={can.editSettings}
                    onAuthError={handleAuthError}
                    onUnhandledCount={setSponsorInquiryCount}
                  />
                </div>
              </div>

          {/* ── Ledger (applications + withdrawn views) ─────────── */}
          <div
            className="@container/ledger"
            data-view={isWithdrawnTab ? 'withdrawn' : 'applications'}
            hidden={view !== 'applications' && view !== 'withdrawn'}
          >
          <ViewHeading
            title={isWithdrawnTab ? 'ผู้สมัครที่ยกเลิกเอง' : 'ใบสมัครและสลิป'}
            sub={
              isWithdrawnTab
                ? 'รายชื่อที่ยกเลิกใบสมัครด้วยตนเอง (อ่านอย่างเดียว ลบถาวรได้ทีละรายการ)'
                : 'ตรวจสลิป เปลี่ยนสถานะ แก้ไขข้อมูล และส่งออก CSV'
            }
          />
          <section aria-busy={isWithdrawnTab ? withdrawnLoading : busy}>
            {/* Queue chips, search and the column header stay in reach while scrolling the list (md and up). */}
            <div
              ref={toolbarRef}
              className="z-20 md:sticky"
              style={{ top: 'var(--admin-nav-h, 0px)', backgroundColor: BG_CANVAS }}
            >
              {/* Phones: one select instead of a second horizontal scroller */}
              <div hidden={isWithdrawnTab} className="relative border-b py-3 md:hidden" style={{ borderColor: INK }}>
                <label htmlFor="status-filter-select" className="sr-only">
                  กรองตามสถานะ
                </label>
                <select
                  id="status-filter-select"
                  value={filter}
                  onChange={(e) => {
                    resetDeleteConfirm(false);
                    setFilter(e.target.value as FilterKey);
                  }}
                  className={`min-h-11 w-full cursor-pointer appearance-none rounded-full border bg-[var(--bg-card)] py-2 pl-4 pr-10 text-sm font-semibold ${FOCUS}`}
                  style={{ borderColor: INPUT_BORDER, color: INK, colorScheme: 'inherit' }}
                >
                  {visibleTabs.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label} ({t.n}){t.key === 'AWAITING_PAY' && overduePayCount > 0 ? ` · เกินกำหนด ${overduePayCount}` : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  strokeWidth={1.5}
                  size={16}
                  className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: INK_3 }}
                />
              </div>
              <AdminFilterTabs
                tabs={visibleTabs}
                active={filter}
                onSelect={(k) => {
                  resetDeleteConfirm(false);
                  setFilter(k);
                }}
                slipKey="SLIP_PENDING"
                awaitKey="AWAITING_PAY"
                overduePayCount={overduePayCount}
                hidden={isWithdrawnTab}
                groupRef={filterGroupRef}
              />

              {/* Search, sort, count and export */}
              <div className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center lg:flex-1">
                  <VanishSearchInput
                    id="applicant-search"
                    label={isWithdrawnTab ? 'ค้นหาผู้สมัครที่ยกเลิกเอง' : 'ค้นหาผู้สมัคร'}
                    value={query}
                    onChange={setQuery}
                    placeholders={isWithdrawnTab ? WITHDRAWN_SEARCH_HINTS : SEARCH_HINTS}
                    className="w-full sm:max-w-md"
                    inputClassName={`${INPUT_BASE} min-h-11 rounded-full py-2 pl-10`}
                    style={{ borderColor: INPUT_BORDER, color: INK }}
                  />

                  {!isWithdrawnTab && (
                    <div className="relative w-full sm:w-auto sm:min-w-[14.5rem]">
                      <label htmlFor="applicant-sort" className="sr-only">
                        เรียงลำดับรายการ
                      </label>
                      <select
                        id="applicant-sort"
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as SortKey)}
                        className={`min-h-11 w-full cursor-pointer appearance-none rounded-full border bg-[var(--bg-card)] py-2 pl-4 pr-10 text-sm font-medium ${FOCUS}`}
                        style={{ borderColor: INPUT_BORDER, color: INK, colorScheme: 'inherit' }}
                      >
                        <option value="newest">เรียง: สมัครล่าสุดก่อน</option>
                        <option value="slip_queue">เรียง: ส่งสลิปก่อน–หลัง / คิวตรวจ</option>
                        <option value="updated_desc">เรียง: อัปเดตล่าสุดก่อน</option>
                      </select>
                      <ChevronDown
                        aria-hidden="true"
                        strokeWidth={1.5}
                        size={16}
                        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2"
                        style={{ color: INK_3 }}
                      />
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-start">
                  <p role="status" aria-live="polite" className="text-sm tabular-nums" style={{ color: INK_2 }}>
                    {countLabel}
                  </p>
                  {!isWithdrawnTab && can.exportCsv && (
                    <StatefulButton
                      onClick={() => void exportCsv()}
                      disabled={visible.length === 0}
                      busy={exporting}
                      busyLabel="กำลังส่งออก…"
                      doneSignal={exportDone}
                      doneLabel="ส่งออกแล้ว"
                      icon={<Download aria-hidden="true" strokeWidth={1.5} size={16} />}
                      className={pillGhost}
                      style={{ borderColor: RULE, color: INK }}
                    >
                      ส่งออก CSV
                    </StatefulButton>
                  )}
                </div>
              </div>

              {!isWithdrawnTab && visible.length > 0 && (
                <div
                  aria-hidden="true"
                  className={`hidden rounded-t-[24px] border px-5 py-2.5 text-xs font-semibold lg:grid lg:items-center lg:gap-3 xl:gap-4 ${ROW_GRID}`}
                  style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE, color: INK_3 }}
                >
                  <span>รหัส / วันที่สมัคร</span>
                  <span>ผู้สมัคร</span>
                  <span>โรงเรียน</span>
                  <span>หลักฐานการโอน</span>
                  <span>สถานะใบสมัคร</span>
                  <span className="lg:text-right">การจัดการ</span>
                </div>
              )}

              {isWithdrawnTab && !withdrawnError && visibleWithdrawn.length > 0 && (
                <div
                  aria-hidden="true"
                  className={`hidden rounded-t-[24px] border px-5 py-2.5 text-xs font-semibold whitespace-nowrap lg:grid lg:items-center lg:gap-3 xl:gap-4 ${WITHDRAWN_GRID}`}
                  style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE, color: INK_3 }}
                >
                  <span>รหัส</span>
                  <span>ผู้สมัคร</span>
                  <span>โรงเรียน</span>
                  <span>สถานะก่อนยกเลิก</span>
                  <span className="whitespace-nowrap">สมัคร → ยกเลิก</span>
                  <span>เหตุผล</span>
                  <span className="sr-only">จัดการ</span>
                </div>
              )}
            </div>

            {/* Applications */}
            {!isWithdrawnTab && visible.length > 0 && (
              <div
                className="overflow-hidden rounded-[24px] border lg:rounded-t-none lg:border-t-0"
                style={{ borderColor: RULE, backgroundColor: BG_CARD }}
              >
                <ul ref={listRef} tabIndex={-1} className={`rounded-xl ${FOCUS}`}>
                  {visible.map((a) => {
                    const slip = hasSlip(a);
                    const open = inspectingId === a.id;
                    const detailOpen = detailId === a.id;
                    const editing = editingId === a.id;
                    const pendingChange = pendingStatus?.appId === a.id ? pendingStatus : null;
                    const risky = pendingChange ? isRiskyTransition(pendingChange.from, pendingChange.to) : false;
                    // Only FORFEITED → PASSED reopens a payment window; → CONFIRMED gets the skip-slip-review warning instead.
                    const restoringForfeited = pendingChange
                      ? pendingChange.from === 'FORFEITED' && pendingChange.to === 'PASSED'
                      : false;
                    // The seat-retaking change on this row just failed with QUOTA_FULL: offer the audited over-capacity restore.
                    const overCapOffered = Boolean(
                      can.changeStatus &&
                        pendingChange &&
                        quotaFull &&
                        quotaFull.appId === a.id &&
                        quotaFull.from === pendingChange.from &&
                        quotaFull.to === pendingChange.to &&
                        a.status === quotaFull.from,
                    );
                    const overCapShown = overCapOffered && overCapOpen;
                    const deleteStep = deleteConfirm?.appId === a.id ? deleteConfirm.step : 0;
                    // REJECTED / REFUND_PENDING / REFUNDED: the slip stays viewable but cannot be settled.
                    const slipLocked = !holdsSeat(a.status);
                    const slipPending = (a.slipStatus ?? 'PENDING') === 'PENDING';
                    const slipIdx = visibleWithSlip.findIndex((x) => x.id === a.id);
                    const prevSlipApp = slipIdx > 0 ? visibleWithSlip[slipIdx - 1] : null;
                    const nextSlipApp =
                      slipIdx >= 0 && slipIdx < visibleWithSlip.length - 1 ? visibleWithSlip[slipIdx + 1] : null;
                    const nextPendingInView = findNextPendingSlip(a.id, visible);
                    const nextPendingGlobal = nextPendingInView ? null : findNextPendingSlip(a.id, sorted);
                    const rawLocalVerdict = localSlipVerdicts[a.id];
                    const localVerdict =
                      rawLocalVerdict &&
                      (!rawLocalVerdict.paymentId || !a.slipPaymentId || rawLocalVerdict.paymentId === a.slipPaymentId)
                        ? rawLocalVerdict
                        : undefined;
                    const persistedNote =
                      a.slipStatus === 'REJECTED'
                        ? (a.rejectionReason?.trim() || a.adminNote?.trim() || null)
                        : (a.adminNote?.trim() || null);
                    const savedNote = localVerdict?.note?.trim() || persistedNote;
                    const savedVerifiedAt = localVerdict?.verifiedAt || a.verifiedAt || null;
                    const allergyText = a.allergies?.trim();
                    const medicalText = a.medicalConditions?.trim();
                    const showAllergy = Boolean(allergyText) && isMeaningfulNote(allergyText);
                    const showMedical = Boolean(medicalText) && isMeaningfulNote(medicalText);
                    // Any panel open under the row lifts it out of the ledger as a raised card.
                    const rowExpanded = Boolean(pendingChange) || detailOpen || editing || (open && can.viewSlip);

                    return (
                      <li
                        key={a.id}
                        className={`border-b bg-[var(--bg-card)] transition-[margin,border-radius,box-shadow] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] last:border-b-0 motion-reduce:transition-none ${
                          rowExpanded ? 'relative z-[1] mx-1.5 my-2 overflow-hidden rounded-[24px] border-b-0 [box-shadow:var(--shadow-float)] sm:mx-2' : ''
                        }`}
                        style={{ borderColor: RULE }}
                      >
                        <div className={`flex flex-col gap-3 px-5 py-3.5 lg:grid lg:items-center lg:gap-3 xl:gap-4 ${ROW_GRID}`}>
                          {/* Col 1: ID + createdAt */}
                          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 lg:block">
                            <span
                              className="inline-block rounded-full border px-2 py-0.5 font-mono text-xs font-semibold tabular-nums"
                              style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE, color: INK }}
                            >
                              {a.id}
                            </span>
                            <p className="text-xs leading-5 lg:mt-1.5" style={{ color: INK_3 }}>
                              {formatBangkokDateTime(a.createdAt)}
                            </p>
                          </div>

                          {/* Col 2: Name, phone, health flags (email and parent contact live in the details) */}
                          <div className="min-w-0">
                            <p className="break-words text-sm font-semibold leading-6" style={{ color: INK }}>
                              {a.prefix}{a.fullName}
                              {a.nickname ? (
                                <span className="font-normal" style={{ color: INK_3 }}>
                                  {' '}
                                  ({a.nickname})
                                </span>
                              ) : null}
                            </p>
                            <p className="mt-0.5 font-mono text-xs leading-5 tabular-nums" style={{ color: INK_2 }}>
                              {a.phone}
                            </p>
                            {(showAllergy || showMedical) && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {showAllergy && (
                                  <span
                                    className="inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4"
                                    style={{ borderColor: WARNING, color: AMBER_TEXT, backgroundColor: SURFACE_SUBTLE }}
                                    title={`แพ้อาหาร: ${allergyText}`}
                                  >
                                    <span className="truncate">แพ้อาหาร: {allergyText}</span>
                                  </span>
                                )}
                                {showMedical && (
                                  <span
                                    className="inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4"
                                    style={{ borderColor: TECH, color: INK, backgroundColor: SURFACE_SUBTLE }}
                                    title={`โรคประจำตัว: ${medicalText}`}
                                  >
                                    <span className="truncate">โรคประจำตัว: {medicalText}</span>
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Col 3: School, grade, province, shirt size */}
                          <div className="min-w-0 text-sm leading-6" style={{ color: INK_2 }}>
                            <p className="break-words font-medium" style={{ color: INK }}>
                              {a.school}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs leading-5" style={{ color: INK_3 }}>
                              <span>
                                {a.grade}
                                {a.province ? ` · ${a.province}` : ''}
                              </span>
                              <span
                                className="inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold leading-4"
                                style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE, color: INK }}
                              >
                                เสื้อ {a.shirtSize}
                              </span>
                            </div>
                          </div>

                          {/* Col 4: Slip badge + verify/inspect button */}
                          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:flex-col lg:items-start lg:gap-1.5">
                            <SlipBadge app={a} nowMs={nowMs} />
                            {slip && can.viewSlip && (
                              <button
                                id={`slip-btn-${a.id}`}
                                type="button"
                                aria-expanded={open}
                                onClick={() => openSlip(a)}
                                className={`inline-flex min-h-10 items-center rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-[opacity,background-color] lg:min-h-9 ${slipPending && !open ? 'hover:opacity-90' : 'hover:bg-[var(--color-btn-ghost-hover)]'} ${FOCUS}`}
                                style={
                                  slipPending && !open
                                    ? { borderColor: AMBER_TEXT, backgroundColor: AMBER_TEXT, color: AMBER_ON }
                                    : { borderColor: open ? TECH : RULE, backgroundColor: open ? SURFACE_SUBTLE : BG_CARD, color: TECH }
                                }
                              >
                                {open ? 'ซ่อนสลิป' : slipPending ? 'ตรวจสลิป' : 'ดู/แก้ผลสลิป'}
                              </button>
                            )}
                          </div>

                          {/* Col 5 + 6: status and row actions wrap cleanly on small screens */}
                          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:contents">
                          <div className="min-w-0 flex-1 basis-40">
                            {can.changeStatus ? (
                              <div className="flex flex-col items-start gap-1.5">
                                <StatusSelect
                                  app={a}
                                  value={pendingChange?.to ?? a.status}
                                  pending={Boolean(pendingChange)}
                                  disabled={patching === a.id || deletingId === a.id}
                                  onChange={(status) => requestStatusChange(a, status)}
                                />
                                {a.status === 'FORFEITED' && (
                                  <button
                                    type="button"
                                    disabled={patching === a.id || deletingId === a.id}
                                    aria-pressed={pendingChange?.from === 'FORFEITED' && pendingChange?.to === 'PASSED'}
                                    onClick={() => requestStatusChange(a, 'PASSED')}
                                    className={`gap-1.5 ${pillGhost}`}
                                    style={{ borderColor: RULE, color: INK }}
                                  >
                                    <RotateCcw aria-hidden="true" size={16} strokeWidth={1.5} />
                                    กู้สิทธิ์
                                  </button>
                                )}
                              </div>
                            ) : (
                              <p
                                className="inline-flex min-h-10 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium leading-6 lg:min-h-9"
                                style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE, color: INK }}
                              >
                                <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS_DOT[a.status] }} />
                                {STATUS_LABELS[a.status]}
                              </p>
                            )}
                          </div>

                          <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:justify-end">
                            <button
                              id={`detail-btn-${a.id}`}
                              type="button"
                              aria-expanded={detailOpen}
                              onClick={() => toggleDetail(a)}
                              className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full border px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] sm:px-3 lg:min-h-9 ${FOCUS}`}
                              style={{
                                borderColor: detailOpen ? INK : RULE,
                                backgroundColor: detailOpen ? SURFACE_SUBTLE : BG_CARD,
                                color: detailOpen ? INK : INK_2,
                              }}
                            >
                              <Eye size={14} strokeWidth={1.5} aria-hidden="true" />
                              <span className="sr-only sm:not-sr-only">{detailOpen ? 'ซ่อนรายละเอียด' : 'รายละเอียด'}</span>
                            </button>
                            {can.editProfile && (
                              <button
                                id={`edit-btn-${a.id}`}
                                type="button"
                                aria-expanded={editing}
                                onClick={() => toggleEdit(a)}
                                className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full border px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] sm:px-3 lg:min-h-9 ${FOCUS}`}
                                style={{
                                  borderColor: editing ? TECH : RULE,
                                  backgroundColor: editing ? SURFACE_SUBTLE : BG_CARD,
                                  color: TECH,
                                }}
                              >
                                <Pencil size={13} strokeWidth={1.5} aria-hidden="true" />
                                <span className="sr-only sm:not-sr-only">{editing ? 'ซ่อนการแก้ไข' : 'แก้ไข'}</span>
                              </button>
                            )}
                          </div>
                          </div>
                        </div>

                    {/* Every status change waits for a confirm: picking a value only proposes it. */}
                    {pendingChange && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={EXPAND}
                        role="region"
                        aria-label={`ยืนยันการเปลี่ยนสถานะ ${a.id}`}
                        className="border-t px-5 py-4"
                        style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE }}
                      >
                        <p className="text-sm font-semibold leading-7" style={{ color: INK }}>
                          เปลี่ยนสถานะ {a.fullName} จาก “{STATUS_LABELS[pendingChange.from]}” เป็น “{STATUS_LABELS[pendingChange.to]}”
                        </p>
                        {restoringForfeited && (
                          <p className="mt-0.5 text-sm font-medium leading-7" style={{ color: AMBER_TEXT }}>
                            กู้สิทธิ์จะคืนที่นั่งให้ผู้สมัครคนนี้ (ถ้ายังมีที่นั่งว่าง) และให้เวลาชำระเงินอีกอย่างน้อย{' '}
                            <span className="font-mono tabular-nums">24</span> ชั่วโมงนับจากตอนนี้ หากยังไม่ส่งสลิปภายในกำหนด ระบบจะตัดสิทธิ์อัตโนมัติอีกครั้ง
                          </p>
                        )}
                        {(!restoringForfeited || risky) && (
                          <p className="mt-0.5 text-sm leading-7" style={{ color: risky ? DANGER : INK_2 }}>
                            {!risky
                              ? 'ระบบจะบันทึกการเปลี่ยนแปลงนี้ในประวัติพร้อมเหตุผล (ถ้ามี)'
                              : !holdsSeat(pendingChange.to)
                                ? 'การเปลี่ยนเป็นสถานะนี้จะคืนที่นั่งทันที และอาจคืนกลับมาไม่ได้หากโควตาเต็มแล้ว'
                                : pendingChange.to === 'CONFIRMED'
                                  ? 'การเปลี่ยนเป็น “ยืนยันสิทธิ์สมบูรณ์” ด้วยตนเองจะข้ามขั้นตอนตรวจสลิป (ควรใช้เมื่อตรวจสอบการชำระเงินเรียบร้อยแล้ว)'
                                  : 'การเปลี่ยนสถานะออกจาก “ยืนยันสิทธิ์สมบูรณ์” อาจต้องตรวจสอบหลักฐานการชำระเงินใหม่'}
                            {a.slipStatus === 'APPROVED' && pendingChange.to === 'REJECTED'
                              ? ' (ผู้สมัครมีสลิปที่อนุมัติแล้ว หากต้องคืนเงินแนะนำให้เลือก “รอคืนเงิน”)'
                              : ''}
                          </p>
                        )}
                        {!overCapShown && (
                        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                          <label htmlFor={`status-reason-${a.id}`} className="sr-only">
                            เหตุผลการเปลี่ยนสถานะ (ไม่บังคับ)
                          </label>
                          <input
                            id={`status-reason-${a.id}`}
                            type="text"
                            maxLength={500}
                            value={statusReason}
                            onChange={(e) => setStatusReason(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && patching !== a.id) {
                                e.preventDefault();
                                void onStatus(a.id, pendingChange.to, statusReason.trim() || undefined);
                              }
                            }}
                            placeholder="เหตุผลในการเปลี่ยนสถานะ (ไม่บังคับ)"
                            className={`${inputCls} sm:max-w-sm`}
                            style={{ borderColor: INPUT_BORDER, color: INK }}
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <StatefulButton
                              busy={patching === a.id}
                              busyLabel="กำลังบันทึก…"
                              onClick={() => void onStatus(a.id, pendingChange.to, statusReason.trim() || undefined)}
                              className={`min-h-11 rounded-full border px-5 py-2 text-sm font-semibold transition-[opacity,background-color] disabled:opacity-50 ${risky ? 'hover:bg-[var(--color-btn-ghost-hover)]' : 'hover:opacity-90'} ${FOCUS}`}
                              style={risky ? { borderColor: DANGER, color: DANGER } : { borderColor: BTN_DARK, backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                            >
                              ยืนยันเปลี่ยนสถานะ
                            </StatefulButton>
                            {overCapOffered && (
                              <button
                                type="button"
                                disabled={patching === a.id}
                                onClick={openOverCapacity}
                                className={PILL_DANGER}
                                style={{ borderColor: DANGER, color: DANGER }}
                              >
                                <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="shrink-0" />
                                รับกลับ (เกินโควตา)
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={patching === a.id}
                              onClick={cancelPendingStatus}
                              className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                              style={{ color: INK_2 }}
                            >
                              ยกเลิก
                            </button>
                          </div>
                        </div>
                        )}

                        {/* Over-capacity restore: explicit, reason required, audited by the server. */}
                        {overCapShown && (
                          <div
                            id={`overcap-${a.id}`}
                            className="mt-3 border-t pt-3"
                            style={{ borderColor: DANGER }}
                          >
                            <p
                              role="alert"
                              className="flex items-start gap-1.5 text-sm font-semibold leading-7"
                              style={{ color: DANGER }}
                            >
                              <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1.5 shrink-0" />
                              <span>
                                ที่นั่งเต็มแล้ว การรับกลับจะทำให้จำนวนผู้ถือที่นั่งเกินโควตา
                                {maxCapacity !== null && (
                                  <>
                                    {' '}(เป็น <span className="font-mono tabular-nums">{currentCount + 1}</span> จาก{' '}
                                    <span className="font-mono tabular-nums">{maxCapacity}</span>)
                                  </>
                                )}{' '}
                                และจะถูกบันทึกใน audit
                              </span>
                            </p>
                            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                              <label htmlFor={`overcap-reason-${a.id}`} className="sr-only">
                                เหตุผลการรับกลับเกินโควตา (จำเป็น)
                              </label>
                              <input
                                id={`overcap-reason-${a.id}`}
                                type="text"
                                aria-required="true"
                                maxLength={500}
                                value={overCapReason}
                                onChange={(e) => setOverCapReason(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && patching !== a.id && overCapReason.trim()) {
                                    e.preventDefault();
                                    void onStatus(a.id, pendingChange.to, overCapReason.trim(), true);
                                  }
                                }}
                                placeholder="เหตุผลการรับกลับเกินโควตา (จำเป็น)"
                                className={`${inputCls} sm:max-w-sm`}
                                style={{ borderColor: DANGER, color: INK }}
                              />
                              <div className="flex flex-wrap items-center gap-2">
                                <StatefulButton
                                  disabled={!overCapReason.trim()}
                                  busy={patching === a.id}
                                  busyLabel="กำลังบันทึก…"
                                  onClick={() => void onStatus(a.id, pendingChange.to, overCapReason.trim(), true)}
                                  className={`min-h-11 rounded-full border px-5 py-2 text-sm font-semibold transition-[opacity,background-color] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] disabled:opacity-50 ${FOCUS}`}
                                  style={{ borderColor: DANGER, color: DANGER }}
                                >
                                  ยืนยันรับกลับเกินโควตา
                                </StatefulButton>
                                <button
                                  type="button"
                                  disabled={patching === a.id}
                                  onClick={cancelPendingStatus}
                                  className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                                  style={{ color: INK_2 }}
                                >
                                  ยกเลิก
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </motion.div>
                    )}

                    {/* Applicant details: expands under its own row */}
                    {detailOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={EXPAND}
                        className="border-t px-5 py-6"
                        style={{ borderColor: RULE }}
                        role="region"
                        aria-label={`รายละเอียดใบสมัคร ${a.id}`}
                      >
                        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>การยืนยันสิทธิ์เข้าร่วมค่าย</p>
                            <p className="mt-1 text-sm" style={{ color: INK }}>
                              {a.attendanceConfirmed ? 'ยืนยันสิทธิ์แล้ว' : 'ยังไม่ยืนยันสิทธิ์'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>สถานะหลักฐานการโอนเงิน</p>
                            <p className="mt-1 text-sm" style={{ color: INK }}>
                              {slipLabel(a)}
                            </p>
                            {(a.slipStatus === 'APPROVED' || a.slipStatus === 'REJECTED') && (savedNote || savedVerifiedAt) && (
                              <p className="mt-1 break-words text-xs leading-5" style={{ color: INK_3 }}>
                                {savedNote ? `หมายเหตุ: ${savedNote}` : ''}
                                {savedNote && savedVerifiedAt ? ' · ' : ''}
                                {savedVerifiedAt ? `ตรวจเมื่อ ${formatBangkokDateTime(savedVerifiedAt)}` : ''}
                              </p>
                            )}
                          </div>
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>อีเมล</p>
                            <p className="mt-1 break-all text-sm" style={{ color: INK }}>
                              {a.email || '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>ผู้ปกครอง / เบอร์ติดต่อ</p>
                            <p className="mt-1 break-words text-sm" style={{ color: INK }}>
                              {a.parentName || '—'}
                              {a.parentRelation ? ` (${a.parentRelation})` : ''}
                            </p>
                            <p className="mt-0.5 font-mono text-sm tabular-nums" style={{ color: INK_2 }}>
                              {a.parentPhone || '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>วันที่สมัคร</p>
                            <p className="mt-1 text-sm" style={{ color: INK }}>
                              {formatBangkokDateTime(a.createdAt)}
                            </p>
                          </div>
                          {a.updatedAt && (
                            <div>
                              <p className="text-xs font-semibold" style={{ color: INK_3 }}>อัปเดตล่าสุด</p>
                              <p className="mt-1 text-sm" style={{ color: INK }}>
                                {formatBangkokDateTime(a.updatedAt)}
                              </p>
                            </div>
                          )}
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>การแพ้อาหาร</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-7" style={{ color: INK }}>
                              {a.allergies?.trim() ? a.allergies : '— ไม่มี / ไม่ได้ระบุ —'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>โรคประจำตัว</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-7" style={{ color: INK }}>
                              {a.medicalConditions?.trim() ? a.medicalConditions : '— ไม่มี / ไม่ได้ระบุ —'}
                            </p>
                          </div>
                          <div className="sm:col-span-2 lg:col-span-3">
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>รู้จักค่ายจาก</p>
                            <p className="mt-1 break-words text-sm leading-7" style={{ color: INK }}>
                              {formatReferralLabels(a.referralSources, a.referralOther)}
                            </p>
                          </div>
                          <div className="sm:col-span-2 lg:col-span-3">
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>เหตุผลการสมัคร / แรงบันดาลใจ</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-7" style={{ color: INK_2 }}>
                              {a.motivation?.trim() ? a.motivation : '— ไม่ได้ระบุ —'}
                            </p>
                          </div>
                        </div>
                        <div className="mt-6 flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={() => setDetailId(null)}
                            className={`inline-flex min-h-11 items-center justify-center rounded-full border px-6 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                            style={{ borderColor: RULE, color: INK }}
                          >
                            ปิด
                          </button>
                        </div>
                        {can.deleteApplication && (
                          <div className="mt-6 border-t pt-4" style={{ borderColor: RULE }}>
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <p className="text-sm leading-7" style={{ color: INK_2 }}>
                                ลบใบสมัครถาวร คืนที่นั่งและเบอร์/อีเมลให้สมัครใหม่ได้
                              </p>
                              <button
                                id={`delete-btn-${a.id}`}
                                type="button"
                                disabled={deletingId === a.id}
                                aria-busy={deletingId === a.id || undefined}
                                aria-expanded={deleteStep > 0}
                                aria-controls={deleteStep > 0 ? `delete-strip-${a.id}` : undefined}
                                aria-label={
                                  deleteStep === 0 && deletingId !== a.id
                                    ? `ลบใบสมัคร ${a.id} (${a.fullName})`
                                    : undefined
                                }
                                onClick={() => onDeleteButtonClick(a)}
                                className={`max-w-full text-left ${PILL_DANGER}`}
                                style={{
                                  borderColor: DANGER,
                                  color: DANGER,
                                  backgroundColor:
                                    deleteStep > 0
                                      ? 'color-mix(in srgb, var(--color-danger) 10%, transparent)'
                                      : undefined,
                                }}
                              >
                                <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
                                <span className="min-w-0 break-words">
                                  {deletingId === a.id
                                    ? 'กำลังลบ…'
                                    : deleteStep === 1
                                      ? 'ยืนยันลบ? (1/3)'
                                      : deleteStep === 2
                                        ? 'แน่ใจหรือไม่? (2/3)'
                                        : deleteStep === 3
                                          ? `ลบ ${a.fullName} ถาวร (3/3)`
                                          : 'ลบ'}
                                </span>
                              </button>
                            </div>
                            {deleteStep > 0 && (
                              <div
                                id={`delete-strip-${a.id}`}
                                role="region"
                                aria-label={`ยืนยันการลบ ${a.id}`}
                                className="mt-4 border-t pt-4"
                                style={{ borderColor: DANGER }}
                              >
                                <p aria-live="polite" className="text-sm font-semibold leading-7" style={{ color: DANGER }}>
                                  ขั้นตอน <span className="font-mono tabular-nums">{deleteStep}/3</span> · ลบใบสมัคร{' '}
                                  <span className="font-mono tabular-nums">{a.id}</span> ({a.fullName})
                                </p>
                                <p className="mt-0.5 text-sm leading-7" style={{ color: INK_2 }}>
                                  การลบจะคืนที่นั่งและปล่อยเบอร์โทรและอีเมลให้สมัครใหม่ได้
                                  {(slip || a.status === 'CONFIRMED') &&
                                    ' — หมายเหตุ: ใบสมัครนี้มีข้อมูลสลิป/การยืนยันสิทธิ์ หากจ่ายเงินแล้วให้ใช้สถานะ “รอคืนเงิน” แทนเพื่อไม่ให้หายจากบัญชี'}
                                </p>
                                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                                  <label htmlFor={`delete-reason-${a.id}`} className="sr-only">
                                    เหตุผลการลบ (ไม่บังคับ)
                                  </label>
                                  <input
                                    id={`delete-reason-${a.id}`}
                                    type="text"
                                    maxLength={500}
                                    disabled={deletingId === a.id}
                                    value={deleteReason}
                                    onChange={(e) => setDeleteReason(e.target.value)}
                                    placeholder="เหตุผลการลบ (ไม่บังคับ เช่น ข้อมูลซ้ำ/ผู้สมัครขอยกเลิก)"
                                    className={`${inputCls} sm:max-w-sm`}
                                    style={{ borderColor: INPUT_BORDER, color: INK }}
                                  />
                                  <button
                                    type="button"
                                    disabled={deletingId === a.id}
                                    onClick={() => resetDeleteConfirm(true)}
                                    className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                                    style={{ color: INK_2 }}
                                  >
                                    ยกเลิก
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </motion.div>
                    )}

                    {/* Profile editor: expands under its own row */}
                    {editing && token && can.editProfile && (
                      <motion.div className="px-5" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={EXPAND}>
                        <AdminProfileEditor
                          key={a.id}
                          app={a}
                          token={token}
                          onSaved={onProfileSaved}
                          onClose={() => {
                            setEditingDirty(false);
                            setEditingId(null);
                          }}
                          onAuthError={handleAuthError}
                          onDirtyChange={setEditingDirty}
                        />
                      </motion.div>
                    )}

                    {/* Slip review: expands under its own row */}
                    {open && can.viewSlip && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={EXPAND}
                        ref={slipPanelRef}
                        tabIndex={-1}
                        className={`grid gap-8 border-t px-5 py-6 md:grid-cols-[minmax(0,22rem)_1fr] ${FOCUS}`}
                        style={{ borderColor: RULE }}
                        role="region"
                        aria-label={`ตรวจสอบหลักฐานการชำระเงิน ${a.id}`}
                      >
                        <div>
                          <div
                            className="flex min-h-48 items-center justify-center overflow-hidden rounded-xl border"
                            style={{ backgroundColor: SURFACE_SUBTLE, borderColor: RULE }}
                          >
                            {slipImage.url ? (
                              <button
                                type="button"
                                onClick={() => setLightboxOpen(true)}
                                aria-label={`ขยายดูรูปสลิปของ ${a.id}`}
                                className={`group relative w-full cursor-zoom-in ${FOCUS}`}
                              >
                                <img
                                  src={slipImage.url}
                                  alt={`สลิปโอนเงินของ ${a.id}`}
                                  onError={() =>
                                    setSlipImage((prev) => ({
                                      ...prev,
                                      url: null,
                                      error: 'ไม่สามารถแสดงรูปสลิปได้ กรุณาลองโหลดใหม่',
                                      loading: false,
                                    }))
                                  }
                                  className="max-h-[28rem] w-full object-contain"
                                />
                              </button>
                            ) : slipImage.error ? (
                              <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                                <p className="text-sm leading-6" role="alert" style={{ color: DANGER }}>
                                  {slipImage.error}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => setSlipRetryNonce((n) => n + 1)}
                                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                                  style={{ borderColor: RULE, color: INK }}
                                >
                                  <RotateCcw aria-hidden="true" size={15} strokeWidth={1.75} />
                                  ลองโหลดใหม่
                                </button>
                              </div>
                            ) : (
                              <p className="px-4 py-10 text-center text-sm leading-7" style={{ color: INK_3 }}>
                                {slipImage.loading ? 'กำลังโหลดรูปสลิป…' : 'กำลังเตรียมรูปสลิป…'}
                              </p>
                            )}
                          </div>
                          {slipImage.url && (
                            <button
                              type="button"
                              onClick={() => setLightboxOpen(true)}
                              className={`mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl py-2 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
                              style={{ color: TECH }}
                            >
                              <Maximize2 aria-hidden="true" size={15} strokeWidth={1.75} />
                              เปิดรูปเต็มจอ
                            </button>
                          )}
                        </div>

                        <div className="flex min-w-0 flex-col">
                          {/* Header + Prev/Next triage navigation */}
                          <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: RULE }}>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                              <h2 className="text-lg font-bold leading-[1.35]" style={{ color: INK }}>
                                หลักฐานการชำระเงิน
                              </h2>
                              <SlipBadge app={a} nowMs={nowMs} />
                              {slipIdx >= 0 && (
                                <span className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                                  สลิป {slipIdx + 1}/{visibleWithSlip.length}
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                disabled={!prevSlipApp || verifying}
                                onClick={() => prevSlipApp && switchToSlipApplicant(prevSlipApp)}
                                className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-40 ${FOCUS}`}
                                style={{ borderColor: RULE, color: INK }}
                              >
                                <ChevronLeft aria-hidden="true" size={15} strokeWidth={1.75} />
                                คนก่อนหน้า
                              </button>
                              <button
                                type="button"
                                disabled={!nextSlipApp || verifying}
                                onClick={() => nextSlipApp && switchToSlipApplicant(nextSlipApp)}
                                className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-40 ${FOCUS}`}
                                style={{ borderColor: RULE, color: INK }}
                              >
                                คนถัดไป
                                <ChevronRight aria-hidden="true" size={15} strokeWidth={1.75} />
                              </button>
                              {(nextPendingInView || nextPendingGlobal) && (
                                <button
                                  type="button"
                                  disabled={verifying}
                                  onClick={() => {
                                    if (nextPendingInView) {
                                      switchToSlipApplicant(nextPendingInView);
                                    } else if (nextPendingGlobal) {
                                      switchToSlipApplicant(nextPendingGlobal, true);
                                    }
                                  }}
                                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-40 ${FOCUS}`}
                                  style={{ borderColor: WARNING, color: WARNING }}
                                >
                                  สลิปรอตรวจถัดไป
                                  <ChevronRight aria-hidden="true" size={14} strokeWidth={1.75} />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Identity cross-check summary alongside the slip */}
                          <dl
                            className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2.5 rounded-xl border p-3.5 text-sm sm:grid-cols-2"
                            style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE }}
                          >
                            <div className="min-w-0">
                              <dt className="text-xs font-semibold" style={{ color: INK_3 }}>ผู้สมัคร</dt>
                              <dd className="mt-0.5 break-words font-semibold" style={{ color: INK }}>
                                {a.prefix}{a.fullName}
                                {a.nickname ? <span className="font-normal" style={{ color: INK_2 }}> ({a.nickname})</span> : null}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-semibold" style={{ color: INK_3 }}>เบอร์โทรศัพท์</dt>
                              <dd className="mt-0.5 font-mono tabular-nums" style={{ color: INK }}>
                                {a.phone}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-semibold" style={{ color: INK_3 }}>สถานะใบสมัคร / ยืนยันสิทธิ์</dt>
                              <dd className="mt-0.5 flex flex-wrap items-center gap-1.5" style={{ color: INK }}>
                                <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS_DOT[a.status] }} />
                                <span>{STATUS_LABELS[a.status]}</span>
                                <span style={{ color: INK_3 }}>·</span>
                                <span style={{ color: a.attendanceConfirmed ? SUCCESS : INK_2 }}>
                                  {a.attendanceConfirmed ? 'ยืนยันเข้าร่วมแล้ว' : 'ยังไม่ยืนยันเข้าร่วม'}
                                </span>
                              </dd>
                            </div>
                            <div className="min-w-0 sm:col-span-2">
                              <dt className="text-xs font-semibold" style={{ color: INK_3 }}>ผู้ปกครอง / เบอร์ติดต่อ</dt>
                              <dd className="mt-0.5 break-words" style={{ color: INK }}>
                                {a.parentName || '—'}
                                {a.parentRelation ? ` (${a.parentRelation})` : ''}
                                {' · '}
                                <span className="font-mono tabular-nums" style={{ color: INK_2 }}>
                                  {a.parentPhone || '—'}
                                </span>
                              </dd>
                            </div>
                            <div className="sm:col-span-2">
                              <dt className="text-xs font-semibold" style={{ color: INK_3 }}>วันที่สมัคร</dt>
                              <dd className="mt-0.5" style={{ color: INK_2 }}>
                                {formatBangkokDateTime(a.createdAt)}
                                {a.updatedAt ? ` · อัปเดตล่าสุด ${formatBangkokDateTime(a.updatedAt)}` : ''}
                              </dd>
                            </div>
                          </dl>

                          <p className="mt-3 text-sm leading-7" style={{ color: INK_3 }}>
                            {slipLocked
                              ? `ใบสมัครนี้อยู่ในสถานะ “${STATUS_LABELS[a.status]}” จึงอนุมัติหรือปฏิเสธสลิปไม่ได้ ยังดูรูปสลิปเพื่อทำบัญชีได้ตามปกติ`
                              : a.slipStatus === 'APPROVED'
                                ? 'สลิปนี้ได้รับการอนุมัติเรียบร้อยแล้ว (สามารถแก้ไขผลการตรวจหรือเปลี่ยนสถานะได้)'
                                : a.slipStatus === 'REJECTED'
                                  ? 'สลิปนี้ถูกปฏิเสธแล้ว รอผู้สมัครอัปโหลดสลิปใหม่ (หรือแก้ไขผลการตรวจได้)'
                                  : 'อนุมัติแล้วสถานะจะเป็นยืนยันสิทธิ์สมบูรณ์ ปฏิเสธแล้วจะกลับเป็นได้รับสิทธิ์เพื่อให้ส่งสลิปใหม่'}
                          </p>

                          {/* Already-reviewed slip note & verification timestamp */}
                          {(a.slipStatus === 'APPROVED' || a.slipStatus === 'REJECTED') && (
                            <div
                              className="mt-4 rounded-xl border p-3.5 text-sm"
                              style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE }}
                            >
                              <p className="font-semibold" style={{ color: INK }}>
                                ผลการตรวจสลิป: {SLIP_LABELS[a.slipStatus]}
                              </p>
                              <p className="mt-1 break-words leading-6" style={{ color: INK_2 }}>
                                หมายเหตุ / เหตุผล:{' '}
                                {savedNote
                                  ? savedNote
                                  : 'บันทึกผลตรวจในระบบแล้ว (ดูหมายเหตุย้อนหลังได้ในประวัติการตรวจสอบของระบบ)'}
                              </p>
                              <p className="mt-1 text-xs leading-5" style={{ color: INK_3 }}>
                                เวลาที่บันทึกผล: {formatBangkokDateTime(savedVerifiedAt ?? a.updatedAt)}
                              </p>
                              {!slipLocked && can.verifySlip && !editingSlipVerdict && (
                                <div className="mt-3">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setVerificationNote(savedNote ?? '');
                                      setConfirmRejectSlip(false);
                                      setVerifyNoteError(null);
                                      setEditingSlipVerdict(true);
                                    }}
                                    className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                                    style={{ borderColor: RULE, color: INK, backgroundColor: BG_CARD }}
                                  >
                                    <Pencil aria-hidden="true" size={14} strokeWidth={1.75} />
                                    แก้ไขผลการตรวจ / เปลี่ยนสถานะสลิป
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {!slipLocked && (slipPending || editingSlipVerdict) && can.verifySlip && (
                            <>
                              {editingSlipVerdict && (
                                <div
                                  className="mt-5 rounded-xl border px-3.5 py-2.5 text-sm"
                                  style={{ borderColor: TECH, backgroundColor: SURFACE_SUBTLE }}
                                >
                                  <p className="font-semibold" style={{ color: INK }}>
                                    แก้ไขผลการตรวจสลิป
                                  </p>
                                  <p className="mt-0.5 text-xs leading-5" style={{ color: INK_2 }}>
                                    สามารถปรับแก้หมายเหตุหรือเปลี่ยนเป็นอนุมัติ / ปฏิเสธใหม่ได้ทันที ระบบจะอัปเดตสถานะใบสมัครให้อัตโนมัติ
                                  </p>
                                </div>
                              )}
                              <div className="mb-1.5 mt-5 flex items-baseline justify-between gap-2">
                                <label className="text-sm font-semibold" style={{ color: INK }} htmlFor="verify-note">
                                  หมายเหตุเจ้าหน้าที่ (บังคับระบุหากปฏิเสธสลิป)
                                </label>
                                <span className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                                  {verificationNote.length}/{VERIFY_NOTE_MAX}
                                </span>
                              </div>
                              <div className="relative">
                                <input
                                  id="verify-note"
                                  maxLength={VERIFY_NOTE_MAX}
                                  className={`${inputCls} ${verificationNote ? 'pr-12' : ''}`}
                                  style={{
                                    borderColor: verifyNoteError ? DANGER : INPUT_BORDER,
                                    color: INK,
                                  }}
                                  aria-invalid={verifyNoteError ? true : undefined}
                                  aria-describedby={verifyNoteError ? 'verify-note-err' : undefined}
                                  placeholder="ระบุหมายเหตุการตรวจ หรือเลือกข้อความสำเร็จรูปด้านล่าง"
                                  value={verificationNote}
                                  onChange={(e) => {
                                    const next = e.target.value;
                                    setVerificationNote(next);
                                    if (verifyNoteError) setVerifyNoteError(null);
                                    if (confirmRejectSlip && !stripZeroWidth(next).trim()) {
                                      setConfirmRejectSlip(false);
                                    }
                                  }}
                                />
                                {verificationNote && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setVerificationNote('');
                                      setVerifyNoteError(null);
                                      if (confirmRejectSlip) setConfirmRejectSlip(false);
                                    }}
                                    aria-label="ล้างหมายเหตุ"
                                    className={`absolute right-1 top-1/2 inline-flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full ${FOCUS}`}
                                    style={{ color: INK_2 }}
                                  >
                                    <X aria-hidden="true" size={16} strokeWidth={1.5} />
                                  </button>
                                )}
                              </div>
                              {verifyNoteError && (
                                <p
                                  id="verify-note-err"
                                  role="alert"
                                  className="mt-1.5 flex items-start gap-1.5 text-sm leading-6"
                                  style={{ color: DANGER }}
                                >
                                  <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} className="mt-1 shrink-0" />
                                  <span>{verifyNoteError}</span>
                                </p>
                              )}

                              {/* Separated Approve vs Reject preset buttons */}
                              <div className="mt-3 space-y-2.5">
                                <div>
                                  <p className="mb-1.5 text-xs font-semibold" style={{ color: SUCCESS }}>
                                    ข้อความสำเร็จรูป — อนุมัติสลิป
                                  </p>
                                  <div role="group" aria-label="ข้อความสำเร็จรูปสำหรับอนุมัติสลิป" className="flex flex-wrap gap-2">
                                    {approvePresets.map((t) => (
                                      <button
                                        key={t}
                                        type="button"
                                        onClick={() => applyNotePreset(t)}
                                        className={`inline-flex min-h-11 items-center rounded-full border px-3.5 py-2 text-left text-xs leading-5 transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                                        style={{ borderColor: RULE, color: INK_2 }}
                                      >
                                        {t}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <div>
                                  <p className="mb-1.5 text-xs font-semibold" style={{ color: DANGER }}>
                                    ข้อความสำเร็จรูป — ปฏิเสธสลิป
                                  </p>
                                  <div role="group" aria-label="ข้อความสำเร็จรูปสำหรับปฏิเสธสลิป" className="flex flex-wrap gap-2">
                                    {REJECT_NOTE_TEMPLATES.map((t) => (
                                      <button
                                        key={t}
                                        type="button"
                                        onClick={() => applyNotePreset(t)}
                                        className={`inline-flex min-h-11 items-center rounded-full border px-3.5 py-2 text-left text-xs leading-5 transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                                        style={{ borderColor: RULE, color: INK_2 }}
                                      >
                                        {t}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>

                              <label className="mt-4 inline-flex min-h-11 cursor-pointer items-center gap-2.5 text-sm" style={{ color: INK_2 }}>
                                <input
                                  type="checkbox"
                                  checked={autoAdvanceSlip}
                                  onChange={(e) => setAutoAdvanceSlip(e.target.checked)}
                                  className="size-4 accent-[var(--color-tech)]"
                                />
                                <span>เปิดดูสลิปรอตรวจคนถัดไปอัตโนมัติหลังบันทึกผล</span>
                              </label>

                              {/* Step 2 inline confirmation for reject only; approve submits in 1 click */}
                              {confirmRejectSlip ? (
                                <div
                                  role="region"
                                  aria-label="ยืนยันการปฏิเสธสลิป"
                                  className="mt-4 rounded-xl border p-4"
                                  style={{
                                    borderColor: DANGER,
                                    backgroundColor: SURFACE_SUBTLE,
                                  }}
                                >
                                  <p className="text-sm font-semibold leading-6" style={{ color: INK }}>
                                    {`ยืนยันปฏิเสธสลิปของ ${a.id} (${a.fullName})?`}
                                  </p>
                                  <p className="mt-1 text-sm leading-6" style={{ color: INK_2 }}>
                                    สถานะใบสมัครจะกลับเป็น “ได้สิทธิ์แล้ว” เพื่อให้ผู้สมัครอัปโหลดสลิปใหม่
                                    {stripZeroWidth(verificationNote).trim()
                                      ? ` · หมายเหตุ: “${stripZeroWidth(verificationNote).trim()}”`
                                      : ''}
                                  </p>
                                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                                    <StatefulButton
                                      disabled={verifying || !slipReadyToVerify}
                                      busy={verifyingAction === 'reject'}
                                      busyLabel="กำลังปฏิเสธ…"
                                      onClick={() => void handleVerifySlip(false)}
                                      className={`min-h-11 rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                                      style={{ border: `1px solid ${DANGER}`, color: DANGER, backgroundColor: 'transparent' }}
                                    >
                                      ยืนยันปฏิเสธสลิป
                                    </StatefulButton>
                                    <button
                                      type="button"
                                      disabled={verifying}
                                      onClick={() => setConfirmRejectSlip(false)}
                                      className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                                      style={{ color: INK_2 }}
                                    >
                                      ยกเลิก
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
                                  <StatefulButton
                                    disabled={verifying || !slipReadyToVerify}
                                    busy={verifyingAction === 'approve'}
                                    busyLabel="กำลังอนุมัติ…"
                                    onClick={() => void handleVerifySlip(true)}
                                    className={`min-h-11 rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                                    style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                                  >
                                    อนุมัติสลิป
                                  </StatefulButton>
                                  <button
                                    type="button"
                                    disabled={verifying || !slipReadyToVerify}
                                    onClick={initiateSlipReject}
                                    className={`inline-flex min-h-11 items-center justify-center rounded-full border px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                                    style={{ borderColor: DANGER, color: DANGER }}
                                  >
                                    {verifyingAction === 'reject' ? 'กำลังปฏิเสธ…' : 'ปฏิเสธสลิป'}
                                  </button>
                                  {editingSlipVerdict ? (
                                    <button
                                      type="button"
                                      disabled={verifying}
                                      onClick={() => {
                                        setEditingSlipVerdict(false);
                                        setConfirmRejectSlip(false);
                                        setVerifyNoteError(null);
                                        setVerificationNote('');
                                      }}
                                      className={`inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                                      style={{ borderColor: RULE, color: INK }}
                                    >
                                      ยกเลิกการแก้ไขผล
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={verifying}
                                      onClick={() => {
                                        setLightboxOpen(false);
                                        setInspectingId(null);
                                      }}
                                      className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2.5 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                                      style={{ color: INK_2 }}
                                    >
                                      ปิด
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                          {(slipLocked || (!slipPending && !editingSlipVerdict) || !can.verifySlip) && (
                            <div className="mt-6">
                              <button
                                type="button"
                                onClick={() => {
                                  setLightboxOpen(false);
                                  setInspectingId(null);
                                }}
                                className={`inline-flex min-h-11 items-center justify-center rounded-full border px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                                style={{ borderColor: RULE, color: INK }}
                              >
                                ปิด
                              </button>
                            </div>
                          )}
                          <p className="mt-4 text-xs leading-6" style={{ color: INK_3 }}>
                            กด Esc เพื่อปิดหน้าตรวจสลิป
                          </p>
                        </div>
                      </motion.div>
                    )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Read-only withdrawn applicants tab */}
            {isWithdrawnTab && withdrawnError && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2.5 border-y py-4 text-sm leading-7"
                style={{ borderColor: DANGER, color: INK }}
              >
                <TriangleAlert
                  aria-hidden="true"
                  size={18}
                  strokeWidth={1.5}
                  className="mt-1 shrink-0"
                  style={{ color: DANGER }}
                />
                <span>{withdrawnError}</span>
              </div>
            )}

            {isWithdrawnTab && !withdrawnError && visibleWithdrawn.length > 0 && (
              <div
                className="overflow-hidden rounded-[24px] border lg:rounded-t-none lg:border-t-0"
                style={{ borderColor: RULE, backgroundColor: BG_CARD }}
              >
                <ul>
                  {visibleWithdrawn.map((w, i) => {
                    const confirming = purgeConfirmId === w.id;
                    const purging = purgingId === w.id;
                    const nextId = visibleWithdrawn[i + 1]?.id ?? visibleWithdrawn[i - 1]?.id ?? null;
                    return (
                    <li key={`${w.id}-${w.withdrawnAt}`} className="border-b last:border-b-0" style={{ borderColor: RULE }}>
                      <div className={`flex flex-col gap-2 px-5 py-3.5 lg:grid lg:items-center lg:gap-3 xl:gap-4 ${WITHDRAWN_GRID}`}>
                        {/* Col 1: Code */}
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 lg:block">
                          <span
                            className="inline-block rounded-full border px-2 py-0.5 font-mono text-xs font-semibold tabular-nums"
                            style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE, color: INK }}
                          >
                            {w.id}
                          </span>
                          <span
                            className="inline-flex items-center gap-1.5 text-xs font-medium lg:hidden"
                            style={{ color: INK_2 }}
                          >
                            <span
                              aria-hidden="true"
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: STATUS_DOT[w.status] }}
                            />
                            {STATUS_LABELS[w.status]}
                          </span>
                        </div>

                        {/* Col 2: Name (nickname) and phone */}
                        <div className="min-w-0">
                          <p className="break-words text-sm font-semibold leading-6" style={{ color: INK }}>
                            {w.fullName}
                            {w.nickname ? (
                              <span className="font-normal" style={{ color: INK_3 }}>
                                {' '}
                                ({w.nickname})
                              </span>
                            ) : null}
                          </p>
                          <p className="font-mono text-xs leading-5 tabular-nums" style={{ color: INK_2 }}>
                            {w.phone}
                          </p>
                        </div>

                        {/* Col 4: School · Province */}
                        <p className="min-w-0 break-words text-sm leading-6" style={{ color: INK_2 }}>
                          <span className="font-medium" style={{ color: INK }}>
                            {w.school}
                          </span>
                          {w.province ? ` · ${w.province}` : ''}
                        </p>

                        {/* Col 5: Status before withdrawal (lg; mobile shows next to code) */}
                        <p className="hidden items-center gap-1.5 text-xs font-medium leading-5 lg:inline-flex" style={{ color: INK }}>
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: STATUS_DOT[w.status] }}
                          />
                          <span className="min-w-0 break-words">{STATUS_LABELS[w.status]}</span>
                        </p>

                        {/* Col 6: Applied → withdrawn (stacked) */}
                        <div className="text-xs leading-5" style={{ color: INK_3 }}>
                          <p>
                            <span className="font-semibold lg:hidden">สมัครเมื่อ: </span>
                            {formatBangkokDateTime(w.createdAt)}
                          </p>
                          <p style={{ color: INK_2 }}>
                            <span className="font-semibold lg:hidden">ยกเลิกเมื่อ: </span>
                            <span className="hidden lg:inline" aria-hidden="true">→ </span>
                            {formatBangkokDateTime(w.withdrawnAt)}
                          </p>
                        </div>

                        {/* Col 8: Reason */}
                        <p className="min-w-0 break-words text-xs leading-6" style={{ color: w.reason?.trim() ? INK_2 : INK_3 }}>
                          <span className="font-semibold lg:hidden">เหตุผล: </span>
                          {w.reason?.trim() ? w.reason.trim() : '— ไม่ได้ระบุ —'}
                        </p>

                        {/* Col 9: Permanent delete (opens the confirmation strip below the row) */}
                        {can.deleteApplication && (
                          <div className="lg:justify-self-end">
                            <button
                              id={`purge-btn-${w.id}`}
                              type="button"
                              disabled={purging}
                              aria-expanded={confirming}
                              aria-controls={confirming ? `purge-strip-${w.id}` : undefined}
                              aria-label={`ลบใบสมัคร ${w.id} (${w.fullName}) ถาวร`}
                              onClick={() => (confirming ? cancelPurge(w.id) : setPurgeConfirmId(w.id))}
                              className={`max-w-full text-left ${PILL_DANGER}`}
                              style={{
                                borderColor: DANGER,
                                color: DANGER,
                                backgroundColor: confirming
                                  ? 'color-mix(in srgb, var(--color-danger) 10%, transparent)'
                                  : undefined,
                              }}
                            >
                              <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
                              <span>ลบถาวร</span>
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Permanent delete confirmation: one explicit confirm, separated by a danger hairline. */}
                      {can.deleteApplication && confirming && (
                        <div
                          id={`purge-strip-${w.id}`}
                          role="region"
                          aria-label={`ยืนยันการลบถาวร ${w.id}`}
                          className="border-t px-5 py-4"
                          style={{ borderColor: DANGER }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelPurge(w.id);
                            }
                          }}
                        >
                          <p className="text-sm font-semibold leading-7" style={{ color: DANGER }}>
                            ลบใบสมัคร <span className="font-mono tabular-nums">{w.id}</span> ({w.fullName}) ออกจากระบบถาวร?
                          </p>
                          <p className="mt-0.5 text-sm leading-7" style={{ color: INK_2 }}>
                            ข้อมูลผู้สมัคร ประวัติสถานะ และสลิป (ถ้ามี) จะถูกลบทั้งหมดและกู้คืนไม่ได้ ใช้กับใบสมัครทดลองหรือใบสมัครซ้ำเท่านั้น
                            หากผู้สมัครตัวจริงอาจเปลี่ยนใจกลับมา ให้เก็บรายการนี้ไว้
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={purging}
                              aria-busy={purging || undefined}
                              onClick={() => void handlePurgeWithdrawn(w, nextId)}
                              className={`${PILL_DANGER} disabled:opacity-60`}
                              style={{
                                borderColor: DANGER,
                                color: DANGER,
                                backgroundColor: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                              }}
                            >
                              <Trash2 size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
                              {purging ? 'กำลังลบ…' : 'ยืนยันลบถาวร'}
                            </button>
                            <button
                              type="button"
                              disabled={purging}
                              onClick={() => cancelPurge(w.id)}
                              className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                              style={{ color: INK_2 }}
                            >
                              ยกเลิก
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {isWithdrawnTab && withdrawnLoading && withdrawnApps.length === 0 && !withdrawnError && (
              <div
                aria-hidden="true"
                className="mt-4 overflow-hidden rounded-[24px] border"
                style={{ borderColor: RULE, backgroundColor: BG_CARD }}
              >
                {[0, 1, 2].map((i) => (
                  <div key={i} className="border-b px-5 py-5 last:border-b-0" style={{ borderColor: RULE }}>
                    <div
                      className="h-3 w-24 animate-pulse rounded-full motion-reduce:animate-none"
                      style={{ backgroundColor: SURFACE_SUBTLE }}
                    />
                    <div
                      className="mt-3 h-4 w-56 animate-pulse rounded-full motion-reduce:animate-none"
                      style={{ backgroundColor: SURFACE_SUBTLE }}
                    />
                  </div>
                ))}
              </div>
            )}

            {isWithdrawnTab && !withdrawnLoading && !withdrawnError && visibleWithdrawn.length === 0 && (
              <div
                className="mt-4 rounded-[24px] border px-6 py-16 text-center"
                style={{ borderColor: RULE, backgroundColor: BG_CARD }}
              >
                <p className="text-base leading-[1.75]" style={{ color: searching ? INK_2 : INK_3 }}>
                  {searching
                    ? `ไม่พบผู้สมัครที่ตรงกับคำค้นหา '${stripZeroWidth(query).trim()}'`
                    : 'ยังไม่มีผู้สมัครที่ยกเลิกเอง'}
                </p>
              </div>
            )}

            {/* Loading skeleton (first load only) */}
            {!isWithdrawnTab && busy && apps.length === 0 && (
              <div
                aria-hidden="true"
                className="mt-4 overflow-hidden rounded-[24px] border"
                style={{ borderColor: RULE, backgroundColor: BG_CARD }}
              >
                {[0, 1, 2].map((i) => (
                  <div key={i} className="border-b px-5 py-5 last:border-b-0" style={{ borderColor: RULE }}>
                    <div
                      className="h-3 w-24 animate-pulse rounded-full motion-reduce:animate-none"
                      style={{ backgroundColor: SURFACE_SUBTLE }}
                    />
                    <div
                      className="mt-3 h-4 w-56 animate-pulse rounded-full motion-reduce:animate-none"
                      style={{ backgroundColor: SURFACE_SUBTLE }}
                    />
                  </div>
                ))}
              </div>
            )}

            {!isWithdrawnTab && !busy && visible.length === 0 && (
              <div
                ref={emptyStateRef}
                tabIndex={-1}
                className={`mt-4 rounded-[24px] border px-6 py-16 text-center ${FOCUS}`}
                style={{ borderColor: RULE, backgroundColor: BG_CARD }}
              >
                {searching ? (
                  <>
                    <p className="text-base leading-[1.75]" style={{ color: INK_2 }}>
                      ไม่พบผู้สมัครที่ตรงกับคำค้นหา '{stripZeroWidth(query).trim()}'
                    </p>
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className={`mt-4 ${pillGhost}`}
                      style={{ borderColor: RULE, color: INK }}
                    >
                      ล้างคำค้นหา
                    </button>
                  </>
                ) : (
                  <p className="text-base leading-[1.75]" style={{ color: INK_3 }}>
                    {apps.length === 0
                      ? 'ยังไม่มีใบสมัครเข้ามา เมื่อมีผู้สมัครรายชื่อจะแสดงที่นี่'
                      : filter === 'SLIP_PENDING'
                        ? 'ไม่มีสลิปรอตรวจในขณะนี้'
                        : filter === 'AWAITING_PAY'
                          ? 'ทุกคนที่ได้สิทธิ์ส่งสลิปแล้ว'
                          : 'ไม่มีใบสมัครในสถานะนี้'}
                  </p>
                )}
              </div>
            )}

            {source && (import.meta.env.DEV || source !== 'LIVE GO API') && (
              <p className="mt-8 text-xs" style={{ color: INK_3 }}>
                แหล่งข้อมูล <span className="font-mono tabular-nums">{source}</span>
              </p>
            )}
          </section>
          </div>
            </div>
          </div>

          <SlipLightbox
            src={slipImage.url}
            open={lightboxOpen && Boolean(slipImage.url)}
            onClose={() => setLightboxOpen(false)}
          />
        </>
      )}
    </div>
    </MotionConfig>
  );
}
