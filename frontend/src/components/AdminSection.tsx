import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  ApiHttpError,
  adminLogin,
  fetchAdminSlip,
  hasSlip,
  listApplications,
  updateApplicationStatus,
  verifyPaymentSlip,
  type Application,
  type ApplicationStatus,
  type ApiSource,
} from '../lib/api';

const STATUSES: ApplicationStatus[] = ['PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED'];

/* Editorial ledger: no cards, no shadows. Structure comes from whitespace and 1px rules; colour
   appears only as a small status dot (AGENTS §4.1 master tokens). */
const STATUS_DOT: Record<ApplicationStatus, string> = {
  PENDING: '#B45309',
  PASSED: '#1A5FE0',
  RESERVE: '#62666E',
  CONFIRMED: '#029E00',
  REJECTED: '#C62828',
};

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PENDING: 'รอพิจารณา',
  PASSED: 'ผ่านการคัดเลือก',
  RESERVE: 'ตัวสำรอง',
  CONFIRMED: 'ยืนยันสิทธิ์สมบูรณ์',
  REJECTED: 'ไม่ผ่าน',
};

const INK = '#121316';
const INK_2 = '#4A4D55';
const INK_3 = '#62666E';
const RULE = 'rgba(18,19,22,0.14)';
const INPUT_BORDER = '#8A8D93';

/* The admin JWT lives in sessionStorage: it survives a refresh but not closing the tab, so it is
   gone from shared camp-office computers once the browser closes (8h expiry server-side). */
const TOKEN_KEY = 'comcamp-admin-token';
const tokenStore = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* storage blocked: the session lasts until refresh */
    }
  },
  clear: () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY); // older builds kept it in localStorage
    } catch {
      /* ignore */
    }
  },
};

/** Shared focus treatment: blue-600 ring on every interactive element (AGENTS §11.3). */
const FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-[#1A5FE0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F9F8F4]';

function StatusMark({ status }: { status: ApplicationStatus }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: STATUS_DOT[status] }}>
        ●
      </span>
      <span className="text-sm leading-7" style={{ color: INK }}>
        {STATUS_LABELS[status]}
      </span>
    </span>
  );
}

export function AdminSection() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [apps, setApps] = useState<Application[]>([]);
  const [filter, setFilter] = useState<string>('ALL');
  const [busy, setBusy] = useState(false);
  const [patching, setPatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Slip review state (an inline panel under the row, not a modal)
  const [inspectingApp, setInspectingApp] = useState<Application | null>(null);
  const [verificationNote, setVerificationNote] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [slipImage, setSlipImage] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });

  /** Expired or deactivated session: drop the token and show the login form again. */
  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiHttpError && err.status === 401) {
      tokenStore.clear();
      setToken(null);
      setApps([]);
      setInspectingApp(null);
      setError('เซสชันหมดอายุหรือบัญชีถูกระงับ กรุณาเข้าสู่ระบบอีกครั้ง');
      return true;
    }
    return false;
  }

  async function refresh(t: string) {
    setBusy(true);
    try {
      const res = await listApplications(t);
      setApps(Array.isArray(res.data) ? res.data : []);
      setSource(res.source);
      setError(null);
    } catch (err) {
      if (handleAuthError(err)) return;
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
      setPassword('');
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
      setActionSuccess(`เปลี่ยนสถานะของ ${id} เป็น ${STATUS_LABELS[status]} สำเร็จ`);
    } catch (err) {
      if (handleAuthError(err)) return;
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
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : 'การตรวจสอบสลิปล้มเหลว');
    } finally {
      setVerifying(false);
    }
  }

  function openSlip(a: Application) {
    setInspectingApp((cur) => (cur?.id === a.id ? null : a));
    setVerificationNote('');
  }

  function logout() {
    setToken(null);
    setApps([]);
    setInspectingApp(null);
    tokenStore.clear();
  }

  useEffect(() => {
    try {
      localStorage.removeItem(TOKEN_KEY); // migrate away from the old persistent token
    } catch {
      /* ignore */
    }
    const saved = tokenStore.get();
    if (saved) {
      setToken(saved);
      refresh(saved);
    }
  }, []);

  useEffect(() => {
    if (token) tokenStore.set(token);
  }, [token]);

  /* Slips are served only to an authenticated admin, so fetch the image with the token and show
     it from an object URL (revoked when the panel closes). */
  useEffect(() => {
    if (!token || !inspectingApp) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setSlipImage({ url: null, error: null });
    fetchAdminSlip(token, inspectingApp.id)
      .then((url) => {
        if (cancelled) return URL.revokeObjectURL(url);
        objectUrl = url;
        setSlipImage({ url, error: null });
      })
      .catch((err) => {
        if (cancelled || handleAuthError(err)) return;
        setSlipImage({ url: null, error: err instanceof Error ? err.message : 'โหลดรูปสลิปไม่สำเร็จ' });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, inspectingApp?.id]);

  /* Escape closes the open slip panel. */
  useEffect(() => {
    if (!inspectingApp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectingApp(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspectingApp]);

  /* Newest first, ties broken by id, so the order is stable across refreshes whatever the API returns. */
  const sorted = [...apps].sort(
    (x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? '') || x.id.localeCompare(y.id),
  );
  const filtered = filter === 'ALL' ? sorted : sorted.filter((a) => a.status === filter);
  const count = (s: ApplicationStatus) => apps.filter((a) => a.status === s).length;
  const withSlip = apps.filter((a) => hasSlip(a)).length;

  const inputCls = `w-full rounded-xl border bg-white px-3.5 py-3 text-base leading-6 transition-colors ${FOCUS}`;
  const pillGhost = `rounded-full border px-4 py-2 text-sm font-semibold transition-colors hover:bg-[#F2F0E8] disabled:opacity-50 ${FOCUS}`;

  const tabs: { key: string; label: string; n: number }[] = [
    { key: 'ALL', label: 'ทั้งหมด', n: apps.length },
    ...STATUSES.map((s) => ({ key: s, label: STATUS_LABELS[s], n: count(s) })),
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-24 pt-14 selection:bg-[#EAF1FF] sm:px-8 sm:pt-20">
      {/* ── Masthead ─────────────────────────────────────────── */}
      <header>
        <h1
          className="text-balance text-[2.25rem] font-bold leading-[1.22] sm:text-[3.25rem]"
          style={{ color: INK }}
        >
          {token ? 'ใบสมัครและสลิป' : 'สำหรับพี่ค่าย'}
        </h1>
        {token ? (
          <p className="mt-4 max-w-[60ch] text-base leading-[1.75]" style={{ color: INK_2 }}>
            ผู้สมัคร <span className="font-mono tabular-nums" style={{ color: INK }}>{apps.length}</span> คน
            {' · '}รอพิจารณา <span className="font-mono tabular-nums" style={{ color: INK }}>{count('PENDING')}</span>
            {' · '}ยืนยันสิทธิ์แล้ว <span className="font-mono tabular-nums" style={{ color: INK }}>{count('CONFIRMED')}</span>
            {' · '}แนบสลิปแล้ว <span className="font-mono tabular-nums" style={{ color: INK }}>{withSlip}</span>
          </p>
        ) : (
          <p className="mt-4 max-w-[46ch] text-base leading-[1.75]" style={{ color: INK_2 }}>
            เข้าสู่ระบบเพื่อตรวจรายชื่อใบสมัคร เปลี่ยนสถานะ และอนุมัติหลักฐานการชำระเงิน
          </p>
        )}
      </header>

      {/* ── Notices: one ruled line, announced to assistive tech ── */}
      {error && (
        <div
          role="alert"
          className="mt-8 flex items-baseline justify-between gap-4 border-y py-3"
          style={{ borderColor: RULE }}
        >
          <p className="text-sm leading-7" style={{ color: '#C62828' }}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            className={`shrink-0 rounded-full px-2 py-0.5 text-sm underline underline-offset-4 ${FOCUS}`}
            style={{ color: INK_2 }}
          >
            ปิด
          </button>
        </div>
      )}

      {actionSuccess && (
        <div
          role="status"
          className="mt-8 flex items-baseline justify-between gap-4 border-y py-3"
          style={{ borderColor: RULE }}
        >
          <p className="text-sm leading-7" style={{ color: INK }}>
            <span aria-hidden="true" className="mr-2 text-[10px]" style={{ color: STATUS_DOT.CONFIRMED }}>
              ●
            </span>
            {actionSuccess}
          </p>
          <button
            type="button"
            onClick={() => setActionSuccess(null)}
            className={`shrink-0 rounded-full px-2 py-0.5 text-sm underline underline-offset-4 ${FOCUS}`}
            style={{ color: INK_2 }}
          >
            ปิด
          </button>
        </div>
      )}

      {!token ? (
        /* ── Login: a single quiet column ─────────────────────── */
        <section className="mt-14 max-w-sm">
          <form onSubmit={onLogin} aria-busy={busy}>
            <div>
              <label className="mb-2 block text-sm font-semibold" style={{ color: INK }} htmlFor="admin-user">
                ชื่อผู้ใช้
              </label>
              <input
                id="admin-user"
                className={inputCls}
                style={{ borderColor: INPUT_BORDER, color: INK }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </div>
            <div className="mt-6">
              <label className="mb-2 block text-sm font-semibold" style={{ color: INK }} htmlFor="admin-pass">
                รหัสผ่าน
              </label>
              <input
                id="admin-pass"
                className={inputCls}
                style={{ borderColor: INPUT_BORDER, color: INK }}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className={`mt-10 w-full rounded-full px-5 py-3.5 text-base font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
              style={{ backgroundColor: INK, color: '#F9F8F4' }}
            >
              {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </button>
          </form>

          <p className="mt-10 border-t pt-4 text-sm leading-[1.75]" style={{ borderColor: RULE, color: INK_3 }}>
            เซสชันอยู่ได้ไม่เกิน 8 ชั่วโมงและสิ้นสุดเมื่อปิดแท็บ ทุกการเปลี่ยนสถานะและการเปิดดูสลิปถูกบันทึกพร้อมบัญชีผู้ใช้และ IP
          </p>
        </section>
      ) : (
        /* ── Ledger ───────────────────────────────────────────── */
        <section className="mt-12" aria-busy={busy}>
          {/* Filter as text tabs; refresh / sign out as quiet pills */}
          <div className="flex flex-col gap-4 border-b pb-3 md:flex-row md:items-end md:justify-between" style={{ borderColor: INK }}>
            <div role="group" aria-label="กรองตามสถานะ" className="-mx-1 flex gap-x-6 gap-y-1 overflow-x-auto px-1 pb-1">
              {tabs.map((t) => {
                const active = filter === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(t.key)}
                    className={`shrink-0 whitespace-nowrap rounded-none border-b-2 py-1 text-sm transition-colors ${FOCUS}`}
                    style={{
                      color: active ? INK : INK_3,
                      fontWeight: active ? 600 : 400,
                      borderColor: active ? INK : 'transparent',
                    }}
                  >
                    {t.label}{' '}
                    <span className="font-mono text-xs tabular-nums">{t.n}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {busy && (
                <span className="mr-1 text-xs" style={{ color: INK_3 }}>
                  กำลังโหลด…
                </span>
              )}
              <button
                type="button"
                onClick={() => token && refresh(token)}
                disabled={busy}
                className={pillGhost}
                style={{ borderColor: RULE, color: INK }}
              >
                รีเฟรช
              </button>
              <button type="button" onClick={logout} className={pillGhost} style={{ borderColor: RULE, color: INK_2 }}>
                ออกจากระบบ
              </button>
            </div>
          </div>

          {/* Rows */}
          <ul>
            {filtered.map((a) => {
              const slip = hasSlip(a);
              const open = inspectingApp?.id === a.id;
              return (
                <li key={a.id} className="border-b" style={{ borderColor: RULE }}>
                  <div className="grid gap-x-8 gap-y-3 py-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_13.5rem] md:items-start">
                    {/* Who */}
                    <div className="min-w-0">
                      <p className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                        {a.id}
                      </p>
                      <p className="mt-1 text-base font-semibold leading-7" style={{ color: INK }}>
                        {a.fullName}
                        {a.nickname ? (
                          <span className="font-normal" style={{ color: INK_3 }}>
                            {' '}({a.nickname})
                          </span>
                        ) : null}
                      </p>
                      <p className="text-sm leading-7" style={{ color: INK_2 }}>
                        <span className="font-mono tabular-nums">{a.phone}</span>
                        {a.email ? <span style={{ color: INK_3 }}> · {a.email}</span> : null}
                      </p>
                    </div>

                    {/* Where */}
                    <div className="min-w-0 text-sm leading-7" style={{ color: INK_2 }}>
                      <p>{a.school}</p>
                      <p style={{ color: INK_3 }}>
                        {a.grade}
                        {a.province ? ` · ${a.province}` : ''} · ไซส์ {a.shirtSize}
                      </p>
                    </div>

                    {/* State + actions */}
                    <div className="flex flex-col items-start gap-2">
                      <label className="relative inline-flex items-center gap-2">
                        <span className="sr-only">เปลี่ยนสถานะของ {a.id}</span>
                        <span aria-hidden="true" className="text-[10px] leading-none" style={{ color: STATUS_DOT[a.status] }}>
                          ●
                        </span>
                        <select
                          value={a.status}
                          disabled={patching === a.id}
                          onChange={(e) => onStatus(a.id, e.target.value as ApplicationStatus)}
                          className={`cursor-pointer appearance-none rounded-sm border-b bg-transparent py-0.5 pr-6 text-sm leading-7 disabled:opacity-50 ${FOCUS}`}
                          style={{ borderColor: RULE, color: INK }}
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABELS[s]}
                            </option>
                          ))}
                        </select>
                        <ChevronDown
                          aria-hidden="true"
                          strokeWidth={1.5}
                          size={16}
                          className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2"
                          style={{ color: INK_3 }}
                        />
                      </label>

                      {slip ? (
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => openSlip(a)}
                          className={`rounded-sm py-0.5 text-sm font-semibold underline underline-offset-4 ${FOCUS}`}
                          style={{ color: '#1A5FE0' }}
                        >
                          {open ? 'ซ่อนสลิป' : 'ตรวจสอบสลิป'}
                        </button>
                      ) : (
                        <span className="text-sm leading-7" style={{ color: INK_3 }}>
                          ยังไม่มีสลิป
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Slip review: expands under its own row */}
                  {open && (
                    <div
                      className="grid gap-8 border-t py-6 md:grid-cols-[minmax(0,20rem)_1fr]"
                      style={{ borderColor: RULE }}
                      role="region"
                      aria-label={`ตรวจสอบหลักฐานการชำระเงิน ${a.id}`}
                    >
                      <div>
                        <div className="flex min-h-48 items-center justify-center" style={{ backgroundColor: '#F2F0E8' }}>
                          {slipImage.url ? (
                            <img src={slipImage.url} alt={`สลิปโอนเงินของ ${a.id}`} className="max-h-96 w-full object-contain" />
                          ) : (
                            <p
                              className="px-4 py-10 text-center text-sm leading-7"
                              role={slipImage.error ? 'alert' : undefined}
                              style={{ color: slipImage.error ? '#C62828' : INK_3 }}
                            >
                              {slipImage.error ?? 'กำลังโหลดรูปสลิป…'}
                            </p>
                          )}
                        </div>
                        {slipImage.url && (
                          <a
                            href={slipImage.url}
                            target="_blank"
                            rel="noreferrer"
                            className={`mt-2 inline-block rounded-sm text-sm underline underline-offset-4 ${FOCUS}`}
                            style={{ color: '#1A5FE0' }}
                          >
                            เปิดรูปขนาดเต็ม
                          </a>
                        )}
                      </div>

                      <div className="flex min-w-0 flex-col">
                        <h2 className="text-lg font-bold leading-[1.35]" style={{ color: INK }}>
                          หลักฐานการชำระเงิน
                        </h2>
                        <p className="mt-1 text-sm leading-7" style={{ color: INK_3 }}>
                          อนุมัติแล้วสถานะจะเป็นยืนยันสิทธิ์สมบูรณ์ ปฏิเสธแล้วจะกลับเป็นผ่านการคัดเลือกเพื่อให้ส่งสลิปใหม่
                        </p>

                        <label className="mb-2 mt-6 block text-sm font-semibold" style={{ color: INK }} htmlFor="verify-note">
                          หมายเหตุเจ้าหน้าที่
                        </label>
                        <input
                          id="verify-note"
                          className={inputCls}
                          style={{ borderColor: INPUT_BORDER, color: INK }}
                          placeholder="เช่น ยอดเงินถูกต้องครบถ้วน"
                          value={verificationNote}
                          onChange={(e) => setVerificationNote(e.target.value)}
                        />

                        <div className="mt-6 flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            disabled={verifying}
                            onClick={() => handleVerifySlip(true)}
                            className={`rounded-full px-6 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${FOCUS}`}
                            style={{ backgroundColor: INK, color: '#F9F8F4' }}
                          >
                            {verifying ? 'กำลังบันทึก…' : 'อนุมัติสลิป'}
                          </button>
                          <button
                            type="button"
                            disabled={verifying}
                            onClick={() => handleVerifySlip(false)}
                            className={`rounded-full border px-6 py-2.5 text-sm font-semibold transition-colors hover:bg-[#F2F0E8] disabled:opacity-50 ${FOCUS}`}
                            style={{ borderColor: '#C62828', color: '#C62828' }}
                          >
                            ปฏิเสธสลิป
                          </button>
                          <button
                            type="button"
                            onClick={() => setInspectingApp(null)}
                            className={`rounded-full px-3 py-2.5 text-sm underline underline-offset-4 ${FOCUS}`}
                            style={{ color: INK_2 }}
                          >
                            ปิด
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Loading skeleton (first load only) */}
          {busy && apps.length === 0 && (
            <div aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="border-b py-5" style={{ borderColor: RULE }}>
                  <div className="h-3 w-24 animate-pulse rounded-sm motion-reduce:animate-none" style={{ backgroundColor: '#F2F0E8' }} />
                  <div className="mt-3 h-4 w-56 animate-pulse rounded-sm motion-reduce:animate-none" style={{ backgroundColor: '#F2F0E8' }} />
                </div>
              ))}
            </div>
          )}

          {!busy && filtered.length === 0 && (
            <p className="py-16 text-base leading-[1.75]" style={{ color: INK_3 }}>
              {apps.length === 0
                ? 'ยังไม่มีใบสมัครเข้ามา เมื่อมีผู้สมัครรายชื่อจะแสดงที่นี่'
                : 'ไม่มีใบสมัครในสถานะนี้'}
            </p>
          )}

          {source && (
            <p className="mt-8 text-xs" style={{ color: INK_3 }}>
              แหล่งข้อมูล <span className="font-mono tabular-nums">{source}</span>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
