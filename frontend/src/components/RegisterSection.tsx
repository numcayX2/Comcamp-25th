import { useState, useEffect } from 'react';
import {
  User,
  Phone,
  CreditCard,
  CheckCircle2,
  AlertTriangle,
  UploadCloud,
  Copy,
  FileText,
  School,
  Tag,
  Sparkles,
  MapPin,
  Mail,
  BookOpen,
  ArrowRight,
  RotateCcw,
  Check,
  Trash2,
  ExternalLink,
  ShieldCheck,
  CheckSquare,
} from 'lucide-react';
import {
  submitApplication,
  uploadPaymentSlip,
  getApplicationStatus,
  getSlipImageUrl,
  getSlipUrl,
  saveActiveApplication,
  getActiveApplication,
  clearActiveApplication,
  saveFormDraft,
  getFormDraft,
  clearFormDraft,
  type ApplicationPayload,
  type Application,
  type ApiSource,
  type ShirtSize,
} from '../lib/api';

const GRADES = ['ม.4', 'ม.5', 'ม.6', 'ปวช.1', 'ปวช.2', 'ปวช.3'];

const SHIRT_SIZE_SPECS: { size: ShirtSize; chest: string }[] = [
  { size: 'XS', chest: 'รอบอก 34"' },
  { size: 'S', chest: 'รอบอก 36"' },
  { size: 'M', chest: 'รอบอก 38"' },
  { size: 'L', chest: 'รอบอก 40"' },
  { size: 'XL', chest: 'รอบอก 42"' },
  { size: '2XL', chest: 'รอบอก 44"' },
  { size: '3XL', chest: 'รอบอก 48"' },
];

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
  const [recoverableApp, setRecoverableApp] = useState<Application | null>(null);

  // Step 2: Slip upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewLocalUrl, setPreviewLocalUrl] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedSlipUrl, setUploadedSlipUrl] = useState<string | null>(null);
  const [copiedBank, setCopiedBank] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Restore application or draft on mount (survives refresh)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const queryId = params.get('id') || params.get('appId') || params.get('q');

    if (queryId) {
      setBusy(true);
      getApplicationStatus(queryId.trim())
        .then((res) => {
          setCreatedApp(res.data);
          setSource(res.source);
          saveActiveApplication(res.data);
          const currentSlip = getSlipUrl(res.data);
          if (currentSlip) setUploadedSlipUrl(currentSlip);
        })
        .catch(() => {
          restoreFromStorage();
        })
        .finally(() => setBusy(false));
      return;
    }

    restoreFromStorage();

    function restoreFromStorage() {
      const savedApp = getActiveApplication();
      if (savedApp) {
        setCreatedApp(savedApp);
        const currentSlip = getSlipUrl(savedApp);
        if (currentSlip) setUploadedSlipUrl(currentSlip);

        // Fetch latest status in background to keep data fresh
        getApplicationStatus(savedApp.id)
          .then((res) => {
            setCreatedApp(res.data);
            setSource(res.source);
            saveActiveApplication(res.data);
            const liveSlip = getSlipUrl(res.data);
            if (liveSlip) setUploadedSlipUrl(liveSlip);
          })
          .catch(() => {});
        return;
      }

      // Restore form draft if any
      const draft = getFormDraft();
      if (draft) {
        setForm(draft);
      }
    }
  }, []);

  const set = <K extends keyof ApplicationPayload>(key: K, value: ApplicationPayload[K]) => {
    setForm((f) => {
      const updated = { ...f, [key]: value };
      saveFormDraft(updated);
      return updated;
    });
  };

  function handleStartNewApplication() {
    clearActiveApplication();
    clearFormDraft();
    setCreatedApp(null);
    setForm(EMPTY);
    setRecoverableApp(null);
    setSelectedFile(null);
    setPreviewLocalUrl(null);
    setUploadedSlipUrl(null);
    setUploadMessage(null);
    setUploadError(null);
    setError(null);
    if (typeof window !== 'undefined' && window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete('id');
      url.searchParams.delete('appId');
      url.searchParams.delete('q');
      window.history.replaceState(null, '', url.pathname);
    }
  }

  function copyBankNumber() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText('123-4-56789-0');
      setCopiedBank(true);
      setTimeout(() => setCopiedBank(false), 2200);
    }
  }

  const inputCls =
    'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all';
  const labelCls = 'block text-xs font-semibold text-slate-700 mb-1.5';

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
    setRecoverableApp(null);
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
      saveActiveApplication(res.data);
      clearFormDraft();

      // Update URL with ?id=... so refresh keeps the exact application
      if (typeof window !== 'undefined' && window.history.replaceState) {
        const url = new URL(window.location.href);
        url.searchParams.set('id', res.data.id);
        window.history.replaceState(null, '', url.toString());
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการส่งใบสมัคร';
      const isAlreadyRegistered =
        msg.includes('already registered') ||
        msg.includes('เคยลงทะเบียน') ||
        msg.includes('ซ้ำ');

      if (isAlreadyRegistered) {
        // Look up existing application so user can resume immediately without remembering ID!
        const searchKey = cleanNationalId || cleanPhone;
        getApplicationStatus(searchKey)
          .then((foundRes) => {
            setRecoverableApp(foundRes.data);
            setError(null);
          })
          .catch(() => {
            setError(msg);
          });
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  function processSelectedFile(file?: File) {
    if (!file) return;
    setUploadError(null);
    setUploadMessage(null);

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

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    processSelectedFile(e.target.files?.[0]);
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
      const updatedApp: Application = {
        ...createdApp,
        slipUrl: res.data.slipUrl,
        slip_url: res.data.slipUrl,
      };
      setCreatedApp(updatedApp);
      saveActiveApplication(updatedApp);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการอัปโหลดสลิป');
    } finally {
      setUploadBusy(false);
    }
  }

  const isNatIdValid = /^\d{13}$/.test(form.nationalId);
  const isPhoneValid = /^0\d{9}$/.test(form.phone);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      
      {/* Visual Stepper Bar */}
      <div className="mb-8">
        <div className="flex items-center justify-between max-w-md mx-auto">
          {/* Step 1 Pill */}
          <div className="flex items-center gap-2">
            <div className={`flex h-8 w-8 items-center justify-center rounded-xl text-xs font-bold transition-all ${
              !createdApp
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-emerald-100 text-emerald-800'
            }`}>
              {!createdApp ? '1' : <Check className="w-4 h-4" />}
            </div>
            <div className="text-left">
              <p className="text-xs font-semibold text-slate-900">ขั้นตอนที่ 1</p>
              <p className="text-[11px] text-slate-500">กรอกข้อมูลใบสมัคร</p>
            </div>
          </div>

          <div className="h-0.5 w-12 sm:w-20 bg-slate-200" />

          {/* Step 2 Pill */}
          <div className="flex items-center gap-2">
            <div className={`flex h-8 w-8 items-center justify-center rounded-xl text-xs font-bold transition-all ${
              createdApp
                ? 'bg-blue-600 text-white shadow-xs ring-4 ring-blue-50'
                : 'bg-slate-100 text-slate-400'
            }`}>
              2
            </div>
            <div className="text-left">
              <p className="text-xs font-semibold text-slate-900">ขั้นตอนที่ 2</p>
              <p className="text-[11px] text-slate-500">ชำระเงิน & แนบสลิป</p>
            </div>
          </div>
        </div>
      </div>

      {!createdApp ? (
        /* STEP 1: Registration Form */
        <div>
          <header className="mb-8 text-center">
            <div className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
              <Sparkles className="w-3.5 h-3.5" />
              <span>ComCamp #25 · รับสมัครน้องค่าย</span>
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              สมัครเข้าร่วมค่าย ComCamp #25
            </h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-500">
              กรอกข้อมูลเพื่อลงทะเบียนเข้าสู่ระบบ จากนั้นจะเข้าสู่ขั้นตอนชำระเงินค่ายืนยันสิทธิ์ทันที
            </p>
          </header>

          {/* Conflict Recovery Banner (เมื่อพบว่าเคยสมัครแล้ว) */}
          {recoverableApp && (
            <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50/80 p-5 shadow-2xs text-amber-950">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-bold text-sm text-amber-900">
                    ตรวจพบข้อมูลการสมัครในระบบแล้ว
                  </h3>
                  <p className="mt-1 text-xs text-amber-800 leading-relaxed">
                    เลขบัตรประชาชน <strong className="font-mono">{recoverableApp.nationalId}</strong> หรือเบอร์โทรศัพท์นี้ เคยส่งใบสมัครแล้วในชื่อ <strong>{recoverableApp.fullName}</strong> ({recoverableApp.nickname})
                    <span className="block mt-0.5 font-mono text-[11px] text-amber-700">
                      เลขที่ใบสมัคร: <strong>{recoverableApp.id}</strong> (สถานะ: {recoverableApp.status})
                    </span>
                  </p>
                  <div className="mt-3.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCreatedApp(recoverableApp);
                        saveActiveApplication(recoverableApp);
                        setRecoverableApp(null);
                        const existingSlip = getSlipUrl(recoverableApp);
                        if (existingSlip) setUploadedSlipUrl(existingSlip);
                        if (typeof window !== 'undefined' && window.history.replaceState) {
                          const url = new URL(window.location.href);
                          url.searchParams.set('id', recoverableApp.id);
                          window.history.replaceState(null, '', url.toString());
                        }
                      }}
                      className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 shadow-2xs transition-colors flex items-center gap-1.5"
                    >
                      <CreditCard className="w-3.5 h-3.5" />
                      <span>ไปหน้าชำระเงิน & แนบสลิปต่อทันที</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={`/status?q=${recoverableApp.id}`}
                      className="rounded-xl border border-amber-300 bg-white px-3.5 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100 transition-colors inline-flex items-center gap-1.5"
                    >
                      <span>ตรวจสอบสถานะ</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs sm:text-sm text-rose-800 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-6">
            
            {/* Section 1: ข้อมูลส่วนตัว */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-2xs space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                <User className="w-4 h-4 text-blue-600" />
                <h2 className="text-sm font-bold text-slate-900">1. ข้อมูลส่วนตัวผู้สมัคร</h2>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls} htmlFor="fullName">ชื่อ-นามสกุล *</label>
                  <input
                    id="fullName"
                    className={inputCls}
                    required
                    value={form.fullName}
                    onChange={(e) => set('fullName', e.target.value)}
                    placeholder="เช่น สมชาย ใจดี"
                  />
                </div>

                <div>
                  <label className={labelCls} htmlFor="nickname">ชื่อเล่น *</label>
                  <input
                    id="nickname"
                    className={inputCls}
                    required
                    value={form.nickname}
                    onChange={(e) => set('nickname', e.target.value)}
                    placeholder="เช่น ชาย"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-700" htmlFor="nationalId">
                      เลขประจำตัวประชาชน (13 หลัก) *
                    </label>
                    {isNatIdValid && (
                      <span className="text-[11px] text-emerald-600 font-medium inline-flex items-center gap-1">
                        <Check className="w-3 h-3" /> ครบ 13 หลัก
                      </span>
                    )}
                  </div>
                  <input
                    id="nationalId"
                    className={`${inputCls} font-mono`}
                    required
                    maxLength={13}
                    value={form.nationalId}
                    onChange={(e) => set('nationalId', e.target.value.replace(/\D/g, ''))}
                    placeholder="1509900112233"
                    inputMode="numeric"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">ใช้สำหรับยืนยันตัวตนและค้นหาประวัติใบสมัคร</p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-700" htmlFor="phone">
                      เบอร์โทรศัพท์มือถือ (10 หลัก) *
                    </label>
                    {isPhoneValid && (
                      <span className="text-[11px] text-emerald-600 font-medium inline-flex items-center gap-1">
                        <Check className="w-3 h-3" /> ถูกต้อง
                      </span>
                    )}
                  </div>
                  <input
                    id="phone"
                    className={`${inputCls} font-mono`}
                    required
                    maxLength={10}
                    type="tel"
                    value={form.phone}
                    onChange={(e) => set('phone', e.target.value.replace(/\D/g, ''))}
                    placeholder="08XXXXXXXX"
                    inputMode="numeric"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">เบอร์ที่สามารถติดต่อได้ในวันค่าย</p>
                </div>

                <div className="sm:col-span-2">
                  <label className={labelCls} htmlFor="email">อีเมลสำหรับติดต่อ (ไม่บังคับ)</label>
                  <input
                    id="email"
                    className={inputCls}
                    type="email"
                    value={form.email}
                    onChange={(e) => set('email', e.target.value)}
                    placeholder="student@example.com"
                  />
                </div>
              </div>
            </div>

            {/* Section 2: ข้อมูลการศึกษา & ไซส์เสื้อ */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-2xs space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                <School className="w-4 h-4 text-blue-600" />
                <h2 className="text-sm font-bold text-slate-900">2. ข้อมูลการศึกษาและเสื้อค่าย</h2>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls} htmlFor="school">โรงเรียน / วิทยาลัย *</label>
                  <input
                    id="school"
                    className={inputCls}
                    required
                    value={form.school}
                    onChange={(e) => set('school', e.target.value)}
                    placeholder="เช่น โรงเรียนแม่โจ้วิทยาคม"
                  />
                </div>

                <div>
                  <label className={labelCls} htmlFor="province">จังหวัดของโรงเรียน *</label>
                  <input
                    id="province"
                    className={inputCls}
                    value={form.province}
                    onChange={(e) => set('province', e.target.value)}
                    placeholder="เช่น เชียงใหม่, ลำพูน, ลำปาง"
                  />
                </div>

                <div>
                  <label className={labelCls} htmlFor="grade">ระดับชั้นปัจจุบัน *</label>
                  <select
                    id="grade"
                    className={inputCls}
                    value={form.grade}
                    onChange={(e) => set('grade', e.target.value)}
                  >
                    {GRADES.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelCls} htmlFor="shirtSize">ไซส์เสื้อค่าย ComCamp #25 *</label>
                  <select
                    id="shirtSize"
                    className={inputCls}
                    value={form.shirtSize}
                    onChange={(e) => set('shirtSize', e.target.value as ShirtSize)}
                  >
                    {SHIRT_SIZE_SPECS.map(({ size, chest }) => (
                      <option key={size} value={size}>
                        ไซส์ {size} ({chest})
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-400">
                    ขนาดที่เลือก: <strong className="text-blue-700">{form.shirtSize}</strong> ({SHIRT_SIZE_SPECS.find(s => s.size === form.shirtSize)?.chest})
                  </p>
                </div>
              </div>
            </div>

            {/* Section 3: ความมุ่งหวัง & เหตุผล */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-2xs space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <h2 className="text-sm font-bold text-slate-900">3. ความมุ่งหวังในการเข้าร่วมค่าย</h2>
                </div>
                <span className="text-[11px] text-slate-400 font-mono">
                  {form.motivation.length} ตัวอักษร
                </span>
              </div>

              <div>
                <label className={labelCls} htmlFor="motivation">
                  เหตุผลและความสนใจที่อยากเข้าร่วมค่าย ComCamp ครั้งที่ 25 *
                </label>
                <textarea
                  id="motivation"
                  required
                  rows={4}
                  className={`${inputCls} resize-none`}
                  value={form.motivation}
                  onChange={(e) => set('motivation', e.target.value)}
                  placeholder="เช่น อยากเรียนรู้การเขียนโปรแกรมและการทำโครงงาน IoT เชื่อมต่อคลาวด์ พร้อมทั้งสัมผัสบรรยากาศการเรียนสาขาวิทยาการคอมพิวเตอร์ ม.แม่โจ้..."
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  บอกเล่าความสนใจเพื่อช่วยให้พี่ๆ ค่ายเตรียมเนื้อหาที่เหมาะสมสำหรับน้อง
                </p>
              </div>
            </div>

            {/* Submit Action */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-2xl bg-blue-600 px-6 py-3.5 text-base font-semibold text-white shadow-xs hover:bg-blue-700 disabled:opacity-50 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {busy ? (
                  <>
                    <RotateCcw className="w-4 h-4 animate-spin" />
                    <span>กำลังส่งข้อมูลใบสมัคร...</span>
                  </>
                ) : (
                  <>
                    <span>ส่งใบสมัคร & ไปขั้นตอนชำระเงิน</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
              <p className="mt-2 text-center text-[11px] text-slate-400">
                เมื่อกดส่งใบสมัคร ระบบจะบันทึกข้อมูลและนำท่านเข้าสู่ขั้นตอนโอนเงิน 300 บาท และแนบสลิปทันที
              </p>
            </div>
          </form>
        </div>
      ) : (
        /* STEP 2: Payment & Slip Upload Section */
        <div className="space-y-6">
          
          <header className="text-center">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 mb-2 border border-emerald-200">
              <Check className="w-3.5 h-3.5 text-emerald-600" />
              <span>ส่งใบสมัครสำเร็จแล้ว</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              ขั้นตอนชำระเงินค่าสมัคร & แนบสลิป
            </h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-500">
              โอนเงินค่าสมัครค่าย 300 บาท และแนบสลิปเพื่อให้พี่ค่ายตรวจสอบยืนยันสิทธิ์
            </p>
          </header>

          {/* Applicant Info Summary Card */}
          <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-5 shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 pb-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">เลขที่ใบสมัคร (Application No.)</p>
                <p className="text-2xl font-bold font-mono text-blue-900">{createdApp.id}</p>
                <p className="text-[11px] text-emerald-700 font-medium mt-0.5 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>บันทึกข้อมูลในเครื่องนี้แล้ว (รีเฟรชหน้าจอข้อมูลไม่หาย)</span>
                </p>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <span className="rounded-full bg-amber-100 border border-amber-200 px-3 py-1 text-xs font-semibold text-amber-900">
                  สถานะ: {createdApp.status === 'PENDING' ? 'รอชำระเงินและตรวจสลิป' : createdApp.status}
                </span>
                <button
                  type="button"
                  onClick={handleStartNewApplication}
                  className="text-xs text-blue-700 hover:text-rose-600 underline font-medium transition-colors cursor-pointer"
                >
                  + สมัครใหม่สำหรับคนอื่น
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-slate-700">
              <p><span className="text-slate-400">ผู้สมัคร:</span> <strong>{createdApp.fullName}</strong> ({createdApp.nickname})</p>
              <p><span className="text-slate-400">โรงเรียน:</span> {createdApp.school} ({createdApp.grade})</p>
              <p><span className="text-slate-400">เบอร์โทร:</span> <span className="font-mono">{createdApp.phone}</span></p>
            </div>
          </div>

          {/* Payment Instructions Card */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 shadow-2xs">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3.5">
              <div className="flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-blue-600" />
                <h2 className="text-base font-bold text-slate-900">ช่องทางการโอนเงิน</h2>
              </div>
              <span className="rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 px-3 py-0.5 text-xs font-semibold">
                ยอดชำระ 300.00 บาท
              </span>
            </div>

            {/* Bank Card with Copy Action */}
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/70 p-5 flex flex-col sm:flex-row items-center gap-5">
              
              {/* QR Mockup Card */}
              <div className="w-32 h-32 rounded-xl border border-blue-200 bg-white p-2.5 flex flex-col items-center justify-between text-center shrink-0 shadow-2xs">
                <div className="w-full bg-blue-900 text-white rounded px-1.5 py-0.5 text-[9px] font-bold font-mono">
                  PROMPTPAY
                </div>
                <div className="text-3xl my-auto">📲</div>
                <span className="text-[11px] text-blue-700 font-bold">สแกนจ่าย 300.-</span>
              </div>

              {/* Bank Details */}
              <div className="space-y-2 text-xs sm:text-sm text-slate-700 w-full">
                <p>
                  <span className="text-slate-400">ธนาคาร:</span> <strong>ธนาคารกรุงไทย (Krungthai Bank)</strong>
                </p>
                
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-400">เลขที่บัญชี:</span>
                  <strong className="font-mono text-blue-950 text-base sm:text-lg tracking-wider">
                    123-4-56789-0
                  </strong>
                  <button
                    type="button"
                    onClick={copyBankNumber}
                    className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 transition-colors shadow-2xs cursor-pointer"
                  >
                    {copiedBank ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-emerald-700">คัดลอกแล้ว!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>คัดลอกเลขบัญชี</span>
                      </>
                    )}
                  </button>
                </div>

                <p>
                  <span className="text-slate-400">ชื่อบัญชี:</span> <strong>โครงการค่ายยุวชนคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้</strong>
                </p>
                <p>
                  <span className="text-slate-400">ยอดเงินที่ต้องโอน:</span> <strong className="text-emerald-700 text-base font-mono">300.00 บาท</strong>
                </p>
              </div>
            </div>

            {/* Slip Upload Dropzone Form */}
            <form onSubmit={handleUploadSlip} className="mt-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1.5">
                  แนบภาพถ่ายสลิปโอนเงิน (Payment Slip) *
                </label>

                {/* Dropzone Box */}
                {!previewLocalUrl && !uploadedSlipUrl ? (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                      processSelectedFile(e.dataTransfer.files?.[0]);
                    }}
                    className={`relative rounded-2xl border-2 border-dashed p-6 text-center transition-all cursor-pointer ${
                      isDragging
                        ? 'border-blue-500 bg-blue-50/50'
                        : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
                    }`}
                  >
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={onFileChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      disabled={uploadBusy}
                    />
                    <UploadCloud className="w-8 h-8 text-blue-600 mx-auto mb-2" />
                    <p className="text-xs font-semibold text-slate-800">
                      คลิกเพื่อเลือกไฟล์ หรือ ลากภาพสลิปมาวางที่นี่
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      รองรับไฟล์ภาพ JPG, PNG, WebP ขนาดไม่เกิน 5MB (ระบบตรวจจับสลิปซ้ำผ่าน SHA-256)
                    </p>
                  </div>
                ) : null}
              </div>

              {/* Selected File Preview Box */}
              {previewLocalUrl && (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 max-w-sm mx-auto text-center space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-600 pb-2 border-b border-slate-200">
                    <span className="font-medium truncate max-w-48">{selectedFile?.name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFile(null);
                        setPreviewLocalUrl(null);
                      }}
                      className="text-rose-500 hover:text-rose-700 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>เปลี่ยนไฟล์</span>
                    </button>
                  </div>
                  <img
                    src={previewLocalUrl}
                    alt="Preview Slip"
                    className="max-h-56 rounded-xl mx-auto object-contain border border-slate-200"
                  />
                  <p className="text-[11px] text-slate-400">
                    ขนาด: {selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB` : ''}
                  </p>
                </div>
              )}

              {uploadError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs sm:text-sm text-rose-800 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>{uploadError}</span>
                </div>
              )}

              {uploadMessage && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs sm:text-sm text-emerald-900 space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <strong className="font-semibold">{uploadMessage}</strong>
                  </div>
                  <p className="text-xs text-emerald-800">
                    พี่ค่ายได้รับหลักฐานการโอนเงินแล้ว และจะตรวจสอบความถูกต้องในหน้า Admin ระบบจะปรับสถานะเป็น ยืนยันสิทธิ์สมบูรณ์ (CONFIRMED) ทันทีที่ได้รับการอนุมัติ
                  </p>
                </div>
              )}

              {!uploadedSlipUrl ? (
                <button
                  type="submit"
                  disabled={uploadBusy || !selectedFile}
                  className="w-full rounded-2xl bg-blue-600 px-4 py-3.5 text-sm font-semibold text-white shadow-xs hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  {uploadBusy ? (
                    <>
                      <RotateCcw className="w-4 h-4 animate-spin" />
                      <span>กำลังอัปโหลดสลิป...</span>
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-4 h-4" />
                      <span>อัปโหลดสลิปยืนยันการสมัคร</span>
                    </>
                  )}
                </button>
              ) : (
                <div className="pt-2 flex flex-col sm:flex-row gap-3">
                  <a
                    href={`/status?q=${createdApp.id}`}
                    className="flex-1 rounded-2xl bg-emerald-600 px-4 py-3 text-center text-xs sm:text-sm font-semibold text-white hover:bg-emerald-700 shadow-xs transition-colors flex items-center justify-center gap-2"
                  >
                    <span>🔍 ไปที่หน้าตรวจสอบสถานะใบสมัคร</span>
                    <ArrowRight className="w-4 h-4" />
                  </a>
                  <a
                    href="/"
                    className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-center text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    กลับสู่หน้าหลัก
                  </a>
                </div>
              )}
            </form>

            <div className="mt-6 border-t border-slate-100 pt-4 text-center">
              <p className="text-xs text-slate-400">
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