import { useEffect, useState, useMemo } from 'react';
import {
  Users,
  CheckCircle2,
  Clock,
  DollarSign,
  AlertCircle,
  FileSpreadsheet,
  RefreshCw,
  Settings as SettingsIcon,
  LogOut,
  Search,
  Eye,
  X,
  ExternalLink,
  ShieldCheck,
  Building,
  GraduationCap,
  Sparkles,
} from 'lucide-react';
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
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  PASSED: 'bg-blue-50 text-blue-700 border-blue-200',
  RESERVE: 'bg-purple-50 text-purple-700 border-purple-200',
  CONFIRMED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-700 border-rose-200',
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
  const [searchQuery, setSearchQuery] = useState('');
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
      await loadSettings(res.data.token);
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
      loadSettings(saved);
    }
  }, []);

  useEffect(() => {
    if (token) localStorage.setItem('comcamp-admin-token', token);
  }, [token]);

  // Statistics Computations
  const totalApps = apps.length;
  const pendingSlipApps = useMemo(() => {
    return apps.filter((a) => {
      const slip = getSlipUrl(a);
      return Boolean(slip) && a.status !== 'CONFIRMED' && a.status !== 'REJECTED';
    });
  }, [apps]);
  const pendingSlipCount = pendingSlipApps.length;

  const confirmedCount = useMemo(() => apps.filter((a) => a.status === 'CONFIRMED').length, [apps]);
  const passedCount = useMemo(() => apps.filter((a) => a.status === 'PASSED').length, [apps]);
  const feePerPerson = settingsData?.campFee ?? 300;
  const totalRevenue = confirmedCount * feePerPerson;
  const maxCapacity = settingsData?.maxCapacity ?? 30;
  const capacityPercent = Math.min(100, Math.round((confirmedCount / maxCapacity) * 100));

  // Filtered List
  const filtered = useMemo(() => {
    return apps.filter((a) => {
      // 1. Status Filter
      if (filter === 'NEED_SLIP_VERIFY') {
        const slip = getSlipUrl(a);
        if (!slip || a.status === 'CONFIRMED' || a.status === 'REJECTED') return false;
      } else if (filter !== 'ALL' && a.status !== filter) {
        return false;
      }

      // 2. Search Query Filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchName = a.fullName.toLowerCase().includes(q);
        const matchNick = (a.nickname || '').toLowerCase().includes(q);
        const matchId = a.id.toLowerCase().includes(q);
        const matchNat = a.nationalId.includes(q);
        const matchPhone = a.phone.includes(q);
        const matchSchool = a.school.toLowerCase().includes(q);
        if (!matchName && !matchNick && !matchId && !matchNat && !matchPhone && !matchSchool) {
          return false;
        }
      }
      return true;
    });
  }, [apps, filter, searchQuery]);

  function exportCSV() {
    if (apps.length === 0) return;
    const headers = [
      'เลขที่ใบสมัคร',
      'ชื่อ-นามสกุล',
      'ชื่อเล่น',
      'เลขประจำตัวประชาชน',
      'เบอร์โทรศัพท์',
      'อีเมล',
      'โรงเรียน',
      'ระดับชั้น',
      'ไซส์เสื้อ',
      'จังหวัด',
      'สถานะ',
      'หลักฐานสลิป',
      'วันที่ส่งใบสมัคร',
    ];
    const rows = filtered.map((a) => [
      a.id,
      `"${a.fullName.replace(/"/g, '""')}"`,
      `"${(a.nickname || '').replace(/"/g, '""')}"`,
      `'${a.nationalId}`,
      `'${a.phone}`,
      `"${(a.email || '').replace(/"/g, '""')}"`,
      `"${a.school.replace(/"/g, '""')}"`,
      a.grade,
      a.shirtSize,
      a.province || '',
      a.status,
      getSlipUrl(a) ? 'มีสลิปแนบ' : 'ไม่มีสลิป',
      a.createdAt ? new Date(a.createdAt).toLocaleString('th-TH') : '',
    ]);

    const csvContent =
      '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `comcamp25_applicants_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const inputCls =
    'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all';

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      
      {/* Header */}
      <header className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <div className="inline-flex items-center gap-2 rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>ComCamp #25 · Admin Portal</span>
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            ระบบจัดการใบสมัคร & สรุปยอดค่าย
          </h1>
          <p className="mt-1 text-xs text-slate-500 font-mono">
            Endpoint: <code>/api/admin/applications</code> · <code>/api/admin/applications/:id/verify-slip</code>
          </p>
        </div>

        {token && (
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => refresh(token)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              <span>{busy ? 'กำลังโหลด...' : 'รีเฟรช'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSettingsOpen(true);
                loadSettings(token);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors shadow-2xs"
            >
              <SettingsIcon className="w-3.5 h-3.5" />
              <span>ตั้งค่าค่าย/โควตา</span>
            </button>

            <button
              type="button"
              onClick={exportCSV}
              disabled={apps.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 transition-colors shadow-2xs disabled:opacity-50"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>ส่งออก CSV ({filtered.length})</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setToken(null);
                setApps([]);
                localStorage.removeItem('comcamp-admin-token');
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3.5 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors shadow-2xs"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>ออกจากระบบ</span>
            </button>
          </div>
        )}
      </header>

      {/* Global Alerts */}
      {error && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 flex items-center justify-between shadow-2xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError(null)} className="text-xs text-rose-500 hover:text-rose-800 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionSuccess && (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-center justify-between shadow-2xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{actionSuccess}</span>
          </div>
          <button type="button" onClick={() => setActionSuccess(null)} className="text-xs text-emerald-600 hover:text-emerald-900 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!token ? (
        /* Login Card */
        <div className="mx-auto w-full max-w-md pt-4">
          <form onSubmit={onLogin} className="rounded-2xl border border-slate-200 bg-white p-7 shadow-xs">
            <div className="mb-6 text-center">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600 mb-3">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <h2 className="text-xl font-bold text-slate-900">เข้าสู่ระบบผู้ดูแลระบบ</h2>
              <p className="mt-1 text-xs text-slate-500">กรุณาเข้าสู่ระบบเพื่อจัดการข้อมูลใบสมัครและการตรวจสลิป</p>
            </div>

            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-semibold text-slate-700" htmlFor="admin-user">
                ชื่อผู้ใช้ (Username)
              </label>
              <input
                id="admin-user"
                className={inputCls}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                required
              />
            </div>

            <div className="mb-6">
              <label className="mb-1.5 block text-xs font-semibold text-slate-700" htmlFor="admin-pass">
                รหัสผ่าน (Password)
              </label>
              <input
                id="admin-pass"
                className={inputCls}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="strong_password หรือ admin123"
                required
              />
              <p className="mt-2 text-[11px] text-slate-500">
                ค่าเริ่มต้น: ชื่อผู้ใช้ <code>admin</code> รหัสผ่าน <code>strong_password</code>
              </p>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-xs"
            >
              {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบผู้ดูแล'}
            </button>
          </form>
        </div>
      ) : (
        /* Main Dashboard & Table View */
        <div className="space-y-6">

          {/* 1. Summary Stat Cards (สรุปยอดต่างๆ ที่ขอ) */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            
            {/* Stat 1: Total Applicants */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">ผู้สมัครทั้งหมด</span>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                  <Users className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-slate-900">{totalApps}</span>
                <span className="text-xs text-slate-500">คน</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {apps.length > 0 ? `ล่าสุดเมื่อ ${new Date().toLocaleTimeString('th-TH')}` : 'ยังไม่มีผู้สมัคร'}
              </p>
            </div>

            {/* Stat 2: Pending Slip Checks (ACTION REQUIRED) */}
            <div
              onClick={() => setFilter(pendingSlipCount > 0 ? 'NEED_SLIP_VERIFY' : 'ALL')}
              className={`cursor-pointer rounded-2xl border p-5 shadow-2xs transition-all ${
                pendingSlipCount > 0
                  ? 'border-amber-200 bg-amber-50/60 hover:bg-amber-100/50'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-amber-900">รอตรวจสอบสลิป</span>
                <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${pendingSlipCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                  <AlertCircle className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className={`text-2xl font-bold font-mono ${pendingSlipCount > 0 ? 'text-amber-900' : 'text-slate-900'}`}>
                  {pendingSlipCount}
                </span>
                <span className="text-xs text-amber-800">รายการ</span>
              </div>
              <p className="mt-1 text-xs font-medium text-amber-700">
                {pendingSlipCount > 0 ? '👉 คลิกเพื่อกรองเฉพาะรายการที่ต้องตรวจ' : '✓ ตรวจสลิปครบถ้วนแล้ว'}
              </p>
            </div>

            {/* Stat 3: Confirmed Campers & Quota Progress */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">ยืนยันสิทธิ์สมบูรณ์ (โควตา)</span>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline justify-between">
                <div>
                  <span className="text-2xl font-bold font-mono text-emerald-700">{confirmedCount}</span>
                  <span className="text-xs text-slate-400 font-mono"> / {maxCapacity} คน</span>
                </div>
                <span className="text-xs font-semibold text-emerald-700 font-mono">{capacityPercent}%</span>
              </div>
              {/* Progress bar */}
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-emerald-600 transition-all duration-500"
                  style={{ width: `${capacityPercent}%` }}
                />
              </div>
            </div>

            {/* Stat 4: Total Verified Revenue */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">ยอดเงินค่าสมัครที่ยืนยันแล้ว</span>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
                  <DollarSign className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-2xl font-bold font-mono text-slate-900">
                  ฿{totalRevenue.toLocaleString()}
                </span>
                <span className="text-xs text-slate-400">บาท</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                จาก {confirmedCount} คน (คนละ {feePerPerson} บาท)
              </p>
            </div>

          </div>

          {/* 2. Filter Bar & Quick Search */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              
              {/* Quick Filter Tabs */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setFilter('ALL')}
                  className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                    filter === 'ALL'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  ทั้งหมด ({totalApps})
                </button>

                <button
                  type="button"
                  onClick={() => setFilter('NEED_SLIP_VERIFY')}
                  className={`inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                    filter === 'NEED_SLIP_VERIFY'
                      ? 'bg-amber-600 text-white shadow-2xs'
                      : 'bg-amber-50 text-amber-900 border border-amber-200 hover:bg-amber-100'
                  }`}
                >
                  <span>รอตรวจสลิป</span>
                  {pendingSlipCount > 0 && (
                    <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] ${
                      filter === 'NEED_SLIP_VERIFY' ? 'bg-white text-amber-700' : 'bg-amber-600 text-white'
                    }`}>
                      {pendingSlipCount}
                    </span>
                  )}
                </button>

                {STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setFilter(s)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${
                      filter === s
                        ? 'bg-blue-600 text-white font-semibold'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {STATUS_LABELS[s]} ({apps.filter((a) => a.status === s).length})
                  </button>
                ))}
              </div>

              {/* Live Search Input */}
              <div className="relative w-full md:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="ค้นหาชื่อ, เบอร์, ID, รร...."
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-8 py-1.5 text-xs text-slate-900 outline-none focus:bg-white focus:border-blue-600 focus:ring-1 focus:ring-blue-100"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

            </div>

            {/* Status indicators */}
            <div className="flex flex-wrap items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-100">
              <span className="font-mono">
                แสดงผล: {filtered.length} จากทั้งหมด {totalApps} รายการ
              </span>
              <span className="font-mono">
                สถานะการเชื่อมต่อ: {source || 'เชื่อมต่อเซิร์ฟเวอร์เรียบร้อย'}
              </span>
            </div>
          </div>

          {/* 3. Main Applicants Table (Desktop) */}
          <div className="hidden md:block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-600">
                <thead className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <tr>
                    <th scope="col" className="px-4 py-3.5">ผู้สมัคร</th>
                    <th scope="col" className="px-4 py-3.5">ข้อมูลติดต่อ</th>
                    <th scope="col" className="px-4 py-3.5">โรงเรียน / เสื้อ</th>
                    <th scope="col" className="px-4 py-3.5">สถานะ</th>
                    <th scope="col" className="px-4 py-3.5">หลักฐานการชำระ</th>
                    <th scope="col" className="px-4 py-3.5">เปลี่ยนสถานะ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((a) => {
                    const slip = getSlipUrl(a);
                    const isPendingSlip = slip && a.status !== 'CONFIRMED' && a.status !== 'REJECTED';
                    const initial = a.fullName.slice(0, 2);

                    return (
                      <tr
                        key={a.id}
                        className={`hover:bg-slate-50/80 transition-colors ${
                          isPendingSlip ? 'bg-amber-50/20' : ''
                        }`}
                      >
                        {/* Column 1: Applicant Name & ID */}
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 font-bold text-xs text-slate-700">
                              {initial}
                            </div>
                            <div>
                              <p className="font-semibold text-slate-900 leading-tight">
                                {a.fullName}
                                {a.nickname && <span className="text-xs text-slate-500 font-normal"> ({a.nickname})</span>}
                              </p>
                              <p className="font-mono text-xs text-slate-400 mt-0.5">{a.id}</p>
                            </div>
                          </div>
                        </td>

                        {/* Column 2: Contact info */}
                        <td className="px-4 py-3.5 text-xs text-slate-600">
                          <div className="font-mono font-medium text-slate-800">{a.phone}</div>
                          <div className="text-slate-400 truncate max-w-44">{a.email || '-'}</div>
                          <div className="text-[11px] font-mono text-slate-400">{a.nationalId}</div>
                        </td>

                        {/* Column 3: School & Shirt */}
                        <td className="px-4 py-3.5 text-xs text-slate-600">
                          <div className="font-medium text-slate-800 truncate max-w-52">{a.school}</div>
                          <div className="text-slate-400 mt-0.5">
                            {a.grade} · เสื้อไซส์ <span className="font-semibold text-slate-700">{a.shirtSize}</span>
                          </div>
                        </td>

                        {/* Column 4: Status Badge */}
                        <td className="px-4 py-3.5">
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[a.status]}`}>
                            {STATUS_LABELS[a.status] || a.status}
                          </span>
                        </td>

                        {/* Column 5: Payment Slip Inspection */}
                        <td className="px-4 py-3.5">
                          {slip ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setInspectingApp(a);
                                  setVerificationNote('');
                                }}
                                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all shadow-2xs ${
                                  isPendingSlip
                                    ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 ring-2 ring-amber-200/50'
                                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                }`}
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>ตรวจสอบสลิป</span>
                              </button>

                              {a.status === 'CONFIRMED' && (
                                <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">
                                  ✓ สลิปผ่านแล้ว
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400 italic">ยังไม่แนบสลิป</span>
                          )}
                        </td>

                        {/* Column 6: Quick Status Update */}
                        <td className="px-4 py-3.5">
                          <div className="flex flex-wrap gap-1">
                            {STATUSES.map((s) => (
                              <button
                                key={s}
                                type="button"
                                disabled={patching === a.id || s === a.status}
                                onClick={() => onStatus(a.id, s)}
                                className={`rounded-lg px-2 py-0.5 text-[11px] font-medium transition-colors ${
                                  s === a.status
                                    ? 'bg-slate-800 text-white font-semibold'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
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

            {filtered.length === 0 && (
              <div className="py-12 text-center text-slate-400 text-sm">
                <Search className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                <p>ไม่พบใบสมัครที่ตรงกับเงื่อนไขการค้นหาหรือตัวกรอง</p>
              </div>
            )}
          </div>

          {/* 4. Mobile Card View */}
          <div className="grid gap-3.5 md:hidden">
            {filtered.map((a) => {
              const slip = getSlipUrl(a);
              return (
                <article
                  key={a.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3"
                >
                  <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2.5">
                    <div>
                      <p className="font-semibold text-slate-900">{a.fullName}</p>
                      <p className="font-mono text-xs text-slate-400">{a.id} {a.nickname && `(ชื่อเล่น: ${a.nickname})`}</p>
                    </div>
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[a.status]}`}>
                      {STATUS_LABELS[a.status] || a.status}
                    </span>
                  </div>

                  <div className="text-xs text-slate-600 space-y-1">
                    <p><span className="text-slate-400">โทร:</span> <span className="font-mono">{a.phone}</span></p>
                    <p><span className="text-slate-400">โรงเรียน:</span> {a.school} ({a.grade}) · ไซส์ {a.shirtSize}</p>
                  </div>

                  {slip && (
                    <button
                      type="button"
                      onClick={() => {
                        setInspectingApp(a);
                        setVerificationNote('');
                      }}
                      className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 transition-colors"
                    >
                      <Eye className="w-4 h-4" />
                      <span>ตรวจสอบสลิป</span>
                    </button>
                  )}

                  <div className="border-t border-slate-100 pt-2 flex flex-wrap gap-1">
                    {STATUSES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={patching === a.id || s === a.status}
                        onClick={() => onStatus(a.id, s)}
                        className={`rounded-lg px-2 py-1 text-[11px] font-medium ${
                          s === a.status ? 'bg-slate-800 text-white font-semibold' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>

          {/* 5. Camp Settings & Quota Modal */}
          {isSettingsOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
              <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-start justify-between border-b border-slate-100 pb-3">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">⚙️ ตั้งค่าระบบค่ายและโควตา (Dynamic Settings)</h3>
                    <p className="text-xs text-slate-500 font-mono">
                      Endpoint: PATCH /api/admin/settings
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSaveSettings} className="mt-4 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1" htmlFor="set-camp-name">
                      ชื่อโครงการค่าย
                    </label>
                    <input
                      id="set-camp-name"
                      className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100"
                      value={settingsForm.campName}
                      onChange={(e) => setSettingsForm({ ...settingsForm, campName: e.target.value })}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1" htmlFor="set-capacity">
                        โควตารับสมัครเป้าหมาย (คน) *
                      </label>
                      <input
                        id="set-capacity"
                        type="number"
                        min="1"
                        max="200"
                        className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100 font-mono"
                        value={settingsForm.maxCapacity}
                        onChange={(e) => setSettingsForm({ ...settingsForm, maxCapacity: Number(e.target.value) })}
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1" htmlFor="set-fee">
                        ค่าสมัครเข้าร่วมค่าย (บาท) *
                      </label>
                      <input
                        id="set-fee"
                        type="number"
                        min="0"
                        className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100 font-mono"
                        value={settingsForm.campFee}
                        onChange={(e) => setSettingsForm({ ...settingsForm, campFee: Number(e.target.value) })}
                        required
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settingsForm.isManualClosed}
                        onChange={(e) => setSettingsForm({ ...settingsForm, isManualClosed: e.target.checked })}
                        className="w-4 h-4 rounded text-rose-600 focus:ring-rose-500 border-slate-300"
                      />
                      <div>
                        <span className="text-sm font-semibold text-slate-800">
                          ปิดระบบรับสมัครฉุกเฉิน (Emergency Manual Close)
                        </span>
                        <p className="text-xs text-slate-500">
                          เมื่อเปิดใช้งาน ระบบจะระงับการส่งใบสมัครใหม่ทันทีโดยไม่คำนึงถึงกำหนดการ
                        </p>
                      </div>
                    </label>
                  </div>

                  {settingsData && (
                    <div className="text-[11px] text-slate-400 space-y-0.5 border-t border-slate-100 pt-2 font-mono">
                      <p>เปิดรับสมัคร: {new Date(settingsData.registrationOpenAt).toLocaleString('th-TH')}</p>
                      <p>ปิดรับสมัคร: {new Date(settingsData.registrationCloseAt).toLocaleString('th-TH')}</p>
                    </div>
                  )}

                  <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      disabled={settingsBusy}
                      onClick={() => setIsSettingsOpen(false)}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="submit"
                      disabled={settingsBusy}
                      className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 shadow-xs disabled:opacity-50"
                    >
                      {settingsBusy ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า (Save Settings)'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* 6. Slip Inspection & Verification Modal */}
          {inspectingApp && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
              <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-start justify-between border-b border-slate-100 pb-3">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">ตรวจสอบหลักฐานการชำระเงิน</h3>
                    <p className="text-xs text-slate-500 font-mono">
                      {inspectingApp.id} · {inspectingApp.fullName} ({inspectingApp.nickname || '-'})
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectingApp(null)}
                    className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="mt-4">
                  <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-2">
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
                      <span>เปิดดูรูปภาพสลิปขนาดเต็ม</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-xs font-semibold text-slate-700 mb-1" htmlFor="verify-note">
                    หมายเหตุเจ้าหน้าที่ (ส่งไปกับ Verify Request)
                  </label>
                  <input
                    id="verify-note"
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-100"
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
                    className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors"
                  >
                    {verifying ? 'กำลังบันทึก...' : 'ปฏิเสธสลิป (Reject Slip)'}
                  </button>
                  <button
                    type="button"
                    disabled={verifying}
                    onClick={() => handleVerifySlip(true)}
                    className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 shadow-xs disabled:opacity-50 transition-colors"
                  >
                    {verifying ? 'กำลังบันทึก...' : 'อนุมัติสลิป (Approve Slip)'}
                  </button>
                </div>
                <p className="mt-3 text-center text-xs text-slate-400">
                  Endpoint: <code>PATCH /api/admin/applications/{inspectingApp.id}/verify-slip</code>
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}