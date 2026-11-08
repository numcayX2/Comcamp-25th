import { useEffect, useState } from 'react';
import {
  adminLogin,
  listApplications,
  updateApplicationStatus,
  verifyPaymentSlip,
  getAdminSettings,
  updateAdminSettings,
  getSlipImageUrl,
  getSlipUrl,
  type Application,
  type ApplicationStatus,
  type ApiSource,
  type AdminSettings,
  type UpdateAdminSettingsPayload,
} from '../lib/api';

const STATUSES: ApplicationStatus[] = ['PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED'];

const STATUS_COLORS: Record<ApplicationStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800 border-amber-200',
  PASSED: 'bg-blue-100 text-blue-800 border-blue-200',
  RESERVE: 'bg-purple-100 text-purple-800 border-purple-200',
  CONFIRMED: 'bg-green-100 text-green-800 border-green-200',
  REJECTED: 'bg-red-100 text-red-800 border-red-200',
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอพิจารณา',
  PASSED: 'ผ่านการคัดเลือก',
  RESERVE: 'ตัวสำรอง',
  CONFIRMED: 'ยืนยันสิทธิ์สมบูรณ์',
  REJECTED: 'ไม่ผ่าน',
};

export function AdminSection() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('strong_password');
  const [token, setToken] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [apps, setApps] = useState<Application[]>([]);
  const [filter, setFilter] = useState<string>('ALL');
  const [busy, setBusy] = useState(false);
  const [patching, setPatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Slip modal state
  const [inspectingApp, setInspectingApp] = useState<Application | null>(null);
  const [verificationNote, setVerificationNote] = useState('');
  const [verifying, setVerifying] = useState(false);

  // Settings modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsData, setSettingsData] = useState<AdminSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsForm, setSettingsForm] = useState<{
    campName: string;
    maxCapacity: number;
    campFee: number;
    isManualClosed: boolean;
  }>({
    campName: 'ComCamp 25th',
    maxCapacity: 30,
    campFee: 300,
    isManualClosed: false,
  });

  async function loadSettings(t: string) {
    setSettingsBusy(true);
    try {
      const res = await getAdminSettings(t);
      setSettingsData(res.data);
      setSettingsForm({
        campName: res.data.campName,
        maxCapacity: res.data.maxCapacity,
        campFee: Number(res.data.campFee) || 300,
        isManualClosed: res.data.isManualClosed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดการตั้งค่าไม่สำเร็จ');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSettingsBusy(true);
    try {
      const res = await updateAdminSettings(token, {
        campName: settingsForm.campName.trim(),
        maxCapacity: Number(settingsForm.maxCapacity),
        campFee: Number(settingsForm.campFee),
        isManualClosed: settingsForm.isManualClosed,
      });
      setSettingsData(res.data);
      setActionSuccess(`บันทึกการตั้งค่าเรียบร้อย: โควตา ${res.data.maxCapacity} คน, ค่าสมัคร ${res.data.campFee} บาท`);
      setIsSettingsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกการตั้งค่าไม่สำเร็จ');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function refresh(t: string) {
    setBusy(true);
    try {
      const res = await listApplications(t);
      setApps(Array.isArray(res.data) ? res.data : []);
      setSource(res.source);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดรายการใบสมัครไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await adminLogin(username, password);
      setToken(res.data.token);
      setSource(res.source);
      await refresh(res.data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    } finally {
      setBusy(false);
    }
  }

  async function onStatus(id: string, status: ApplicationStatus) {
    if (!token) return;
    setPatching(id);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await updateApplicationStatus(token, id, status);
      setApps((prev) => prev.map((a) => (a.id === id ? res.data : a)));
      setSource(res.source);
      setActionSuccess(`เปลี่ยนสถานะของ ${id} เป็น ${status} สำเร็จ`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เปลี่ยนสถานะไม่สำเร็จ');
    } finally {
      setPatching(null);
    }
  }

  async function handleVerifySlip(approved: boolean) {
    if (!token || !inspectingApp) return;
    setVerifying(true);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await verifyPaymentSlip(token, inspectingApp.id, approved, verificationNote);
      setSource(res.source);

      const newStatus: ApplicationStatus = approved ? 'CONFIRMED' : 'PASSED';
      setApps((prev) =>
        prev.map((a) => (a.id === inspectingApp.id ? { ...a, status: newStatus } : a)),
      );

      setActionSuccess(
        `${approved ? 'อนุมัติสลิปสำเร็จ' : 'ปฏิเสธสลิปแล้ว'}: ${res.data.message || inspectingApp.id}`,
      );
      setInspectingApp(null);
      setVerificationNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'การตรวจสอบสลิปล้มเหลว');
    } finally {
      setVerifying(false);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem('comcamp-admin-token');
    if (saved) {
      setToken(saved);
      refresh(saved);
    }
  }, []);

  useEffect(() => {
    if (token) localStorage.setItem('comcamp-admin-token', token);
  }, [token]);

  const filtered = filter === 'ALL' ? apps : apps.filter((a) => a.status === filter);

  const inputCls =
    'w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      <header className="mb-8 text-center">
        <p className="text-sm font-semibold tracking-widest text-blue-700 uppercase">ComCamp #25 · Admin Portal</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 sm:text-3xl">ระบบจัดการใบสมัครและตรวจสอบสลิป</h1>
        <p className="mt-2 text-sm text-gray-500">
          <code>POST /api/auth/login</code> · <code>GET /api/admin/applications</code> · <code>PATCH /api/admin/applications/:id/verify-slip</code>
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-xs text-red-500 hover:text-red-800">ปิด</button>
        </div>
      )}

      {actionSuccess && (
        <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-center justify-between">
          <span>✓ {actionSuccess}</span>
          <button type="button" onClick={() => setActionSuccess(null)} className="text-xs text-green-600 hover:text-green-900">ปิด</button>
        </div>
      )}

      {!token ? (
        <form onSubmit={onLogin} className="mx-auto w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-gray-700" htmlFor="admin-user">ชื่อผู้ใช้ (Username)</label>
            <input
              id="admin-user"
              className={inputCls}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              required
            />
          </div>
          <div className="mb-5">
            <label className="mb-1.5 block text-sm font-medium text-gray-700" htmlFor="admin-pass">รหัสผ่าน (Password)</label>
            <input
              id="admin-pass"
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="strong_password หรือ admin123"
              required
            />
            <p className="mt-1.5 text-xs text-gray-500">
              ค่าเริ่มต้น Go Backend: บัญชี <code>admin</code> รหัสผ่าน <code>strong_password</code> หรือ <code>admin123</code>
            </p>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบผู้ดูแล'}
          </button>
        </form>
      ) : (
        <section>
          {/* Action Toolbar */}
          <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-600">
                สถานะการเชื่อมต่อ:
              </span>
              {source && (
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${source === 'LIVE GO API' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                  {source}
                </span>
              )}
              {busy && <span className="text-xs text-gray-400">กำลังโหลด...</span>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700"
              >
                <option value="ALL">สถานะ: ทั้งหมด ({apps.length})</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    สถานะ: {STATUS_LABELS[s]} ({apps.filter((a) => a.status === s).length})
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => token && refresh(token)}
                className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm transition-colors"
              >
                รีเฟรช
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsSettingsOpen(true);
                  if (token) loadSettings(token);
                }}
                className="rounded-lg border border-blue-300 bg-blue-50 px-3.5 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 shadow-sm transition-colors inline-flex items-center gap-1.5"
              >
                ⚙️ ตั้งค่าค่าย/โควตา
              </button>

              <button
                type="button"
                onClick={() => {
                  setToken(null);
                  setApps([]);
                  localStorage.removeItem('comcamp-admin-token');
                }}
                className="rounded-lg border border-red-200 bg-white px-3.5 py-2 text-sm font-medium text-red-700 hover:bg-red-50 shadow-sm transition-colors"
              >
                ออกจากระบบ
              </button>
            </div>
          </div>

          <p className="mb-3 text-sm text-gray-500">
            แสดง {filtered.length} จาก {apps.length} รายการ
          </p>

          {/* Desktop Table View */}
          <div className="hidden overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1020px] text-left text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3.5">ID</th>
                    <th className="px-4 py-3.5">ชื่อ-นามสกุล</th>
                    <th className="px-4 py-3.5">การติดต่อ</th>
                    <th className="px-4 py-3.5">โรงเรียน / ชั้น</th>
                    <th className="px-4 py-3.5">สถานะ</th>
                    <th className="px-4 py-3.5">หลักฐานสลิป</th>
                    <th className="px-4 py-3.5">จัดการสถานะ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((a) => {
                    const slip = getSlipUrl(a);
                    return (
                      <tr key={a.id} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-700">{a.id}</td>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {a.fullName}
                          <div className="text-xs text-gray-400 font-normal">ชื่อเล่น: {a.nickname || '-'}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-xs">
                          <div>{a.phone}</div>
                          <div className="text-gray-400">{a.email || '-'}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-xs">
                          <div>{a.school}</div>
                          <div className="text-gray-400">{a.grade} · ไซส์ {a.shirtSize}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[a.status]}`}>
                            {a.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {slip ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setInspectingApp(a);
                                  setVerificationNote('');
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 shadow-xs transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                                ตรวจสอบสลิป
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400 italic">ไม่มีสลิป</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {STATUSES.map((s) => (
                              <button
                                key={s}
                                type="button"
                                disabled={patching === a.id || s === a.status}
                                onClick={() => onStatus(a.id, s)}
                                className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                                  s === a.status
                                    ? 'bg-gray-800 text-white font-semibold'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                } disabled:opacity-40`}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile Card View */}
          <div className="grid gap-4 md:hidden">
            {filtered.map((a) => {
              const slip = getSlipUrl(a);
              return (
                <article key={a.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2 border-b border-gray-100 pb-3">
                    <div>
                      <p className="font-semibold text-gray-900">{a.fullName}</p>
                      <p className="font-mono text-xs text-gray-400">{a.id} (ชื่อเล่น: {a.nickname || '-'})</p>
                    </div>
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[a.status]}`}>
                      {a.status}
                    </span>
                  </div>

                  <div className="mt-3 text-xs text-gray-600 space-y-1">
                    <p><span className="text-gray-400">โทร:</span> {a.phone}</p>
                    <p><span className="text-gray-400">โรงเรียน:</span> {a.school} ({a.grade})</p>
                  </div>

                  {slip && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => {
                          setInspectingApp(a);
                          setVerificationNote('');
                        }}
                        className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        ดูสลิปและดำเนินการตรวจสอบ
                      </button>
                    </div>
                  )}

                  <div className="mt-3 border-t border-gray-100 pt-3 flex flex-wrap gap-1">
                    {STATUSES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={patching === a.id || s === a.status}
                        onClick={() => onStatus(a.id, s)}
                        className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                          s === a.status
                            ? 'bg-gray-800 text-white font-semibold'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        } disabled:opacity-40`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <p className="mt-8 text-center text-sm text-gray-400">ไม่พบใบสมัครที่ตรงกับเงื่อนไขการค้นหา</p>
          )}

          {/* Camp Settings & Quota Modal */}
          {isSettingsOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
              <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-start justify-between border-b border-gray-100 pb-3">
                  <div>
                    <h3 className="text-lg font-bold text-gray-900">⚙️ ตั้งค่าระบบค่ายและโควตา (Dynamic Settings)</h3>
                    <p className="text-xs text-gray-500 font-mono">
                      Endpoint: PATCH /api/admin/settings
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <form onSubmit={handleSaveSettings} className="mt-4 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1" htmlFor="set-camp-name">
                      ชื่อโครงการค่าย
                    </label>
                    <input
                      id="set-camp-name"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100"
                      value={settingsForm.campName}
                      onChange={(e) => setSettingsForm({ ...settingsForm, campName: e.target.value })}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1" htmlFor="set-capacity">
                        โควตารับสมัครเป้าหมาย (คน) *
                      </label>
                      <input
                        id="set-capacity"
                        type="number"
                        min="1"
                        max="1000"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100 font-mono"
                        value={settingsForm.maxCapacity}
                        onChange={(e) => setSettingsForm({ ...settingsForm, maxCapacity: parseInt(e.target.value, 10) || 1 })}
                        required
                      />
                      <p className="mt-1 text-[11px] text-gray-400">
                        ปรับเพิ่มได้ตามจำนวนผู้สมัครจริง ไม่จำกัดตายตัว
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1" htmlFor="set-fee">
                        ค่าสมัครค่าย (บาท) *
                      </label>
                      <input
                        id="set-fee"
                        type="number"
                        min="0"
                        step="1"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100 font-mono"
                        value={settingsForm.campFee}
                        onChange={(e) => setSettingsForm({ ...settingsForm, campFee: parseFloat(e.target.value) || 0 })}
                        required
                      />
                      <p className="mt-1 text-[11px] text-gray-400">
                        ยอดเงินที่น้องต้องชำระในสลิป
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settingsForm.isManualClosed}
                        onChange={(e) => setSettingsForm({ ...settingsForm, isManualClosed: e.target.checked })}
                        className="w-4 h-4 rounded text-red-600 focus:ring-red-500 border-gray-300"
                      />
                      <div>
                        <span className="text-sm font-semibold text-gray-800">
                          ปิดระบบรับสมัครฉุกเฉิน (Emergency Manual Close)
                        </span>
                        <p className="text-xs text-gray-500">
                          เมื่อเปิดใช้งาน ระบบจะระงับการส่งใบสมัครใหม่ทันทีโดยไม่คำนึงถึงกำหนดการ
                        </p>
                      </div>
                    </label>
                  </div>

                  {settingsData && (
                    <div className="text-[11px] text-gray-400 space-y-0.5 border-t border-gray-100 pt-2 font-mono">
                      <p>เปิดรับสมัคร: {new Date(settingsData.registrationOpenAt).toLocaleString('th-TH')}</p>
                      <p>ปิดรับสมัคร: {new Date(settingsData.registrationCloseAt).toLocaleString('th-TH')}</p>
                    </div>
                  )}

                  <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end border-t border-gray-100 pt-3">
                    <button
                      type="button"
                      disabled={settingsBusy}
                      onClick={() => setIsSettingsOpen(false)}
                      className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="submit"
                      disabled={settingsBusy}
                      className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 shadow-sm disabled:opacity-50"
                    >
                      {settingsBusy ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า (Save Settings)'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Slip Inspection & Verification Modal */}
          {inspectingApp && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
              <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-start justify-between border-b border-gray-100 pb-3">
                  <div>
                    <h3 className="text-lg font-bold text-gray-900">ตรวจสอบหลักฐานการชำระเงิน</h3>
                    <p className="text-xs text-gray-500 font-mono">
                      {inspectingApp.id} · {inspectingApp.fullName}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectingApp(null)}
                    className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <div className="mt-4">
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50 p-2">
                    <img
                      src={getSlipImageUrl(getSlipUrl(inspectingApp))}
                      alt="สลิปโอนเงิน"
                      className="max-h-72 w-full object-contain mx-auto rounded"
                    />
                  </div>
                  <div className="mt-2 text-right">
                    <a
                      href={getSlipImageUrl(getSlipUrl(inspectingApp))}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-600 hover:text-blue-800 underline inline-flex items-center gap-1"
                    >
                      เปิดดูรูปภาพสลิปขนาดเต็ม &rarr;
                    </a>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-xs font-medium text-gray-700 mb-1" htmlFor="verify-note">
                    หมายเหตุเจ้าหน้าที่ (ส่งไปกับ Verify Request)
                  </label>
                  <input
                    id="verify-note"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100"
                    placeholder="เช่น ยอดเงิน 300 บาท ถูกต้องครบถ้วน หรือ สลิปไม่ชัดเจน"
                    value={verificationNote}
                    onChange={(e) => setVerificationNote(e.target.value)}
                  />
                </div>

                <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    disabled={verifying}
                    onClick={() => handleVerifySlip(false)}
                    className="rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
                  >
                    {verifying ? 'กำลังบันทึก...' : 'ปฏิเสธสลิป (Reject Slip)'}
                  </button>
                  <button
                    type="button"
                    disabled={verifying}
                    onClick={() => handleVerifySlip(true)}
                    className="rounded-lg bg-green-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-700 shadow-sm disabled:opacity-50 transition-colors"
                  >
                    {verifying ? 'กำลังบันทึก...' : 'อนุมัติสลิป (Approve Slip)'}
                  </button>
                </div>
                <p className="mt-3 text-center text-xs text-gray-400">
                  Endpoint: <code>PATCH /api/admin/applications/{inspectingApp.id}/verify-slip</code>
                </p>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
