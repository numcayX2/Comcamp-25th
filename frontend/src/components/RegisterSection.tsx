import { useState } from 'react';
import {
  submitApplication,
  uploadPaymentSlip,
  getSlipImageUrl,
  type ApplicationPayload,
  type Application,
  type ApiSource,
  type ShirtSize,
} from '../lib/api';

const GRADES = ['ม.4', 'ม.5', 'ม.6', 'ปวช.1', 'ปวช.2', 'ปวช.3'];
const SHIRT_SIZES: ShirtSize[] = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

const EMPTY: ApplicationPayload = {
  fullName: '',
  nickname: '',
  nationalId: '',
  phone: '',
  email: '',
  school: '',
  grade: 'ม.4',
  shirtSize: 'M',
  motivation: '',
  province: 'เชียงใหม่',
};

export function RegisterSection() {
  const [form, setForm] = useState<ApplicationPayload>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [createdApp, setCreatedApp] = useState<Application | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 2: Slip upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewLocalUrl, setPreviewLocalUrl] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedSlipUrl, setUploadedSlipUrl] = useState<string | null>(null);

  const set = <K extends keyof ApplicationPayload>(key: K, value: ApplicationPayload[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const inputCls =
    'w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 placeholder-gray-400 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-colors';
  const labelCls = 'block text-sm font-medium text-gray-700 mb-1.5';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Client-side validation aligning with Go backend
    const cleanNationalId = form.nationalId.trim();
    if (!/^\d{13}$/.test(cleanNationalId)) {
      setError('เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก');
      return;
    }

    const cleanPhone = form.phone.trim();
    if (!/^0\d{9}$/.test(cleanPhone)) {
      setError('เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0 (เช่น 08XXXXXXXX)');
      return;
    }

    if (!form.fullName.trim() || !form.nickname.trim() || !form.school.trim()) {
      setError('กรุณากรอกข้อมูลในช่องที่มีเครื่องหมาย * ให้ครบถ้วน');
      return;
    }

    setBusy(true);
    setError(null);
    setCreatedApp(null);
    setUploadMessage(null);
    setUploadError(null);

    try {
      const payload: ApplicationPayload = {
        ...form,
        nationalId: cleanNationalId,
        phone: cleanPhone,
        fullName: form.fullName.trim(),
        nickname: form.nickname.trim(),
        school: form.school.trim(),
        province: form.province?.trim() || 'เชียงใหม่',
      };
      const res = await submitApplication(payload);
      setCreatedApp(res.data);
      setSource(res.source);
      // Scroll to top smoothly
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการส่งใบสมัคร');
    } finally {
      setBusy(false);
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
        setSelectedFile(null);
        setPreviewLocalUrl(null);
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setUploadError('ขนาดไฟล์ต้องไม่เกิน 5MB');
        setSelectedFile(null);
        setPreviewLocalUrl(null);
        return;
      }
      setSelectedFile(file);
      setPreviewLocalUrl(URL.createObjectURL(file));
    }
  }

  async function handleUploadSlip(e: React.FormEvent) {
    e.preventDefault();
    if (!createdApp || !selectedFile) return;

    setUploadBusy(true);
    setUploadError(null);
    setUploadMessage(null);

    try {
      const res = await uploadPaymentSlip(createdApp.id, selectedFile);
      setUploadedSlipUrl(res.data.slipUrl);
      setUploadMessage(res.data.message || 'อัปโหลดสลิปเรียบร้อยแล้ว ข้อมูลถูกส่งเข้าสู่ระบบของพี่ค่ายเพื่อตรวจสอบ');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการอัปโหลดสลิป');
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      
      {/* Step Indicator */}
      <div className="mb-8 flex items-center justify-center gap-2 sm:gap-4 text-xs sm:text-sm font-medium">
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full ${!createdApp ? 'bg-blue-600 text-white font-semibold' : 'bg-green-100 text-green-800'}`}>
          <span>{!createdApp ? '1' : '✓'}</span>
          <span>กรอกใบสมัคร</span>
        </div>
        <span className="text-gray-300">&rarr;</span>
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full ${createdApp ? 'bg-blue-600 text-white font-semibold shadow-sm' : 'bg-gray-100 text-gray-500'}`}>
          <span>2</span>
          <span>ชำระเงินค่าสมัคร & แนบสลิป</span>
        </div>
      </div>

      {!createdApp ? (
        <>
          <header className="mb-8 text-center">
            <p className="text-sm font-semibold tracking-widest text-blue-700 uppercase">ComCamp #25</p>
            <h1 className="mt-2 text-2xl font-bold text-gray-900 sm:text-3xl">สมัครเข้าร่วมค่าย ComCamp #25</h1>
            <p className="mt-2 text-sm text-gray-500">
              กรอกข้อมูลส่วนตัวเพื่อลงทะเบียนเข้าสู่ระบบ จากนั้นจะเข้าสู่ขั้นตอนชำระเงินค่าสมัคร
            </p>
          </header>

          {error && (
            <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-start gap-2.5">
              <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:grid-cols-2 sm:p-8">
            <div>
              <label className={labelCls} htmlFor="fullName">ชื่อ-นามสกุล *</label>
              <input id="fullName" className={inputCls} required value={form.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="เช่น สมชาย ใจดี" />
            </div>
            <div>
              <label className={labelCls} htmlFor="nickname">ชื่อเล่น *</label>
              <input id="nickname" className={inputCls} required value={form.nickname} onChange={(e) => set('nickname', e.target.value)} placeholder="เช่น ชาย" />
            </div>
            <div>
              <label className={labelCls} htmlFor="nationalId">เลขบัตรประชาชน (13 หลัก) *</label>
              <input id="nationalId" className={inputCls} required maxLength={13} value={form.nationalId} onChange={(e) => set('nationalId', e.target.value.replace(/\D/g, ''))} placeholder="เช่น 1509900112233" inputMode="numeric" />
            </div>
            <div>
              <label className={labelCls} htmlFor="phone">เบอร์โทรศัพท์ (10 หลัก) *</label>
              <input id="phone" className={inputCls} required maxLength={10} type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value.replace(/\D/g, ''))} placeholder="08XXXXXXXX" inputMode="numeric" />
            </div>
            <div>
              <label className={labelCls} htmlFor="email">อีเมล</label>
              <input id="email" className={inputCls} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" />
            </div>
            <div>
              <label className={labelCls} htmlFor="school">โรงเรียน *</label>
              <input id="school" className={inputCls} required value={form.school} onChange={(e) => set('school', e.target.value)} placeholder="ชื่อโรงเรียน" />
            </div>
            <div>
              <label className={labelCls} htmlFor="province">จังหวัด (Province)</label>
              <input id="province" className={inputCls} value={form.province || ''} onChange={(e) => set('province', e.target.value)} placeholder="เช่น เชียงใหม่" />
            </div>
            <div>
              <label className={labelCls} htmlFor="grade">ชั้นเรียน *</label>
              <select id="grade" className={inputCls} value={form.grade} onChange={(e) => set('grade', e.target.value)}>
                {GRADES.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="shirtSize">ไซส์เสื้อ *</label>
              <select id="shirtSize" className={inputCls} value={form.shirtSize} onChange={(e) => set('shirtSize', e.target.value as ShirtSize)}>
                {SHIRT_SIZES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="motivation">แรงบันดาลใจในการเข้าร่วมค่าย</label>
              <textarea id="motivation" className={inputCls} rows={3} value={form.motivation} onChange={(e) => set('motivation', e.target.value)} placeholder="เล่าเหตุผลหรือสิ่งที่อยากเรียนรู้ในค่าย ComCamp #25" />
            </div>
            <div className="sm:col-span-2 pt-2">
              <button type="submit" disabled={busy} className="w-full rounded-xl bg-blue-600 px-4 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {busy ? 'กำลังส่งข้อมูล...' : 'ส่งใบสมัคร & ไปหน้าชำระเงิน →'}
              </button>
            </div>
          </form>
        </>
      ) : (
        /* Step 2: Payment & Slip Upload Section */
        <div className="space-y-6">
          <header className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3.5 py-1 text-xs font-semibold text-green-800 mb-2">
              ✓ ส่งใบสมัครสำเร็จ
            </span>
            <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">ขั้นตอนชำระเงินค่าสมัคร & แนบสลิป</h1>
            <p className="mt-1 text-sm text-gray-500">
              โอนเงินค่าสมัครค่ายและแนบภาพถ่ายสลิปเพื่อให้พี่ค่ายตรวจสอบยืนยันสิทธิ์
            </p>
          </header>

          {/* Applicant Info Summary Card */}
          <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 pb-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">เลขที่ใบสมัคร (Application No.)</p>
                <p className="text-2xl font-bold font-mono text-blue-900">{createdApp.id}</p>
              </div>
              <span className="rounded-full bg-amber-100 border border-amber-200 px-3 py-1 text-xs font-semibold text-amber-800">
                สถานะ: รอชำระเงินและตรวจสลิป
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-gray-700">
              <p><span className="text-gray-400">ผู้สมัคร:</span> <strong>{createdApp.fullName}</strong> ({createdApp.nickname})</p>
              <p><span className="text-gray-400">โรงเรียน:</span> {createdApp.school} ({createdApp.grade})</p>
              <p><span className="text-gray-400">เบอร์โทร:</span> {createdApp.phone}</p>
            </div>
          </div>

          {/* Payment Instructions Card */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-7 shadow-sm">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <span>💳 ข้อมูลการโอนเงิน</span>
              <span className="text-xs font-normal text-gray-500">(ยอดชำระ 300.00 บาท)</span>
            </h2>

            <div className="mt-4 rounded-xl border border-gray-100 bg-gray-50 p-4 flex flex-col sm:flex-row items-center gap-4">
              <div className="w-28 h-28 bg-white border border-gray-200 rounded-lg p-2 flex flex-col items-center justify-center text-center shrink-0">
                <span className="text-[10px] text-gray-400 font-mono">PromptPay QR</span>
                <span className="text-2xl mt-1">📱</span>
                <span className="text-[10px] text-blue-700 font-bold mt-1">สแกนจ่าย 300.-</span>
              </div>
              <div className="space-y-1.5 text-sm text-gray-700 w-full">
                <p><span className="text-gray-400">ธนาคาร:</span> <strong>ธนาคารกรุงไทย (Krungthai Bank)</strong></p>
                <p><span className="text-gray-400">เลขที่บัญชี:</span> <strong className="font-mono text-blue-900 text-base">123-4-56789-0</strong></p>
                <p><span className="text-gray-400">ชื่อบัญชี:</span> <strong>โครงการค่ายยุวชนคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้</strong></p>
                <p><span className="text-gray-400">ยอดเงินที่ต้องโอน:</span> <strong className="text-green-700 text-base">300.00 บาท</strong></p>
              </div>
            </div>

            {/* Slip Upload Box */}
            <form onSubmit={handleUploadSlip} className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1.5">
                  แนบภาพถ่ายสลิปโอนเงิน (Slip) *
                </label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={onFileChange}
                  className="block w-full text-sm text-gray-500 file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                  disabled={uploadBusy || Boolean(uploadedSlipUrl)}
                />
                <p className="mt-1 text-xs text-gray-400">
                  รองรับไฟล์ภาพ JPG, PNG, WebP ขนาดไม่เกิน 5MB (ระบบตรวจจับสลิปซ้ำผ่าน SHA-256)
                </p>
              </div>

              {previewLocalUrl && (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 max-w-xs mx-auto">
                  <p className="text-xs text-gray-500 mb-1 text-center font-medium">ตัวอย่างรูปสลิปที่เลือก:</p>
                  <img src={previewLocalUrl} alt="Preview" className="max-h-48 rounded mx-auto object-contain" />
                </div>
              )}

              {uploadError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-start gap-2">
                  <span className="text-red-500 font-bold">✕</span>
                  <span>{uploadError}</span>
                </div>
              )}

              {uploadMessage && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-green-600 font-bold">✓</span>
                    <strong className="font-semibold">{uploadMessage}</strong>
                  </div>
                  <p className="text-xs text-green-700">
                    พี่ค่ายได้รับหลักฐานการโอนเงินแล้ว และจะตรวจสอบความถูกต้องในหน้า Admin ระบบจะปรับสถานะเป็น ยืนยันสิทธิ์สมบูรณ์ (CONFIRMED) ทันทีที่ได้รับการอนุมัติ
                  </p>
                </div>
              )}

              {!uploadedSlipUrl ? (
                <button
                  type="submit"
                  disabled={uploadBusy || !selectedFile}
                  className="w-full rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {uploadBusy ? 'กำลังอัปโหลดสลิป...' : '📤 อัปโหลดสลิปยืนยันการสมัคร'}
                </button>
              ) : (
                <div className="pt-2 flex flex-col sm:flex-row gap-3">
                  <a
                    href={`/status?q=${createdApp.id}`}
                    className="flex-1 rounded-xl bg-green-600 px-4 py-3 text-center text-sm font-semibold text-white hover:bg-green-700 shadow-sm transition-colors"
                  >
                    🔍 ไปที่หน้าตรวจสอบสถานะใบสมัคร
                  </a>
                  <a
                    href="/"
                    className="rounded-xl border border-gray-300 bg-white px-4 py-3 text-center text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    กลับสู่หน้าหลัก
                  </a>
                </div>
              )}
            </form>

            <div className="mt-6 border-t border-gray-100 pt-4 text-center">
              <p className="text-xs text-gray-400">
                หากยังไม่สะดวกโอนเงินในตอนนี้ ท่านสามารถกลับมาแนบสลิปภายหลังได้ตลอดเวลาที่{' '}
                <a href={`/status?q=${createdApp.id}`} className="text-blue-600 underline font-medium">
                  หน้าตรวจสอบสถานะ (/status)
                </a>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
