import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, CircleCheck, Download, Pencil, Search, Trash2, TriangleAlert, X } from 'lucide-react';
import {
  ApiHttpError,
  adminLogin,
  adminPermissions,
  deleteApplication,
  fetchAdminSlip,
  hasSlip,
  holdsSeat,
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
} from '../lib/applicant-tools';
import { AdminProfileEditor } from './AdminProfileEditor';
import { AdminSettingsPanel } from './AdminSettingsPanel';
import {
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

const STATUSES: ApplicationStatus[] = ['PASSED', 'CONFIRMED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED'];

/** What each role can do, in the words staff use. Mirrors adminPermissions() in lib/api.ts. */
const ROLE_NOTE: Record<string, string> = {
  superadmin: 'จัดการได้ทุกอย่าง รวมถึงลบใบสมัครและแก้การตั้งค่า',
  staff: 'เปลี่ยนสถานะ แก้ข้อมูล และตรวจสลิปได้ ลบใบสมัครและแก้การตั้งค่าไม่ได้',
  finance: 'ดูและตรวจสลิปได้ เปลี่ยนสถานะหรือแก้ข้อมูลผู้สมัครไม่ได้',
  reviewer: 'ดูรายชื่อผู้สมัครและการตั้งค่าได้อย่างเดียว',
};

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

/** Quick notes for the staff note field. Wording is internal (the audit log keeps it). */
function noteTemplates(feeBaht: number | null): string[] {
  return [
    feeBaht === null
      ? 'ยอดเงินถูกต้องครบถ้วน'
      : `ยอดเงิน ${feeBaht.toLocaleString('en-US')} บาท ถูกต้องครบถ้วน`,
    'สลิปไม่ชัดเจน กรุณาอัปโหลดใหม่',
    'ยอดเงินในสลิปไม่ตรงกับค่าสมัคร ให้ตรวจกับรายการโอนอีกครั้ง',
  ];
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
        className={`cursor-pointer appearance-none rounded-sm border-b bg-transparent py-0.5 pr-6 text-sm leading-7 disabled:opacity-50 ${FOCUS}`}
        style={{ borderColor: RULE, color: INK, colorScheme: 'inherit' }}
      >
        {!STATUSES.includes(app.status) && (
          <option key={app.status} value={app.status} disabled>
            {STATUS_LABELS[app.status]} (สถานะเดิม)
          </option>
        )}
        {STATUSES.map((s) => (
          <option
            key={s}
            value={s}
          >
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
      return 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือเซสชันหมดอายุ';
    }
    if (err.status === 403) {
      return 'บัญชีของคุณไม่มีสิทธิ์ทำรายการนี้ หากเพิ่งถูกเปลี่ยนบทบาท กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่';
    }
    if (err.status === 404 || err.code === 'NOT_FOUND') {
      return 'ไม่พบรายการใบสมัครนี้ในระบบ';
    }
    if (err.code === 'QUOTA_FULL') {
      return 'ที่นั่งเต็มแล้ว จึงคืนใบสมัครนี้กลับเป็นสถานะที่ถือที่นั่งไม่ได้ ต้องมีที่นั่งว่างหรือเพิ่มโควตาก่อน (ใบสมัครยังคงสถานะเดิม)';
    }
    if (err.code === 'DUPLICATE_APPLICATION') {
      return 'เลขบัตรประชาชน เบอร์โทร หรืออีเมลนี้ซ้ำกับผู้สมัครคนอื่นที่ยังอยู่ในระบบ';
    }
    if (err.code === 'SLIP_CHANGED') {
      return 'ผู้สมัครเพิ่งอัปโหลดสลิปใหม่ จึงยังไม่ได้อนุมัติหรือปฏิเสธรายการนี้ รายการถูกโหลดใหม่แล้ว กรุณาเปิดดูสลิปล่าสุดก่อนตัดสินอีกครั้ง';
    }
    if (err.code === 'ALREADY_VERIFIED') {
      return 'สลิปนี้ถูกตรวจสอบไปแล้ว กรุณากดรีเฟรชรายการ';
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
  const [token, setToken] = useState<string | null>(null);
  /** The account's role, from the login response or the token payload: a UI hint only. */
  const [role, setRole] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [apps, setApps] = useState<Application[]>([]);
  const [filter, setFilter] = useState<string>('ALL');
  const [query, setQuery] = useState('');
  /** Camp fee in baht from the settings panel; used in the note templates. */
  const [feeBaht, setFeeBaht] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [patching, setPatching] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Slip review state (an inline panel under the row, not a modal)
  const [inspectingApp, setInspectingApp] = useState<Application | null>(null);
  // Profile editor: an inline panel too. Only one panel (slip or editor) is open at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [verificationNote, setVerificationNote] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [slipImage, setSlipImage] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });

  // Focus bookkeeping: the slip panel / delete confirmation open in the previous render, and a
  // pending move to the ledger list after a delete (the deleted row's controls are gone).
  const prevSlipId = useRef<string | null>(null);
  const prevConfirmId = useRef<string | null>(null);
  const prevEditId = useRef<string | null>(null);
  const focusListAfterDelete = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);

  /* Hide what this role would only get 403 for (the server enforces it either way). A token with no
     readable role, i.e. the dev mock token, keeps the full dashboard as before. */
  const can = adminPermissions(role ?? 'superadmin');

  /** Expired or deactivated session: drop the token and show the login form again. */
  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiHttpError && err.status === 401) {
      tokenStore.clear();
      setToken(null);
      setRole(null);
      setApps([]);
      setInspectingApp(null);
      setEditingId(null);
      setError('เซสชันหมดอายุหรือบัญชีถูกระงับ กรุณาเข้าสู่ระบบอีกครั้ง');
      return true;
    }
    return false;
  }

  async function refresh(t: string) {
    setBusy(true);
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
    try {
      const res = await adminLogin(username, password);
      setPassword('');
      setToken(res.data.token);
      setRole(res.data.role ?? roleFromToken(res.data.token));
      setSource(res.source);
      await refresh(res.data.token);
    } catch (err) {
      setError(describeAdminError(err, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'));
    } finally {
      setBusy(false);
    }
  }

  async function onStatus(id: string, status: ApplicationStatus) {
    if (!token) return;
    setPatching(id);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await updateApplicationStatus(token, id, status);
      setApps((prev) => prev.map((a) => (a.id === id ? res.data : a)));
      setSource(res.source);
      setActionSuccess(`เปลี่ยนสถานะของ ${id} เป็น ${STATUS_LABELS[status]} สำเร็จ`);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(describeAdminError(err, 'เปลี่ยนสถานะไม่สำเร็จ'));
    } finally {
      setPatching(null);
    }
  }

  async function handleVerifySlip(approved: boolean) {
    if (!token || !inspectingApp) return;
    setVerifying(true);
    setError(null);
    setActionSuccess(null);
    try {
      // slipPaymentId pins the verdict to the slip that is on screen: a slip swapped in meanwhile
      // is refused (SLIP_CHANGED) instead of being approved unseen.
      const res = await verifyPaymentSlip(token, inspectingApp.id, approved, verificationNote, inspectingApp.slipPaymentId);
      setSource(res.source);

      const newStatus: ApplicationStatus = approved ? 'CONFIRMED' : 'PASSED';
      const newSlip: SlipStatus = approved ? 'APPROVED' : 'REJECTED';
      setApps((prev) =>
        prev.map((a) => (a.id === inspectingApp.id ? { ...a, status: newStatus, slipStatus: newSlip } : a)),
      );

      setActionSuccess(
        `${approved ? 'อนุมัติสลิปสำเร็จ' : 'ปฏิเสธสลิปแล้ว'}: ${res.data.message || inspectingApp.id}`,
      );
      setInspectingApp(null);
      setVerificationNote('');
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err instanceof ApiHttpError && err.code === 'SLIP_CHANGED') {
        // Close the stale slip and reload the list, so the next open shows the new slip.
        setInspectingApp(null);
        setVerificationNote('');
        listApplications(token)
          .then((res) => setApps(Array.isArray(res.data) ? res.data : []))
          .catch(() => undefined);
      }
      setError(describeAdminError(err, 'การตรวจสอบสลิปล้มเหลว'));
    } finally {
      setVerifying(false);
    }
  }

  async function handleDeleteApp(id: string, name: string) {
    if (!token) return;
    setDeletingId(id);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await deleteApplication(token, id);
      setApps((prev) => prev.filter((a) => a.id !== id));
      focusListAfterDelete.current = true;
      if (inspectingApp?.id === id) setInspectingApp(null);
      if (editingId === id) setEditingId(null);
      setConfirmDeleteId(null);
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
    setEditingId(null);
    setInspectingApp((cur) => (cur?.id === a.id ? null : a));
    setVerificationNote('');
  }

  function toggleEdit(a: Application) {
    setInspectingApp(null);
    setConfirmDeleteId(null);
    setEditingId((cur) => (cur === a.id ? null : a.id));
  }

  function onProfileSaved(updated: Application) {
    setApps((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    setActionSuccess(`บันทึกการแก้ไขข้อมูลของ ${updated.id} เรียบร้อยแล้ว`);
    setEditingId(null);
  }

  function logout() {
    setToken(null);
    setRole(null);
    setApps([]);
    setInspectingApp(null);
    setEditingId(null);
    setQuery('');
    tokenStore.clear();
  }

  /** Records the export in audit_logs first; the file is built only once that succeeded. */
  async function exportCsv() {
    if (!token || exporting) return;
    const rows = visible;
    setExporting(true);
    setActionSuccess(null);
    setError(null);
    try {
      await recordCsvExport(token, {
        applicationIds: rows.map((a) => a.id),
        statusFilter: filter === 'ALL' ? undefined : (filter as ApplicationStatus),
        searchFiltered: searching,
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

  useEffect(() => {
    try {
      localStorage.removeItem(TOKEN_KEY); // migrate away from the old persistent token
    } catch {
      /* ignore */
    }
    const saved = tokenStore.get();
    if (saved) {
      setToken(saved);
      setRole(roleFromToken(saved));
      refresh(saved);
    }
  }, []);

  useEffect(() => {
    if (token) tokenStore.set(token);
  }, [token]);

  /* Slips are served only to an authenticated admin, so fetch the image with the token and show
     it from an object URL (revoked when the panel closes). */
  useEffect(() => {
    if (!token || !inspectingApp) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setSlipImage({ url: null, error: null });
    fetchAdminSlip(token, inspectingApp.id)
      .then((url) => {
        if (cancelled) return URL.revokeObjectURL(url);
        objectUrl = url;
        setSlipImage({ url, error: null });
      })
      .catch((err) => {
        if (cancelled || handleAuthError(err)) return;
        setSlipImage({ url: null, error: err instanceof Error ? err.message : 'โหลดรูปสลิปไม่สำเร็จ' });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      // Drop the revoked URL too, so reopening the panel never renders an <img> pointing at it.
      setSlipImage({ url: null, error: null });
    };
  }, [token, inspectingApp?.id]);

  /* Escape closes the open slip panel or delete confirmation. */
  useEffect(() => {
    if (!inspectingApp && !confirmDeleteId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInspectingApp(null);
        setConfirmDeleteId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspectingApp, confirmDeleteId]);

  /* Keyboard focus should never fall to <body>: closing the slip panel or the delete confirmation
     returns focus to the control that opened it; after a delete it moves to the ledger list. */
  useEffect(() => {
    const nowSlip = inspectingApp?.id ?? null;
    if (prevSlipId.current && !nowSlip) {
      document.getElementById(`slip-btn-${prevSlipId.current}`)?.focus();
    }
    if (prevConfirmId.current && !confirmDeleteId) {
      document.getElementById(`delete-btn-${prevConfirmId.current}`)?.focus();
    }
    if (prevEditId.current && !editingId) {
      document.getElementById(`edit-btn-${prevEditId.current}`)?.focus();
    }
    prevSlipId.current = nowSlip;
    prevConfirmId.current = confirmDeleteId;
    prevEditId.current = editingId;
  }, [inspectingApp, confirmDeleteId, editingId]);

  useEffect(() => {
    if (!focusListAfterDelete.current) return;
    focusListAfterDelete.current = false;
    listRef.current?.focus();
  }, [apps]);

  /* Newest first, ties broken by id, so the order is stable across refreshes whatever the API returns. */
  const sorted = [...apps].sort(
    (x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? '') || x.id.localeCompare(y.id),
  );
  const byTab = filter === 'ALL' ? sorted : sorted.filter((a) => a.status === filter);
  const visible = byTab.filter((a) => matchesApplicantQuery(a, query));
  const searching = stripZeroWidth(query).trim() !== '';
  const count = (s: ApplicationStatus) => apps.filter((a) => a.status === s).length;
  const withSlip = apps.filter((a) => hasSlip(a)).length;
  /** Same rule the server uses for the seat quota: REJECTED, REFUND_PENDING and REFUNDED released theirs. */
  const currentCount = apps.filter((a) => holdsSeat(a.status)).length;
  /** First come, first served: a new application is PASSED and then waits for a slip or its review. */
  const awaitingPayment = count('PASSED') + count('PENDING');
  const countLabel = searching
    ? `พบ ${visible.length} จาก ${byTab.length} รายการ`
    : `${byTab.length} รายการ`;

  const inputCls = `${INPUT_BASE} rounded-xl`;
  const pillGhost = PILL_GHOST;

  const tabs: { key: string; label: string; n: number }[] = [
    { key: 'ALL', label: 'ทั้งหมด', n: apps.length },
    ...STATUSES.map((s) => ({ key: s, label: STATUS_LABELS[s], n: count(s) })),
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-24 pt-14 selection:bg-[color-mix(in_srgb,var(--color-tech)_25%,transparent)] sm:px-8 sm:pt-20">
      {/* ── Masthead ─────────────────────────────────────────── */}
      <header>
        <h1
          className="text-balance text-[2.25rem] font-bold leading-[1.22] sm:text-[3.25rem]"
          style={{ color: INK }}
        >
          {token ? 'ใบสมัครและสลิป' : 'สำหรับพี่ค่าย'}
        </h1>
        {token ? (
          <>
          <p className="mt-4 max-w-[60ch] text-base leading-[1.75]" style={{ color: INK_2 }}>
            ผู้สมัคร <span className="font-mono tabular-nums" style={{ color: INK }}>{apps.length}</span> คน
            {' · '}รอชำระ/รอตรวจสลิป <span className="font-mono tabular-nums" style={{ color: INK }}>{awaitingPayment}</span>
            {' · '}ยืนยันสิทธิ์แล้ว <span className="font-mono tabular-nums" style={{ color: INK }}>{count('CONFIRMED')}</span>
            {' · '}รอคืนเงิน <span className="font-mono tabular-nums" style={{ color: INK }}>{count('REFUND_PENDING')}</span>
            {' · '}แนบสลิปแล้ว <span className="font-mono tabular-nums" style={{ color: INK }}>{withSlip}</span>
          </p>
          {role && (
            <p className="mt-2 max-w-[60ch] text-sm leading-7" style={{ color: INK_3 }}>
              เข้าสู่ระบบในบทบาท <span className="font-mono" style={{ color: INK }}>{role}</span>
              {' · '}
              {ROLE_NOTE[role] ?? 'บทบาทนี้ไม่มีสิทธิ์ในระบบ กรุณาติดต่อผู้ดูแลระบบ'}
            </p>
          )}
          </>
        ) : (
          <p className="mt-4 max-w-[46ch] text-base leading-[1.75]" style={{ color: INK_2 }}>
            เข้าสู่ระบบเพื่อตรวจรายชื่อใบสมัคร เปลี่ยนสถานะ และอนุมัติหลักฐานการชำระเงิน
          </p>
        )}
      </header>

      {/* ── Notices: solid semantic bar fill for immediate visibility (AA contrast in light & dark) ── */}
      {error && (
        <div
          role="alert"
          className="mt-8 flex items-start justify-between gap-4 rounded-xl border px-4 py-3.5"
          style={{ backgroundColor: DANGER, borderColor: DANGER, color: 'var(--bg-canvas)' }}
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

      {actionSuccess && (
        <div
          role="status"
          className="mt-8 flex items-start justify-between gap-4 rounded-xl border px-4 py-3.5"
          style={{ backgroundColor: SUCCESS, borderColor: SUCCESS, color: '#121316' }}
        >
          <p className="flex items-start gap-2.5 text-sm font-semibold leading-7">
            <CircleCheck aria-hidden="true" size={18} strokeWidth={1.75} className="mt-1 shrink-0" />
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

      {!token ? (
        /* ── Login: a single quiet column ─────────────────────── */
        <section className="mt-14 max-w-sm">
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
              <input
                id="admin-pass"
                className={inputCls}
                style={{ borderColor: INPUT_BORDER, color: INK }}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className={`mt-10 w-full rounded-full px-5 py-3.5 text-base font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
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
            onAuthError={handleAuthError}
            onSettings={(s: AdminSettings) => setFeeBaht(Number(s.campFee))}
          />

          {/* ── Ledger ───────────────────────────────────────────── */}
          <section className="mt-12" aria-busy={busy}>
            {/* Filter as text tabs; refresh / sign out as quiet pills */}
            <div
              className="flex flex-col gap-4 border-b pb-3 md:flex-row md:items-end md:justify-between"
              style={{ borderColor: INK }}
            >
              <div role="group" aria-label="กรองตามสถานะ" className="-mx-1 flex gap-x-6 gap-y-1 overflow-x-auto px-1 pb-1">
                {tabs.map((t) => {
                  const active = filter === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFilter(t.key)}
                      className={`shrink-0 whitespace-nowrap rounded-none border-b-2 py-1 text-sm transition-colors ${FOCUS}`}
                      style={{
                        color: active ? INK : INK_3,
                        fontWeight: active ? 600 : 400,
                        borderColor: active ? INK : 'transparent',
                      }}
                    >
                      {t.label} <span className="font-mono text-xs tabular-nums">{t.n}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {busy && (
                  <span className="mr-1 text-xs" style={{ color: INK_3 }}>
                    กำลังโหลด…
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => token && refresh(token)}
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

            {/* Search and export */}
            <div
              className="flex flex-col gap-3 border-b py-4 sm:flex-row sm:items-center sm:justify-between"
              style={{ borderColor: RULE }}
            >
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
                  placeholder="ค้นหารหัส ชื่อ ชื่อเล่น เบอร์ โรงเรียน หรือจังหวัด"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="search"
                  className={`${INPUT_BASE} rounded-full pl-10 ${searching ? 'pr-10' : 'pr-4'}`}
                  style={{ borderColor: INPUT_BORDER, color: INK }}
                />
                {searching && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="ล้างคำค้นหา"
                    className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 ${FOCUS}`}
                    style={{ color: INK_2 }}
                  >
                    <X aria-hidden="true" strokeWidth={1.5} size={16} />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
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
                const open = inspectingApp?.id === a.id;
                const editing = editingId === a.id;
                // REJECTED / REFUND_PENDING / REFUNDED: the slip stays viewable but cannot be settled.
                const slipLocked = !holdsSeat(a.status);
                return (
                  <li key={a.id} className="border-b" style={{ borderColor: RULE }}>
                    <div className="grid gap-x-8 gap-y-3 py-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_13.5rem] md:items-start">
                      {/* Who */}
                      <div className="min-w-0">
                        <p className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                          {a.id}
                        </p>
                        <p className="mt-1 text-base font-semibold leading-7" style={{ color: INK }}>
                          {a.fullName}
                          {a.nickname ? (
                            <span className="font-normal" style={{ color: INK_3 }}>
                              {' '}({a.nickname})
                            </span>
                          ) : null}
                        </p>
                        <p className="text-sm leading-7" style={{ color: INK_2 }}>
                          <span className="font-mono tabular-nums">{a.phone}</span>
                          {a.email ? <span style={{ color: INK_3 }}> · {a.email}</span> : null}
                        </p>
                      </div>

                      {/* Where */}
                      <div className="min-w-0 text-sm leading-7" style={{ color: INK_2 }}>
                        <p>{a.school}</p>
                        <p style={{ color: INK_3 }}>
                          {a.grade}
                          {a.province ? ` · ${a.province}` : ''} · ไซส์ {a.shirtSize}
                        </p>
                      </div>

                      {/* State + actions */}
                      <div className="flex flex-col items-start gap-2">
                        {can.changeStatus ? (
                          <StatusSelect
                            app={a}
                            disabled={patching === a.id || deletingId === a.id}
                            onChange={(status) => onStatus(a.id, status)}
                          />
                        ) : (
                          <p className="inline-flex items-center gap-2 py-0.5 text-sm leading-7" style={{ color: INK }}>
                            <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: STATUS_DOT[a.status] }}>
                              ●
                            </span>
                            {STATUS_LABELS[a.status]}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <SlipBadge app={a} />
                          {slip && can.viewSlip && (
                            <button
                              id={`slip-btn-${a.id}`}
                              type="button"
                              aria-expanded={open}
                              onClick={() => openSlip(a)}
                              className={`rounded-sm py-0.5 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
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
                            className={`inline-flex items-center gap-1 rounded-sm py-0.5 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
                            style={{ color: TECH }}
                          >
                            <Pencil size={13} strokeWidth={1.5} aria-hidden="true" />
                            {editing ? 'ซ่อนการแก้ไข' : 'แก้ไขข้อมูล'}
                          </button>
                          )}
                          {can.deleteApplication && (confirmDeleteId === a.id ? (
                            <div className="inline-flex items-center gap-1.5" role="group" aria-label={`ยืนยันการลบ ${a.id}`}>
                              <button
                                type="button"
                                disabled={deletingId === a.id}
                                onClick={() => handleDeleteApp(a.id, a.fullName)}
                                className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                                style={{ borderColor: DANGER, color: DANGER }}
                              >
                                {deletingId === a.id ? 'กำลังลบ…' : 'ยืนยันลบ'}
                              </button>
                              <button
                                type="button"
                                disabled={deletingId === a.id}
                                onClick={() => setConfirmDeleteId(null)}
                                className={`rounded-full px-2 py-1 text-xs underline underline-offset-2 ${FOCUS}`}
                                style={{ color: INK_3 }}
                              >
                                ยกเลิก
                              </button>
                            </div>
                          ) : (
                            <button
                              id={`delete-btn-${a.id}`}
                              type="button"
                              disabled={deletingId === a.id}
                              onClick={() => setConfirmDeleteId(a.id)}
                              className={`inline-flex items-center gap-1 rounded-sm py-0.5 text-sm font-semibold underline underline-offset-4 transition-colors hover:opacity-80 disabled:opacity-50 ${FOCUS}`}
                              style={{ color: DANGER }}
                              title={`ลบใบสมัคร ${a.id}`}
                            >
                              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
                              ลบ
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Profile editor: expands under its own row */}
                    {editing && token && can.editProfile && (
                      <AdminProfileEditor
                        app={a}
                        token={token}
                        onSaved={onProfileSaved}
                        onClose={() => setEditingId(null)}
                        onAuthError={handleAuthError}
                      />
                    )}

                    {/* Slip review: expands under its own row */}
                    {open && can.viewSlip && (
                      <div
                        className="grid gap-8 border-t py-6 md:grid-cols-[minmax(0,20rem)_1fr]"
                        style={{ borderColor: RULE }}
                        role="region"
                        aria-label={`ตรวจสอบหลักฐานการชำระเงิน ${a.id}`}
                      >
                        <div>
                          <div
                            className="flex min-h-48 items-center justify-center"
                            style={{ backgroundColor: SURFACE_SUBTLE }}
                          >
                            {slipImage.url ? (
                              <img
                                src={slipImage.url}
                                alt={`สลิปโอนเงินของ ${a.id}`}
                                className="max-h-96 w-full object-contain"
                              />
                            ) : (
                              <p
                                className="px-4 py-10 text-center text-sm leading-7"
                                role={slipImage.error ? 'alert' : undefined}
                                style={{ color: slipImage.error ? DANGER : INK_3 }}
                              >
                                {slipImage.error ?? 'กำลังโหลดรูปสลิป…'}
                              </p>
                            )}
                          </div>
                          {slipImage.url && (
                            <a
                              href={slipImage.url}
                              target="_blank"
                              rel="noreferrer"
                              className={`mt-1 inline-block rounded-sm py-1 text-sm underline underline-offset-4 ${FOCUS}`}
                              style={{ color: TECH }}
                            >
                              เปิดรูปขนาดเต็ม
                            </a>
                          )}
                        </div>

                        <div className="flex min-w-0 flex-col">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <h2 className="text-lg font-bold leading-[1.35]" style={{ color: INK }}>
                              หลักฐานการชำระเงิน
                            </h2>
                            <SlipBadge app={a} />
                          </div>
                          <p className="mt-1 text-sm leading-7" style={{ color: INK_3 }}>
                            {slipLocked
                              ? `ใบสมัครนี้อยู่ในสถานะ “${STATUS_LABELS[a.status]}” จึงอนุมัติหรือปฏิเสธสลิปไม่ได้ ยังดูรูปสลิปเพื่อทำบัญชีได้ตามปกติ`
                              : 'อนุมัติแล้วสถานะจะเป็นยืนยันสิทธิ์สมบูรณ์ ปฏิเสธแล้วจะกลับเป็นได้รับสิทธิ์เพื่อให้ส่งสลิปใหม่'}
                          </p>

                          {!slipLocked && can.verifySlip && (
                          <>
                          <label
                            className="mb-2 mt-6 block text-sm font-semibold"
                            style={{ color: INK }}
                            htmlFor="verify-note"
                          >
                            หมายเหตุเจ้าหน้าที่
                          </label>
                          <input
                            id="verify-note"
                            className={inputCls}
                            style={{ borderColor: INPUT_BORDER, color: INK }}
                            placeholder="เช่น ยอดเงินถูกต้องครบถ้วน"
                            value={verificationNote}
                            onChange={(e) => setVerificationNote(e.target.value)}
                          />
                          <div role="group" aria-label="ข้อความหมายเหตุสำเร็จรูป" className="mt-3 flex flex-wrap gap-2">
                            {noteTemplates(feeBaht).map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setVerificationNote(t)}
                                className={`rounded-full border px-3 py-1.5 text-xs leading-5 transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
                                style={{ borderColor: RULE, color: INK_2 }}
                              >
                                {t}
                              </button>
                            ))}
                          </div>

                          <div className="mt-6 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              disabled={verifying}
                              onClick={() => handleVerifySlip(true)}
                              className={`rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                              style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                            >
                              {verifying ? 'กำลังบันทึก…' : 'อนุมัติสลิป'}
                            </button>
                            <button
                              type="button"
                              disabled={verifying}
                              onClick={() => handleVerifySlip(false)}
                              className={`rounded-full border px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                              style={{ borderColor: DANGER, color: DANGER }}
                            >
                              ปฏิเสธสลิป
                            </button>
                            <button
                              type="button"
                              onClick={() => setInspectingApp(null)}
                              className={`rounded-full px-3 py-2.5 text-sm underline underline-offset-4 ${FOCUS}`}
                              style={{ color: INK_2 }}
                            >
                              ปิด
                            </button>
                          </div>
                          </>
                          )}
                          {(slipLocked || !can.verifySlip) && (
                            <div className="mt-6">
                              <button
                                type="button"
                                onClick={() => setInspectingApp(null)}
                                className={`rounded-full border px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
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

            {!busy && visible.length === 0 &&
              (searching ? (
                <div className="py-16">
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
                </div>
              ) : (
                <p className="py-16 text-base leading-[1.75]" style={{ color: INK_3 }}>
                  {apps.length === 0
                    ? 'ยังไม่มีใบสมัครเข้ามา เมื่อมีผู้สมัครรายชื่อจะแสดงที่นี่'
                    : 'ไม่มีใบสมัครในสถานะนี้'}
                </p>
              ))}

            {source && (
              <p className="mt-8 text-xs" style={{ color: INK_3 }}>
                แหล่งข้อมูล <span className="font-mono tabular-nums">{source}</span>
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
