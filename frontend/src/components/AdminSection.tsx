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
  Award,
  Palette,
  Printer,
  Copy,
  Check,
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  SlidersHorizontal,
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
  REJECTED: 'ไม่ผ่านการคัดเลือก',
};

export function getCertificateNo(app: Application): string {
  const cleanId = app.id.replace(/^CC25-?/i, '');
  return `CC25-CERT-${cleanId}`;
}

export function AdminSection() {
  const [token, setToken] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('strong_password');

  const [apps, setApps] = useState<Application[]>([]);
  const [filter, setFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [patching, setPatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Pagination State
  const [pageSize, setPageSize] = useState<number>(10);
  const [currentPage, setCurrentPage] = useState<number>(1);

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

  // Certificate Modal State
  const [certApp, setCertApp] = useState<Application | null>(null);
  const [copiedCertId, setCopiedCertId] = useState<boolean>(false);

  // Canva Export Modal State
  const [isCanvaModalOpen, setIsCanvaModalOpen] = useState<boolean>(false);
  const [canvaScope, setCanvaScope] = useState<'CONFIRMED' | 'PASSED_OR_CONFIRMED' | 'FILTERED'>('CONFIRMED');
  const [copiedCanvaTable, setCopiedCanvaTable] = useState<boolean>(false);

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
      setApps((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: res.data.status, note: res.data.note } : a)),
      );
      setSource(res.source);
      setActionSuccess(`อัปเดตสถานะ ${id} เป็น "${STATUS_LABELS[status]}" สำเร็จ`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'อัปเดตสถานะไม่สำเร็จ');
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
      setApps((prev) =>
        prev.map((a) =>
          a.id === inspectingApp.id
            ? {
                ...a,
                status: approved ? 'CONFIRMED' : 'REJECTED',
                note: verificationNote || a.note,
              }
            : a,
        ),
      );
      setSource(res.source);

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

  // Reset page when filter, searchQuery, or pageSize changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filter, searchQuery, pageSize]);

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

  // Pagination Calculations
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (safeCurrentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, filtered.length);

  const paginatedApps = useMemo(() => {
    return filtered.slice(startIndex, endIndex);
  }, [filtered, startIndex, endIndex]);

  // Canva target scope computation
  const canvaTargetApps = useMemo(() => {
    if (canvaScope === 'CONFIRMED') {
      return apps.filter((a) => a.status === 'CONFIRMED');
    }
    if (canvaScope === 'PASSED_OR_CONFIRMED') {
      return apps.filter((a) => a.status === 'CONFIRMED' || a.status === 'PASSED');
    }
    return filtered;
  }, [apps, filtered, canvaScope]);

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
      'รหัสเกียรติบัตร',
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
      getCertificateNo(a),
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

  function exportCanvaCSV(targetList: Application[]) {
    if (targetList.length === 0) return;
    const headers = [
      'FullName',
      'Nickname',
      'School',
      'Province',
      'CertificateNo',
      'Date',
      'CampName',
      'Grade',
      'NationalId',
    ];
    const rows = targetList.map((a) => [
      `"${a.fullName.replace(/"/g, '""')}"`,
      `"${(a.nickname || '').replace(/"/g, '""')}"`,
      `"${a.school.replace(/"/g, '""')}"`,
      `"${(a.province || '').replace(/"/g, '""')}"`,
      `"${getCertificateNo(a)}"`,
      `"16 พฤศจิกายน 2569"`,
      `"ค่ายวิทยาการคอมพิวเตอร์ ComCamp ครั้งที่ 25"`,
      `"${a.grade}"`,
      `"'${a.nationalId}"`,
    ]);

    const csvContent =
      '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `canva_bulk_create_certificates_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function copyCanvaTableData(targetList: Application[]) {
    if (targetList.length === 0) return;
    const headers = [
      'FullName',
      'Nickname',
      'School',
      'Province',
      'CertificateNo',
      'Date',
      'CampName',
    ];
    const rows = targetList.map((a) => [
      a.fullName,
      a.nickname || '',
      a.school,
      a.province || '',
      getCertificateNo(a),
      '16 พฤศจิกายน 2569',
      'ค่ายวิทยาการคอมพิวเตอร์ ComCamp ครั้งที่ 25',
    ]);
    const tsv = [headers.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n');
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(tsv);
      setCopiedCanvaTable(true);
      setTimeout(() => setCopiedCanvaTable(false), 2500);
    }
  }

  function copyCertificateId(certNo: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(certNo);
      setCopiedCertId(true);
      setTimeout(() => setCopiedCertId(false), 2200);
    }
  }

  function handlePrintCertificate() {
    window.print();
  }

  const inputCls =
    'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all';

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6" style={{ fontFamily: 'Kanit, sans-serif' }}>
      
      {/* Print-only CSS to format certificates cleanly */}
      <style>{`
        @media print {
          body * {
            visibility: hidden !important;
          }
          #printable-certificate-container,
          #printable-certificate-container * {
            visibility: visible !important;
          }
          #printable-certificate-container {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            padding: 1.5cm !important;
            margin: 0 !important;
            background: white !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            z-index: 99999 !important;
            box-shadow: none !important;
          }
          @page {
            size: A4 landscape;
            margin: 0;
          }
        }
      `}</style>

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
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => refresh(token)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs disabled:opacity-50 cursor-pointer"
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
              className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors shadow-2xs cursor-pointer"
            >
              <SettingsIcon className="w-3.5 h-3.5" />
              <span>ตั้งค่าค่าย/โควตา</span>
            </button>

            {/* Canva Bulk Create Button */}
            <button
              type="button"
              id="btn-open-canva-modal"
              onClick={() => setIsCanvaModalOpen(true)}
              disabled={apps.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-purple-300 bg-purple-50 px-3.5 py-2 text-xs font-semibold text-purple-800 hover:bg-purple-100 transition-colors shadow-2xs disabled:opacity-50 cursor-pointer"
            >
              <Palette className="w-3.5 h-3.5 text-purple-600" />
              <span>🎨 ส่งออก Canva / เกียรติบัตร</span>
            </button>

            <button
              type="button"
              onClick={exportCSV}
              disabled={apps.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 transition-colors shadow-2xs disabled:opacity-50 cursor-pointer"
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
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors shadow-2xs cursor-pointer"
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
          <button type="button" onClick={() => setError(null)} className="text-rose-500 hover:text-rose-700">
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
          <button type="button" onClick={() => setActionSuccess(null)} className="text-emerald-500 hover:text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!token ? (
        /* Login Card */
        <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xs">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold text-slate-900">เข้าสู่ระบบผู้ดูแลระบบ</h2>
            <p className="mt-1 text-xs text-slate-500">กรุณาลงชื่อเข้าใช้ด้วยบัญชี Staff / Admin ของโครงการ</p>
          </div>

          <form onSubmit={onLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1" htmlFor="admin-user">
                ชื่อผู้ใช้ (Username)
              </label>
              <input
                id="admin-user"
                className={inputCls}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1" htmlFor="admin-pass">
                รหัสผ่าน (Password)
              </label>
              <input
                id="admin-pass"
                type="password"
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white shadow-2xs hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {busy ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบผู้ดูแล'}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-slate-400">
            Default credentials: <code>admin</code> / <code>strong_password</code>
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          
          {/* 1. Summary Stat Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            
            {/* Card 1: Total Applicants */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">ผู้สมัครทั้งหมด</span>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
                  <Users className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-bold font-mono text-slate-900">{totalApps}</span>
                <span className="text-xs text-slate-400">คน</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                ผ่านเกณฑ์เบื้องต้น {passedCount} คน
              </p>
            </div>

            {/* Card 2: Pending Slip Checks */}
            <div
              onClick={() => setFilter('NEED_SLIP_VERIFY')}
              className={`rounded-2xl border p-5 shadow-2xs cursor-pointer transition-all ${
                filter === 'NEED_SLIP_VERIFY'
                  ? 'border-amber-400 bg-amber-50/50 ring-2 ring-amber-200'
                  : 'border-slate-200 bg-white hover:border-amber-300 hover:bg-amber-50/20'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-amber-800">รอตรวจสอบสลิป</span>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                  <Clock className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-bold font-mono text-amber-900">{pendingSlipCount}</span>
                <span className="text-xs text-amber-700">รายการ</span>
              </div>
              <p className="mt-1 text-xs text-amber-600 flex items-center gap-1">
                <span>คลิกเพื่อกรองเฉพาะผู้รอตรวจสลิป</span>
              </p>
            </div>

            {/* Card 3: Confirmed / Quota */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">ยืนยันสิทธิ์ / โควตา</span>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-bold font-mono text-emerald-700">{confirmedCount}</span>
                <span className="text-xs text-slate-400 font-mono">/ {maxCapacity} คน ({capacityPercent}%)</span>
              </div>
              {/* Progress Bar */}
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-emerald-600 transition-all duration-500 rounded-full"
                  style={{ width: `${capacityPercent}%` }}
                />
              </div>
            </div>

            {/* Card 4: Total Revenue */}
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
                  className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
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
                  className={`inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
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
                    className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
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
              <div className="relative w-full md:w-80">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="ค้นหาชื่อ, รหัส, โรงเรียน, เบอร์..."
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-8 py-2 text-xs text-slate-900 outline-none focus:bg-white focus:border-blue-600 focus:ring-1 focus:ring-blue-100 transition-all font-mono"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

            </div>

            {/* Status indicators */}
            <div className="flex flex-wrap items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-100">
              <span className="font-mono">
                แสดงผล: {filtered.length} จากทั้งหมด {totalApps} รายการ {searchQuery && `(ค้นหาคำว่า: "${searchQuery}")`}
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
                    <th scope="col" className="px-4 py-3.5">สลิป & เกียรติบัตร</th>
                    <th scope="col" className="px-4 py-3.5">เปลี่ยนสถานะ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedApps.map((a) => {
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

                        {/* Column 5: Payment Slip & Certificate */}
                        <td className="px-4 py-3.5">
                          <div className="flex flex-wrap items-center gap-2">
                            {slip ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setInspectingApp(a);
                                  setVerificationNote('');
                                }}
                                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all shadow-2xs cursor-pointer ${
                                  isPendingSlip
                                    ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 ring-2 ring-amber-200/50'
                                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                }`}
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>สลิป</span>
                              </button>
                            ) : (
                              <span className="text-xs text-slate-400 italic">ยังไม่แนบ</span>
                            )}

                            {/* Certificate Button */}
                            <button
                              type="button"
                              title="ออกเกียรติบัตรสำหรับผู้สมัครรายนี้"
                              onClick={() => setCertApp(a)}
                              className="inline-flex items-center gap-1 rounded-xl border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 transition-colors shadow-2xs cursor-pointer"
                            >
                              <Award className="w-3.5 h-3.5 text-amber-600" />
                              <span>เกียรติบัตร</span>
                            </button>
                          </div>
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
                                className={`rounded-lg px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
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
            {paginatedApps.map((a) => {
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

                  <div className="flex items-center gap-2 pt-1">
                    {slip && (
                      <button
                        type="button"
                        onClick={() => {
                          setInspectingApp(a);
                          setVerificationNote('');
                        }}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-100 transition-colors cursor-pointer"
                      >
                        <Eye className="w-4 h-4" />
                        <span>ตรวจสลิป</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setCertApp(a)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 transition-colors cursor-pointer"
                    >
                      <Award className="w-4 h-4 text-amber-600" />
                      <span>เกียรติบัตร</span>
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1 pt-1 border-t border-slate-100">
                    {STATUSES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={patching === a.id || s === a.status}
                        onClick={() => onStatus(a.id, s)}
                        className={`rounded-lg px-2 py-1 text-xs font-medium ${
                          s === a.status
                            ? 'bg-slate-800 text-white font-semibold'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        } disabled:opacity-40`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </article>
              );
            })}

            {filtered.length === 0 && (
              <div className="py-8 text-center text-slate-400 text-xs">
                ไม่พบข้อมูลใบสมัคร
              </div>
            )}
          </div>

          {/* 5. Pagination Bar Controls */}
          {filtered.length > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs">
              
              {/* Record Range & Page Size Selector */}
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <span>
                  กำลังแสดง <strong>{filtered.length > 0 ? startIndex + 1 : 0} - {endIndex}</strong> จากทั้งหมด <strong>{filtered.length}</strong> รายการ
                </span>
                <span className="text-slate-300">|</span>
                <div className="flex items-center gap-1.5">
                  <label htmlFor="page-size-select" className="text-slate-500">แถวต่อหน้า:</label>
                  <select
                    id="page-size-select"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-blue-600 cursor-pointer"
                  >
                    <option value={5}>5 รายการ</option>
                    <option value={10}>10 รายการ</option>
                    <option value={20}>20 รายการ</option>
                    <option value={50}>50 รายการ</option>
                  </select>
                </div>
              </div>

              {/* Page Number Navigation Buttons */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  id="btn-page-first"
                  disabled={safeCurrentPage <= 1}
                  onClick={() => setCurrentPage(1)}
                  title="หน้าแรกสุด"
                  className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  id="btn-page-prev"
                  disabled={safeCurrentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  title="หน้าก่อนหน้า"
                  className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>

                {/* Numbered Page Buttons with windowing */}
                <div className="flex items-center gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter((page) => {
                      return (
                        page === 1 ||
                        page === totalPages ||
                        Math.abs(page - safeCurrentPage) <= 1
                      );
                    })
                    .map((page, idx, arr) => {
                      const prev = arr[idx - 1];
                      const hasGap = prev && page - prev > 1;
                      return (
                        <span key={page} className="flex items-center">
                          {hasGap && <span className="px-1.5 text-xs text-slate-400">...</span>}
                          <button
                            type="button"
                            onClick={() => setCurrentPage(page)}
                            className={`h-8 min-w-8 px-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                              safeCurrentPage === page
                                ? 'bg-blue-600 text-white shadow-2xs font-bold'
                                : 'text-slate-600 hover:bg-slate-100'
                            }`}
                          >
                            {page}
                          </button>
                        </span>
                      );
                    })}
                </div>

                <button
                  type="button"
                  id="btn-page-next"
                  disabled={safeCurrentPage >= totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  title="หน้าถัดไป"
                  className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  id="btn-page-last"
                  disabled={safeCurrentPage >= totalPages}
                  onClick={() => setCurrentPage(totalPages)}
                  title="หน้าสุดท้าย"
                  className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>

            </div>
          )}

          {/* 6. Settings Modal */}
          {isSettingsOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
              <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <SettingsIcon className="w-5 h-5 text-blue-600" />
                    <h3 className="text-lg font-bold text-slate-900">การตั้งค่าค่าย & โควตารับสมัคร</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSaveSettings} className="mt-4 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1" htmlFor="set-camp-name">
                      ชื่อโครงการค่าย *
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
                        className="w-4 h-4 rounded text-rose-600 focus:ring-rose-500 border-slate-300 cursor-pointer"
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
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="submit"
                      disabled={settingsBusy}
                      className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 shadow-xs disabled:opacity-50 cursor-pointer"
                    >
                      {settingsBusy ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า (Save Settings)'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* 7. Slip Inspection & Verification Modal */}
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
                    className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
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
                    className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {verifying ? 'กำลังบันทึก...' : 'ปฏิเสธสลิป (Reject Slip)'}
                  </button>
                  <button
                    type="button"
                    disabled={verifying}
                    onClick={() => handleVerifySlip(true)}
                    className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 shadow-xs disabled:opacity-50 transition-colors cursor-pointer"
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

          {/* 8. Certificate Viewer & Print Modal */}
          {certApp && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
              <div className="relative w-full max-w-4xl rounded-2xl bg-white p-6 shadow-2xl max-h-[95vh] overflow-y-auto">
                
                {/* Modal Top Bar */}
                <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                  <div className="flex items-center gap-2">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                      <Award className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">เกียรติบัตรเข้าร่วมโครงการ (Certificate of Completion)</h3>
                      <p className="text-xs text-slate-500 font-mono">
                        เลขที่: {getCertificateNo(certApp)} · ผู้รับ: {certApp.fullName}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    id="btn-x-close-cert-modal"
                    onClick={() => setCertApp(null)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Printable Certificate Frame */}
                <div className="mt-6 flex justify-center">
                  <div
                    id="printable-certificate-container"
                    className="w-full max-w-3xl rounded-2xl border-8 border-double border-amber-600/60 bg-linear-to-b from-amber-50/40 via-white to-amber-50/40 p-6 sm:p-10 shadow-lg text-center relative"
                  >
                    {/* Decorative Corner Flairs */}
                    <div className="absolute top-3 left-3 w-8 h-8 border-t-2 border-l-2 border-amber-600/80 pointer-events-none" />
                    <div className="absolute top-3 right-3 w-8 h-8 border-t-2 border-r-2 border-amber-600/80 pointer-events-none" />
                    <div className="absolute bottom-3 left-3 w-8 h-8 border-b-2 border-l-2 border-amber-600/80 pointer-events-none" />
                    <div className="absolute bottom-3 right-3 w-8 h-8 border-b-2 border-r-2 border-amber-600/80 pointer-events-none" />

                    {/* Emblem & Host */}
                    <div className="mb-4">
                      <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-linear-to-tr from-amber-600 to-amber-400 text-white shadow-md">
                        <Sparkles className="h-7 w-7" />
                      </div>
                      <p className="text-xs font-semibold tracking-wider text-amber-800 uppercase">
                        สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้
                      </p>
                      <h4 className="mt-1 text-base font-bold text-slate-800">
                        โครงการค่ายวิทยาการคอมพิวเตอร์ ComCamp ครั้งที่ 25
                      </h4>
                    </div>

                    {/* Certificate Presentation Text */}
                    <div className="my-6 space-y-3">
                      <p className="text-xs font-medium text-slate-500">
                        เกียรติบัตรฉบับนี้ให้ไว้เพื่อแสดงว่า
                      </p>
                      <h2 className="text-2xl sm:text-3xl font-bold tracking-wide text-slate-900 border-b-2 border-amber-400/50 pb-2 inline-block px-8">
                        {certApp.fullName}
                      </h2>
                      <p className="text-sm font-medium text-blue-900">
                        โรงเรียน{certApp.school} {certApp.province ? `(${certApp.province})` : ''}
                      </p>
                      <p className="mx-auto max-w-xl text-xs sm:text-sm text-slate-600 leading-relaxed pt-2">
                        ได้ผ่านการเข้าร่วมและสำเร็จการฝึกอบรมเชิงปฏิบัติการทางวิทยาการคอมพิวเตอร์ นวัตกรรมซอฟต์แวร์ และปัญญาประดิษฐ์ (AI & IoT)
                        ตลอดระยะเวลาการจัดโครงการค่าย ComCamp ครั้งที่ 25
                      </p>
                      <p className="text-xs text-slate-500 pt-2 font-medium">
                        ให้ไว้ ณ วันที่ 16 พฤศจิกายน พุทธศักราช 2569
                      </p>
                    </div>

                    {/* Signatures & Verification Badge */}
                    <div className="mt-8 pt-4 border-t border-amber-200/60 grid grid-cols-1 sm:grid-cols-3 items-end gap-4 text-center">
                      <div>
                        <div className="mx-auto mb-2 h-10 w-28 border-b border-dashed border-slate-400" />
                        <p className="text-xs font-semibold text-slate-800">(ผู้ช่วยศาสตราจารย์ ดร. ...)</p>
                        <p className="text-[10px] text-slate-500">ประธานหลักสูตรวิทยาการคอมพิวเตอร์</p>
                      </div>

                      <div className="bg-white/80 rounded-xl p-2.5 border border-amber-200 text-center">
                        <div className="text-[10px] font-mono text-slate-400">เลขที่เกียรติบัตร</div>
                        <div className="text-xs font-bold font-mono text-amber-800">{getCertificateNo(certApp)}</div>
                        <div className="mt-1 text-[9px] text-slate-400">✓ ออกโดยระบบ ComCamp #25</div>
                      </div>

                      <div>
                        <div className="mx-auto mb-2 h-10 w-28 border-b border-dashed border-slate-400" />
                        <p className="text-xs font-semibold text-slate-800">(รองศาสตราจารย์ ดร. ...)</p>
                        <p className="text-[10px] text-slate-500">คณบดีคณะวิทยาศาสตร์</p>
                      </div>
                    </div>

                  </div>
                </div>

                {/* Modal Footer Actions */}
                <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => copyCertificateId(getCertificateNo(certApp))}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer transition-colors"
                    >
                      {copiedCertId ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          <span className="text-emerald-700">คัดลอกรหัสแล้ว</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-slate-500" />
                          <span>คัดลอกรหัสเกียรติบัตร</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setCertApp(null);
                        setIsCanvaModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-purple-200 bg-purple-50 px-3 py-2 text-xs font-medium text-purple-700 hover:bg-purple-100 cursor-pointer transition-colors"
                    >
                      <Palette className="w-3.5 h-3.5 text-purple-600" />
                      <span>เปิดส่งออก Canva Bulk Create</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      id="btn-close-cert-modal"
                      onClick={() => setCertApp(null)}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      ปิดหน้าต่าง
                    </button>
                    <button
                      type="button"
                      id="btn-print-certificate"
                      onClick={handlePrintCertificate}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-blue-700 cursor-pointer transition-colors"
                    >
                      <Printer className="w-4 h-4" />
                      <span>พิมพ์ / บันทึกเป็น PDF (Print)</span>
                    </button>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* 9. Canva Bulk Create & Template Export Hub Modal */}
          {isCanvaModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
              <div className="relative w-full max-w-2xl rounded-2xl bg-white p-6 sm:p-7 shadow-2xl max-h-[92vh] overflow-y-auto">
                
                {/* Modal Header */}
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-purple-100 text-purple-700">
                      <Palette className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">
                        ส่งออกข้อมูลสำหรับ Canva (Bulk Create / Template)
                      </h3>
                      <p className="text-xs text-slate-500">
                        เชื่อมต่อข้อมูลผู้เข้าร่วมค่ายเพื่อสร้างเกียรติบัตรบน Canva แบบอัตโนมัติในครั้งเดียว
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsCanvaModalOpen(false)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Scope Selection */}
                <div className="mt-5 space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    เลือกกลุ่มผู้สมัครที่ต้องการส่งออก ({canvaTargetApps.length} รายการ):
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setCanvaScope('CONFIRMED')}
                      className={`p-3 rounded-xl border text-left text-xs transition-all cursor-pointer ${
                        canvaScope === 'CONFIRMED'
                          ? 'border-purple-600 bg-purple-50 text-purple-900 ring-2 ring-purple-200 font-semibold'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-bold flex items-center justify-between">
                        <span>ยืนยันสิทธิ์สมบูรณ์</span>
                        <span className="font-mono">{confirmedCount} คน</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">แนะนำสำหรับออกเกียรติบัตรจริง</p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setCanvaScope('PASSED_OR_CONFIRMED')}
                      className={`p-3 rounded-xl border text-left text-xs transition-all cursor-pointer ${
                        canvaScope === 'PASSED_OR_CONFIRMED'
                          ? 'border-purple-600 bg-purple-50 text-purple-900 ring-2 ring-purple-200 font-semibold'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-bold flex items-center justify-between">
                        <span>ผ่านคัดเลือกทั้งหมด</span>
                        <span className="font-mono">{passedCount + confirmedCount} คน</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">PASSED + CONFIRMED</p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setCanvaScope('FILTERED')}
                      className={`p-3 rounded-xl border text-left text-xs transition-all cursor-pointer ${
                        canvaScope === 'FILTERED'
                          ? 'border-purple-600 bg-purple-50 text-purple-900 ring-2 ring-purple-200 font-semibold'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-bold flex items-center justify-between">
                        <span>ตามตัวกรองปัจจุบัน</span>
                        <span className="font-mono">{filtered.length} คน</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">รวมผลค้นหาปัจจุบัน</p>
                    </button>
                  </div>
                </div>

                {/* Canva Template Variable Mapping Table */}
                <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-800">
                      ตัวแปรที่ส่งออกไปยัง Template ใน Canva (Data Field Mapping):
                    </span>
                    <span className="text-[11px] font-mono text-purple-700 bg-purple-100 px-2 py-0.5 rounded-full">
                      UTF-8 BOM Supported
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs text-slate-600">
                      <thead className="border-b border-slate-200 text-slate-400 uppercase text-[10px]">
                        <tr>
                          <th className="py-1.5 px-2">ชื่อคอลัมน์ใน Canva</th>
                          <th className="py-1.5 px-2">ตัวอย่างค่าที่ส่งออก</th>
                          <th className="py-1.5 px-2">กล่องข้อความที่แนะนำใน Canva</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/60 font-mono text-[11px]">
                        <tr>
                          <td className="py-1.5 px-2 font-bold text-purple-700">{`{{FullName}}`}</td>
                          <td className="py-1.5 px-2 text-slate-800">{canvaTargetApps[0]?.fullName || 'สมชาย รักคอม'}</td>
                          <td className="py-1.5 px-2 text-slate-500">ชื่อ-นามสกุลผู้รับเกียรติบัตร</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 px-2 font-bold text-purple-700">{`{{School}}`}</td>
                          <td className="py-1.5 px-2 text-slate-800">{canvaTargetApps[0]?.school || 'โรงเรียนแม่โจ้วิทยาคม'}</td>
                          <td className="py-1.5 px-2 text-slate-500">โรงเรียนของผู้เข้าร่วม</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 px-2 font-bold text-purple-700">{`{{CertificateNo}}`}</td>
                          <td className="py-1.5 px-2 text-slate-800">{canvaTargetApps[0] ? getCertificateNo(canvaTargetApps[0]) : 'CC25-CERT-866F13'}</td>
                          <td className="py-1.5 px-2 text-slate-500">รหัสเลขที่เกียรติบัตร</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 px-2 font-bold text-purple-700">{`{{Date}}`}</td>
                          <td className="py-1.5 px-2 text-slate-800">16 พฤศจิกายน 2569</td>
                          <td className="py-1.5 px-2 text-slate-500">วันที่จัดกิจกรรม / ออกเกียรติบัตร</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 px-2 font-bold text-purple-700">{`{{CampName}}`}</td>
                          <td className="py-1.5 px-2 text-slate-800">ค่ายวิทยาการคอมพิวเตอร์ ComCamp ครั้งที่ 25</td>
                          <td className="py-1.5 px-2 text-slate-500">ชื่อโครงการค่าย</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Step-by-Step Instructions */}
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/70 p-3.5 text-xs text-blue-900 space-y-1.5">
                  <p className="font-bold text-blue-800 flex items-center gap-1.5">
                    <span>💡 วิธีเชื่อมต่อ Canva แบบกลุ่ม (Bulk Create) ใน 4 ขั้นตอน:</span>
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-slate-600 pl-1">
                    <li>เปิดดีไซน์เกียรติบัตรใน Canva (ค้นหาคำว่า <em>Certificate</em> หรือใช้ Template ของค่าย)</li>
                    <li>ที่แถบเครื่องมือซ้ายมือ คลิก <strong>Apps (แอป)</strong> ค้นหาและเลือก <strong>Bulk Create (สร้างแบบกลุ่ม)</strong></li>
                    <li>กด <strong>Upload CSV</strong> (ไฟล์ที่โหลดจากปุ่มล่าง) หรือกด <strong>Enter data manually</strong> แล้วกด <strong>Ctrl+V</strong> เพื่อวางตารางได้ทันที</li>
                    <li>คลิกขวาที่กล่องข้อความบนเกียรติบัตร เลือก <strong>Connect data (เชื่อมต่อข้อมูล)</strong> ตามชื่อตัวแปร แล้วกด <strong>Generate pages</strong> 🎉</li>
                  </ol>
                </div>

                {/* Action Buttons */}
                <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <a
                    href="https://www.canva.com"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-purple-700 hover:text-purple-900 underline"
                  >
                    <span>เปิด Canva.com ในแท็บใหม่</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>

                  <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                    {/* Copy Table for Canva Manual Entry */}
                    <button
                      type="button"
                      id="btn-copy-canva-table"
                      onClick={() => copyCanvaTableData(canvaTargetApps)}
                      disabled={canvaTargetApps.length === 0}
                      className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs disabled:opacity-50 cursor-pointer"
                    >
                      {copiedCanvaTable ? (
                        <>
                          <Check className="w-4 h-4 text-emerald-600" />
                          <span className="text-emerald-700">คัดลอกตารางแล้ว (วางใน Canva ได้เลย)</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4 text-slate-500" />
                          <span>คัดลอกตาราง (Paste ใน Canva)</span>
                        </>
                      )}
                    </button>

                    {/* Download CSV for Canva */}
                    <button
                      type="button"
                      id="btn-download-canva-csv"
                      onClick={() => exportCanvaCSV(canvaTargetApps)}
                      disabled={canvaTargetApps.length === 0}
                      className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-xs font-semibold text-white shadow-2xs hover:bg-purple-700 transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      <span>ดาวน์โหลด CSV สำหรับ Canva ({canvaTargetApps.length} คน)</span>
                    </button>
                  </div>
                </div>

              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
