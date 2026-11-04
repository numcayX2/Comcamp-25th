import { useEffect, useState } from 'react';
import {
  adminLogin,
  listApplications,
  updateApplicationStatus,
  type Application,
  type ApplicationStatus,
  type ApiSource,
} from '../lib/api';

const STATUSES: ApplicationStatus[] = ['PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED'];

const STATUS_COLORS: Record<ApplicationStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  PASSED: 'bg-blue-100 text-blue-800',
  RESERVE: 'bg-purple-100 text-purple-800',
  CONFIRMED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
};

export function AdminSection() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [apps, setApps] = useState<Application[]>([]);
  const [filter, setFilter] = useState<string>('ALL');
  const [busy, setBusy] = useState(false);
  const [patching, setPatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(t: string) {
    setBusy(true);
    try {
      const res = await listApplications(t);
      setApps(Array.isArray(res.data) ? res.data : []);
      setSource(res.source);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดรายการไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await adminLogin(username, password);
      setToken(res.data.token);
      setSource(res.source);
      await refresh(res.data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function onStatus(id: string, status: ApplicationStatus) {
    if (!token) return;
    setPatching(id);
    setError(null);
    try {
      const res = await updateApplicationStatus(token, id, status);
      setApps((prev) => prev.map((a) => (a.id === id ? res.data : a)));
      setSource(res.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เปลี่ยนสถานะไม่สำเร็จ');
    } finally {
      setPatching(null);
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
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      <header className="mb-8 text-center">
        <p className="text-sm font-semibold tracking-widest text-blue-700 uppercase">ComCamp #25 · Admin</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 sm:text-3xl">จัดการใบสมัคร</h1>
        <p className="mt-2 text-sm text-gray-500">
          <code>POST /api/auth/login</code> · <code>GET /api/admin/applications</code> · <code>PATCH /api/admin/applications/:id</code>
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {!token ? (
        <form onSubmit={onLogin} className="mx-auto w-full max-w-md rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-8">
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-gray-700" htmlFor="admin-user">ชื่อผู้ใช้</label>
            <input id="admin-user" className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="mb-5">
            <label className="mb-1.5 block text-sm font-medium text-gray-700" htmlFor="admin-pass">รหัสผ่าน</label>
            <input id="admin-pass" className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบผู้ดูแล'}
          </button>
          <p className="mt-3 text-center text-xs text-gray-400">
            Go skeleton: เมื่อ server ออฟไลน์จะใช้ token จำลอง (<code>mock-jwt-token</code>) ให้ทดสอบ UI ต่อได้
          </p>
        </form>
      ) : (
        <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-600">Token: <code className="rounded bg-gray-100 px-2 py-0.5 text-xs">{token.slice(0, 24)}{token.length > 24 ? '...' : ''}</code></span>
              {source && (
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${source === 'LIVE GO API' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                  {source}
                </span>
              )}
              {busy && <span className="text-sm text-gray-400">กำลังโหลด...</span>}
            </div>
            <div className="flex gap-2">
              <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="ALL">สถานะ: ทั้งหมด</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>สถานะ: {s}</option>
                ))}
              </select>
              <button type="button" onClick={() => token && refresh(token)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">รีเฟรช</button>
              <button
                type="button"
                onClick={() => {
                  setToken(null);
                  setApps([]);
                  localStorage.removeItem('comcamp-admin-token');
                }}
                className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                ออกจากระบบ
              </button>
            </div>
          </div>

          <p className="mb-4 text-sm text-gray-500">แสดง {filtered.length} / {apps.length} รายการ</p>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">ID</th>
                    <th className="px-4 py-3 font-medium">ชื่อ</th>
                    <th className="px-4 py-3 font-medium">ติดต่อ</th>
                    <th className="px-4 py-3 font-medium">โรงเรียน / ชั้น</th>
                    <th className="px-4 py-3 font-medium">สถานะ</th>
                    <th className="px-4 py-3 font-medium">เปลี่ยนสถานะ (PATCH)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((a) => (
                    <tr key={a.id}>
                      <td className="px-4 py-3 font-mono text-xs">{a.id}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{a.fullName}<div className="text-xs text-gray-400">({a.nickname || '-'})</div></td>
                      <td className="px-4 py-3 text-gray-600">{a.phone}<div className="text-xs">{a.email}</div></td>
                      <td className="px-4 py-3 text-gray-600">{a.school}<div className="text-xs">{a.grade} · {a.shirtSize}</div></td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLORS[a.status]}`}>{a.status}</span></td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {STATUSES.map((s) => (
                            <button
                              key={s}
                              type="button"
                              disabled={patching === a.id || s === a.status}
                              onClick={() => onStatus(a.id, s)}
                              className={`rounded px-2 py-1 text-xs font-medium ${s === a.status ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'} disabled:opacity-40`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="grid gap-3 md:hidden">
            {filtered.map((a) => (
              <article key={a.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-gray-900">{a.fullName}</p>
                    <p className="font-mono text-xs text-gray-400">{a.id}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLORS[a.status]}`}>{a.status}</span>
                </div>
                <p className="mt-2 text-sm text-gray-600">{a.phone} · {a.school} · {a.grade}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={patching === a.id || s === a.status}
                      onClick={() => onStatus(a.id, s)}
                      className={`rounded px-2.5 py-1.5 text-xs font-medium ${s === a.status ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'} disabled:opacity-40`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>

          {filtered.length === 0 && (
            <p className="mt-8 text-center text-sm text-gray-400">ไม่มีรายการที่ตรงกับตัวกรอง</p>
          )}
        </section>
      )}
    </div>
  );
}
