import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../styles/applicants.css';
import { ChevronDown, Info, Loader2, RotateCcw, Search, TriangleAlert, Users, X } from 'lucide-react';
import {
  ApiHttpError,
  fetchPublicApplicants,
  stripZeroWidth,
  type PublicApplicant,
  type PublicApplicantStatus,
} from '../lib/api';
import { STAFF_CONTACTS } from './register/model';

/*
 * /applicants — the public list of applicants. PDPA: this component only ever receives the
 * allowlisted fields (no, fullName, nickname, school, province, status); see fetchPublicApplicants.
 * It never asks for, stores or renders a code, phone, email or any other identifier.
 */

const INK = 'var(--color-ink)';
const INK_MUTED = 'var(--color-ink-muted)';
const SURFACE = 'var(--bg-card)';
const BORDER_INPUT = 'var(--color-border-input)';
const BTN_DARK = 'var(--color-btn-dark)';
const BTN_DARK_TEXT = 'var(--color-btn-dark-text)';
const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-tech)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-canvas)]';

type StatusFilter = 'ALL' | PublicApplicantStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'ทั้งหมด' },
  { value: 'รอชำระเงิน', label: 'รอชำระเงิน' },
  { value: 'ยืนยันสิทธิ์แล้ว', label: 'ยืนยันสิทธิ์แล้ว' },
];

/* Dot colours are theme tokens, so light and dark both follow global.css. Text stays ink. */
const STATUS_DOT: Record<PublicApplicantStatus, string> = {
  รอชำระเงิน: 'var(--color-warning)',
  ยืนยันสิทธิ์แล้ว: 'var(--color-success)',
};

type LoadState = 'loading' | 'ready' | 'error';

/** Case-, spacing- and zero-width-insensitive text for matching what a student types. */
function normalizeText(value: string): string {
  return stripZeroWidth(value).toLocaleLowerCase('th').replace(/\s+/g, ' ').trim();
}

function describeLoadError(err: unknown): string {
  if (err instanceof ApiHttpError) {
    if (err.code === 'RATE_LIMITED') {
      return err.retryAfterSeconds
        ? `มีการโหลดหน้านี้ถี่เกินไป กรุณารอประมาณ ${err.retryAfterSeconds} วินาทีแล้วลองใหม่อีกครั้ง`
        : 'มีการโหลดหน้านี้ถี่เกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
    }
    return 'ระบบไม่สามารถแสดงรายชื่อได้ในขณะนี้ กรุณาลองใหม่อีกครั้งในอีกสักครู่';
  }
  return 'เชื่อมต่อระบบไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง';
}

function StatusPill({ status }: { status: PublicApplicantStatus }) {
  const color = STATUS_DOT[status];
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold"
      style={{ color: INK, backgroundColor: `color-mix(in srgb, ${color} 16%, ${SURFACE})` }}
    >
      <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {status}
    </span>
  );
}

/** The applicant's order number: digits only, so it is set in mono. */
function OrderNo({ no }: { no: number }) {
  return <span className="font-mono tabular-nums">{String(no).padStart(2, '0')}</span>;
}

export function ApplicantsSection() {
  const [state, setState] = useState<LoadState>('loading');
  const [rows, setRows] = useState<PublicApplicant[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [province, setProvince] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const loadingRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    // Synchronous lock: a double tap on "ลองใหม่" must not fire two requests.
    if (loadingRef.current) return;
    loadingRef.current = true;
    setState('loading');
    setError('');
    try {
      const { data } = await fetchPublicApplicants();
      if (!mountedRef.current) return;
      setRows(data);
      setState('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(describeLoadError(err));
      setState('error');
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const provinces = useMemo(
    () => Array.from(new Set(rows.map((r) => r.province).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'th')),
    [rows],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { ALL: rows.length, รอชำระเงิน: 0, ยืนยันสิทธิ์แล้ว: 0 };
    for (const r of rows) counts[r.status] += 1;
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = normalizeText(query);
    return rows.filter((r) => {
      if (province && r.province !== province) return false;
      if (status !== 'ALL' && r.status !== status) return false;
      if (!q) return true;
      return [r.fullName, r.nickname, r.school].some((field) => normalizeText(field).includes(q));
    });
  }, [rows, query, province, status]);

  const filtersActive = query.trim() !== '' || province !== '' || status !== 'ALL';

  const clearFilters = () => {
    setQuery('');
    setProvince('');
    setStatus('ALL');
    searchRef.current?.focus();
  };

  const busy = state === 'loading';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <header className="border-t-4 pt-5" style={{ borderColor: INK }}>
        <h1 className="text-balance text-3xl font-bold leading-[1.22] sm:text-5xl" style={{ color: INK }}>
          รายชื่อผู้สมัคร
        </h1>
        <p className="mt-3 max-w-[60ch] text-base leading-7" style={{ color: INK_MUTED }}>
          รายชื่อน้อง ๆ ที่สมัครค่าย ComCamp <span className="font-mono tabular-nums">#25</span> เรียงตามลำดับการสมัคร
          ค้นหาชื่อ ชื่อเล่น หรือโรงเรียนของตัวเองและเพื่อนได้ที่นี่
        </p>
      </header>

      {/* ── Search & filters ── */}
      <form
        role="search"
        aria-label="ค้นหาและกรองรายชื่อผู้สมัคร"
        onSubmit={(e) => e.preventDefault()}
        className="ap-controls mt-6 md:mt-10"
      >
        <div className="grid gap-4 md:grid-cols-12 md:items-end">
          <div className="md:col-span-8">
            <label htmlFor="ap-q" className="mb-1.5 block text-sm font-semibold" style={{ color: INK }}>
              ค้นหาชื่อ ชื่อเล่น หรือโรงเรียน
            </label>
            <div className="relative flex items-center">
              <Search
                aria-hidden="true"
                size={18}
                strokeWidth={1.5}
                className="pointer-events-none absolute left-4"
                style={{ color: INK_MUTED }}
              />
              <input
                ref={searchRef}
                id="ap-q"
                type="search"
                inputMode="search"
                enterKeyHint="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="เช่น ชื่อ ชื่อเล่น หรือชื่อโรงเรียน"
                autoComplete="off"
                spellCheck={false}
                className="ap-input min-h-11 w-full rounded-full border bg-[var(--bg-card)] py-2.5 pl-11 pr-12 text-base outline-none transition-colors focus:border-[var(--color-tech)] focus-visible:ring-2 focus-visible:ring-[var(--color-tech)]"
                style={{ borderColor: BORDER_INPUT, color: INK }}
              />
              {query.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  aria-label="ล้างคำค้นหา"
                  className={`absolute right-0.5 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition-opacity hover:opacity-75 ${FOCUS_RING}`}
                  style={{ color: INK_MUTED }}
                >
                  <X aria-hidden="true" size={18} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </div>

          <div className="md:col-span-4">
            <label htmlFor="ap-province" className="mb-1.5 block text-sm font-semibold" style={{ color: INK }}>
              จังหวัด
            </label>
            <div className="relative flex items-center">
              <select
                id="ap-province"
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                disabled={provinces.length === 0}
                className="min-h-11 w-full cursor-pointer appearance-none rounded-full border bg-[var(--bg-card)] py-2.5 pl-4 pr-10 text-base outline-none transition-colors focus:border-[var(--color-tech)] focus-visible:ring-2 focus-visible:ring-[var(--color-tech)] disabled:cursor-not-allowed"
                style={{ borderColor: BORDER_INPUT, color: INK, colorScheme: 'inherit' }}
              >
                <option value="">ทุกจังหวัด</option>
                {provinces.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden="true"
                size={16}
                strokeWidth={1.5}
                className="pointer-events-none absolute right-4"
                style={{ color: INK_MUTED }}
              />
            </div>
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-sm font-semibold" style={{ color: INK }}>
            สถานะ
          </legend>
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((f) => {
              const selected = status === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setStatus(f.value)}
                  className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${FOCUS_RING}`}
                  style={
                    selected
                      ? { backgroundColor: BTN_DARK, color: BTN_DARK_TEXT, borderColor: BTN_DARK }
                      : { backgroundColor: 'transparent', color: INK, borderColor: BORDER_INPUT }
                  }
                >
                  {f.value !== 'ALL' && (
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: STATUS_DOT[f.value] }}
                    />
                  )}
                  {f.label}
                  {state === 'ready' && (
                    <span className="font-mono text-xs tabular-nums" aria-hidden="true">
                      {statusCounts[f.value]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </fieldset>
      </form>

      {/* ── Count / live region ── */}
      <div className="ap-summary mt-8 flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="inline-flex items-center gap-2 text-base font-semibold leading-7" style={{ color: INK }}>
          <Users aria-hidden="true" size={18} strokeWidth={1.5} className="shrink-0" style={{ color: INK_MUTED }} />
          {state === 'loading' && <span>กำลังโหลดรายชื่อ…</span>}
          {state === 'error' && <span>โหลดรายชื่อไม่สำเร็จ</span>}
          {state === 'ready' &&
            (filtersActive ? (
              <span>
                พบ <span className="font-mono tabular-nums">{filtered.length}</span> คน จากทั้งหมด{' '}
                <span className="font-mono tabular-nums">{rows.length}</span> คน
              </span>
            ) : (
              <span>
                ผู้สมัครทั้งหมด <span className="font-mono tabular-nums">{rows.length}</span> คน
              </span>
            ))}
        </p>
        {state === 'ready' && filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold underline underline-offset-4 transition-opacity hover:opacity-80 ${FOCUS_RING}`}
            style={{ color: INK }}
          >
            <X aria-hidden="true" size={16} strokeWidth={1.5} />
            ล้างตัวกรอง
          </button>
        )}
      </div>

      {/* ── Results ── */}
      <div className="mt-4" aria-busy={busy || undefined}>
        {state === 'loading' && (
          <div className="ap-state flex items-center gap-3 text-base leading-7" style={{ color: INK_MUTED }}>
            <Loader2 aria-hidden="true" size={20} strokeWidth={1.5} className="shrink-0 motion-safe:animate-spin" />
            กำลังโหลดรายชื่อผู้สมัคร…
          </div>
        )}

        {state === 'error' && (
          <div role="alert" className="ap-alert flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2.5 text-base font-semibold leading-7" style={{ color: INK }}>
              <TriangleAlert aria-hidden="true" size={20} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: 'var(--color-danger)' }} />
              <span>{error}</span>
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-5 text-base font-semibold transition-opacity hover:opacity-90 ${FOCUS_RING}`}
              style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
            >
              <RotateCcw aria-hidden="true" size={16} strokeWidth={1.5} />
              ลองใหม่อีกครั้ง
            </button>
          </div>
        )}

        {state === 'ready' && rows.length === 0 && (
          <div className="ap-state">
            <p className="text-xl font-bold leading-8" style={{ color: INK }}>
              ยังไม่มีรายชื่อผู้สมัคร
            </p>
            <p className="mt-2 max-w-[56ch] text-base leading-7" style={{ color: INK_MUTED }}>
              เมื่อเปิดรับสมัครและมีน้อง ๆ สมัครเข้ามา รายชื่อจะแสดงที่หน้านี้ตามลำดับการสมัคร
            </p>
            <a
              href="/"
              className={`mt-5 inline-flex min-h-11 items-center rounded-full border px-5 text-base font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS_RING}`}
              style={{ color: INK, borderColor: BORDER_INPUT }}
            >
              ดูรายละเอียดค่าย
            </a>
          </div>
        )}

        {state === 'ready' && rows.length > 0 && filtered.length === 0 && (
          <div className="ap-state">
            <p className="text-xl font-bold leading-8" style={{ color: INK }}>
              ไม่พบรายชื่อที่ตรงกับการค้นหา
            </p>
            <p className="mt-2 max-w-[56ch] text-base leading-7" style={{ color: INK_MUTED }}>
              ลองตรวจสอบการสะกด ใช้คำที่สั้นลง หรือล้างตัวกรองจังหวัดและสถานะ
            </p>
            <button
              type="button"
              onClick={clearFilters}
              className={`mt-5 inline-flex min-h-11 items-center gap-2 rounded-full border px-5 text-base font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS_RING}`}
              style={{ color: INK, borderColor: BORDER_INPUT }}
            >
              <X aria-hidden="true" size={16} strokeWidth={1.5} />
              ล้างตัวกรอง
            </button>
          </div>
        )}

        {state === 'ready' && filtered.length > 0 && (
          <>
            {/* Phones and tablets: stacked rows, no horizontal scroll. */}
            <ol className="ap-list lg:hidden" aria-label="รายชื่อผู้สมัคร">
              {filtered.map((r) => (
                <li key={r.no} className="ap-row">
                  <span className="ap-row__no text-sm" style={{ color: INK_MUTED }}>
                    <span className="sr-only">ลำดับที่ </span>
                    <OrderNo no={r.no} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-base font-semibold leading-7" style={{ color: INK }}>
                      {r.fullName}
                      {r.nickname && (
                        <span className="font-normal" style={{ color: INK_MUTED }}>
                          {' '}({r.nickname})
                        </span>
                      )}
                    </p>
                    <p className="text-sm leading-6" style={{ color: INK_MUTED }}>
                      {r.school}
                      {r.province && <> · {r.province}</>}
                    </p>
                    <div className="mt-2">
                      <StatusPill status={r.status} />
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            {/* Desktop: a real table with column headers. */}
            <div className="hidden lg:block">
              <table className="ap-table w-full text-left">
                <caption className="sr-only">รายชื่อผู้สมัครค่าย ComCamp #25 เรียงตามลำดับการสมัคร</caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-20">ลำดับ</th>
                    <th scope="col">ชื่อ–นามสกุล</th>
                    <th scope="col">ชื่อเล่น</th>
                    <th scope="col">โรงเรียน</th>
                    <th scope="col">จังหวัด</th>
                    <th scope="col" className="w-44">สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.no}>
                      <td style={{ color: INK_MUTED }}>
                        <OrderNo no={r.no} />
                      </td>
                      <td className="font-semibold" style={{ color: INK }}>{r.fullName}</td>
                      <td style={{ color: INK }}>{r.nickname}</td>
                      <td style={{ color: INK }}>{r.school}</td>
                      <td style={{ color: INK }}>{r.province}</td>
                      <td>
                        <StatusPill status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── Privacy note ── */}
      <aside className="ap-note mt-10" aria-label="เกี่ยวกับข้อมูลในหน้านี้">
        <p className="flex items-start gap-2.5 text-sm leading-7" style={{ color: INK_MUTED }}>
          <Info aria-hidden="true" size={18} strokeWidth={1.5} className="mt-1 shrink-0" style={{ color: 'var(--color-tech)' }} />
          <span>
            หน้านี้แสดงเฉพาะชื่อ–นามสกุล ชื่อเล่น โรงเรียน และจังหวัด ตามที่ผู้สมัครยินยอมไว้ตอนสมัคร
            สถานะ “รอชำระเงิน” คือได้ที่นั่งแล้ว อยู่ระหว่างโอนเงินหรือรอทีมงานตรวจสลิป ส่วน “ยืนยันสิทธิ์แล้ว”
            คือทีมงานยืนยันการชำระเงินเรียบร้อย หากข้อมูลไม่ถูกต้องหรือมีข้อสงสัยเกี่ยวกับการแสดงรายชื่อ ติดต่อพี่ค่าย{' '}
            {STAFF_CONTACTS.map((c, i) => (
              <span key={c.tel}>
                {i > 0 && ' หรือ '}
                <a
                  href={`tel:${c.tel}`}
                  className={`font-semibold underline underline-offset-4 ${FOCUS_RING}`}
                  style={{ color: INK }}
                >
                  <span className="font-mono tabular-nums">{c.phone}</span>
                </a>
              </span>
            ))}
          </span>
        </p>
      </aside>
    </div>
  );
}
