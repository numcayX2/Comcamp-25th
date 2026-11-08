import { useState, useEffect } from 'react';
import {
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  UploadCloud,
  User,
  School,
  Phone,
  Tag,
  Sparkles,
  ArrowRight,
  RotateCcw,
  Check,
  CreditCard,
  Building,
  GraduationCap,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import {
  getApplicationStatus,
  confirmAttendance,
  uploadPaymentSlip,
  getSlipImageUrl,
  getSlipUrl,
  saveActiveApplication,
  getRecentApplications,
  type SavedAppSummary,
  type Application,
  type ApplicationStatus,
  type ApiSource,
} from '../lib/api';

const STATUS_COLORS: Record<ApplicationStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  PASSED: 'bg-blue-50 text-blue-700 border-blue-200',
  RESERVE: 'bg-purple-50 text-purple-700 border-purple-200',
  CONFIRMED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-700 border-rose-200',
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอประกาศผล (PENDING)',
  PASSED: 'ผ่านการคัดเลือก (PASSED)',
  RESERVE: 'ตัวสำรอง (RESERVE)',
  CONFIRMED: 'ยืนยันสิทธิ์สำเร็จ (CONFIRMED)',
  REJECTED: 'ไม่ผ่านการคัดเลือก (REJECTED)',
};

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
  const [recentApps, setRecentApps] = useState<SavedAppSummary[]>([]);

  // Load recent applications from localStorage on mount & auto-search if ?q=... is present in URL
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setRecentApps(getRecentApplications());

      const params = new URLSearchParams(window.location.search);
      const queryParam = params.get('q');
      if (queryParam) {
        setQ(queryParam);
        searchDirect(queryParam.trim());
      }
    }
  }, []);

  async function searchDirect(query: string) {
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getApplicationStatus(query);
      setApp(res.data);
      setSource(res.source);
      saveActiveApplication(res.data);
      setRecentApps(getRecentApplications());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่พบข้อมูลใบสมัครที่ค้นหา');
      setApp(null);
    } finally {
      setBusy(false);
    }
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setUploadMessage(null);
    setUploadError(null);
    setSelectedFile(null);
    setPreviewLocalUrl(null);
    await searchDirect(query);
  }

  async function onConfirm() {
    if (!app) return;
    setConfirmBusy(true);
    setError(null);
    try {
      const res = await confirmAttendance(app.id, true);
      setApp(res.data);
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ยืนยันสิทธิ์ไม่สำเร็จ');
    } finally {
      setConfirmBusy(false);
    }
  }

  async function onCancelConfirm() {
    if (!app) return;
    setConfirmBusy(true);
    setError(null);
    try {
      const res = await confirmAttendance(app.id, false);
      setApp(res.data);
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ยกเลิกการยืนยันไม่สำเร็จ');
    } finally {
      setConfirmBusy(false);
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    setUploadMessage(null);
    const file = e.target.files?.[0];
    if (file) {
      const isImg = (file.type && file.type.startsWith('image/')) || /\.(jpg|jpeg|png|webp)$/i.test(file.name);
      if (!isImg) {
        setUploadError('กรุณาเลือกไฟล์รูปภาพ (JPG, PNG หรือ WebP)');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setUploadError('ขนาดไฟล์รูปภาพต้องไม่เกิน 5 MB');
        return;
      }
      setSelectedFile(file);
      setPreviewLocalUrl(URL.createObjectURL(file));
    }
  }

  async function onUploadSlip(e: React.FormEvent) {
    e.preventDefault();
    if (!app || !selectedFile) return;

    setUploadBusy(true);
    setUploadError(null);
    setUploadMessage(null);

    try {
      const res = await uploadPaymentSlip(app.id, selectedFile);
      setUploadMessage(res.data.message || 'อัปโหลดสลิปเรียบร้อยแล้ว รอเจ้าหน้าที่ตรวจสอบ');
      setSource(res.source);

      // Refresh application record to reflect new slipUrl
      const updatedApp = {
        ...app,
        slipUrl: res.data.slipUrl,
        slip_url: res.data.slipUrl,
      };
      setApp(updatedApp);
      saveActiveApplication(updatedApp);
      setSelectedFile(null);
      setPreviewLocalUrl(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการอัปโหลดสลิป');
    } finally {
      setUploadBusy(false);
    }
  }

  const currentSlip = getSlipUrl(app);
  const isEligibleForPayment = app && app.status !== 'REJECTED';

  // Stepper Calculation
  const hasSubmitted = Boolean(app);
  const hasSlip = Boolean(currentSlip);
  const isConfirmed = app?.status === 'CONFIRMED';
  const isRejected = app?.status === 'REJECTED';

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      
      <header className="mb-8 text-center">
        <div className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
          <Sparkles className="w-3.5 h-3.5" />
          <span>ComCamp #25</span>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          ตรวจสอบสถานะใบสมัคร
        </h1>
        <p className="mt-1 text-xs sm:text-sm text-slate-500">
          ติดตามความคืบหน้าการสมัคร การตรวจสอบสลิป และการยืนยันสิทธิ์เข้าร่วมค่าย
        </p>
      </header>

      {/* Search Form Card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 shadow-2xs space-y-3">
        <form onSubmit={onSearch} className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              id="status-search-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="เช่น 1509900112233 หรือ CC25-XXXXXX"
              className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 py-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all font-mono"
            />
          </div>
          <button
            type="submit"
            disabled={busy || !q.trim()}
            className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-2xs whitespace-nowrap cursor-pointer flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <RotateCcw className="w-4 h-4 animate-spin" />
                <span>กำลังค้นหา...</span>
              </>
            ) : (
              <span>ค้นหาข้อมูล</span>
            )}
          </button>
        </form>

        <p className="text-[11px] text-slate-400">
          💡 หากจำ Application ID ไม่ได้ สามารถพิมพ์ค้นหาด้วย <strong>เลขประจำตัวประชาชน 13 หลัก</strong> หรือ <strong>เบอร์โทรศัพท์ 10 หลัก</strong> ได้ทันที
        </p>

        {/* Recent Applications Quick Access */}
        {recentApps.length > 0 && !app && (
          <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3.5 text-xs text-blue-900">
            <p className="font-semibold text-blue-800 mb-2 flex items-center gap-1.5">
              <span>💾 ใบสมัครล่าสุดบนเครื่องนี้:</span>
              <span className="text-[11px] font-normal text-blue-600">(คลิกเพื่อตรวจสอบข้อมูลทันทีโดยไม่ต้องพิมพ์)</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {recentApps.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setQ(item.id);
                    searchDirect(item.id);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 shadow-2xs transition-colors cursor-pointer"
                >
                  <span className="font-mono font-bold">{item.id}</span>
                  <span>· {item.fullName}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error Alert */}
      {error && (
        <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs sm:text-sm text-rose-800 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">ไม่พบข้อมูลใบสมัคร</p>
            <p className="text-xs text-rose-700 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Application Result Details */}
      {app && (
        <div className="mt-8 space-y-6">

          {/* Stepper Timeline Tracker */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-2xs">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
              ความคืบหน้าการสมัคร (Application Journey)
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              {/* Step 1 */}
              <div className={`p-3 rounded-xl border transition-all ${
                hasSubmitted
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-slate-50 border-slate-200 text-slate-400'
              }`}>
                <div className={`mx-auto mb-1.5 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  hasSubmitted ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'
                }`}>
                  <Check className="w-3.5 h-3.5" />
                </div>
                <p className="text-xs font-bold">1. ส่งใบสมัคร</p>
                <p className="text-[10px] text-slate-500 mt-0.5">บันทึกข้อมูลแล้ว</p>
              </div>

              {/* Step 2 */}
              <div className={`p-3 rounded-xl border transition-all ${
                hasSlip
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}>
                <div className={`mx-auto mb-1.5 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  hasSlip ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'
                }`}>
                  {hasSlip ? <Check className="w-3.5 h-3.5" /> : '2'}
                </div>
                <p className="text-xs font-bold">2. แนบสลิป</p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {hasSlip ? 'อัปโหลดสลิปแล้ว' : 'รอชำระเงิน'}
                </p>
              </div>

              {/* Step 3 */}
              <div className={`p-3 rounded-xl border transition-all ${
                isConfirmed
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : hasSlip
                  ? 'bg-blue-50 border-blue-200 text-blue-900'
                  : 'bg-slate-50 border-slate-200 text-slate-400'
              }`}>
                <div className={`mx-auto mb-1.5 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  isConfirmed ? 'bg-emerald-600 text-white' : hasSlip ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'
                }`}>
                  {isConfirmed ? <Check className="w-3.5 h-3.5" /> : '3'}
                </div>
                <p className="text-xs font-bold">3. ตรวจสอบสลิป</p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {isConfirmed ? 'อนุมัติสลิปแล้ว' : hasSlip ? 'รอแอดมินตรวจ' : 'ยังไม่ตรวจ'}
                </p>
              </div>

              {/* Step 4 */}
              <div className={`p-3 rounded-xl border transition-all ${
                isConfirmed
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900 ring-2 ring-emerald-300'
                  : isRejected
                  ? 'bg-rose-50 border-rose-200 text-rose-900'
                  : 'bg-slate-50 border-slate-200 text-slate-400'
              }`}>
                <div className={`mx-auto mb-1.5 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  isConfirmed ? 'bg-emerald-600 text-white' : isRejected ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-500'
                }`}>
                  {isConfirmed ? <Check className="w-3.5 h-3.5" /> : isRejected ? '✕' : '4'}
                </div>
                <p className="text-xs font-bold">4. ยืนยันสิทธิ์</p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {isConfirmed ? 'ยืนยันสมบูรณ์' : isRejected ? 'ไม่ผ่าน' : 'รอดำเนินการ'}
                </p>
              </div>
            </div>
          </div>

          {/* Main Info Card */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-slate-400">Application No.</span>
                <p className="font-mono text-2xl font-bold text-slate-900">{app.id}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_COLORS[app.status]}`}>
                  {STATUS_LABELS[app.status] || app.status}
                </span>
                {source && (
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${source === 'LIVE GO API' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-800'}`}>
                    {source}
                  </span>
                )}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-y-4 gap-x-6 sm:grid-cols-2 text-xs sm:text-sm">
              <div>
                <dt className="text-slate-400">ชื่อ - นามสกุล</dt>
                <dd className="font-semibold text-slate-900 text-base">{app.fullName}</dd>
              </div>
              <div>
                <dt className="text-slate-400">ชื่อเล่น</dt>
                <dd className="font-semibold text-slate-900 text-base">{app.nickname || '-'}</dd>
              </div>
              <div>
                <dt className="text-slate-400">เลขประจำตัวประชาชน</dt>
                <dd className="font-mono text-slate-800">{app.nationalId}</dd>
              </div>
              <div>
                <dt className="text-slate-400">เบอร์โทรศัพท์ติดต่อ</dt>
                <dd className="font-mono text-slate-800">{app.phone}</dd>
              </div>
              <div>
                <dt className="text-slate-400">โรงเรียน / วิทยาลัย</dt>
                <dd className="text-slate-800 font-medium">{app.school}</dd>
              </div>
              <div>
                <dt className="text-slate-400">ระดับชั้น / ไซส์เสื้อ</dt>
                <dd className="text-slate-800">{app.grade} (เสื้อไซส์: <strong className="text-blue-700">{app.shirtSize}</strong>)</dd>
              </div>
              {app.email && (
                <div>
                  <dt className="text-slate-400">อีเมล</dt>
                  <dd className="text-slate-800">{app.email}</dd>
                </div>
              )}
              {app.province && (
                <div>
                  <dt className="text-slate-400">จังหวัด</dt>
                  <dd className="text-slate-800">{app.province}</dd>
                </div>
              )}
            </div>

            {/* Attendance Confirmation Section */}
            {app.status === 'PASSED' && (
              <div className="mt-6 rounded-2xl bg-blue-50/70 p-4 border border-blue-100">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-blue-900">การยืนยันสิทธิ์เข้าร่วมค่าย</h3>
                    <p className="text-xs text-blue-700 mt-0.5">
                      {app.attendanceConfirmed
                        ? 'คุณได้กดยืนยันสิทธิ์เข้าร่วมค่ายเรียบร้อยแล้ว'
                        : 'โปรดยืนยันสิทธิ์เข้าร่วมค่ายและอัปโหลดหลักฐานการโอนเงิน'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={onConfirm}
                      disabled={confirmBusy || app.attendanceConfirmed}
                      className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-emerald-700 disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      {confirmBusy ? 'กำลังดำเนินการ...' : app.attendanceConfirmed ? '✓ ยืนยันสิทธิ์แล้ว' : 'ยืนยันสิทธิ์'}
                    </button>
                    {app.attendanceConfirmed && (
                      <button
                        type="button"
                        onClick={onCancelConfirm}
                        disabled={confirmBusy}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                      >
                        ยกเลิก
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Payment Slip Upload & Status Card */}
          {isEligibleForPayment && (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 shadow-2xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900">หลักฐานการชำระเงิน (Payment Slip)</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    ค่าสมัครค่าย 300.00 บาท (โอนผ่านธนาคารกรุงไทย 123-4-56789-0 หรือ PromptPay)
                  </p>
                </div>
                <div>
                  {currentSlip ? (
                    app.status === 'CONFIRMED' ? (
                      <span className="rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-3 py-1 text-xs font-semibold">
                        ✓ อนุมัติสลิปแล้ว
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-3 py-1 text-xs font-semibold">
                        ⏳ รอเจ้าหน้าที่ตรวจสอบ
                      </span>
                    )
                  ) : (
                    <span className="rounded-full bg-slate-100 text-slate-600 px-3 py-1 text-xs font-semibold">
                      ยังไม่อัปโหลด
                    </span>
                  )}
                </div>
              </div>

              {/* Upload Status Alerts */}
              {uploadMessage && (
                <div className="mt-4 rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-xs sm:text-sm text-emerald-800 flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <span>{uploadMessage}</span>
                </div>
              )}

              {uploadError && (
                <div className="mt-4 rounded-xl bg-rose-50 border border-rose-200 p-4 text-xs sm:text-sm text-rose-800 flex items-start gap-2">
                  <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  <span>{uploadError}</span>
                </div>
              )}

              <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
                
                {/* Current Slip Preview */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-xs font-bold text-slate-700 mb-2">สลิปที่ส่งเข้าระบบ</p>
                  {currentSlip ? (
                    <div className="space-y-2">
                      <img
                        src={getSlipImageUrl(currentSlip)}
                        alt="Uploaded Slip"
                        className="max-h-60 w-full object-contain rounded-xl border border-slate-200 bg-white"
                      />
                      <div className="text-right">
                        <a
                          href={getSlipImageUrl(currentSlip)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:text-blue-800 underline inline-flex items-center gap-1"
                        >
                          <span>ดูภาพขนาดเต็ม</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="py-8 text-center text-slate-400 text-xs">
                      <CreditCard className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                      <p>ยังไม่มีภาพสลิปในระบบ</p>
                      <p className="mt-1 text-[11px]">สามารถโอนเงิน 300 บาท และแนบสลิปด้านข้างได้ทันที</p>
                    </div>
                  )}
                </div>

                {/* Upload or Re-upload Slip Form */}
                <form onSubmit={onUploadSlip} className="space-y-3">
                  <p className="text-xs font-bold text-slate-700">
                    {currentSlip ? 'อัปโหลดสลิปใหม่ (แทนที่ภาพเดิม)' : 'แนบภาพสลิปโอนเงิน (300 บาท)'}
                  </p>

                  <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/50 p-4 text-center">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={onFileChange}
                      className="block w-full text-xs text-slate-500 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                      disabled={uploadBusy}
                    />
                    <p className="mt-1.5 text-[11px] text-slate-400">
                      รองรับไฟล์ภาพ JPG, PNG, WebP ขนาดไม่เกิน 5MB
                    </p>
                  </div>

                  {previewLocalUrl && (
                    <div className="rounded-xl border border-slate-200 bg-white p-2 text-center">
                      <p className="text-[11px] text-slate-500 mb-1">ตัวอย่างภาพสลิปใหม่:</p>
                      <img src={previewLocalUrl} alt="New Slip Preview" className="max-h-36 mx-auto rounded object-contain" />
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={uploadBusy || !selectedFile}
                    className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white shadow-2xs hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {uploadBusy ? (
                      <>
                        <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                        <span>กำลังอัปโหลด...</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud className="w-3.5 h-3.5" />
                        <span>{currentSlip ? 'อัปโหลดสลิปใหม่' : 'อัปโหลดสลิปยืนยัน'}</span>
                      </>
                    )}
                  </button>
                </form>

              </div>
            </section>
          )}

        </div>
      )}
    </div>
  );
}