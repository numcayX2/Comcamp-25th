import { useEffect, useRef, useState } from 'react';
import {
  ApiHttpError,
  getApplicationStatus,
  confirmAttendance,
  uploadPaymentSlip,
  withdrawApplication,
  hasSlip,
  normalizeLookupQuery,
  type Application,
  type ApplicationStatus,
  type ApiSource,
} from '../lib/api';

/** Server limit on slip width and height (AGENTS.md §13.4). */
const MAX_SLIP_PX = 4096;

/** Thai copy keyed by the backend error code; never exposes raw English developer errors to users. */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiHttpError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return 'ไม่พบข้อมูลใบสมัครในระบบ กรุณาตรวจสอบเลขประจำตัวประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัครอีกครั้ง';
      case 'INVALID_VERIFY_CODE':
        return 'เลข 4 ตัวท้ายของบัตรประชาชนไม่ตรงกับใบสมัครนี้ กรุณาตรวจสอบแล้วลองอีกครั้ง';
      case 'INVALID_IMAGE_DIMENSIONS':
        return `รูปสลิปมีขนาดใหญ่เกิน ${MAX_SLIP_PX}×${MAX_SLIP_PX} พิกเซล กรุณาส่งภาพหน้าจอสลิปจากแอปธนาคาร หรือย่อรูปก่อนอัปโหลด`;
      case 'DUPLICATE_SLIP':
        return 'สลิปนี้เคยถูกอัปโหลดในระบบแล้ว กรุณาใช้สลิปการโอนของใบสมัครนี้';
      case 'ALREADY_VERIFIED':
        return 'สลิปนี้ได้รับการตรวจสอบยืนยันเรียบร้อยแล้ว ไม่จำเป็นต้องอัปโหลดซ้ำ';
      case 'PAYLOAD_TOO_LARGE':
        return 'ขนาดไฟล์รูปภาพใหญ่เกิน 5 MB กรุณาเลือกรูปภาพที่มีขนาดเล็กลง';
      case 'RATE_LIMITED':
        return 'มีการทำรายการถี่เกินไป เพื่อความปลอดภัยกรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
      case 'VALIDATION_ERROR':
        return 'ข้อมูลที่ค้นหาไม่ถูกต้อง กรุณาระบุเลขบัตรประชาชน 13 หลัก เบอร์โทร 10 หลัก หรือรหัส CC25-XXXXXX';
      case 'SERVICE_UNAVAILABLE':
        return 'ระบบกำลังมีผู้ใช้งานจำนวนมาก กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
      case 'REGISTRATION_CLOSED':
        return 'ระบบปิดรับสมัครตามกำหนดการแล้ว หากมีข้อสงสัยกรุณาติดต่อทีมงานพี่ค่าย';
      case 'FORBIDDEN':
        return 'ใบสมัครนี้ยืนยันสิทธิ์แล้ว ไม่สามารถดำเนินการขั้นตอนนี้ได้';
    }
    if (err.status === 404) {
      return 'ไม่พบข้อมูลใบสมัครในระบบ กรุณาตรวจสอบเลขประจำตัวประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัครอีกครั้ง';
    }
    if (err.status === 403) {
      return 'ไม่สามารถดำเนินการได้ในขณะนี้ กรุณาติดต่อทีมงานพี่ค่าย';
    }
    if (err.status === 413) {
      return 'ขนาดไฟล์รูปภาพใหญ่เกิน 5 MB กรุณาเลือกรูปภาพที่มีขนาดเล็กลง';
    }
    if (err.status >= 500) {
      return 'ระบบขัดข้องชั่วคราว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
    }
    return fallback;
  }
  return 'ไม่สามารถเชื่อมต่อกับระบบได้ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง';
}

/** Natural size of an image file, or null when the browser cannot decode it. */
function readImageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/* Editorial minimalism — same flat ledger language as AdminSection:
   hairline rules, mono indexes, square tags with a solid 3px status bar. */
const STATUS_BAR: Record<ApplicationStatus, string> = {
  PENDING: 'var(--color-warning)',
  PASSED: 'var(--color-tech)',
  RESERVE: 'var(--color-ink-subtle)',
  CONFIRMED: 'var(--color-success)',
  REJECTED: 'var(--color-danger)',
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอประกาศผล',
  PASSED: 'ผ่านการคัดเลือก',
  RESERVE: 'ตัวสำรอง',
  CONFIRMED: 'ยืนยันสิทธิ์สำเร็จ',
  REJECTED: 'ไม่ผ่านการคัดเลือก',
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

/** Must match the backend allow-list (magic-byte checked server-side). */
const SLIP_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function StatusTag({ status }: { status: ApplicationStatus }) {
  return (
    <span
      className="inline-block border px-3 py-1 text-xs font-semibold"
      style={{ borderColor: RULE, borderLeft: `3px solid ${STATUS_BAR[status]}`, color: INK, backgroundColor: SURFACE }}
    >
      {STATUS_LABELS[status] || status}
      <span className="ml-2 font-mono text-[11px] font-medium tabular-nums" style={{ color: INK_SUBTLE }}>
        {status}
      </span>
    </span>
  );
}

export function StatusSection() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [app, setApp] = useState<Application | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewLocalUrl, setPreviewLocalUrl] = useState<string | null>(null);
  /** The slip sent in this visit, shown from the device. Uploaded slips are never served publicly. */
  const [sentPreviewUrl, setSentPreviewUrl] = useState<string | null>(null);
  /** Last 4 digits of the national ID (AGENTS.md §13.5). Kept in memory only, never stored. */
  const [verifyCode, setVerifyCode] = useState('');
  const codeReady = verifyCode.length === 4;
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  /** Set after a successful withdrawal; the record is cleared and this notice replaces it. */
  const [withdrawnId, setWithdrawnId] = useState<string | null>(null);
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

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    // Zero-width characters and hyphens from a LINE copy-paste are removed (§9.2.2).
    const query = normalizeLookupQuery(q);
    if (!query) return;
    setBusy(true);
    setError(null);
    setUploadMessage(null);
    setUploadError(null);
    setSelectedFile(null);
    setPreviewLocalUrl(null);
    setSentPreviewUrl(null);
    setVerifyCode('');
    setWithdrawOpen(false);
    setWithdrawnId(null);
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
      setUploadMessage(null);
      setUploadError(null);
      setSelectedFile(null);
      setPreviewLocalUrl(null);
      setSentPreviewUrl(null);
      setWithdrawnId(id);
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 409) {
        setError('ใบสมัครนี้ยืนยันสิทธิ์แล้ว ยกเลิกเองไม่ได้ กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการ');
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

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    setUploadMessage(null);
    const file = e.target.files?.[0];
    if (file) {
      if (!SLIP_TYPES.includes(file.type)) {
        setUploadError('กรุณาเลือกไฟล์รูปภาพ (JPG, PNG หรือ WebP)');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setUploadError('ขนาดไฟล์รูปภาพต้องไม่เกิน 5 MB');
        return;
      }
      const url = URL.createObjectURL(file);
      // Same limit as the server, checked here so a doomed upload never uses mobile data.
      const size = await readImageSize(url);
      if (size && (size.width > MAX_SLIP_PX || size.height > MAX_SLIP_PX)) {
        URL.revokeObjectURL(url);
        setUploadError(
          `รูปสลิปมีขนาด ${size.width}×${size.height} พิกเซล ซึ่งเกิน ${MAX_SLIP_PX}×${MAX_SLIP_PX} กรุณาส่งภาพหน้าจอสลิปจากแอปธนาคาร หรือย่อรูปก่อนอัปโหลด`,
        );
        return;
      }
      setSelectedFile(file);
      setPreviewLocalUrl(url);
    }
  }

  async function onUploadSlip(e: React.FormEvent) {
    e.preventDefault();
    if (!app || !selectedFile || !codeReady) return;

    setUploadBusy(true);
    setUploadError(null);
    setUploadMessage(null);

    try {
      const res = await uploadPaymentSlip(app.id, selectedFile, verifyCode);
      setUploadMessage(res.data.message || 'อัปโหลดสลิปเรียบร้อยแล้ว รอเจ้าหน้าที่ตรวจสอบ');
      setSource(res.source);

      setApp((prev) => (prev ? { ...prev, hasSlip: true, slipStatus: res.data.slipStatus } : null));
      setSentPreviewUrl(previewLocalUrl);
      setSelectedFile(null);
      setPreviewLocalUrl(null);
    } catch (err) {
      setUploadError(describeError(err, 'เกิดข้อผิดพลาดในการอัปโหลดสลิป'));
    } finally {
      setUploadBusy(false);
    }
  }

  const slipUploaded = hasSlip(app);
  // slipStatus comes from the server; older responses without it fall back to the applicant status.
  const slipApproved = app?.slipStatus ? app.slipStatus === 'APPROVED' : app?.status === 'CONFIRMED';
  const slipRejected = app?.slipStatus === 'REJECTED';
  const isEligibleForPayment = app && (app.status === 'PASSED' || app.status === 'CONFIRMED');
  // Self-service withdrawal: open until the place is confirmed (CONFIRMED or an approved slip);
  // after that only staff can remove it. REJECTED has no seat to give back.
  const canWithdraw = Boolean(
    app && (app.status === 'PENDING' || app.status === 'PASSED' || app.status === 'RESERVE') && !slipApproved,
  );
  // The code is asked for only while there is something left to do on this application.
  const needsVerifyCode = Boolean(isEligibleForPayment && (app?.status === 'PASSED' || !slipApproved)) || canWithdraw;

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

      {uploadMessage && (
        <div
          role="status"
          className="mt-6 flex items-baseline justify-between gap-4 rounded-xl border bg-[var(--bg-card)] px-4 py-3.5"
          style={{ borderColor: RULE }}
        >
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span aria-hidden="true" className="mr-2 text-[10px]" style={{ color: 'var(--color-success)' }}>
              ●
            </span>
            {uploadMessage}
          </p>
          <button
            type="button"
            onClick={() => setUploadMessage(null)}
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

      {uploadError && (
        <div
          role="alert"
          className="mt-6 flex items-baseline justify-between gap-4 rounded-xl border bg-[var(--bg-card)] px-4 py-3.5"
          style={{ borderColor: RULE }}
        >
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span aria-hidden="true" className="mr-2 text-[10px]" style={{ color: 'var(--color-danger)' }}>
              ●
            </span>
            {uploadError}
          </p>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            className="shrink-0 rounded-full px-2.5 py-0.5 text-sm underline underline-offset-4 transition-opacity hover:opacity-80"
            style={{ color: INK_MUTED }}
          >
            ปิด
          </button>
        </div>
      )}

      {app && (
        <div className="mt-8 space-y-8">
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
                <label className="block text-base font-bold leading-7" style={{ color: INK }} htmlFor="verify-code">
                  เลข <span className="font-mono tabular-nums">4</span> ตัวท้ายของบัตรประชาชน
                </label>
                <p id="verify-code-hint" className="max-w-[60ch] text-sm leading-7" style={{ color: INK_MUTED }}>
                  ใช้ยืนยันว่าเป็นเจ้าของใบสมัครก่อนยืนยันสิทธิ์ ส่งสลิป หรือยกเลิกใบสมัคร ระบบไม่บันทึกตัวเลขนี้ไว้ในเครื่อง
                </p>
                <input
                  id="verify-code"
                  value={verifyCode}
                  // Digits only, max 4: also drops zero-width characters pasted from LINE.
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0000"
                  aria-describedby="verify-code-hint"
                  className="mt-2 w-32 rounded-none border bg-[var(--bg-card)] px-3 py-2.5 font-mono text-base tabular-nums outline-none transition-colors focus:border-[var(--color-tech)] focus-visible:ring-2 focus-visible:ring-[var(--color-tech)]/30"
                  style={{ borderColor: BORDER_INPUT, color: INK }}
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
          </section>

          {/* ── 04 · Payment slip ───────────────────────────── */}
          {isEligibleForPayment && (
            <section className="border bg-[var(--bg-card)] p-6 sm:p-8" style={{ borderColor: INK, backgroundColor: SURFACE }}>
              <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: INK }}>
                <div>
                  <p className="font-mono text-xs font-medium uppercase" style={{ color: INK_SUBTLE }}>
                    Payment / Slip
                  </p>
                  <h2 className="mt-1 text-xl font-bold leading-8" style={{ color: INK }}>หลักฐานการชำระเงิน</h2>
                  <p className="mt-1 text-sm leading-7" style={{ color: INK_MUTED }}>
                    ค่าธรรมเนียมยืนยันสิทธิ์ <span className="font-mono tabular-nums">1,000</span> บาท (รองรับไฟล์รูปภาพ JPG, PNG หรือ WebP ขนาดไม่เกิน <span className="font-mono tabular-nums">5</span> MB และไม่เกิน <span className="font-mono tabular-nums">{MAX_SLIP_PX}×{MAX_SLIP_PX}</span> พิกเซล)
                  </p>
                </div>
                {slipUploaded ? (
                  slipApproved ? (
                    <span className="inline-block border px-3 py-1 text-xs font-semibold" style={{ borderColor: RULE, borderLeft: '3px solid var(--color-success)', color: INK, backgroundColor: SURFACE }}>
                      ✓ อนุมัติสลิปแล้ว
                    </span>
                  ) : slipRejected ? (
                    <span className="inline-block border px-3 py-1 text-xs font-semibold" style={{ borderColor: RULE, borderLeft: '3px solid var(--color-danger)', color: INK, backgroundColor: SURFACE }}>
                      สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดใหม่
                    </span>
                  ) : (
                    <span className="inline-block border px-3 py-1 text-xs font-semibold" style={{ borderColor: RULE, borderLeft: '3px solid var(--color-warning)', color: INK, backgroundColor: SURFACE }}>
                      ⏳ รอเจ้าหน้าที่ตรวจสอบ
                    </span>
                  )
                ) : (
                  <span className="inline-block border px-3 py-1 font-mono text-xs tabular-nums" style={{ borderColor: RULE, color: INK_SUBTLE, backgroundColor: SURFACE }}>
                    — NO SLIP
                  </span>
                )}
              </div>

              <div className="mt-6 grid grid-cols-1 items-start gap-6 md:grid-cols-2">
                <div className="border p-2" style={{ borderColor: RULE, backgroundColor: SURFACE_SUBTLE }}>
                  {sentPreviewUrl ? (
                    <div>
                      <img
                        src={sentPreviewUrl}
                        alt="หลักฐานการโอนเงินที่เพิ่งส่ง"
                        className="mx-auto max-h-72 w-full object-contain"
                      />
                      <p className="mt-2 bg-[var(--bg-card)] px-2 py-1 text-xs leading-6" style={{ color: INK_MUTED, backgroundColor: SURFACE }}>
                        สลิปที่เพิ่งส่ง (แสดงจากเครื่องของคุณ)
                      </p>
                    </div>
                  ) : slipUploaded ? (
                    <p className="px-4 py-10 text-center text-sm leading-7" style={{ color: INK_MUTED }}>
                      ได้รับสลิปของคุณแล้ว เพื่อความปลอดภัยของข้อมูลทางการเงิน รูปสลิปจะเปิดดูได้เฉพาะในระบบของเจ้าหน้าที่
                    </p>
                  ) : (
                    <p className="py-10 text-center font-mono text-sm tabular-nums" style={{ color: INK_SUBTLE }}>
                      — NO IMAGE
                    </p>
                  )}
                </div>

                {slipApproved ? (
                  <p className="text-sm leading-7" style={{ color: INK_MUTED }}>
                    ชำระเงินเรียบร้อยแล้ว ไม่ต้องอัปโหลดสลิปเพิ่ม
                  </p>
                ) : (
                <form onSubmit={onUploadSlip} className="flex flex-col gap-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold" style={{ color: INK }} htmlFor="slipFile">
                      {slipUploaded ? 'อัปโหลดสลิปใหม่เพื่อแทนที่' : 'เลือกไฟล์สลิปการโอนเงิน'}
                    </label>
                    <input
                      id="slipFile"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={onFileChange}
                      className="block w-full cursor-pointer border bg-[var(--bg-card)] p-1 text-sm"
                      style={{ borderColor: BORDER_INPUT, color: INK_MUTED }}
                    />
                  </div>

                  {previewLocalUrl && (
                    <div className="border p-3" style={{ borderColor: 'var(--color-tech)', backgroundColor: SURFACE }}>
                      <p className="mb-2 text-xs font-semibold" style={{ color: INK }}>ตัวอย่างรูปภาพที่กำลังจะอัปโหลด</p>
                      <img
                        src={previewLocalUrl}
                        alt="ตัวอย่างรูปภาพสลิปใหม่"
                        className="mx-auto max-h-48 rounded-none object-contain"
                      />
                      <p className="mt-1 text-center font-mono text-xs tabular-nums" style={{ color: INK_SUBTLE }}>
                        {selectedFile?.name} ({(selectedFile ? selectedFile.size / 1024 : 0).toFixed(1)} KB)
                      </p>
                    </div>
                  )}

                  {!codeReady && (
                    <p className="text-sm leading-7" style={{ color: INK_MUTED }}>
                      กรอกเลข <span className="font-mono tabular-nums">4</span> ตัวท้ายของบัตรประชาชนด้านบนก่อนส่งสลิป
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={uploadBusy || !selectedFile || !codeReady}
                    className="w-full rounded-full px-4 py-3 text-sm font-semibold transition-opacity disabled:opacity-50"
                    style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
                  >
                    {uploadBusy ? 'กำลังอัปโหลด…' : 'ยืนยันและส่งหลักฐานสลิป'}
                  </button>
                  
                </form>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
