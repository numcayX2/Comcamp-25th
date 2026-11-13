import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Download,
  Eye,
  EyeOff,
  Maximize2,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  ApiHttpError,
  adminLogin,
  adminPermissions,
  deleteApplication,
  fetchAdminSlipInfo,
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
} from '../lib/api';
import {
  SLIP_LABELS,
  STATUS_LABELS,
  buildApplicantsCsv,
  csvFileName,
  downloadCsv,
  matchesApplicantQuery,
  slipLabel,
} from '../lib/applicant-tools';
import { formatNationalId } from './register/model';
import { AdminProfileEditor } from './AdminProfileEditor';
import { AdminSettingsPanel } from './AdminSettingsPanel';
import { SlipLightbox } from './slip/SlipLightbox';
import {
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
  PILL_GHOST,
  RULE,
  SUCCESS,
  SURFACE_SUBTLE,
  TECH,
  WARNING,
} from './admin-ui';

const STATUSES: ApplicationStatus[] = ['PASSED', 'CONFIRMED', 'RESERVE', 'REJECTED', 'REFUND_PENDING', 'REFUNDED'];

type FilterKey = 'ALL' | 'SLIP_PENDING' | ApplicationStatus;
type SortKey = 'newest' | 'slip_queue' | 'updated_desc';

/** Optional slip verification metadata when provided by an extended API payload or session cache. */
type ApplicantSlipMeta = Application & {
  adminNote?: string | null;
  rejectionReason?: string | null;
  verifiedAt?: string | null;
};

type LocalSlipVerdict = {
  approved: boolean;
  note: string;
  verifiedAt: string;
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

function StatusSelect({
  app,
  disabled,
  onChange,
}: {
  app: Application;
  disabled: boolean;
  onChange: (status: ApplicationStatus) => void;
}) {
  return (
    <label className="relative inline-flex items-center gap-2">
      <span className="sr-only">เปลี่ยนสถานะของ {app.id}</span>
      <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: STATUS_DOT[app.status] }}>
        ●
      </span>
      <select
        value={app.status}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ApplicationStatus)}
        className={`min-h-11 cursor-pointer appearance-none rounded-sm border-b bg-transparent py-2 pr-7 text-sm leading-6 disabled:opacity-50 ${FOCUS}`}
        style={{ borderColor: RULE, color: INK, colorScheme: 'inherit' }}
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
        size={16}
        className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2"
        style={{ color: INK_3 }}
      />
    </label>
  );
}

/** Payment-slip state as a pill: the dot carries the colour, the text carries the meaning. */
function SlipBadge({ app }: { app: Application }) {
  if (!hasSlip(app)) {
    return (
      <span className="text-sm leading-7" style={{ color: INK_3 }}>
        ยังไม่มีสลิป
      </span>
    );
  }
  const s: SlipStatus = app.slipStatus ?? 'PENDING';
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-xs font-semibold leading-6"
      style={{ borderColor: RULE, color: INK }}
    >
      <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: SLIP_DOT[s] }}>
        ●
      </span>
      {SLIP_LABELS[s]}
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
      return 'เลขบัตรประชาชน เบอร์โทร หรืออีเมลนี้ซ้ำกับผู้สมัครคนอื่นที่ยังอยู่ในระบบ';
    }
    if (err.code === 'SLIP_CHANGED') {
      return 'ผู้สมัครเพิ่งอัปโหลดสลิปใหม่ จึงยังไม่ได้บันทึกผล ระบบโหลดสลิปล่าสุดให้แล้ว กรุณาตรวจสอบอีกครั้ง';
    }
    if (err.code === 'ALREADY_VERIFIED') {
      return 'สลิปนี้ถูกตรวจสอบไปแล้ว รายการถูกโหลดใหม่ให้แล้ว';
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
  const [filter, setFilter] = useState<FilterKey>('ALL');
  const [sortBy, setSortBy] = useState<SortKey>('newest');
  const [query, setQuery] = useState('');
  /** Camp fee in baht from the settings panel; used in the note templates. */
  const [feeBaht, setFeeBaht] = useState<number | null>(null);
  const [settingsRefreshKey, setSettingsRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [patching, setPatching] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
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

  // Two-step slip decision & note state.
  const [verificationNote, setVerificationNote] = useState('');
  const [verifyNoteError, setVerifyNoteError] = useState<string | null>(null);
  const [confirmVerifyAction, setConfirmVerifyAction] = useState<'approve' | 'reject' | null>(null);
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
  const prevConfirmId = useRef<string | null>(null);
  const prevEditId = useRef<string | null>(null);
  const focusListAfterDelete = useRef(false);
  const focusSlipPanelAfterAdvance = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const ledgerRef = useRef<HTMLElement>(null);
  const filterGroupRef = useRef<HTMLDivElement>(null);
  const emptyStateRef = useRef<HTMLDivElement>(null);
  const slipPanelRef = useRef<HTMLDivElement>(null);

  const inspectingApp = inspectingId ? apps.find((a) => a.id === inspectingId) ?? null : null;
  const verifying = verifyingAction !== null;
  /* Fail closed when role is not `'admin'`. */
  const can = adminPermissions(role);

  const resetSessionState = useCallback(() => {
    tokenStore.clear();
    setToken(null);
    setRole(null);
    setSource(null);
    setApps([]);
    setFeeBaht(null);
    setFilter('ALL');
    setSortBy('newest');
    setQuery('');
    setInspectingId(null);
    setLightboxOpen(false);
    setDetailId(null);
    setEditingId(null);
    setEditingDirty(false);
    setPendingDiscardSwitch(null);
    setConfirmDeleteId(null);
    setDeleteReason('');
    setPendingStatus(null);
    setStatusReason('');
    setVerificationNote('');
    setVerifyNoteError(null);
    setConfirmVerifyAction(null);
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

  async function refresh(t: string, alsoSettings = false) {
    setBusy(true);
    if (alsoSettings) {
      setSettingsRefreshKey((k) => k + 1);
    }
    try {
      const res = await listApplications(t);
      setApps(Array.isArray(res.data) ? res.data : []);
      setSource(res.source);
      setError(null);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'โหลดรายการใบสมัครไม่สำเร็จ'));
    } finally {
      setBusy(false);
    }
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
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
        return;
      }
      setToken(res.data.token);
      setRole(resolvedRole);
      setSource(res.source);
      await refresh(res.data.token);
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
    } finally {
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

  function requestStatusChange(app: Application, to: ApplicationStatus) {
    if (to === app.status) return;
    const releasesSeat = holdsSeat(app.status) && !holdsSeat(to);
    const leavesConfirmed = app.status === 'CONFIRMED' && to !== 'CONFIRMED';
    const bypassesSlipToConfirm = to === 'CONFIRMED' && app.status !== 'CONFIRMED';
    const movesPassedToReserve = app.status === 'PASSED' && to === 'RESERVE';
    if (releasesSeat || leavesConfirmed || bypassesSlipToConfirm || movesPassedToReserve) {
      setConfirmDeleteId(null);
      setDeleteReason('');
      setStatusReason('');
      setPendingStatus({ appId: app.id, from: app.status, to });
      return;
    }
    void onStatus(app.id, to);
  }

  async function onStatus(id: string, status: ApplicationStatus, reason?: string) {
    if (!token) return;
    setPatching(id);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await updateApplicationStatus(token, id, status, reason);
      setApps((prev) => prev.map((a) => (a.id === id ? res.data : a)));
      setSource(res.source);
      setPendingStatus(null);
      setStatusReason('');
      setActionSuccess(`เปลี่ยนสถานะของ ${id} เป็น ${STATUS_LABELS[status]} สำเร็จ`);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'เปลี่ยนสถานะไม่สำเร็จ'));
    } finally {
      setPatching(null);
    }
  }

  /* Compute sorted & filtered lists before handlers that need next-pending navigation. */
  const sorted = sortApplications(apps, sortBy);
  const byTab =
    filter === 'ALL'
      ? sorted
      : filter === 'SLIP_PENDING'
        ? sorted.filter((a) => isSlipPending(a))
        : sorted.filter((a) => a.status === filter);
  const visible = byTab.filter((a) => matchesApplicantQuery(a, query));
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
    setEditingId(null);
    setDetailId(null);
    setLightboxOpen(false);
    setInspectingId(target.id);
    setVerificationNote('');
    setVerifyNoteError(null);
    setConfirmVerifyAction(null);
    focusSlipPanelAfterAdvance.current = true;
  }

  function initiateSlipDecision(action: 'approve' | 'reject') {
    const trimmed = stripZeroWidth(verificationNote).trim();
    if (action === 'reject' && !trimmed) {
      setVerifyNoteError('กรุณาระบุเหตุผลการปฏิเสธสลิป หรือเลือกข้อความสำเร็จรูปด้านล่าง');
      setConfirmVerifyAction(null);
      document.getElementById('verify-note')?.focus();
      return;
    }
    setVerifyNoteError(null);
    setConfirmVerifyAction(action);
  }

  async function confirmSlipDecision(approved: boolean) {
    if (!token || !inspectingApp || verifying) return;
    const trimmed = stripZeroWidth(verificationNote).trim();
    if (!approved && !trimmed) {
      setVerifyNoteError('กรุณาระบุเหตุผลการปฏิเสธสลิป หรือเลือกข้อความสำเร็จรูปด้านล่าง');
      setConfirmVerifyAction(null);
      document.getElementById('verify-note')?.focus();
      return;
    }

    const currentId = inspectingApp.id;
    const nextPendingInView = autoAdvanceSlip ? findNextPendingSlip(currentId, visible) : null;

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
        slipImage.paymentId ?? inspectingApp.slipPaymentId,
      );
      setSource(res.source);

      const newStatus: ApplicationStatus = approved ? 'CONFIRMED' : 'PASSED';
      const newSlip: SlipStatus = approved ? 'APPROVED' : 'REJECTED';
      const recordedNote = trimmed || (approved ? 'ยอดเงินถูกต้องครบถ้วน' : '');
      const verifiedAt = new Date().toISOString();

      setLocalSlipVerdicts((prev) => ({
        ...prev,
        [currentId]: { approved, note: recordedNote, verifiedAt },
      }));
      setApps((prev) =>
        prev.map((a) =>
          a.id === currentId
            ? { ...a, status: newStatus, slipStatus: newSlip, updatedAt: verifiedAt }
            : a,
        ),
      );

      setActionSuccess(
        `${approved ? 'อนุมัติสลิปสำเร็จ' : 'ปฏิเสธสลิปแล้ว'}: ${currentId}${nextPendingInView ? ` · เปิดคิวถัดไป ${nextPendingInView.id}` : ''}`,
      );
      setLightboxOpen(false);
      setConfirmVerifyAction(null);
      setVerificationNote('');

      if (nextPendingInView) {
        setInspectingId(nextPendingInView.id);
        focusSlipPanelAfterAdvance.current = true;
      } else {
        setInspectingId(null);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setConfirmVerifyAction(null);
      if (err instanceof ApiHttpError && err.code === 'SLIP_CHANGED') {
        // Keep the panel open, reload list & fetch the newly uploaded slip image without losing staff context.
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
      setVerifyingAction(null);
    }
  }

  async function handleDeleteApp(id: string, name: string) {
    if (!token) return;
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
      setConfirmDeleteId(null);
      setDeleteReason('');
      setSource(res.source);
      setActionSuccess(`ลบใบสมัคร ${id} (${name}) สำเร็จ`);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'ลบใบสมัครไม่สำเร็จ'));
    } finally {
      setDeletingId(null);
    }
  }

  function openSlip(a: Application) {
    const run = () => {
      setEditingId(null);
      setEditingDirty(false);
      setDetailId(null);
      setLightboxOpen(false);
      setConfirmVerifyAction(null);
      setVerifyNoteError(null);
      setVerificationNote('');
      setInspectingId((cur) => (cur === a.id ? null : a.id));
    };
    guardProfileEditSwitch(`เปิดตรวจสลิปของ ${a.id}`, run);
  }

  function toggleDetail(a: Application) {
    const run = () => {
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
      setInspectingId(null);
      setLightboxOpen(false);
      setDetailId(null);
      setConfirmDeleteId(null);
      setDeleteReason('');
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
    if (!token || exporting) return;
    const rows = visible;
    setExporting(true);
    setActionSuccess(null);
    setError(null);
    try {
      const apiStatusFilter: ApplicationStatus | undefined =
        filter === 'ALL' || filter === 'SLIP_PENDING' ? undefined : filter;
      await recordCsvExport(token, {
        applicationIds: rows.map((a) => a.id),
        statusFilter: apiStatusFilter,
        searchFiltered: searching || filter === 'SLIP_PENDING',
      });
      downloadCsv(csvFileName(), buildApplicantsCsv(rows));
      setActionSuccess(`ส่งออก ${rows.length} รายการเป็นไฟล์ CSV แล้ว (บันทึกประวัติการส่งออกแล้ว)`);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'บันทึกประวัติการส่งออกไม่สำเร็จ จึงยังไม่ได้สร้างไฟล์ CSV กรุณาลองใหม่อีกครั้ง'));
    } finally {
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

  /* Escape closes open inline panels or confirmations (when lightbox/mutation is not active). */
  useEffect(() => {
    if (!inspectingId && !detailId && !confirmDeleteId && !pendingStatus && !pendingDiscardSwitch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightboxOpen) return;
        if (pendingDiscardSwitch) {
          setPendingDiscardSwitch(null);
          return;
        }
        if (confirmVerifyAction && !verifying) {
          setConfirmVerifyAction(null);
          return;
        }
        if (!verifying) setInspectingId(null);
        setDetailId(null);
        if (!deletingId) {
          setConfirmDeleteId(null);
          setDeleteReason('');
        }
        if (!patching) setPendingStatus(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    inspectingId,
    detailId,
    confirmDeleteId,
    pendingStatus,
    pendingDiscardSwitch,
    confirmVerifyAction,
    lightboxOpen,
    verifying,
    deletingId,
    patching,
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
    if (prevConfirmId.current && !confirmDeleteId) {
      document.getElementById(`delete-btn-${prevConfirmId.current}`)?.focus();
    }
    if (prevEditId.current && !editingId) {
      document.getElementById(`edit-btn-${prevEditId.current}`)?.focus();
    }
    prevSlipId.current = inspectingId;
    prevDetailId.current = detailId;
    prevConfirmId.current = confirmDeleteId;
    prevEditId.current = editingId;
  }, [inspectingId, detailId, confirmDeleteId, editingId, visible.length]);

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
  const withSlip = apps.filter((a) => hasSlip(a)).length;
  const pendingSlipCount = apps.filter((a) => isSlipPending(a)).length;
  /** Same rule the server uses for the seat quota: REJECTED, REFUND_PENDING and REFUNDED released theirs. */
  const currentCount = apps.filter((a) => holdsSeat(a.status)).length;
  /** First come, first served: a new application is PASSED and then waits for a slip or its review. */
  const awaitingPayment = count('PASSED') + count('PENDING');
  const countLabel = searching
    ? `พบ ${visible.length} จาก ${byTab.length} รายการ`
    : `${byTab.length} รายการ`;

  const inputCls = `${INPUT_BASE} rounded-xl`;
  const pillGhost = PILL_GHOST;

  const extraPendingTab: { key: FilterKey; label: string; n: number }[] =
    count('PENDING') > 0 ? [{ key: 'PENDING', label: STATUS_LABELS.PENDING, n: count('PENDING') }] : [];

  const tabs: { key: FilterKey; label: string; n: number }[] = [
    { key: 'ALL', label: 'ทั้งหมด', n: apps.length },
    { key: 'SLIP_PENDING', label: 'สลิปรอตรวจ', n: pendingSlipCount },
    ...extraPendingTab,
    ...STATUSES.map((s) => ({ key: s as FilterKey, label: STATUS_LABELS[s], n: count(s) })),
  ];

  const visibleWithSlip = visible.filter((x) => hasSlip(x) && can.viewSlip);
  const approvePresets = approveNoteTemplates(feeBaht);

  return (
    <div className="mx-auto w-full max-w-5xl select-text px-4 pb-28 pt-12 selection:bg-[color-mix(in_srgb,var(--color-tech)_25%,transparent)] sm:px-8 sm:pt-20">
      {/* ── Masthead ─────────────────────────────────────────── */}
      <header>
        <h1
          className="text-balance text-[2rem] font-bold leading-[1.22] sm:text-[3.25rem]"
          style={{ color: INK }}
        >
          {token ? 'ใบสมัครและสลิป' : 'สำหรับพี่ค่าย'}
        </h1>
        {token ? (
          <>
            <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:flex lg:flex-wrap lg:gap-3">
              <div className="rounded-xl border px-3.5 py-2.5" style={{ borderColor: RULE }}>
                <p className="text-xs leading-5" style={{ color: INK_3 }}>ผู้สมัครทั้งหมด</p>
                <p className="font-mono text-lg font-semibold tabular-nums" style={{ color: INK }}>{apps.length} คน</p>
              </div>
              <div className="rounded-xl border px-3.5 py-2.5" style={{ borderColor: RULE }}>
                <p className="text-xs leading-5" style={{ color: INK_3 }}>ถือที่นั่งอยู่</p>
                <p className="font-mono text-lg font-semibold tabular-nums" style={{ color: INK }}>{currentCount}</p>
              </div>
              <button
                type="button"
                aria-pressed={filter === 'SLIP_PENDING'}
                onClick={() => {
                  setFilter('SLIP_PENDING');
                  ledgerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className={`min-h-11 rounded-xl border px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                style={{
                  borderColor: filter === 'SLIP_PENDING' ? TECH : pendingSlipCount > 0 ? WARNING : RULE,
                  backgroundColor: filter === 'SLIP_PENDING' ? SURFACE_SUBTLE : undefined,
                }}
              >
                <p className="flex items-center gap-1.5 text-xs font-semibold leading-5" style={{ color: pendingSlipCount > 0 ? WARNING : INK_3 }}>
                  <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: pendingSlipCount > 0 ? WARNING : INK_3 }} />
                  สลิปรอตรวจ
                </p>
                <p className="font-mono text-lg font-semibold tabular-nums" style={{ color: INK }}>
                  {pendingSlipCount} รายการ
                </p>
              </button>
              <div className="rounded-xl border px-3.5 py-2.5" style={{ borderColor: RULE }}>
                <p className="text-xs leading-5" style={{ color: INK_3 }}>ยืนยันสิทธิ์แล้ว</p>
                <p className="font-mono text-lg font-semibold tabular-nums" style={{ color: INK }}>{count('CONFIRMED')}</p>
              </div>
              <div className="rounded-xl border px-3.5 py-2.5" style={{ borderColor: RULE }}>
                <p className="text-xs leading-5" style={{ color: INK_3 }}>รอชำระ / รอตรวจ</p>
                <p className="font-mono text-lg font-semibold tabular-nums" style={{ color: INK }}>{awaitingPayment}</p>
              </div>
              <div className="rounded-xl border px-3.5 py-2.5" style={{ borderColor: RULE }}>
                <p className="text-xs leading-5" style={{ color: INK_3 }}>รอคืนเงิน / แนบสลิป</p>
                <p className="font-mono text-lg font-semibold tabular-nums" style={{ color: INK }}>
                  {count('REFUND_PENDING')} / {withSlip}
                </p>
              </div>
            </div>
            {role && (
              <p className="mt-3 max-w-[60ch] text-sm leading-7" style={{ color: INK_3 }}>
                เข้าสู่ระบบในบทบาท <span className="font-mono" style={{ color: INK }}>{role}</span>
                {' · '}
                จัดการใบสมัคร ตรวจสลิป แก้ไขข้อมูล ส่งออก CSV และตั้งค่าค่าย
              </p>
            )}
          </>
        ) : (
          <p className="mt-4 max-w-[46ch] text-base leading-[1.75]" style={{ color: INK_2 }}>
            เข้าสู่ระบบเพื่อตรวจรายชื่อใบสมัคร เปลี่ยนสถานะ และอนุมัติหลักฐานการชำระเงิน
          </p>
        )}
      </header>

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
              className="pointer-events-auto flex w-full items-start justify-between gap-4 rounded-xl border px-4 py-3.5 shadow-lg"
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
              className="pointer-events-auto flex w-full items-start justify-between gap-4 rounded-xl border px-4 py-3.5 shadow-lg"
              style={{ backgroundColor: SUCCESS, borderColor: SUCCESS, color: '#121316' }}
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
          className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-lg rounded-xl border p-4 shadow-lg"
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
          <AdminSettingsPanel
            token={token}
            canEdit={can.editSettings}
            currentCount={currentCount}
            refreshSignal={settingsRefreshKey}
            onAuthError={handleAuthError}
            onSettings={(s: AdminSettings) => setFeeBaht(Number(s.campFee))}
          />

          {/* ── Ledger ───────────────────────────────────────────── */}
          <section ref={ledgerRef} className="mt-12" aria-busy={busy}>
            {/* Filter pills (wrap cleanly on 390px) + refresh / sign out */}
            <div
              className="flex flex-col gap-4 border-b pb-4 md:flex-row md:items-start md:justify-between"
              style={{ borderColor: INK }}
            >
              <div
                ref={filterGroupRef}
                tabIndex={-1}
                role="group"
                aria-label="กรองตามสถานะ"
                className={`flex flex-wrap gap-2 rounded-sm ${FOCUS}`}
              >
                {tabs.map((t) => {
                  const active = filter === t.key;
                  const isSlipQueue = t.key === 'SLIP_PENDING';
                  return (
                    <button
                      key={t.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFilter(t.key)}
                      className={`inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm transition-colors ${FOCUS}`}
                      style={{
                        backgroundColor: active ? BTN_DARK : 'transparent',
                        color: active ? BTN_DARK_TEXT : INK_2,
                        borderColor: active ? BTN_DARK : isSlipQueue && t.n > 0 ? WARNING : RULE,
                        fontWeight: active ? 600 : 500,
                      }}
                    >
                      {isSlipQueue && (
                        <span
                          aria-hidden="true"
                          className="size-2 rounded-full"
                          style={{ backgroundColor: active ? BTN_DARK_TEXT : t.n > 0 ? WARNING : INK_3 }}
                        />
                      )}
                      <span>{t.label}</span>
                      <span
                        className="font-mono text-xs tabular-nums"
                        style={{ opacity: active ? 0.9 : 0.75 }}
                      >
                        {t.n}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {busy && (
                  <span className="mr-1 text-xs" style={{ color: INK_3 }}>
                    กำลังโหลด…
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (!token) return;
                    guardProfileEditSwitch('รีเฟรชรายการ', () => void refresh(token, true));
                  }}
                  disabled={busy}
                  className={pillGhost}
                  style={{ borderColor: RULE, color: INK }}
                >
                  รีเฟรช
                </button>
                <button type="button" onClick={logout} className={pillGhost} style={{ borderColor: RULE, color: INK_2 }}>
                  ออกจากระบบ
                </button>
              </div>
            </div>

            {/* Search, Sort, Count and Export */}
            <div
              className="flex flex-col gap-3 border-b py-4 lg:flex-row lg:items-center lg:justify-between"
              style={{ borderColor: RULE }}
            >
              <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center lg:flex-1">
                <div className="relative w-full sm:max-w-md">
                  <label htmlFor="applicant-search" className="sr-only">
                    ค้นหาผู้สมัคร
                  </label>
                  <Search
                    aria-hidden="true"
                    strokeWidth={1.5}
                    size={16}
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2"
                    style={{ color: INK_3 }}
                  />
                  <input
                    id="applicant-search"
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="ค้นหารหัส ชื่อ เบอร์ อีเมล เลขบัตร โรงเรียน ระดับชั้น ไซส์เสื้อ จังหวัด"
                    autoComplete="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    className={`${INPUT_BASE} rounded-full pl-10 ${searching ? 'pr-12' : 'pr-4'}`}
                    style={{ borderColor: INPUT_BORDER, color: INK }}
                  />
                  {searching && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="ล้างคำค้นหา"
                      className={`absolute right-1 top-1/2 inline-flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full ${FOCUS}`}
                      style={{ color: INK_2 }}
                    >
                      <X aria-hidden="true" strokeWidth={1.5} size={16} />
                    </button>
                  )}
                </div>

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
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-start">
                <p role="status" aria-live="polite" className="text-sm tabular-nums" style={{ color: INK_2 }}>
                  {countLabel}
                </p>
                {can.exportCsv && (
                  <button
                    type="button"
                    onClick={exportCsv}
                    disabled={visible.length === 0 || exporting}
                    aria-busy={exporting}
                    className={`inline-flex items-center gap-2 ${pillGhost}`}
                    style={{ borderColor: RULE, color: INK }}
                  >
                    <Download aria-hidden="true" strokeWidth={1.5} size={16} />
                    ส่งออก CSV
                  </button>
                )}
              </div>
            </div>

            {/* Rows */}
            <ul ref={listRef} tabIndex={-1} className={`rounded-sm ${FOCUS}`}>
              {visible.map((a) => {
                const slip = hasSlip(a);
                const open = inspectingId === a.id;
                const detailOpen = detailId === a.id;
                const editing = editingId === a.id;
                const pendingChange = pendingStatus?.appId === a.id ? pendingStatus : null;
                // REJECTED / REFUND_PENDING / REFUNDED: the slip stays viewable but cannot be settled.
                const slipLocked = !holdsSeat(a.status);
                const slipPending = (a.slipStatus ?? 'PENDING') === 'PENDING';
                const slipIdx = visibleWithSlip.findIndex((x) => x.id === a.id);
                const prevSlipApp = slipIdx > 0 ? visibleWithSlip[slipIdx - 1] : null;
                const nextSlipApp =
                  slipIdx >= 0 && slipIdx < visibleWithSlip.length - 1 ? visibleWithSlip[slipIdx + 1] : null;
                const nextPendingInView = findNextPendingSlip(a.id, visible);
                const nextPendingGlobal = nextPendingInView ? null : findNextPendingSlip(a.id, sorted);
                const slipMeta = a as ApplicantSlipMeta;
                const localVerdict = localSlipVerdicts[a.id];
                const savedNote =
                  a.slipStatus === 'REJECTED'
                    ? (slipMeta.rejectionReason ?? slipMeta.adminNote ?? localVerdict?.note ?? null)
                    : (slipMeta.adminNote ?? localVerdict?.note ?? null);
                const savedVerifiedAt = slipMeta.verifiedAt ?? localVerdict?.verifiedAt ?? null;

                return (
                  <li key={a.id} className="border-b" style={{ borderColor: RULE }}>
                    <div className="grid gap-x-8 gap-y-3 py-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_15.5rem] md:items-start">
                      {/* Who */}
                      <div className="min-w-0">
                        <p className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                          {a.id}
                        </p>
                        <p className="mt-1 break-words text-base font-semibold leading-7" style={{ color: INK }}>
                          {a.fullName}
                          {a.nickname ? (
                            <span className="font-normal" style={{ color: INK_3 }}>
                              {' '}
                              ({a.nickname})
                            </span>
                          ) : null}
                        </p>
                        <p className="text-sm leading-7" style={{ color: INK_2 }}>
                          <span className="font-mono tabular-nums">{a.phone}</span>
                          {a.email ? (
                            <span className="break-all" style={{ color: INK_3 }}>
                              {' '}
                              · {a.email}
                            </span>
                          ) : null}
                        </p>
                      </div>

                      {/* Where */}
                      <div className="min-w-0 text-sm leading-7" style={{ color: INK_2 }}>
                        <p className="break-words">{a.school}</p>
                        <p style={{ color: INK_3 }}>
                          {a.grade}
                          {a.province ? ` · ${a.province}` : ''} · ไซส์ {a.shirtSize}
                        </p>
                      </div>

                      {/* State + actions */}
                      <div className="flex min-w-0 flex-col items-start gap-1.5">
                        {can.changeStatus ? (
                          <StatusSelect
                            app={a}
                            disabled={patching === a.id || deletingId === a.id}
                            onChange={(status) => requestStatusChange(a, status)}
                          />
                        ) : (
                          <p className="inline-flex min-h-11 items-center gap-2 py-2 text-sm leading-6" style={{ color: INK }}>
                            <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: STATUS_DOT[a.status] }}>
                              ●
                            </span>
                            {STATUS_LABELS[a.status]}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
                          <SlipBadge app={a} />
                          <button
                            id={`detail-btn-${a.id}`}
                            type="button"
                            aria-expanded={detailOpen}
                            onClick={() => toggleDetail(a)}
                            className={`inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
                            style={{ color: INK_2 }}
                          >
                            <Eye size={14} strokeWidth={1.5} aria-hidden="true" />
                            {detailOpen ? 'ซ่อนรายละเอียด' : 'รายละเอียด'}
                          </button>
                          {slip && can.viewSlip && (
                            <button
                              id={`slip-btn-${a.id}`}
                              type="button"
                              aria-expanded={open}
                              onClick={() => openSlip(a)}
                              className={`inline-flex min-h-11 items-center rounded-sm py-2 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
                              style={{ color: TECH }}
                            >
                              {open ? 'ซ่อนสลิป' : 'ตรวจสอบสลิป'}
                            </button>
                          )}
                          {can.editProfile && (
                            <button
                              id={`edit-btn-${a.id}`}
                              type="button"
                              aria-expanded={editing}
                              onClick={() => toggleEdit(a)}
                              className={`inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
                              style={{ color: TECH }}
                            >
                              <Pencil size={13} strokeWidth={1.5} aria-hidden="true" />
                              {editing ? 'ซ่อนการแก้ไข' : 'แก้ไขข้อมูล'}
                            </button>
                          )}
                          {can.deleteApplication &&
                            confirmDeleteId !== a.id && (
                              <button
                                id={`delete-btn-${a.id}`}
                                type="button"
                                disabled={deletingId === a.id}
                                onClick={() => {
                                  guardProfileEditSwitch(`ลบใบสมัคร ${a.id}`, () => {
                                    setPendingStatus(null);
                                    setDeleteReason('');
                                    setConfirmDeleteId(a.id);
                                  });
                                }}
                                className={`inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-sm font-semibold underline underline-offset-4 transition-colors hover:opacity-80 disabled:opacity-50 ${FOCUS}`}
                                style={{ color: DANGER }}
                                title={`ลบใบสมัคร ${a.id}`}
                              >
                                <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
                                ลบ
                              </button>
                            )}
                        </div>
                      </div>
                    </div>

                    {/* Confirmation for risky / seat-releasing / slip-bypassing status transition */}
                    {pendingChange && (
                      <div
                        role="region"
                        aria-label={`ยืนยันการเปลี่ยนสถานะ ${a.id}`}
                        className="border-t py-4"
                        style={{ borderColor: RULE }}
                      >
                        <p className="text-sm font-semibold leading-7" style={{ color: INK }}>
                          ยืนยันเปลี่ยนสถานะ {a.id} จาก “{STATUS_LABELS[pendingChange.from]}” เป็น “{STATUS_LABELS[pendingChange.to]}”
                        </p>
                        <p className="mt-0.5 text-sm leading-7" style={{ color: INK_2 }}>
                          {!holdsSeat(pendingChange.to)
                            ? 'การเปลี่ยนเป็นสถานะนี้จะคืนที่นั่งทันที และอาจคืนกลับมาไม่ได้หากโควตาเต็มแล้ว'
                            : pendingChange.to === 'CONFIRMED'
                              ? 'การเปลี่ยนเป็น “ยืนยันสิทธิ์สมบูรณ์” ด้วยตนเองจะข้ามขั้นตอนตรวจสลิป (ควรใช้เมื่อตรวจสอบการชำระเงินเรียบร้อยแล้ว)'
                              : pendingChange.from === 'PASSED' && pendingChange.to === 'RESERVE'
                                ? 'การเปลี่ยนจาก “ได้สิทธิ์แล้ว” เป็น “ตัวสำรอง” จะเปลี่ยนสิทธิ์ผู้สมัครทันที หากส่งสลิปแล้วควรตรวจสอบสลิปก่อน'
                                : 'การเปลี่ยนสถานะออกจาก “ยืนยันสิทธิ์สมบูรณ์” อาจต้องตรวจสอบหลักฐานการชำระเงินใหม่'}
                          {a.slipStatus === 'APPROVED' && pendingChange.to === 'REJECTED'
                            ? ' (ผู้สมัครมีสลิปที่อนุมัติแล้ว หากต้องคืนเงินแนะนำให้เลือก “รอคืนเงิน”)'
                            : ''}
                        </p>
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
                            placeholder="เหตุผลในการเปลี่ยนสถานะ (ไม่บังคับ)"
                            className={`${inputCls} sm:max-w-sm`}
                            style={{ borderColor: INPUT_BORDER, color: INK }}
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={patching === a.id}
                              onClick={() => onStatus(a.id, pendingChange.to, statusReason.trim() || undefined)}
                              className={`inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                              style={{ borderColor: DANGER, color: DANGER }}
                            >
                              {patching === a.id ? 'กำลังบันทึก…' : 'ยืนยันเปลี่ยนสถานะ'}
                            </button>
                            <button
                              type="button"
                              disabled={patching === a.id}
                              onClick={() => {
                                setPendingStatus(null);
                                setStatusReason('');
                              }}
                              className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                              style={{ color: INK_2 }}
                            >
                              ยกเลิก
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Confirmation for soft delete (with optional reason) */}
                    {can.deleteApplication && confirmDeleteId === a.id && (
                      <div
                        role="region"
                        aria-label={`ยืนยันการลบ ${a.id}`}
                        className="border-t py-4"
                        style={{ borderColor: RULE }}
                      >
                        <p className="text-sm font-semibold leading-7" style={{ color: DANGER }}>
                          ยืนยันลบใบสมัคร {a.id} ({a.fullName})?
                        </p>
                        <p className="mt-0.5 text-sm leading-7" style={{ color: INK_2 }}>
                          การลบจะคืนที่นั่งและปล่อยเลขบัตรประชาชน เบอร์โทร และอีเมลให้สมัครใหม่ได้
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
                            value={deleteReason}
                            onChange={(e) => setDeleteReason(e.target.value)}
                            placeholder="เหตุผลการลบ (ไม่บังคับ เช่น ข้อมูลซ้ำ/ผู้สมัครขอยกเลิก)"
                            className={`${inputCls} sm:max-w-sm`}
                            style={{ borderColor: INPUT_BORDER, color: INK }}
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={deletingId === a.id}
                              onClick={() => handleDeleteApp(a.id, a.fullName)}
                              className={`inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                              style={{ borderColor: DANGER, color: DANGER }}
                            >
                              {deletingId === a.id ? 'กำลังลบ…' : 'ยืนยันลบ'}
                            </button>
                            <button
                              type="button"
                              disabled={deletingId === a.id}
                              onClick={() => {
                                setConfirmDeleteId(null);
                                setDeleteReason('');
                              }}
                              className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                              style={{ color: INK_2 }}
                            >
                              ยกเลิก
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Applicant details: expands under its own row */}
                    {detailOpen && (
                      <div
                        className="border-t py-6"
                        style={{ borderColor: RULE }}
                        role="region"
                        aria-label={`รายละเอียดใบสมัคร ${a.id}`}
                      >
                        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                          <div>
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>เลขบัตรประชาชน</p>
                            <p className="mt-1 font-mono text-sm tabular-nums" style={{ color: INK }}>
                              {formatNationalId(a.nationalId)}
                            </p>
                          </div>
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
                          <div className="sm:col-span-2 lg:col-span-3">
                            <p className="text-xs font-semibold" style={{ color: INK_3 }}>เหตุผลการสมัคร / แรงบันดาลใจ</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-7" style={{ color: INK_2 }}>
                              {a.motivation?.trim() ? a.motivation : '— ไม่ได้ระบุ —'}
                            </p>
                          </div>
                        </div>
                        <div className="mt-5">
                          <button
                            type="button"
                            onClick={() => setDetailId(null)}
                            className={`inline-flex min-h-11 items-center justify-center rounded-full border px-6 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                            style={{ borderColor: RULE, color: INK }}
                          >
                            ปิด
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Profile editor: expands under its own row */}
                    {editing && token && can.editProfile && (
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
                    )}

                    {/* Slip review: expands under its own row */}
                    {open && can.viewSlip && (
                      <div
                        ref={slipPanelRef}
                        tabIndex={-1}
                        className={`grid gap-8 border-t py-6 md:grid-cols-[minmax(0,22rem)_1fr] ${FOCUS}`}
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
                              className={`mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm py-2 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
                              style={{ color: TECH }}
                            >
                              <Maximize2 aria-hidden="true" size={15} strokeWidth={1.75} />
                              เปิดรูปขนาดเต็ม / ซูม
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
                              <SlipBadge app={a} />
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
                                {a.fullName}
                                {a.nickname ? <span className="font-normal" style={{ color: INK_2 }}> ({a.nickname})</span> : null}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs font-semibold" style={{ color: INK_3 }}>เลขบัตรประชาชน</dt>
                              <dd className="mt-0.5 font-mono tabular-nums" style={{ color: INK }}>
                                {formatNationalId(a.nationalId)}
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
                                <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: STATUS_DOT[a.status] }}>●</span>
                                <span>{STATUS_LABELS[a.status]}</span>
                                <span style={{ color: INK_3 }}>·</span>
                                <span style={{ color: a.attendanceConfirmed ? SUCCESS : INK_2 }}>
                                  {a.attendanceConfirmed ? 'ยืนยันเข้าร่วมแล้ว' : 'ยังไม่ยืนยันเข้าร่วม'}
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
                                ? 'สลิปนี้ได้รับการอนุมัติเรียบร้อยแล้ว'
                                : a.slipStatus === 'REJECTED'
                                  ? 'สลิปนี้ถูกปฏิเสธแล้ว รอผู้สมัครอัปโหลดสลิปใหม่'
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
                            </div>
                          )}

                          {!slipLocked && slipPending && can.verifySlip && (
                            <>
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
                                    setVerificationNote(e.target.value);
                                    if (verifyNoteError) setVerifyNoteError(null);
                                  }}
                                />
                                {verificationNote && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setVerificationNote('');
                                      setVerifyNoteError(null);
                                      if (confirmVerifyAction === 'reject') setConfirmVerifyAction(null);
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

                              {/* Step 2 inline confirmation before mutating */}
                              {confirmVerifyAction ? (
                                <div
                                  role="region"
                                  aria-label="ยืนยันการบันทึกผลการตรวจสอบสลิป"
                                  className="mt-4 rounded-xl border p-4"
                                  style={{
                                    borderColor: confirmVerifyAction === 'approve' ? SUCCESS : DANGER,
                                    backgroundColor: SURFACE_SUBTLE,
                                  }}
                                >
                                  <p className="text-sm font-semibold leading-6" style={{ color: INK }}>
                                    {confirmVerifyAction === 'approve'
                                      ? `ยืนยันอนุมัติสลิปของ ${a.id} (${a.fullName})?`
                                      : `ยืนยันปฏิเสธสลิปของ ${a.id} (${a.fullName})?`}
                                  </p>
                                  <p className="mt-1 text-sm leading-6" style={{ color: INK_2 }}>
                                    {confirmVerifyAction === 'approve'
                                      ? 'สถานะใบสมัครจะเปลี่ยนเป็น “ยืนยันสิทธิ์สมบูรณ์” ทันที'
                                      : 'สถานะใบสมัครจะกลับเป็น “ได้สิทธิ์แล้ว” เพื่อให้ผู้สมัครอัปโหลดสลิปใหม่'}
                                    {stripZeroWidth(verificationNote).trim()
                                      ? ` · หมายเหตุ: “${stripZeroWidth(verificationNote).trim()}”`
                                      : ''}
                                  </p>
                                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                                    <button
                                      type="button"
                                      disabled={verifying}
                                      onClick={() => void confirmSlipDecision(confirmVerifyAction === 'approve')}
                                      className={`inline-flex min-h-11 items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                                      style={
                                        confirmVerifyAction === 'approve'
                                          ? { backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }
                                          : { border: `1px solid ${DANGER}`, color: DANGER, backgroundColor: 'transparent' }
                                      }
                                    >
                                      {verifyingAction === confirmVerifyAction
                                        ? 'กำลังบันทึก…'
                                        : confirmVerifyAction === 'approve'
                                          ? 'ยืนยันอนุมัติสลิป'
                                          : 'ยืนยันปฏิเสธสลิป'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={verifying}
                                      onClick={() => setConfirmVerifyAction(null)}
                                      className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                                      style={{ color: INK_2 }}
                                    >
                                      ยกเลิก
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
                                  <button
                                    type="button"
                                    disabled={verifying}
                                    onClick={() => initiateSlipDecision('approve')}
                                    className={`inline-flex min-h-11 items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                                    style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                                  >
                                    {verifyingAction === 'approve' ? 'กำลังบันทึก…' : 'อนุมัติสลิป'}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={verifying}
                                    onClick={() => initiateSlipDecision('reject')}
                                    className={`inline-flex min-h-11 items-center justify-center rounded-full border px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                                    style={{ borderColor: DANGER, color: DANGER }}
                                  >
                                    {verifyingAction === 'reject' ? 'กำลังบันทึก…' : 'ปฏิเสธสลิป'}
                                  </button>
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
                                </div>
                              )}
                            </>
                          )}
                          {(slipLocked || !slipPending || !can.verifySlip) && (
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
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* Loading skeleton (first load only) */}
            {busy && apps.length === 0 && (
              <div aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="border-b py-5" style={{ borderColor: RULE }}>
                    <div
                      className="h-3 w-24 animate-pulse rounded-sm motion-reduce:animate-none"
                      style={{ backgroundColor: SURFACE_SUBTLE }}
                    />
                    <div
                      className="mt-3 h-4 w-56 animate-pulse rounded-sm motion-reduce:animate-none"
                      style={{ backgroundColor: SURFACE_SUBTLE }}
                    />
                  </div>
                ))}
              </div>
            )}

            {!busy && visible.length === 0 && (
              <div ref={emptyStateRef} tabIndex={-1} className={`rounded-sm py-16 ${FOCUS}`}>
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
                        : 'ไม่มีใบสมัครในสถานะนี้'}
                  </p>
                )}
              </div>
            )}

            {source && (
              <p className="mt-8 text-xs" style={{ color: INK_3 }}>
                แหล่งข้อมูล <span className="font-mono tabular-nums">{source}</span>
              </p>
            )}
          </section>

          <SlipLightbox
            src={slipImage.url}
            open={lightboxOpen && Boolean(slipImage.url)}
            onClose={() => setLightboxOpen(false)}
          />
        </>
      )}
    </div>
  );
}
