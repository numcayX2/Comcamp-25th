import { useState, useEffect } from 'react';
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
  PENDING: 'bg-amber-100 text-amber-800 border-amber-200',
  PASSED: 'bg-blue-100 text-blue-800 border-blue-200',
  RESERVE: 'bg-purple-100 text-purple-800 border-purple-200',
  CONFIRMED: 'bg-green-100 text-green-800 border-green-200',
  REJECTED: 'bg-red-100 text-red-800 border-red-200',
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
      setApp((prev) =>
        prev
          ? {
              ...prev,
              slipUrl: res.data.slipUrl,
              slip_url: res.data.slipUrl,
            }
          : null,
      );
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

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      <header className="mb-8 text-center">
        <p className="text-sm font-semibold tracking-widest text-blue-700 uppercase">ComCamp #25</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 sm:text-3xl">ตรวจสอบสถานะใบสมัคร</h1>
        <p className="mt-2 text-sm text-gray-500">
          ค้นหาด้วยเลขบัตรประชาชน (13 หลัก), เบอร์โทรศัพท์ หรือ Application ID (เช่น CC25-XXXXXX)
        </p>
      </header>

      {/* Search Form */}
      <form onSubmit={onSearch} className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:flex-row sm:p-6">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="เช่น 1509900112233 หรือ CC25-XXXXXX"
          className="w-full flex-1 rounded-lg border border-gray-300 px-4 py-3 text-base text-gray-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
        />
        <button
          type="submit"
          disabled={busy || !q.trim()}
          className="rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold whitespace-nowrap text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
        >
          {busy ? 'กำลังค้นหา...' : 'ค้นหาข้อมูล'}
        </button>
      </form>

      <p className="mt-2 text-xs text-gray-500 px-1">
        💡 จำ Application ID ไม่ได้? สามารถพิมพ์ค้นหาด้วย <strong>เลขประจำตัวประชาชน 13 หลัก</strong> หรือ <strong>เบอร์โทรศัพท์มือถือ</strong> ที่ใช้สมัครได้ทันที
      </p>

      {/* Recent Applications Quick Access */}
      {recentApps.length > 0 && !app && (
        <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/70 p-3.5 text-xs text-blue-900">
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 shadow-2xs transition-colors"
              >
                <span className="font-mono font-bold">{item.id}</span>
                <span>· {item.fullName}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="font-medium">ไม่พบข้อมูล</p>
            <p className="text-xs mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {app && (
        <div className="mt-8 space-y-6">
          {/* Main Info Card */}
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 pb-4">
              <div>
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-gray-400">Application No.</span>
                <p className="font-mono text-xl font-bold text-gray-900">{app.id}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_COLORS[app.status]}`}>
                  {STATUS_LABELS[app.status] || app.status}
                </span>
                {source && (
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${source === 'LIVE GO API' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                    {source}
                  </span>
                )}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-y-4 gap-x-6 sm:grid-cols-2 text-sm">
              <div>
                <dt className="text-gray-500">ชื่อ - นามสกุล</dt>
                <dd className="font-medium text-gray-900 text-base">{app.fullName}</dd>
              </div>
              <div>
                <dt className="text-gray-500">ชื่อเล่น</dt>
                <dd className="font-medium text-gray-900 text-base">{app.nickname || '-'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">เลขบัตรประชาชน</dt>
                <dd className="font-mono text-gray-800">{app.nationalId}</dd>
              </div>
              <div>
                <dt className="text-gray-500">เบอร์โทรศัพท์ติดต่อ</dt>
                <dd className="text-gray-800">{app.phone}</dd>
              </div>
              <div>
                <dt className="text-gray-500">โรงเรียน</dt>
                <dd className="text-gray-800">{app.school}</dd>
              </div>
              <div>
                <dt className="text-gray-500">ระดับชั้น / ไซส์เสื้อ</dt>
                <dd className="text-gray-800">{app.grade} (เสื้อไซส์: {app.shirtSize})</dd>
              </div>
              {app.email && (
                <div>
                  <dt className="text-gray-500">อีเมล</dt>
                  <dd className="text-gray-800">{app.email}</dd>
                </div>
              )}
              {app.province && (
                <div>
                  <dt className="text-gray-500">จังหวัด</dt>
                  <dd className="text-gray-800">{app.province}</dd>
                </div>
              )}
            </div>

            {/* Attendance Confirmation Section */}
            {app.status === 'PASSED' && (
              <div className="mt-6 rounded-xl bg-blue-50/70 p-4 border border-blue-100">
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
                      className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:opacity-50 transition-colors"
                    >
                      {confirmBusy ? 'กำลังดำเนินการ...' : app.attendanceConfirmed ? '✓ ยืนยันสิทธิ์แล้ว' : 'ยืนยันสิทธิ์'}
                    </button>
                    {app.attendanceConfirmed && (
                      <button
                        type="button"
                        onClick={onCancelConfirm}
                        disabled={confirmBusy}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        ยกเลิก
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Payment Slip Upload Card */}
          {isEligibleForPayment && (
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
              <div className="flex items-center justify-between border-b border-gray-100 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">หลักฐานการชำระเงิน (Payment Slip)</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    ค่าสมัครค่าย 300.00 บาท (รองรับไฟล์ JPG, PNG, WebP ขนาดไม่เกิน 5MB)
                  </p>
                </div>
                <div>
                  {currentSlip ? (
                    app.status === 'CONFIRMED' ? (
                      <span className="rounded-full bg-green-100 text-green-800 px-3 py-1 text-xs font-semibold">
                        ✓ อนุมัติสลิปแล้ว
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-100 text-amber-800 px-3 py-1 text-xs font-semibold">
                        ⏳ รอเจ้าหน้าที่ตรวจสอบ
                      </span>
                    )
                  ) : (
                    <span className="rounded-full bg-gray-100 text-gray-600 px-3 py-1 text-xs font-semibold">
                      ยังไม่อัปโหลด
                    </span>
                  )}
                </div>
              </div>

              {/* Upload Status Alerts */}
              {uploadMessage && (
                <div className="mt-4 rounded-xl bg-green-50 border border-green-200 p-4 text-sm text-green-800 flex items-start gap-2">
                  <svg className="w-5 h-5 text-green-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <span>{uploadMessage}</span>
                </div>
              )}

              {uploadError && (
                <div className="mt-4 rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-start gap-2">
                  <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{uploadError}</span>
                </div>
              )}

              <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                {/* Current Slip Preview */}
                <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
                  <p className="text-sm font-semibold text-gray-700 mb-2">สลิปที่อัปโหลดปัจจุบัน</p>
                  {currentSlip ? (
                    <div className="space-y-3">
                      <div className="relative group overflow-hidden rounded-lg border border-gray-200 bg-white">
                        <img
                          src={getSlipImageUrl(currentSlip)}
                          alt="หลักฐานการโอนเงิน"
                          className="w-full max-h-64 object-contain mx-auto"
                        />
                      </div>
                      <a
                        href={getSlipImageUrl(currentSlip)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium underline"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                        เปิดดูรูปภาพขนาดเต็ม
                      </a>
                    </div>
                  ) : (
                    <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center text-gray-400">
                      <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <p className="mt-2 text-xs">ยังไม่มีรูปภาพสลิปในระบบ</p>
                    </div>
                  )}
                </div>

                {/* File Upload Form */}
                <form onSubmit={onUploadSlip} className="flex flex-col gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="slipFile">
                      {currentSlip ? 'อัปโหลดสลิปใหม่เพื่อแทนที่' : 'เลือกไฟล์สลิปการโอนเงิน'}
                    </label>
                    <input
                      id="slipFile"
                      type="file"
                      accept="image/*"
                      onChange={onFileChange}
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer border border-gray-200 rounded-lg p-1 bg-white"
                    />
                  </div>

                  {previewLocalUrl && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3">
                      <p className="text-xs font-semibold text-blue-900 mb-2">ตัวอย่างรูปภาพที่กำลังจะอัปโหลด:</p>
                      <img
                        src={previewLocalUrl}
                        alt="ตัวอย่างรูปภาพสลิปใหม่"
                        className="max-h-48 rounded object-contain mx-auto"
                      />
                      <p className="mt-1 text-center text-xs text-gray-500">
                        {selectedFile?.name} ({(selectedFile ? selectedFile.size / 1024 : 0).toFixed(1)} KB)
                      </p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={uploadBusy || !selectedFile}
                    className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {uploadBusy ? 'กำลังอัปโหลด...' : 'ยืนยันและส่งหลักฐานสลิป'}
                  </button>
                  <p className="text-center text-xs text-gray-400">
                    Endpoint: <code>POST /api/applications/:id/slip</code>
                  </p>
                </form>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
