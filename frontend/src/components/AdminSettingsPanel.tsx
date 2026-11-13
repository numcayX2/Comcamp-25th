import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  ApiHttpError,
  fetchAdminSettings,
  fetchPublicSettings,
  updateAdminSettings,
  type AdminSettings,
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
} from './admin-ui';

/** Seat quota ceiling (backend: maxCapacity 1–1000). */
const MAX_CAPACITY = 1000;
/** Fee ceiling in baht (backend: campFee 0–100000). */
const MAX_FEE = 100000;

const numberFmt = new Intl.NumberFormat('en-US');

type Notice = { kind: 'ok' | 'error'; text: string } | null;
type FieldErrors = { quota?: string; fee?: string };

interface Props {
  token: string;
  /**
   * Whether this role may change the settings (`admin` role on the server). Others see the
   * values read-only instead of a form that would answer 403.
   */
  canEdit?: boolean;
  /** Applicants who are not rejected. This is the count the server checks the quota against. */
  currentCount: number;
  /** Returns true when the error was an expired session, in which case the parent has logged out. */
  onAuthError: (err: unknown) => boolean;
  /** Reports each settings snapshot so the parent can use the fee elsewhere. */
  onSettings?: (s: AdminSettings) => void;
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiHttpError) {
    if (err.status === 403) return 'บัญชีนี้ไม่มีสิทธิ์แก้การตั้งค่า (ทำได้เฉพาะบทบาท admin)';
    if (err.code === 'VALIDATION_ERROR') {
      if (err.message.includes('capacity') || err.message.includes('quota')) {
        return 'จำนวนโควตาต้องไม่ต่ำกว่าจำนวนผู้สมัครปัจจุบัน และไม่เกิน 1,000 ที่นั่ง';
      }
      if (err.message.includes('fee')) {
        return 'ค่าสมัครต้องอยู่ในช่วง 0 ถึง 100,000 บาท';
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

/**
 * Collapsible control panel for camp staff: the seat quota, the camp fee and the emergency
 * switch. The summary row stays visible when collapsed so the status is always in view.
 */
export function AdminSettingsPanel({ token, canEdit = true, currentCount, onAuthError, onSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The server's own verdict (isOpen from /settings/public). null means the server did not answer. */
  const [acceptingNow, setAcceptingNow] = useState<boolean | null>(null);
  const [quotaInput, setQuotaInput] = useState('');
  const [feeInput, setFeeInput] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const quotaFloor = Math.max(1, currentCount);
  const closed = settings?.isManualClosed ?? false;
  const statusLabel =
    acceptingNow === null ? 'ไม่ทราบสถานะ' : acceptingNow ? 'เปิดรับสมัคร' : 'ปิดรับสมัคร';
  const statusDot = acceptingNow === null ? INK_3 : acceptingNow ? SUCCESS : DANGER;
  const feeShown = settings ? numberFmt.format(Number(settings.campFee)) : '–';

  function receive(s: AdminSettings) {
    setSettings(s);
    onSettings?.(s);
  }

  function resetInputs(s: AdminSettings) {
    setQuotaInput(String(s.maxCapacity));
    setFeeInput(String(Number(s.campFee)));
    setFieldErrors({});
  }

  async function refreshStatus(fresh = false) {
    const pub = await fetchPublicSettings({ fresh });
    setAcceptingNow(pub.live ? pub.settings.isOpen : null);
  }

  useEffect(() => {
    let cancelled = false;
    fetchAdminSettings(token)
      .then((res) => {
        if (cancelled) return;
        receive(res.data);
        resetInputs(res.data);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled || onAuthError(err)) return;
        setLoadError(errorText(err, 'โหลดการตั้งค่าไม่สำเร็จ'));
      });
    refreshStatus();
    return () => {
      cancelled = true;
    };
  }, [token]);

  /** Checks both fields before anything is sent. Returns null when a field is invalid. */
  function checkInputs(): { quota: number; fee: number } | null {
    const next: FieldErrors = {};
    const quota = Number(quotaInput);
    const fee = Number(feeInput);

    if (quotaInput.trim() === '' || !Number.isInteger(quota)) {
      next.quota = 'กรุณากรอกจำนวนที่นั่งเป็นจำนวนเต็ม';
    } else if (quota < quotaFloor) {
      next.quota = `ตั้งต่ำกว่าจำนวนผู้สมัครปัจจุบัน (${currentCount} คน) ไม่ได้`;
    } else if (quota > MAX_CAPACITY) {
      next.quota = `ตั้งได้สูงสุด ${MAX_CAPACITY} ที่นั่ง`;
    }

    if (feeInput.trim() === '' || !Number.isInteger(fee)) {
      next.fee = 'กรุณากรอกค่าสมัครเป็นจำนวนเต็มบาท';
    } else if (fee < 0 || fee > MAX_FEE) {
      next.fee = `ค่าสมัครต้องอยู่ระหว่าง 0 ถึง ${numberFmt.format(MAX_FEE)} บาท`;
    }

    setFieldErrors(next);
    return next.quota || next.fee ? null : { quota, fee };
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    const values = checkInputs();
    if (!values) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await updateAdminSettings(token, { maxCapacity: values.quota, campFee: values.fee });
      receive(res.data);
      resetInputs(res.data);
      setNotice({
        kind: 'ok',
        text: `บันทึกแล้ว: ${numberFmt.format(values.quota)} ที่นั่ง · ค่าสมัคร ${numberFmt.format(values.fee)} บาท`,
      });
      refreshStatus(true);
    } catch (err) {
      if (onAuthError(err)) return;
      setNotice({ kind: 'error', text: `บันทึกไม่สำเร็จ: ${errorText(err, 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')}` });
    } finally {
      setSaving(false);
    }
  }

  /** The emergency switch saves on its own, so it works even while the quota form has unsaved edits. */
  async function onToggleClosed() {
    if (!settings || !canEdit) return;
    const next = !settings.isManualClosed;
    setToggling(true);
    setNotice(null);
    try {
      const res = await updateAdminSettings(token, { isManualClosed: next });
      receive(res.data);
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
        className={`flex w-full flex-col gap-2 rounded-none py-4 text-left sm:flex-row sm:items-center sm:justify-between sm:gap-6 ${FOCUS}`}
      >
        <span className="text-base font-semibold leading-7" style={{ color: INK }}>
          ตั้งค่าการรับสมัคร
        </span>
        <span className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm leading-7" style={{ color: INK_2 }}>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: statusDot }}>
              ●
            </span>
            {statusLabel}
            {closed ? <span style={{ color: INK_3 }}>(ปิดฉุกเฉิน)</span> : null}
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
        <div id={panelId} className="grid gap-x-12 gap-y-8 pb-8 md:grid-cols-2">
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

          {settings && (
            <>
              {canEdit ? (
              <form onSubmit={onSave} noValidate aria-busy={saving} className="flex flex-col gap-6">
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
                    onChange={(e) => setQuotaInput(e.target.value)}
                    aria-invalid={fieldErrors.quota ? true : undefined}
                    aria-describedby={fieldErrors.quota ? 'quota-help quota-error' : 'quota-help'}
                    className={`${INPUT_BASE} rounded-xl font-mono tabular-nums`}
                    style={{ borderColor: fieldErrors.quota ? DANGER : INPUT_BORDER, color: INK }}
                  />
                  <p id="quota-help" className="mt-2 text-sm leading-7" style={{ color: INK_3 }}>
                    ตั้งต่ำกว่าจำนวนผู้สมัครปัจจุบัน ({currentCount} คน) ไม่ได้ ใช้ได้ตั้งแต่ {quotaFloor} ถึง{' '}
                    {numberFmt.format(MAX_CAPACITY)} ที่นั่ง
                  </p>
                  {fieldErrors.quota && (
                    <p id="quota-error" className="mt-1 text-sm leading-7" style={{ color: DANGER }}>
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
                    inputMode="numeric"
                    step={1}
                    min={0}
                    max={MAX_FEE}
                    value={feeInput}
                    onChange={(e) => setFeeInput(e.target.value)}
                    aria-invalid={fieldErrors.fee ? true : undefined}
                    aria-describedby={fieldErrors.fee ? 'fee-help fee-error' : 'fee-help'}
                    className={`${INPUT_BASE} rounded-xl font-mono tabular-nums`}
                    style={{ borderColor: fieldErrors.fee ? DANGER : INPUT_BORDER, color: INK }}
                  />
                  <p id="fee-help" className="mt-2 text-sm leading-7" style={{ color: INK_3 }}>
                    ค่าเริ่มต้นของค่ายคือ 1,000 บาท
                  </p>
                  {fieldErrors.fee && (
                    <p id="fee-error" className="mt-1 text-sm leading-7" style={{ color: DANGER }}>
                      {fieldErrors.fee}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={saving}
                    className={`rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                    style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                  >
                    {saving ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่า'}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => resetInputs(settings)}
                    className={PILL_GHOST}
                    style={{ borderColor: RULE, color: INK_2 }}
                  >
                    ยกเลิกการแก้ไข
                  </button>
                </div>
              </form>
              ) : (
                <div className="flex flex-col gap-6">
                  <div>
                    <p className="text-sm leading-7" style={{ color: INK_2 }}>
                      โควตาที่นั่ง
                    </p>
                    <p className="font-mono text-2xl font-semibold leading-8 tabular-nums" style={{ color: INK }}>
                      {numberFmt.format(settings.maxCapacity)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm leading-7" style={{ color: INK_2 }}>
                      ค่าสมัคร (บาท)
                    </p>
                    <p className="font-mono text-2xl font-semibold leading-8 tabular-nums" style={{ color: INK }}>
                      {feeShown}
                    </p>
                  </div>
                  <p className="max-w-[46ch] text-sm leading-7" style={{ color: INK_3 }}>
                    บัญชีของคุณดูการตั้งค่าได้อย่างเดียว การแก้โควตา ค่าสมัคร และการปิดรับสมัครฉุกเฉินทำได้เฉพาะบทบาท{' '}
                    <span className="font-mono">admin</span>
                  </p>
                </div>
              )}

              <div className="flex flex-col">
                <div className="border-b pb-6" style={{ borderColor: RULE }}>
                  <p className="text-sm leading-7" style={{ color: INK_2 }}>
                    สถานะการรับสมัคร
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-lg font-semibold leading-7" style={{ color: INK }}>
                    <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: statusDot }}>
                      ●
                    </span>
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

                <div className="flex items-start justify-between gap-6 py-6">
                  <div className="min-w-0">
                    <p id="closed-label" className="text-base font-semibold leading-7" style={{ color: INK }}>
                      ปิดรับสมัครฉุกเฉิน
                    </p>
                    <p id="closed-desc" className="mt-1 text-sm leading-7" style={{ color: INK_3 }}>
                      {closed
                        ? 'กำลังปิดรับ ผู้สมัครใหม่จะถูกปฏิเสธจนกว่าจะปิดสวิตช์นี้'
                        : canEdit
                          ? 'เปิดสวิตช์เพื่อหยุดรับใบสมัครใหม่ทันที ไม่ต้องรอถึงกำหนดการ'
                          : 'ยังรับใบสมัครตามกำหนดการ (เปิด/ปิดสวิตช์นี้ได้เฉพาะ admin)'}
                    </p>
                  </div>
                  {canEdit ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={closed}
                    aria-labelledby="closed-label"
                    aria-describedby="closed-desc"
                    disabled={toggling}
                    onClick={onToggleClosed}
                    className={`relative inline-flex h-8 w-14 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${FOCUS}`}
                    style={{
                      backgroundColor: closed ? BTN_DARK : 'transparent',
                      borderColor: closed ? BTN_DARK : INPUT_BORDER,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute left-[3px] top-[3px] size-6 rounded-full transition-transform motion-reduce:transition-none ${
                        closed ? 'translate-x-6' : 'translate-x-0'
                      }`}
                      style={{ backgroundColor: closed ? BTN_DARK_TEXT : INK_3 }}
                    />
                  </button>
                  ) : (
                    <p className="shrink-0 text-sm font-semibold leading-7" style={{ color: closed ? DANGER : INK_2 }}>
                      {closed ? 'เปิดอยู่' : 'ไม่ได้เปิด'}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

          {notice && (
            <p
              role={notice.kind === 'error' ? 'alert' : 'status'}
              className="text-sm leading-7 md:col-span-2"
              style={{ color: notice.kind === 'error' ? DANGER : INK }}
            >
              {notice.kind === 'ok' && (
                <span aria-hidden="true" className="mr-2 text-[10px]" style={{ color: SUCCESS }}>
                  ●
                </span>
              )}
              {notice.text}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
