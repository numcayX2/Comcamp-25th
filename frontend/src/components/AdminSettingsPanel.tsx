import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, CircleCheck, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  ApiHttpError,
  fetchAdminSettings,
  fetchPublicSettings,
  updateAdminSettings,
  type AdminSettings,
  type UpdateAdminSettingsPayload,
} from '../lib/api';
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
  WARNING,
} from './admin-ui';

/** Seat quota ceiling (backend: maxCapacity 1–1000). */
const MAX_CAPACITY = 1000;
/** Fee ceiling in baht (backend: campFee 0–100000). */
const MAX_FEE = 100000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const numberFmt = new Intl.NumberFormat('en-US');
const BANGKOK_PREVIEW_FMT = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

type Notice = { kind: 'ok' | 'error'; text: string } | null;
type FieldErrors = {
  quota?: string;
  fee?: string;
  openAt?: string;
  closeAt?: string;
  certReleaseAt?: string;
};

interface Props {
  token: string;
  /** Kept optional for caller compatibility; backend restricts all admin endpoints to role "admin". */
  canEdit?: boolean;
  /** Applicants who are not rejected. This is the count the server checks the quota against. */
  currentCount: number;
  /** Incremented by parent when staff clicks ledger "รีเฟรช" so settings stay in sync. */
  refreshSignal?: number;
  /** Returns true when the error was an expired session, in which case the parent has logged out. */
  onAuthError: (err: unknown) => boolean;
  /** Reports each settings snapshot so the parent can use the fee elsewhere. */
  onSettings?: (s: AdminSettings) => void;
}

/** Formats an ISO/RFC3339 timestamp into an `<input type="datetime-local">` value in Asia/Bangkok (+07:00). */
function toBangkokDatetimeInput(iso?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + BANGKOK_OFFSET_MS).toISOString().slice(0, 16);
}

/** Converts a `<input type="datetime-local">` value (Asia/Bangkok) to RFC3339 (+07:00) for Go `time.RFC3339`. */
function fromBangkokDatetimeInput(local: string): string | null {
  const trimmed = local.trim();
  if (!DATETIME_LOCAL_RE.test(trimmed)) return null;
  const rfc = `${trimmed.slice(0, 16)}:00+07:00`;
  return Number.isFinite(Date.parse(rfc)) ? rfc : null;
}

/** Renders an unambiguous Bangkok (+07:00) 24-hour preview with CE year to prevent BE/12h confusion. */
function formatBangkokPreview(local: string): string | null {
  const rfc = fromBangkokDatetimeInput(local);
  if (!rfc) return null;
  const ms = Date.parse(rfc);
  if (!Number.isFinite(ms)) return null;
  const ceYear = new Date(ms + BANGKOK_OFFSET_MS).getUTCFullYear();
  return `${BANGKOK_PREVIEW_FMT.format(new Date(ms))} น. (ค.ศ. ${ceYear}, +07:00)`;
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiHttpError) {
    if (err.status === 401 || err.status === 403) {
      return 'เซสชันหมดอายุหรือไม่เพียงพอ กรุณาเข้าสู่ระบบใหม่';
    }
    if (err.status === 429) {
      return err.retryAfterSeconds
        ? `ส่งคำขอบ่อยเกินไป กรุณารอ ${err.retryAfterSeconds} วินาทีแล้วลองใหม่`
        : 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
    if (err.code === 'VALIDATION_ERROR') {
      const msg = err.message.toLowerCase();
      if (msg.includes('registrationcloseat') || msg.includes('after registrationopenat')) {
        return 'วัน-เวลาปิดรับสมัครต้องอยู่หลังวัน-เวลาเปิดรับสมัคร';
      }
      if (msg.includes('rfc 3339') || msg.includes('registrationopenat') || msg.includes('certificatereleaseat')) {
        return 'รูปแบบวันและเวลาไม่ถูกต้อง กรุณาเลือกวัน-เวลาใหม่อีกครั้ง';
      }
      if (msg.includes('capacity') || msg.includes('quota')) {
        return 'จำนวนโควตาต้องไม่ต่ำกว่าจำนวนผู้สมัครปัจจุบัน และไม่เกิน 1,000 ที่นั่ง';
      }
      if (msg.includes('fee')) {
        return 'ค่าสมัครต้องอยู่ในช่วง 0 ถึง 100,000 บาท';
      }
      if (msg.includes('no settings')) {
        return 'กรุณาแก้ไขอย่างน้อย 1 รายการก่อนบันทึก';
      }
      return 'ข้อมูลการตั้งค่าไม่ถูกต้องตามเงื่อนไข';
    }
    if (err.status >= 500) return 'เซิร์ฟเวอร์ขัดข้องชั่วคราว ไม่สามารถบันทึกได้';
  }
  if (err instanceof Error && (err.message.includes('fetch') || err.message.includes('network'))) {
    return 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสัญญาณอินเทอร์เน็ต';
  }
  return fallback;
}

function NoticeBanner({ notice, announced = true }: { notice: NonNullable<Notice>; announced?: boolean }) {
  return (
    <p
      role={announced ? (notice.kind === 'error' ? 'alert' : 'status') : undefined}
      aria-hidden={announced ? undefined : true}
      className="flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm leading-6 md:col-span-2"
      style={{
        borderColor: notice.kind === 'error' ? DANGER : SUCCESS,
        backgroundColor: SURFACE_SUBTLE,
        color: notice.kind === 'error' ? DANGER : INK,
      }}
    >
      {notice.kind === 'ok' ? (
        <CircleCheck aria-hidden="true" size={16} strokeWidth={2} className="mt-1 shrink-0" style={{ color: SUCCESS }} />
      ) : (
        <TriangleAlert aria-hidden="true" size={16} strokeWidth={2} className="mt-1 shrink-0" style={{ color: DANGER }} />
      )}
      <span>{notice.text}</span>
    </p>
  );
}

/**
 * Collapsible control panel for camp admins: registration schedule, certificate release time,
 * seat quota, camp fee, and the emergency switch.
 */
export function AdminSettingsPanel({
  token,
  canEdit = true,
  currentCount,
  refreshSignal = 0,
  onAuthError,
  onSettings,
}: Props) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The server's own verdict (isOpen from /settings/public). null means the server did not answer. */
  const [acceptingNow, setAcceptingNow] = useState<boolean | null>(null);
  const [quotaInput, setQuotaInput] = useState('');
  const [feeInput, setFeeInput] = useState('');
  const [openAtInput, setOpenAtInput] = useState('');
  const [closeAtInput, setCloseAtInput] = useState('');
  const [certReleaseInput, setCertReleaseInput] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirmToggleClosed, setConfirmToggleClosed] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const settingsRef = useRef<AdminSettings | null>(null);
  const inputsRef = useRef({ quotaInput, feeInput, openAtInput, closeAtInput, certReleaseInput });
  inputsRef.current = { quotaInput, feeInput, openAtInput, closeAtInput, certReleaseInput };

  const quotaFloor = Math.max(1, currentCount);
  const closed = settings?.isManualClosed ?? false;
  const statusLabel =
    acceptingNow === null ? 'ไม่ทราบสถานะ' : acceptingNow ? 'เปิดรับสมัคร' : 'ปิดรับสมัคร';
  const statusDot = acceptingNow === null ? INK_3 : acceptingNow ? SUCCESS : DANGER;
  const feeNum = settings ? Number(settings.campFee) : NaN;
  const feeShown = settings && Number.isFinite(feeNum) ? numberFmt.format(feeNum) : '–';

  const openPreview = formatBangkokPreview(openAtInput);
  const closePreview = formatBangkokPreview(closeAtInput);
  const certPreview = formatBangkokPreview(certReleaseInput);

  function isFormDirty(s: AdminSettings | null): boolean {
    if (!s) return false;
    const cur = inputsRef.current;
    const parsedFee = Number(s.campFee);
    const savedFee = Number.isFinite(parsedFee) ? String(parsedFee) : '0';
    return (
      cur.quotaInput !== String(s.maxCapacity) ||
      cur.feeInput !== savedFee ||
      cur.openAtInput !== toBangkokDatetimeInput(s.registrationOpenAt) ||
      cur.closeAtInput !== toBangkokDatetimeInput(s.registrationCloseAt) ||
      cur.certReleaseInput !== toBangkokDatetimeInput(s.certificateReleaseAt)
    );
  }

  function receive(s: AdminSettings) {
    settingsRef.current = s;
    setSettings(s);
    onSettings?.(s);
  }

  function resetInputs(s: AdminSettings) {
    setQuotaInput(String(s.maxCapacity));
    const parsedFee = Number(s.campFee);
    setFeeInput(Number.isFinite(parsedFee) ? String(parsedFee) : '0');
    setOpenAtInput(toBangkokDatetimeInput(s.registrationOpenAt));
    setCloseAtInput(toBangkokDatetimeInput(s.registrationCloseAt));
    setCertReleaseInput(toBangkokDatetimeInput(s.certificateReleaseAt));
    setFieldErrors({});
  }

  async function refreshStatus(fresh = false) {
    const pub = await fetchPublicSettings({ fresh });
    setAcceptingNow(pub.live ? pub.settings.isOpen : null);
  }

  useEffect(() => {
    let cancelled = false;
    const hadLoaded = settingsRef.current !== null;
    const dirtyBeforeRefresh = hadLoaded && isFormDirty(settingsRef.current);

    fetchAdminSettings(token)
      .then((res) => {
        if (cancelled) return;
        receive(res.data);
        if (!dirtyBeforeRefresh) {
          resetInputs(res.data);
        }
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled || onAuthError(err)) return;
        setLoadError(errorText(err, 'โหลดการตั้งค่าไม่สำเร็จ'));
      });
    refreshStatus(refreshSignal > 0);
    return () => {
      cancelled = true;
    };
  }, [token, refreshSignal]);

  useEffect(() => {
    if (!confirmToggleClosed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !toggling) {
        setConfirmToggleClosed(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmToggleClosed, toggling]);

  /** Validates schedule, quota, and fee before submitting. Returns null when a field is invalid. */
  function checkInputs(): UpdateAdminSettingsPayload | null {
    const next: FieldErrors = {};
    const quota = Number(quotaInput);
    const feeTrim = feeInput.trim();
    const fee = Number(feeTrim);

    if (quotaInput.trim() === '' || !Number.isInteger(quota)) {
      next.quota = 'กรุณากรอกจำนวนที่นั่งเป็นจำนวนเต็ม';
    } else if (quota < quotaFloor) {
      next.quota = `ตั้งต่ำกว่าจำนวนผู้สมัครปัจจุบัน (${currentCount} คน) ไม่ได้`;
    } else if (quota > MAX_CAPACITY) {
      next.quota = `ตั้งได้สูงสุด ${MAX_CAPACITY} ที่นั่ง`;
    }

    if (
      feeTrim === '' ||
      !Number.isFinite(fee) ||
      !/^\d+(\.\d{1,2})?$/.test(feeTrim) ||
      fee < 0 ||
      fee > MAX_FEE
    ) {
      next.fee = `ค่าสมัครต้องอยู่ระหว่าง 0 ถึง ${numberFmt.format(MAX_FEE)} บาท (ทศนิยมได้ไม่เกิน 2 ตำแหน่ง)`;
    }

    const openRfc = openAtInput.trim() ? fromBangkokDatetimeInput(openAtInput) : null;
    const closeRfc = closeAtInput.trim() ? fromBangkokDatetimeInput(closeAtInput) : null;

    if (!openAtInput.trim()) {
      next.openAt = 'กรุณาระบุวัน-เวลาเปิดรับสมัคร';
    } else if (!openRfc) {
      next.openAt = 'รูปแบบวัน-เวลาเปิดรับสมัครไม่ถูกต้อง';
    }

    if (!closeAtInput.trim()) {
      next.closeAt = 'กรุณาระบุวัน-เวลาปิดรับสมัคร';
    } else if (!closeRfc) {
      next.closeAt = 'รูปแบบวัน-เวลาปิดรับสมัครไม่ถูกต้อง';
    } else if (openRfc && Date.parse(closeRfc) <= Date.parse(openRfc)) {
      next.closeAt = 'วัน-เวลาปิดรับสมัครต้องอยู่หลังวัน-เวลาเปิดรับสมัคร';
    }

    let certRfc: string | undefined;
    const certTrim = certReleaseInput.trim();
    if (certTrim) {
      const parsed = fromBangkokDatetimeInput(certTrim);
      if (!parsed) {
        next.certReleaseAt = 'รูปแบบวัน-เวลาปล่อยเกียรติบัตรไม่ถูกต้อง';
      } else {
        certRfc = parsed;
      }
    } else if (settings?.certificateReleaseAt) {
      next.certReleaseAt = 'ระบบยังไม่รองรับการล้างเวลาปล่อยเกียรติบัตรที่ตั้งไว้แล้ว กรุณาเลือกวัน-เวลาใหม่หรือกดคืนค่าเดิม';
    }

    setFieldErrors(next);
    const orderedFields: Array<[keyof FieldErrors, string]> = [
      ['openAt', 'open-at-input'],
      ['closeAt', 'close-at-input'],
      ['certReleaseAt', 'cert-release-input'],
      ['quota', 'quota-input'],
      ['fee', 'fee-input'],
    ];
    const firstBad = orderedFields.find(([k]) => Boolean(next[k]));
    if (firstBad) {
      const firstMsg = next[firstBad[0]] ?? 'กรุณาตรวจสอบข้อมูลการตั้งค่าที่ระบุไม่ถูกต้อง';
      setNotice({ kind: 'error', text: `ไม่สามารถบันทึกได้: ${firstMsg}` });
      document.getElementById(firstBad[1])?.focus();
      return null;
    }

    const payload: UpdateAdminSettingsPayload = {
      maxCapacity: quota,
      campFee: Math.round(fee * 100) / 100,
    };
    if (openRfc) payload.registrationOpenAt = openRfc;
    if (closeRfc) payload.registrationCloseAt = closeRfc;
    if (certRfc) payload.certificateReleaseAt = certRfc;
    return payload;
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    const payload = checkInputs();
    if (!payload) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await updateAdminSettings(token, payload);
      receive(res.data);
      resetInputs(res.data);
      const savedFee = Number(res.data.campFee);
      setNotice({
        kind: 'ok',
        text: `บันทึกแล้ว: ${numberFmt.format(res.data.maxCapacity)} ที่นั่ง · ค่าสมัคร ${numberFmt.format(Number.isFinite(savedFee) ? savedFee : 0)} บาท`,
      });
      refreshStatus(true);
    } catch (err) {
      if (onAuthError(err)) return;
      setNotice({ kind: 'error', text: `บันทึกไม่สำเร็จ: ${errorText(err, 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')}` });
    } finally {
      setSaving(false);
    }
  }

  /** Confirmed emergency switch mutation; runs independently of the schedule/quota form. */
  async function confirmEmergencyToggle() {
    if (!settings || !canEdit || toggling) return;
    const next = !settings.isManualClosed;
    setToggling(true);
    setNotice(null);
    try {
      const res = await updateAdminSettings(token, { isManualClosed: next });
      receive(res.data);
      setConfirmToggleClosed(false);
      setNotice({
        kind: 'ok',
        text: next
          ? 'ปิดรับสมัครฉุกเฉินแล้ว ผู้สมัครใหม่จะถูกปฏิเสธ'
          : 'ยกเลิกการปิดฉุกเฉินแล้ว การรับสมัครเป็นไปตามกำหนดการ',
      });
      refreshStatus(true);
    } catch (err) {
      if (onAuthError(err)) return;
      setNotice({ kind: 'error', text: `เปลี่ยนสถานะไม่สำเร็จ: ${errorText(err, 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')}` });
    } finally {
      setToggling(false);
    }
  }

  const panelId = 'admin-settings-body';

  return (
    <section className="mt-12 border-y" style={{ borderColor: RULE }} aria-label="ตั้งค่าการรับสมัคร">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-11 w-full flex-col gap-2 rounded-none py-4 text-left sm:flex-row sm:items-center sm:justify-between sm:gap-6 ${FOCUS}`}
      >
        <span className="text-base font-semibold leading-7" style={{ color: INK }}>
          ตั้งค่าการรับสมัคร
        </span>
        <span className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm leading-7" style={{ color: INK_2 }}>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: statusDot }} />
            {statusLabel}
            {closed ? <span style={{ color: DANGER }}>(ปิดฉุกเฉิน)</span> : null}
          </span>
          <span>
            ที่นั่ง{' '}
            <span className="font-mono tabular-nums" style={{ color: INK }}>
              {currentCount} / {settings?.maxCapacity ?? '–'}
            </span>
          </span>
          <span>
            ค่าสมัคร{' '}
            <span className="font-mono tabular-nums" style={{ color: INK }}>
              {feeShown}
            </span>{' '}
            บาท
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.5}
          size={18}
          className={`hidden shrink-0 transition-transform sm:block motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          style={{ color: INK_3 }}
        />
      </button>

      {open && (
        <div id={panelId} className="grid gap-x-12 gap-y-6 pb-8 md:grid-cols-2">
          {loadError && (
            <p role="alert" className="text-sm leading-7 md:col-span-2" style={{ color: DANGER }}>
              {loadError}
            </p>
          )}
          {!settings && !loadError && (
            <p className="text-sm leading-7 md:col-span-2" style={{ color: INK_3 }}>
              กำลังโหลดการตั้งค่า…
            </p>
          )}

          {notice && <NoticeBanner notice={notice} announced />}

          {settings && (
            <>
              <form onSubmit={onSave} noValidate aria-busy={saving} className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="open-at-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
                      เปิดรับสมัคร (เวลาไทย)
                    </label>
                    <input
                      id="open-at-input"
                      type="datetime-local"
                      value={openAtInput}
                      onChange={(e) => {
                        setOpenAtInput(e.target.value);
                        setFieldErrors((prev) => ({ ...prev, openAt: undefined, closeAt: undefined }));
                      }}
                      disabled={!canEdit}
                      aria-invalid={fieldErrors.openAt ? true : undefined}
                      aria-describedby={fieldErrors.openAt ? 'open-at-preview open-at-error' : 'open-at-preview'}
                      className={`${INPUT_BASE} min-h-11 rounded-xl font-mono text-sm tabular-nums`}
                      style={{ borderColor: fieldErrors.openAt ? DANGER : INPUT_BORDER, color: INK }}
                    />
                    <p id="open-at-preview" className="mt-1.5 text-xs leading-5" style={{ color: INK_3 }}>
                      {openPreview ?? 'ยังไม่ระบุเวลาเปิดรับสมัคร'}
                    </p>
                    {fieldErrors.openAt && (
                      <p id="open-at-error" className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
                        {fieldErrors.openAt}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="close-at-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
                      ปิดรับสมัคร (เวลาไทย)
                    </label>
                    <input
                      id="close-at-input"
                      type="datetime-local"
                      value={closeAtInput}
                      onChange={(e) => {
                        setCloseAtInput(e.target.value);
                        setFieldErrors((prev) => ({ ...prev, closeAt: undefined }));
                      }}
                      disabled={!canEdit}
                      aria-invalid={fieldErrors.closeAt ? true : undefined}
                      aria-describedby={fieldErrors.closeAt ? 'close-at-preview close-at-error' : 'close-at-preview'}
                      className={`${INPUT_BASE} min-h-11 rounded-xl font-mono text-sm tabular-nums`}
                      style={{ borderColor: fieldErrors.closeAt ? DANGER : INPUT_BORDER, color: INK }}
                    />
                    <p id="close-at-preview" className="mt-1.5 text-xs leading-5" style={{ color: INK_3 }}>
                      {closePreview ?? 'ยังไม่ระบุเวลาปิดรับสมัคร'}
                    </p>
                    {fieldErrors.closeAt && (
                      <p id="close-at-error" className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
                        {fieldErrors.closeAt}
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <label htmlFor="cert-release-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
                    วัน-เวลาปล่อยเกียรติบัตร (เวลาไทย{settings.certificateReleaseAt ? '' : ', ไม่บังคับ'})
                  </label>
                  <input
                    id="cert-release-input"
                    type="datetime-local"
                    value={certReleaseInput}
                    onChange={(e) => {
                      setCertReleaseInput(e.target.value);
                      setFieldErrors((prev) => ({ ...prev, certReleaseAt: undefined }));
                    }}
                    disabled={!canEdit}
                    aria-invalid={fieldErrors.certReleaseAt ? true : undefined}
                    aria-describedby={
                      fieldErrors.certReleaseAt ? 'cert-preview cert-help cert-error' : 'cert-preview cert-help'
                    }
                    className={`${INPUT_BASE} min-h-11 rounded-xl font-mono text-sm tabular-nums`}
                    style={{ borderColor: fieldErrors.certReleaseAt ? DANGER : INPUT_BORDER, color: INK }}
                  />
                  <p id="cert-preview" className="mt-1.5 text-xs leading-5" style={{ color: INK_3 }}>
                    {certPreview ?? 'ยังไม่กำหนดเวลาปล่อยเกียรติบัตร'}
                  </p>
                  <p id="cert-help" className="mt-1.5 text-sm leading-6" style={{ color: INK_3 }}>
                    {settings.certificateReleaseAt
                      ? 'ผู้สมัครที่ยืนยันสิทธิ์แล้วจะดาวน์โหลดเกียรติบัตรได้เมื่อถึงเวลาที่กำหนด (เมื่อตั้งค่าแล้วระบบยังไม่รองรับการล้างให้ว่าง แต่สามารถเปลี่ยนเป็นเวลาอื่นได้)'
                      : 'ผู้สมัครที่ยืนยันสิทธิ์แล้วจะดาวน์โหลดเกียรติบัตรได้เมื่อถึงเวลาที่กำหนด (เว้นว่างไว้ได้หากยังไม่กำหนด)'}
                  </p>
                  {fieldErrors.certReleaseAt && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <p id="cert-error" className="text-sm leading-6" style={{ color: DANGER }}>
                        {fieldErrors.certReleaseAt}
                      </p>
                      {settings.certificateReleaseAt && !certReleaseInput.trim() && (
                        <button
                          type="button"
                          onClick={() => {
                            setCertReleaseInput(toBangkokDatetimeInput(settings.certificateReleaseAt));
                            setFieldErrors((prev) => ({ ...prev, certReleaseAt: undefined }));
                          }}
                          className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${FOCUS}`}
                          style={{ borderColor: RULE, color: INK }}
                        >
                          <RotateCcw aria-hidden="true" size={13} strokeWidth={1.75} />
                          คืนค่าเวลาเดิม
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label htmlFor="quota-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
                    โควตาที่นั่ง
                  </label>
                  <input
                    id="quota-input"
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={quotaFloor}
                    max={MAX_CAPACITY}
                    value={quotaInput}
                    onChange={(e) => {
                      setQuotaInput(e.target.value);
                      setFieldErrors((prev) => ({ ...prev, quota: undefined }));
                    }}
                    disabled={!canEdit}
                    aria-invalid={fieldErrors.quota ? true : undefined}
                    aria-describedby={fieldErrors.quota ? 'quota-help quota-error' : 'quota-help'}
                    className={`${INPUT_BASE} min-h-11 rounded-xl font-mono tabular-nums`}
                    style={{ borderColor: fieldErrors.quota ? DANGER : INPUT_BORDER, color: INK }}
                  />
                  <p id="quota-help" className="mt-2 text-sm leading-7" style={{ color: INK_3 }}>
                    ตั้งต่ำกว่าจำนวนผู้สมัครปัจจุบัน ({currentCount} คน) ไม่ได้ ใช้ได้ตั้งแต่ {quotaFloor} ถึง{' '}
                    {numberFmt.format(MAX_CAPACITY)} ที่นั่ง
                  </p>
                  {fieldErrors.quota && (
                    <p id="quota-error" className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
                      {fieldErrors.quota}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="fee-input" className="mb-2 block text-sm font-semibold" style={{ color: INK }}>
                    ค่าสมัคร (บาท)
                  </label>
                  <input
                    id="fee-input"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min={0}
                    max={MAX_FEE}
                    value={feeInput}
                    onChange={(e) => {
                      setFeeInput(e.target.value);
                      setFieldErrors((prev) => ({ ...prev, fee: undefined }));
                    }}
                    disabled={!canEdit}
                    aria-invalid={fieldErrors.fee ? true : undefined}
                    aria-describedby={fieldErrors.fee ? 'fee-help fee-error' : 'fee-help'}
                    className={`${INPUT_BASE} min-h-11 rounded-xl font-mono tabular-nums`}
                    style={{ borderColor: fieldErrors.fee ? DANGER : INPUT_BORDER, color: INK }}
                  />
                  <p id="fee-help" className="mt-2 text-sm leading-7" style={{ color: INK_3 }}>
                    ค่าเริ่มต้นของค่ายคือ 1,000 บาท
                  </p>
                  {fieldErrors.fee && (
                    <p id="fee-error" className="mt-1 text-sm leading-6" style={{ color: DANGER }}>
                      {fieldErrors.fee}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={saving || !canEdit}
                    className={`inline-flex min-h-11 items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                    style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                  >
                    {saving ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      resetInputs(settings);
                      setNotice(null);
                    }}
                    className={PILL_GHOST}
                    style={{ borderColor: RULE, color: INK_2 }}
                  >
                    ยกเลิกการแก้ไข
                  </button>
                </div>
              </form>

              <div className="flex flex-col">
                <div className="border-b pb-6" style={{ borderColor: RULE }}>
                  <p className="text-sm leading-7" style={{ color: INK_2 }}>
                    สถานะการรับสมัคร
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-lg font-semibold leading-7" style={{ color: INK }}>
                    <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: statusDot }} />
                    {statusLabel}
                  </p>
                  <p className="mt-1 text-sm leading-7" style={{ color: INK_3 }}>
                    {acceptingNow === null
                      ? 'เซิร์ฟเวอร์ไม่ตอบสนอง ลองรีเฟรชหน้านี้อีกครั้ง'
                      : 'คำนวณจากเวลาของเซิร์ฟเวอร์และสวิตช์ปิดฉุกเฉิน'}
                  </p>
                  <p className="mt-6 text-sm leading-7" style={{ color: INK_2 }}>
                    ที่นั่งที่ใช้ไปแล้ว
                  </p>
                  <p className="font-mono text-2xl font-semibold leading-8 tabular-nums" style={{ color: INK }}>
                    {currentCount} / {settings.maxCapacity}
                  </p>
                </div>

                <div className="border-b py-6" style={{ borderColor: RULE }}>
                  <div className="flex items-start justify-between gap-6">
                    <div className="min-w-0">
                      <p id="closed-label" className="text-base font-semibold leading-7" style={{ color: INK }}>
                        ปิดรับสมัครฉุกเฉิน
                      </p>
                      <p id="closed-desc" className="mt-1 text-sm leading-7" style={{ color: INK_3 }}>
                        {closed
                          ? 'กำลังปิดรับ ผู้สมัครใหม่จะถูกปฏิเสธจนกว่าจะปิดสวิตช์นี้'
                          : 'เปิดสวิตช์เพื่อหยุดรับใบสมัครใหม่ทันที ไม่ต้องรอถึงกำหนดการ'}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={closed}
                      aria-expanded={confirmToggleClosed}
                      aria-labelledby="closed-label"
                      aria-describedby="closed-desc"
                      disabled={toggling || !canEdit}
                      onClick={() => setConfirmToggleClosed(true)}
                      className={`inline-flex min-h-11 min-w-14 shrink-0 items-center justify-center rounded-full disabled:opacity-50 ${FOCUS}`}
                    >
                      <span
                        aria-hidden="true"
                        className="relative block h-8 w-14 rounded-full border transition-colors"
                        style={{
                          backgroundColor: closed ? BTN_DARK : 'transparent',
                          borderColor: closed ? BTN_DARK : INPUT_BORDER,
                        }}
                      >
                        <span
                          className={`absolute left-[3px] top-[3px] size-6 rounded-full transition-transform motion-reduce:transition-none ${
                            closed ? 'translate-x-6' : 'translate-x-0'
                          }`}
                          style={{ backgroundColor: closed ? BTN_DARK_TEXT : INK_3 }}
                        />
                      </span>
                    </button>
                  </div>

                  {confirmToggleClosed && (
                    <div
                      role="region"
                      aria-label="ยืนยันการเปลี่ยนสถานะปิดรับสมัครฉุกเฉิน"
                      className="mt-4 rounded-xl border p-4"
                      style={{
                        borderColor: closed ? RULE : DANGER,
                        backgroundColor: SURFACE_SUBTLE,
                      }}
                    >
                      <p className="flex items-start gap-2 text-sm font-semibold leading-6" style={{ color: INK }}>
                        <TriangleAlert
                          aria-hidden="true"
                          size={16}
                          strokeWidth={1.75}
                          className="mt-1 shrink-0"
                          style={{ color: closed ? WARNING : DANGER }}
                        />
                        <span>
                          {closed
                            ? 'ยืนยันยกเลิกการปิดรับสมัครฉุกเฉิน?'
                            : 'ยืนยันปิดรับสมัครฉุกเฉินทันที?'}
                        </span>
                      </p>
                      <p className="mt-1 text-sm leading-6" style={{ color: INK_2 }}>
                        {closed
                          ? 'หลังยกเลิก ระบบจะกลับไปเปิดรับสมัครตามช่วงเวลาที่กำหนดไว้'
                          : 'ผู้สมัครใหม่ทุกคนจะถูกปฏิเสธทันทีจนกว่าทีมงานจะกลับมายกเลิกสวิตช์นี้'}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={toggling}
                          onClick={confirmEmergencyToggle}
                          className={`inline-flex min-h-11 items-center justify-center rounded-full border px-5 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`}
                          style={{
                            borderColor: closed ? RULE : DANGER,
                            color: closed ? INK : DANGER,
                          }}
                        >
                          {toggling
                            ? 'กำลังบันทึก…'
                            : closed
                              ? 'ยืนยันยกเลิกปิดฉุกเฉิน'
                              : 'ยืนยันปิดรับฉุกเฉิน'}
                        </button>
                        <button
                          type="button"
                          disabled={toggling}
                          onClick={() => setConfirmToggleClosed(false)}
                          className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm underline underline-offset-4 disabled:opacity-50 ${FOCUS}`}
                          style={{ color: INK_2 }}
                        >
                          ยกเลิก
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {notice && <NoticeBanner notice={notice} announced={false} />}
        </div>
      )}
    </section>
  );
}
