import { useState } from 'react';
import {
  getApplicationStatus,
  confirmAttendance,
  type Application,
  type ApplicationStatus,
  type ApiSource,
} from '../lib/api';

const STATUS_COLORS: Record<ApplicationStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  PASSED: 'bg-blue-100 text-blue-800',
  RESERVE: 'bg-purple-100 text-purple-800',
  CONFIRMED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
};

export function StatusSection() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [app, setApp] = useState<Application | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<boolean | null>(null);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setError(null);
    setConfirmed(null);
    try {
      const res = await getApplicationStatus(query);
      setApp(res.data);
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่พบใบสมัคร');
      setApp(null);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (!app) return;
    setConfirmBusy(true);
    setError(null);
    try {
      const res = await confirmAttendance(app.id, true);
      setApp(res.data);
      setSource(res.source);
      setConfirmed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ยืนยันไม่สำเร็จ');
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
      setConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ยกเลิกไม่สำเร็จ');
    } finally {
      setConfirmBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      <header className="mb-8 text-center">
        <p className="text-sm font-semibold tracking-widest text-blue-700 uppercase">ComCamp #25</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 sm:text-3xl">ตรวจสอบสถานะใบสมัคร</h1>
        <p className="mt-2 text-sm text-gray-500">
          ค้นหาด้วยเลขบัตรประชาชน / เบอร์โทรศัพท์ / Application ID
        </p>
      </header>

      <form onSubmit={onSearch} className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:flex-row sm:p-6">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="เช่น 1234567890123 หรือ CC25-XXXXXX"
          className="w-full flex-1 rounded-lg border border-gray-300 px-3 py-3 text-base outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
        />
        <button
          type="submit"
          disabled={busy || !q.trim()}
          className="rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold whitespace-nowrap text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'กำลังค้นหา...' : 'ค้นหา'}
        </button>
      </form>

      {error && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {app && (
        <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">{app.fullName}</h2>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLORS[app.status]}`}>{app.status}</span>
            {source && (
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${source === 'LIVE GO API' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                {source}
              </span>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-400">Application ID</dt><dd className="font-mono font-medium text-gray-800">{app.id}</dd></div>
            <div><dt className="text-gray-400">ชื่อเล่น</dt><dd className="text-gray-800">{app.nickname || '-'}</dd></div>
            <div><dt className="text-gray-400">เลขบัตรประชาชน</dt><dd className="text-gray-800">{app.nationalId}</dd></div>
            <div><dt className="text-gray-400">เบอร์โทรศัพท์</dt><dd className="text-gray-800">{app.phone}</dd></div>
            <div><dt className="text-gray-400">โรงเรียน</dt><dd className="text-gray-800">{app.school}</dd></div>
            <div><dt className="text-gray-400">ชั้นเรียน / ไซส์เสื้อ</dt><dd className="text-gray-800">{app.grade} / {app.shirtSize}</dd></div>
            <div><dt className="text-gray-400">ยืนยันเข้าร่วมแล้ว</dt><dd className="text-gray-800">{app.attendanceConfirmed ? 'ใช่' : 'ยังไม่ยืนยัน'}</dd></div>
          </dl>

          {confirmed === true && <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">ยืนยันเข้าร่วมเรียบร้อย</p>}
          {confirmed === false && <p className="mt-4 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700">ยกเลิกการยืนยันแล้ว</p>}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmBusy || app.attendanceConfirmed}
              className="rounded-lg bg-green-600 px-4 py-3 text-base font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            >
              {confirmBusy ? 'กำลังยืนยัน...' : 'ยืนยันเข้าร่วมอย่างเป็นทางการ'}
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              disabled={confirmBusy || !app.attendanceConfirmed}
              className="rounded-lg border border-gray-300 px-4 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              ยกเลิกการยืนยัน
            </button>
          </div>
          <p className="mt-3 text-xs text-gray-400">ปุ่มยืนยันเรียก <code>POST /api/applications/:id/confirm</code></p>
        </section>
      )}
    </div>
  );
}
