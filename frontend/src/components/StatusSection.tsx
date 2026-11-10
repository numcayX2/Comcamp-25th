import { useState } from 'react';
import {
  ApiHttpError,
  getApplicationStatus,
  confirmAttendance,
  uploadPaymentSlip,
  hasSlip,
  normalizeLookupQuery,
  type Application,
  type ApplicationStatus,
  type ApiSource,
} from '../lib/api';

/** Server limit on slip width and height (AGENTS.md §13.4). */
const MAX_SLIP_PX = 4096;

/** Thai copy keyed by the backend error code; falls back to the server message. */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiHttpError) {
    switch (err.code) {
      case 'INVALID_VERIFY_CODE':
        return 'เลข 4 ตัวท้ายของบัตรประชาชนไม่ตรงกับใบสมัครนี้ กรุณาตรวจสอบแล้วลองอีกครั้ง';
      case 'INVALID_IMAGE_DIMENSIONS':
        return `รูปสลิปมีขนาดใหญ่เกิน ${MAX_SLIP_PX}×${MAX_SLIP_PX} พิกเซล กรุณาส่งภาพหน้าจอสลิปจากแอปธนาคาร หรือย่อรูปก่อนอัปโหลด`;
      case 'DUPLICATE_SLIP':
        return 'สลิปนี้เคยถูกอัปโหลดในระบบแล้ว กรุณาใช้สลิปการโอนของใบสมัครนี้';
      case 'RATE_LIMITED':
        return 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
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
  PENDING: '#B45309',
  PASSED: '#1A5FE0',
  RESERVE: '#4A4D55',
  CONFIRMED: '#029E00',
  REJECTED: '#C62828',
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอประกาศผล',
  PASSED: 'ผ่านการคัดเลือก',
  RESERVE: 'ตัวสำรอง',
  CONFIRMED: 'ยืนยันสิทธิ์สำเร็จ',
  REJECTED: 'ไม่ผ่านการคัดเลือก',
};

const INK = '#121316';

/** Must match the backend allow-list (magic-byte checked server-side). */
const SLIP_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const RULE = 'rgba(18,19,22,0.14)';

function StatusTag({ status }: { status: ApplicationStatus }) {
  return (
    <span
      className="inline-block border px-3 py-1 text-xs font-semibold"
      style={{ borderColor: RULE, borderLeft: `3px solid ${STATUS_BAR[status]}`, color: INK, backgroundColor: '#FFFFFF' }}
    >
      {STATUS_LABELS[status] || status}
      <span className="ml-2 font-mono text-[11px] font-medium tabular-nums" style={{ color: '#62666E' }}>
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
  // The code is asked for only while there is something left to do on this application.
  const needsVerifyCode = Boolean(isEligibleForPayment && (app?.status === 'PASSED' || !slipApproved));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      {/* ── 01 · Masthead ─────────────────────────────────── */}
      <header className="border-t-4 pt-4" style={{ borderColor: INK }}>
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium uppercase tabular-nums" style={{ color: '#62666E' }}>
              ComCamp #25 — Status / 02
            </p>
            <h1 className="mt-2 text-balance text-3xl font-bold leading-[1.22] sm:text-5xl" style={{ color: INK }}>
              ตรวจสอบสถานะใบสมัคร
            </h1>
          </div>
          <p className="max-w-[42ch] text-base leading-7" style={{ color: '#4A4D55' }}>
            ค้นหาด้วยเลขบัตรประชาชน 13 หลัก เบอร์โทรศัพท์ หรือรหัสใบสมัคร (<span className="font-mono text-sm tabular-nums">CC25-XXXXXX</span>)
          </p>
        </div>

        <p className="mt-4 overflow-x-auto whitespace-nowrap border-t pt-3 font-mono text-xs tabular-nums" style={{ borderColor: RULE, color: '#62666E' }}>
          GET /api/applications/status · POST /api/applications/:id/confirm · POST /api/applications/:id/slip
        </p>
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
          <p className="mt-2 max-w-[42ch] text-base leading-7" style={{ color: '#4A4D55' }}>
            ผลการคัดเลือก การยืนยันสิทธิ์ และการอัปโหลดสลิปโอนเงินทำได้ในหน้าเดียวโดยไม่ต้องสมัครใหม่
          </p>
        </div>

        <form onSubmit={onSearch} className="border bg-white p-6 sm:p-8 md:col-span-7" style={{ borderColor: INK, backgroundColor: '#FFFFFF' }}>
          <p className="font-mono text-xs font-medium uppercase" style={{ color: '#62666E' }}>
            Lookup / Query
          </p>
          <label className="mb-1.5 mt-4 block text-sm font-semibold" style={{ color: INK }} htmlFor="status-q">
            เลขบัตรประชาชน เบอร์โทรศัพท์ หรือรหัสใบสมัคร
          </label>
          <input
            id="status-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="เช่น 1509900112233 หรือ CC25-XXXXXX"
            className="w-full rounded-none border bg-white px-3 py-2.5 text-base outline-none transition-colors focus:border-[#1A5FE0]"
            style={{ borderColor: '#8A8D93' }}
          />
          <button
            type="submit"
            disabled={busy || !q.trim()}
            className="mt-4 w-full rounded-full px-4 py-3 text-base font-semibold transition-opacity disabled:opacity-50"
            style={{ backgroundColor: INK, color: '#F9F8F4' }}
          >
            {busy ? 'กำลังค้นหา…' : 'ค้นหาข้อมูล'}
          </button>
        </form>
      </section>

      {/* ── Alerts: flat, square, ruled ─────────────────────── */}
      {error && (
        <div className="mt-6 flex items-center justify-between gap-4 border border-l-4 bg-white px-4 py-3" style={{ borderColor: RULE, borderLeftColor: '#C62828' }}>
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span className="mr-2 font-mono text-xs font-semibold">ERR</span>
            {error}
          </p>
          <button type="button" onClick={() => setError(null)} className="shrink-0 rounded-full px-3 py-1 text-sm font-medium underline underline-offset-4" style={{ color: '#4A4D55' }}>
            ปิด
          </button>
        </div>
      )}

      {uploadMessage && (
        <div className="mt-6 flex items-center justify-between gap-4 border border-l-4 bg-white px-4 py-3" style={{ borderColor: RULE, borderLeftColor: '#029E00' }}>
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span className="mr-2 font-mono text-xs font-semibold">OK</span>
            {uploadMessage}
          </p>
          <button type="button" onClick={() => setUploadMessage(null)} className="shrink-0 rounded-full px-3 py-1 text-sm font-medium underline underline-offset-4" style={{ color: '#4A4D55' }}>
            ปิด
          </button>
        </div>
      )}

      {uploadError && (
        <div className="mt-6 flex items-center justify-between gap-4 border border-l-4 bg-white px-4 py-3" style={{ borderColor: RULE, borderLeftColor: '#C62828' }}>
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span className="mr-2 font-mono text-xs font-semibold">ERR</span>
            {uploadError}
          </p>
          <button type="button" onClick={() => setUploadError(null)} className="shrink-0 rounded-full px-3 py-1 text-sm font-medium underline underline-offset-4" style={{ color: '#4A4D55' }}>
            ปิด
          </button>
        </div>
      )}

      {app && (
        <div className="mt-8 space-y-8">
          {/* ── 03 · Application record ─────────────────────── */}
          <section className="border bg-white p-6 sm:p-8" style={{ borderColor: INK, backgroundColor: '#FFFFFF' }}>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: INK }}>
              <div>
                <p className="font-mono text-xs font-medium uppercase" style={{ color: '#62666E' }}>
                  Record / Application No.
                </p>
                <p className="mt-1 font-mono text-2xl font-semibold tabular-nums" style={{ color: INK }}>{app.id}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusTag status={app.status} />
                {source && (
                  <span className="rounded-sm border px-2 py-0.5 font-mono text-[11px] font-semibold" style={{ borderColor: RULE, color: INK, backgroundColor: '#FFFFFF' }}>
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
                  <dt className="font-mono text-[11px] font-medium uppercase" style={{ color: '#62666E' }}>{row.k}</dt>
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
                <p id="verify-code-hint" className="max-w-[60ch] text-sm leading-7" style={{ color: '#4A4D55' }}>
                  ใช้ยืนยันว่าเป็นเจ้าของใบสมัครก่อนกดยืนยันสิทธิ์หรือส่งสลิป ระบบไม่บันทึกตัวเลขนี้ไว้ในเครื่อง
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
                  className="mt-2 w-32 rounded-none border bg-white px-3 py-2.5 font-mono text-base tabular-nums outline-none transition-colors focus:border-[#1A5FE0] focus-visible:ring-2 focus-visible:ring-[#1A5FE0]/30"
                  style={{ borderColor: '#8A8D93', color: INK }}
                />
              </div>
            )}

            {/* Attendance confirmation */}
            {app.status === 'PASSED' && (
              <div className="mt-6 border-t pt-4" style={{ borderColor: INK }}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold leading-7" style={{ color: INK }}>การยืนยันสิทธิ์เข้าร่วมค่าย</h3>
                    <p className="text-sm leading-7" style={{ color: '#4A4D55' }}>
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
                      style={{ backgroundColor: INK, color: '#F9F8F4' }}
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
                        style={{ borderColor: RULE, color: '#4A4D55', backgroundColor: '#FFFFFF' }}
                      >
                        ยกเลิก
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ── 04 · Payment slip ───────────────────────────── */}
          {isEligibleForPayment && (
            <section className="border bg-white p-6 sm:p-8" style={{ borderColor: INK, backgroundColor: '#FFFFFF' }}>
              <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: INK }}>
                <div>
                  <p className="font-mono text-xs font-medium uppercase" style={{ color: '#62666E' }}>
                    Payment / Slip
                  </p>
                  <h2 className="mt-1 text-xl font-bold leading-8" style={{ color: INK }}>หลักฐานการชำระเงิน</h2>
                  <p className="mt-1 text-sm leading-7" style={{ color: '#4A4D55' }}>
                    ค่าธรรมเนียมยืนยันสิทธิ์ <span className="font-mono tabular-nums">1,000</span> บาท (รองรับไฟล์รูปภาพ JPG, PNG หรือ WebP ขนาดไม่เกิน <span className="font-mono tabular-nums">5</span> MB และไม่เกิน <span className="font-mono tabular-nums">{MAX_SLIP_PX}×{MAX_SLIP_PX}</span> พิกเซล)
                  </p>
                </div>
                {slipUploaded ? (
                  slipApproved ? (
                    <span className="inline-block border px-3 py-1 text-xs font-semibold" style={{ borderColor: RULE, borderLeft: '3px solid #029E00', color: INK, backgroundColor: '#FFFFFF' }}>
                      ✓ อนุมัติสลิปแล้ว
                    </span>
                  ) : slipRejected ? (
                    <span className="inline-block border px-3 py-1 text-xs font-semibold" style={{ borderColor: RULE, borderLeft: '3px solid #C62828', color: INK, backgroundColor: '#FFFFFF' }}>
                      สลิปไม่ผ่านการตรวจสอบ กรุณาอัปโหลดใหม่
                    </span>
                  ) : (
                    <span className="inline-block border px-3 py-1 text-xs font-semibold" style={{ borderColor: RULE, borderLeft: '3px solid #B45309', color: INK, backgroundColor: '#FFFFFF' }}>
                      ⏳ รอเจ้าหน้าที่ตรวจสอบ
                    </span>
                  )
                ) : (
                  <span className="inline-block border px-3 py-1 font-mono text-xs tabular-nums" style={{ borderColor: RULE, color: '#62666E', backgroundColor: '#FFFFFF' }}>
                    — NO SLIP
                  </span>
                )}
              </div>

              <div className="mt-6 grid grid-cols-1 items-start gap-6 md:grid-cols-2">
                <div className="border p-2" style={{ borderColor: RULE, backgroundColor: '#F2F0E8' }}>
                  {sentPreviewUrl ? (
                    <div>
                      <img
                        src={sentPreviewUrl}
                        alt="หลักฐานการโอนเงินที่เพิ่งส่ง"
                        className="mx-auto max-h-72 w-full object-contain"
                      />
                      <p className="mt-2 bg-white px-2 py-1 text-xs leading-6" style={{ color: '#4A4D55', backgroundColor: '#FFFFFF' }}>
                        สลิปที่เพิ่งส่ง (แสดงจากเครื่องของคุณ)
                      </p>
                    </div>
                  ) : slipUploaded ? (
                    <p className="px-4 py-10 text-center text-sm leading-7" style={{ color: '#4A4D55' }}>
                      ได้รับสลิปของคุณแล้ว เพื่อความปลอดภัยของข้อมูลทางการเงิน รูปสลิปจะเปิดดูได้เฉพาะในระบบของเจ้าหน้าที่
                    </p>
                  ) : (
                    <p className="py-10 text-center font-mono text-sm tabular-nums" style={{ color: '#62666E' }}>
                      — NO IMAGE
                    </p>
                  )}
                </div>

                {slipApproved ? (
                  <p className="text-sm leading-7" style={{ color: '#4A4D55' }}>
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
                      className="block w-full cursor-pointer border bg-white p-1 text-sm"
                      style={{ borderColor: '#8A8D93', color: '#4A4D55' }}
                    />
                  </div>

                  {previewLocalUrl && (
                    <div className="border p-3" style={{ borderColor: '#1A5FE0', backgroundColor: '#FFFFFF' }}>
                      <p className="mb-2 text-xs font-semibold" style={{ color: INK }}>ตัวอย่างรูปภาพที่กำลังจะอัปโหลด</p>
                      <img
                        src={previewLocalUrl}
                        alt="ตัวอย่างรูปภาพสลิปใหม่"
                        className="mx-auto max-h-48 rounded-none object-contain"
                      />
                      <p className="mt-1 text-center font-mono text-xs tabular-nums" style={{ color: '#62666E' }}>
                        {selectedFile?.name} ({(selectedFile ? selectedFile.size / 1024 : 0).toFixed(1)} KB)
                      </p>
                    </div>
                  )}

                  {!codeReady && (
                    <p className="text-sm leading-7" style={{ color: '#4A4D55' }}>
                      กรอกเลข <span className="font-mono tabular-nums">4</span> ตัวท้ายของบัตรประชาชนด้านบนก่อนส่งสลิป
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={uploadBusy || !selectedFile || !codeReady}
                    className="w-full rounded-full px-4 py-3 text-sm font-semibold transition-opacity disabled:opacity-50"
                    style={{ backgroundColor: INK, color: '#F9F8F4' }}
                  >
                    {uploadBusy ? 'กำลังอัปโหลด…' : 'ยืนยันและส่งหลักฐานสลิป'}
                  </button>
                  <p className="overflow-x-auto whitespace-nowrap text-center font-mono text-[11px] tabular-nums" style={{ color: '#62666E' }}>
                    POST /api/applications/:id/slip
                  </p>
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
