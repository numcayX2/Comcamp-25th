import { useState } from 'react';
import {
  submitApplication,
  type ApplicationPayload,
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
  const [result, setResult] = useState<unknown>(null);
  const [appId, setAppId] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setResult(null);
    setAppId(null);

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
      setResult(res.data);
      setSource(res.source);
      setAppId(res.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการส่งใบสมัคร');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      <header className="mb-8 text-center">
        <p className="text-sm font-semibold tracking-widest text-blue-700 uppercase">ComCamp #25</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 sm:text-3xl">สมัครเข้าร่วมค่าย</h1>
        <p className="mt-2 text-sm text-gray-500">
          กรอกข้อมูลแล้วส่งไปที่ <code className="text-xs">POST /api/applications</code>
        </p>
      </header>

      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2 sm:p-8">
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
          <label className={labelCls} htmlFor="motivation">แรงบันดาลใจ</label>
          <textarea id="motivation" className={inputCls} rows={4} value={form.motivation} onChange={(e) => set('motivation', e.target.value)} placeholder="เล่าแรงบันดาลใจที่อยากเข้าร่วมค่าย ComCamp #25" />
        </div>
        <div className="sm:col-span-2">
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'กำลังส่งข้อมูล...' : 'ส่งใบสมัคร'}
          </button>
        </div>
      </form>

      {error && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {result != null && (
        <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">ผลการส่งใบสมัคร</h2>
            {source && (
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${source === 'LIVE GO API' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                {source}
              </span>
            )}
          </div>
          {appId && (
            <div className="mt-4 rounded-xl bg-blue-50 p-4 border border-blue-100">
              <p className="text-xs font-medium uppercase tracking-wider text-blue-700">Application Number</p>
              <p className="mt-1 text-2xl font-bold font-mono text-blue-900">{appId}</p>
              <p className="mt-1 text-xs text-blue-600">โปรดบันทึกรหัสนี้ไว้เพื่อใช้ตรวจสอบสถานะการคัดเลือกและยืนยันสิทธิ์</p>
            </div>
          )}
          <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-gray-900 p-4 text-xs leading-relaxed text-green-300">{JSON.stringify(result, null, 2)}</pre>
          <div className="mt-4 flex items-center justify-between text-sm">
            <a href="/status" className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-800 underline">
              ไปที่หน้าตรวจสอบสถานะ &rarr;
            </a>
          </div>
        </section>
      )}
    </div>
  );
}
