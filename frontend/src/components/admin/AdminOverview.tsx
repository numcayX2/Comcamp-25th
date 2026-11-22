/**
 * /admin overview view: KPI tiles plus Chart.js charts laid out as a bento grid (Aceternity "Bento
 * Grid"), all counted in the browser from the loaded applications. Chart.js is loaded with a dynamic
 * import so the admin island's first bundle stays small, and every chart keeps a readable list or
 * table of its numbers beside the canvas.
 */
import { ChevronDown } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import type * as ChartJsModule from 'chart.js';
import type { Chart, ChartConfiguration, ChartType } from 'chart.js';
import type { Application, ApplicationStatus } from '../../lib/api';
import { STATUS_LABELS, summarizeReferrals } from '../../lib/applicant-tools';
import { dailyApplications, seatBreakdown, topCounts, type CountRow } from '../../lib/admin-stats';
import {
  AMBER_TEXT,
  BG_CARD,
  BTN_DARK,
  BTN_DARK_TEXT,
  DANGER,
  INK,
  INK_2,
  INK_3,
  PILL_GHOST,
  RULE,
  SUCCESS,
  SURFACE_SUBTLE,
  TECH,
  WARNING,
} from '../admin-ui';
import { HoverGroup, HoverItem } from './ui/HoverHighlight';
import { SIZE_SPRING, isFinePointer, useMediaQuery } from './ui/motion';

export interface AdminOverviewProps {
  apps: Application[];
  withdrawnCount: number;
  maxCapacity: number | null;
  campFee: number | null;
  pendingSlipCount: number;
  awaitingPayCount: number;
  overduePayCount: number;
  loading: boolean;
  onOpenQueue: (filter: 'SLIP_PENDING' | 'AWAITING_PAY' | 'ALL') => void;
}

/* ── Shared look ──────────────────────────────────────────────────────── */

const PANEL_CLASS = 'rounded-[24px] min-w-0';
const PANEL_STYLE = {
  background: BG_CARD,
  boxShadow: 'var(--shadow-card)',
  padding: 'clamp(20px, 2.4vw, 28px)',
} as const;

const FONT_THAI = "'IBM Plex Sans Thai', system-ui, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, monospace";

const NUM = new Intl.NumberFormat('th-TH');
const DAY_LABEL = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });

function fmt(n: number): string {
  return NUM.format(n);
}

/** 'YYYY-MM-DD' (Bangkok day) → '19 พ.ย.'. Noon +07 keeps the day stable in any viewer time zone. */
function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00+07:00`);
  return Number.isNaN(d.getTime()) ? date : DAY_LABEL.format(d);
}

/* ── Runtime palette (CSS vars) ───────────────────────────────────────── */

interface Palette {
  tech: string;
  success: string;
  warning: string;
  danger: string;
  inkSubtle: string;
  ink: string;
  inkMuted: string;
  border: string;
  card: string;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    tech: v('--color-tech'),
    success: v('--color-success'),
    warning: v('--color-warning'),
    danger: v('--color-danger'),
    inkSubtle: v('--color-ink-subtle'),
    ink: v('--color-ink'),
    inkMuted: v('--color-ink-muted'),
    border: v('--color-border'),
    card: v('--bg-card'),
  };
}

/** Palette from the live theme; re-read whenever <html> switches class / data-theme. Null before mount. */
function usePalette(): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(null);
  useEffect(() => {
    setPalette(readPalette());
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  return palette;
}

const CHART_ANIMATION = { duration: 420, easing: 'easeOutQuart' as const };

/* ── Chart.js loader + canvas ─────────────────────────────────────────── */

type AnyChartConfig = ChartConfiguration<ChartType, number[], string>;
type AnyChart = Chart<ChartType, number[], string>;

let chartModule: Promise<typeof ChartJsModule> | null = null;

function loadChartJs(): Promise<typeof ChartJsModule> {
  if (!chartModule) {
    chartModule = import('chart.js').then((m) => {
      m.Chart.register(
        m.BarController,
        m.BarElement,
        m.LineController,
        m.LineElement,
        m.PointElement,
        m.DoughnutController,
        m.ArcElement,
        m.CategoryScale,
        m.LinearScale,
        m.Tooltip,
        m.Legend,
        m.Filler,
      );
      return m;
    });
    chartModule.catch(() => {
      chartModule = null;
    });
  }
  return chartModule;
}

/** One chart on a fixed-height wrapper: creates on mount, updates in place on config change, destroys on unmount. */
function ChartCanvas({ config, label, height }: { config: AnyChartConfig; label: string; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<AnyChart | null>(null);
  const configRef = useRef(config);

  useEffect(() => {
    configRef.current = config;
    const chart = chartRef.current;
    if (!chart) return;
    chart.data = config.data;
    chart.options = config.options ?? {};
    chart.update();
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    loadChartJs()
      .then(({ Chart: ChartJs }) => {
        if (cancelled || !canvasRef.current) return;
        chartRef.current = new ChartJs(canvasRef.current, configRef.current) as AnyChart;
      })
      .catch(() => {
        // Chunk failed to load: the visible numbers below each chart still carry the data.
      });
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  return (
    <div className="relative w-full" style={{ height }}>
      <canvas ref={canvasRef} role="img" aria-label={label}>
        {label}
      </canvas>
    </div>
  );
}

/* ── Chart configs ────────────────────────────────────────────────────── */

interface ChartEnv {
  palette: Palette;
  reducedMotion: boolean;
}

function tooltip(p: Palette) {
  return {
    backgroundColor: p.ink,
    titleColor: p.card,
    bodyColor: p.card,
    titleFont: { family: FONT_THAI, size: 13, weight: 600 },
    bodyFont: { family: FONT_THAI, size: 13 },
    padding: 10,
    cornerRadius: 12,
    displayColors: true,
  } as const;
}

function valueAxis(p: Palette, opts: { stacked?: boolean; max?: number; display?: boolean } = {}) {
  return {
    type: 'linear' as const,
    beginAtZero: true,
    stacked: opts.stacked,
    max: opts.max,
    display: opts.display ?? true,
    grid: { color: p.border },
    border: { display: false },
    ticks: { color: p.inkMuted, precision: 0, font: { family: FONT_MONO, size: 11 } },
  };
}

function categoryAxis(p: Palette, opts: { stacked?: boolean; display?: boolean } = {}) {
  return {
    type: 'category' as const,
    stacked: opts.stacked,
    display: opts.display ?? true,
    grid: { display: false },
    border: { color: p.border },
    ticks: { color: p.inkMuted, font: { family: FONT_THAI, size: 12 }, autoSkip: true, maxRotation: 0 },
  };
}

function hBarConfig(env: ChartEnv, rows: CountRow[], color: string, seriesLabel: string): AnyChartConfig {
  const p = env.palette;
  return {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [
        {
          type: 'bar',
          label: seriesLabel,
          data: rows.map((r) => r.count),
          backgroundColor: color,
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: env.reducedMotion ? false : CHART_ANIMATION,
      plugins: { legend: { display: false }, tooltip: tooltip(p) },
      scales: {
        x: valueAxis(p),
        y: { ...categoryAxis(p), ticks: { color: p.inkMuted, font: { family: FONT_THAI, size: 12 }, autoSkip: false } },
      },
    },
  };
}

/* ── Small presentational pieces ──────────────────────────────────────── */

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

interface LegendRow {
  label: string;
  count: number;
  color: string;
}

/** Always-visible legend with exact counts (the canvas is decorative for readers who cannot see it). */
function LegendList({ rows }: { rows: LegendRow[] }) {
  return (
    <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-sm" style={{ color: INK_2 }}>
      {rows.map((r) => (
        <li key={r.label} className="flex min-w-0 items-center gap-2 leading-[1.7]">
          <Swatch color={r.color} />
          <span>{r.label}</span>
          <span className="font-mono tabular-nums" style={{ color: INK }}>
            {fmt(r.count)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Collapsible 'ดูตัวเลข' table of a chart's exact numbers. */
function NumbersTable({ headers, rows }: { headers: [string, ...string[]]; rows: (string | number)[][] }) {
  return (
    <details className="group mt-4 border-t pt-3" style={{ borderColor: RULE }}>
      <summary
        className={`${PILL_GHOST} cursor-pointer list-none gap-1.5 [&::-webkit-details-marker]:hidden`}
        style={{ borderColor: RULE, color: INK_2 }}
      >
        ดูตัวเลข
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.5}
          className="h-4 w-4 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full border-collapse text-sm" style={{ color: INK_2 }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th
                  key={h}
                  scope="col"
                  className={`border-b py-1.5 font-semibold ${i === 0 ? 'text-left' : 'text-right'}`}
                  style={{ borderColor: RULE, color: INK }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) =>
                  ci === 0 ? (
                    <th key={ci} scope="row" className="border-b py-1.5 text-left font-normal" style={{ borderColor: RULE }}>
                      {cell}
                    </th>
                  ) : (
                    <td
                      key={ci}
                      className="border-b py-1.5 text-right font-mono tabular-nums"
                      style={{ borderColor: RULE, color: INK }}
                    >
                      {typeof cell === 'number' ? fmt(cell) : cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ChartPanel({
  title,
  caption,
  className = '',
  children,
}: {
  title: string;
  caption?: ReactNode;
  /** Bento spans (e.g. 'md:col-span-2 lg:col-span-4'). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={`${PANEL_CLASS} m-0 flex flex-col ${className}`} style={PANEL_STYLE}>
      <figcaption className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-base font-semibold leading-[1.3]" style={{ color: INK }}>
          {title}
        </span>
        {caption ? (
          <span className="text-sm leading-[1.7]" style={{ color: INK_3 }}>
            {caption}
          </span>
        ) : null}
      </figcaption>
      {children}
    </figure>
  );
}

/** Fixed-height placeholder while Chart.js / the palette load, so the canvas swap does not shift layout. */
function PlotPlaceholder({ height }: { height: number }) {
  return <div aria-hidden="true" className="w-full rounded-xl" style={{ height, background: SURFACE_SUBTLE }} />;
}

/** Lift on hover for tiles that carry an action (Aceternity bento hover), mouse/pen only. */
const LIFT_REST = { y: 0 } as const;
const LIFT_HOVER = { y: -2 } as const;

function Kpi({
  label,
  value,
  sub,
  action,
  primary = false,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** A tile with an action lifts slightly on hover; tiles without one stay still. */
  action?: ReactNode;
  /** Larger number; used for the one tile that needs staff attention. */
  primary?: boolean;
  /** Amber dot beside the label (decorative; the sub text carries the meaning). */
  accent?: boolean;
}) {
  const [lifted, setLifted] = useState(false);
  const body = (
    <>
      <span className="flex items-center gap-2 text-sm leading-[1.6]" style={{ color: INK_2 }}>
        {accent ? (
          <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full" style={{ background: WARNING }} />
        ) : null}
        {label}
      </span>
      <span
        className={`font-mono font-semibold leading-[1.22] tabular-nums ${primary ? 'text-5xl lg:text-6xl' : 'text-3xl'}`}
        style={{ color: INK }}
      >
        {value}
      </span>
      {sub ? <span className="text-sm leading-[1.6]">{sub}</span> : null}
      {action ? <div className="mt-auto pt-3">{action}</div> : null}
    </>
  );
  if (!action) {
    return (
      <div className={`${PANEL_CLASS} flex h-full flex-col gap-1`} style={PANEL_STYLE}>
        {body}
      </div>
    );
  }
  return (
    <motion.div
      initial={false}
      animate={lifted ? LIFT_HOVER : LIFT_REST}
      transition={SIZE_SPRING}
      onPointerEnter={(e) => isFinePointer(e) && setLifted(true)}
      onPointerLeave={() => setLifted(false)}
      onPointerCancel={() => setLifted(false)}
      className={`${PANEL_CLASS} flex h-full flex-col gap-1 transition-shadow duration-200 motion-reduce:transition-none`}
      style={{
        background: BG_CARD,
        padding: PANEL_STYLE.padding,
        boxShadow: lifted ? 'var(--shadow-float)' : 'var(--shadow-card)',
      }}
    >
      {body}
    </motion.div>
  );
}

/* ── Status ordering / colors ─────────────────────────────────────────── */

const STATUS_ORDER: ApplicationStatus[] = [
  'CONFIRMED',
  'PASSED',
  'PENDING',
  'RESERVE',
  'FORFEITED',
  'REJECTED',
  'REFUND_PENDING',
  'REFUNDED',
];

const STATUS_CSS: Record<ApplicationStatus, string> = {
  PASSED: TECH,
  CONFIRMED: SUCCESS,
  REJECTED: DANGER,
  FORFEITED: WARNING,
  REFUND_PENDING: INK_3,
  REFUNDED: INK_3,
  PENDING: INK_2,
  RESERVE: INK_2,
};

function statusColor(p: Palette, s: ApplicationStatus): string {
  switch (s) {
    case 'PASSED':
      return p.tech;
    case 'CONFIRMED':
      return p.success;
    case 'REJECTED':
      return p.danger;
    case 'FORFEITED':
      return p.warning;
    case 'REFUND_PENDING':
    case 'REFUNDED':
      return p.inkSubtle;
    default:
      return p.inkMuted;
  }
}

/* ── Skeleton ─────────────────────────────────────────────────────────── */

function SkeletonBlock({ height, className = '' }: { height: number; className?: string }) {
  return (
    <div className={`${PANEL_CLASS} ${className}`} style={PANEL_STYLE}>
      <div className="w-full rounded-xl motion-safe:animate-pulse" style={{ height, background: SURFACE_SUBTLE }} />
    </div>
  );
}

/** Bento spans shared by the live grid and its skeleton, so loading does not reflow the layout. */
const KPI_GRID = 'grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4';
const SPAN_PRIMARY = 'sm:col-span-2 lg:row-span-2';
const SPAN_PAIR = 'sm:col-span-2';
const CHART_GRID = 'grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-12';
const SPAN_FULL = 'md:col-span-2 lg:col-span-12';
const SPAN_DAILY = 'md:col-span-2 lg:col-span-8';
const SPAN_THIRD = 'lg:col-span-4';

function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="กำลังโหลดข้อมูลภาพรวม" className="flex flex-col gap-5">
      <div className={KPI_GRID}>
        <SkeletonBlock height={92} className={SPAN_PRIMARY} />
        <SkeletonBlock height={92} />
        <SkeletonBlock height={92} />
        <SkeletonBlock height={92} className={SPAN_PAIR} />
      </div>
      <div className={CHART_GRID}>
        <SkeletonBlock height={150} className={SPAN_FULL} />
        <SkeletonBlock height={300} className={SPAN_DAILY} />
        <SkeletonBlock height={300} className={SPAN_THIRD} />
        <SkeletonBlock height={300} className={SPAN_THIRD} />
        <SkeletonBlock height={300} className={SPAN_THIRD} />
        <SkeletonBlock height={300} className={SPAN_THIRD} />
      </div>
    </div>
  );
}

/* ── Main view ────────────────────────────────────────────────────────── */

const SEATS_H = 96;
const DAILY_H = 280;
const DOUGHNUT_H = 240;

function barsHeight(rows: number): number {
  return Math.max(160, rows * 30 + 32);
}

export function AdminOverview(props: AdminOverviewProps): JSX.Element {
  const {
    apps,
    withdrawnCount,
    maxCapacity,
    campFee,
    pendingSlipCount,
    awaitingPayCount,
    overduePayCount,
    loading,
    onOpenQueue,
  } = props;

  const palette = usePalette();
  // A live media query (motion's useReducedMotion reads the setting once), so charts stop animating
  // as soon as Reduce Motion is switched on while /admin is open.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const seats = useMemo(() => seatBreakdown(apps, maxCapacity), [apps, maxCapacity]);
  const daily = useMemo(() => dailyApplications(apps, Date.now()), [apps]);
  const referrals = useMemo(() => summarizeReferrals(apps), [apps]);
  const provinces = useMemo(() => topCounts(apps.map((a) => a.province), 10), [apps]);
  const grades = useMemo(() => topCounts(apps.map((a) => a.grade), 8), [apps]);
  const statusRows = useMemo(() => {
    const counts = new Map<ApplicationStatus, number>();
    for (const a of apps) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    return STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({ status: s, count: counts.get(s) ?? 0 }));
  }, [apps]);
  const referralRows = useMemo<CountRow[]>(
    () => referrals.groups.map((g) => ({ label: g.label, count: g.count })),
    [referrals],
  );

  const env = useMemo<ChartEnv | null>(() => (palette ? { palette, reducedMotion } : null), [palette, reducedMotion]);

  const seatsConfig = useMemo<AnyChartConfig | null>(() => {
    if (!env || seats.capacity == null) return null;
    const p = env.palette;
    const parts: { label: string; value: number; color: string }[] = [
      { label: 'ยืนยันสิทธิ์แล้ว', value: seats.confirmed, color: p.success },
      { label: 'รอชำระ/รอตรวจ', value: seats.awaiting, color: p.warning },
      { label: 'ว่าง', value: seats.free, color: p.border },
      { label: 'เกินโควตา', value: seats.over, color: p.danger },
    ];
    return {
      type: 'bar',
      data: {
        labels: ['ที่นั่ง'],
        datasets: parts
          .filter((x) => x.value > 0 || x.label !== 'เกินโควตา')
          .map((x) => ({
            type: 'bar' as const,
            label: x.label,
            data: [x.value],
            backgroundColor: x.color,
            borderColor: p.card,
            borderWidth: 2,
            borderSkipped: false,
            borderRadius: 6,
            barThickness: 28,
          })),
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: env.reducedMotion ? false : CHART_ANIMATION,
        plugins: { legend: { display: false }, tooltip: tooltip(p) },
        scales: {
          x: valueAxis(p, { stacked: true, max: Math.max(seats.capacity, seats.held) }),
          y: categoryAxis(p, { stacked: true, display: false }),
        },
      },
    };
  }, [env, seats]);

  const dailyConfig = useMemo<AnyChartConfig | null>(() => {
    if (!env || daily.length === 0) return null;
    const p = env.palette;
    return {
      type: 'bar',
      data: {
        labels: daily.map((d) => dayLabel(d.date)),
        datasets: [
          {
            type: 'bar',
            label: 'สมัครในวันนั้น',
            data: daily.map((d) => d.count),
            backgroundColor: p.tech,
            borderRadius: 6,
            borderSkipped: false,
            maxBarThickness: 28,
            yAxisID: 'y',
            order: 2,
          },
          {
            type: 'line',
            label: 'สะสม',
            data: daily.map((d) => d.cumulative),
            borderColor: p.inkMuted,
            backgroundColor: p.inkMuted,
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 4,
            tension: 0.25,
            fill: false,
            yAxisID: 'y1',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: env.reducedMotion ? false : CHART_ANIMATION,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: tooltip(p) },
        scales: {
          x: categoryAxis(p),
          y: { ...valueAxis(p), position: 'left' },
          y1: { ...valueAxis(p), position: 'right', grid: { display: false } },
        },
      },
    };
  }, [env, daily]);

  const statusConfig = useMemo<AnyChartConfig | null>(() => {
    if (!env || statusRows.length === 0) return null;
    const p = env.palette;
    return {
      type: 'doughnut',
      data: {
        labels: statusRows.map((r) => STATUS_LABELS[r.status]),
        datasets: [
          {
            type: 'doughnut',
            label: 'สถานะ',
            data: statusRows.map((r) => r.count),
            backgroundColor: statusRows.map((r) => statusColor(p, r.status)),
            borderColor: p.card,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: env.reducedMotion ? false : CHART_ANIMATION,
        cutout: '64%',
        plugins: { legend: { display: false }, tooltip: tooltip(p) },
      },
    };
  }, [env, statusRows]);

  const referralConfig = useMemo(
    () => (env ? hBarConfig(env, referralRows, env.palette.tech, 'จำนวนคน') : null),
    [env, referralRows],
  );
  const provinceConfig = useMemo(
    () => (env ? hBarConfig(env, provinces, env.palette.tech, 'จำนวนคน') : null),
    [env, provinces],
  );
  const gradeConfig = useMemo(() => (env ? hBarConfig(env, grades, env.palette.tech, 'จำนวนคน') : null), [env, grades]);

  const heading = (
    <header className="flex flex-col gap-1">
      <h2
        tabIndex={-1}
        data-view-heading
        className="text-2xl font-semibold leading-[1.25] outline-none"
        style={{ color: INK }}
      >
        ภาพรวม
      </h2>
      <p className="text-sm leading-[1.75]" style={{ color: INK_2 }}>
        ข้อมูลสด นับจากใบสมัครที่โหลดอยู่ในหน้านี้
      </p>
    </header>
  );

  if (loading) {
    return (
      <section className="flex flex-col gap-6">
        {heading}
        <OverviewSkeleton />
      </section>
    );
  }

  const confirmedCount = seats.confirmed;
  const totalApps = apps.length;
  const peakDay = daily.reduce<{ date: string; count: number } | null>(
    (best, d) => (d.count > (best?.count ?? 0) ? { date: d.date, count: d.count } : best),
    null,
  );

  const seatLegend: LegendRow[] = [
    { label: 'ยืนยันสิทธิ์แล้ว', count: seats.confirmed, color: SUCCESS },
    { label: 'รอชำระ/รอตรวจ', count: seats.awaiting, color: WARNING },
    { label: 'ว่าง', count: seats.free, color: RULE },
    ...(seats.over > 0 ? [{ label: 'เกินโควตา', count: seats.over, color: DANGER }] : []),
  ];

  const seatsAria =
    seats.capacity == null
      ? ''
      : `ที่นั่ง ${seats.held} จาก ${seats.capacity}: ยืนยันสิทธิ์แล้ว ${seats.confirmed}, รอชำระหรือรอตรวจ ${seats.awaiting}, ว่าง ${seats.free}${
          seats.over > 0 ? `, เกินโควตา ${seats.over}` : ''
        }`;

  const rowsAria = (prefix: string, rows: CountRow[]) =>
    `${prefix}: ${rows.map((r) => `${r.label} ${r.count}`).join(', ')}`;

  return (
    <section className="flex flex-col gap-6">
      {heading}

      {/* KPI tiles: bento cells; Aceternity "Hover Effect" plate slides between them */}
      <HoverGroup className={KPI_GRID}>
        <HoverItem k="slips" className={`min-w-0 ${SPAN_PRIMARY}`}>
        <Kpi
          primary
          label="สลิปรอตรวจ"
          accent={pendingSlipCount > 0}
          value={fmt(pendingSlipCount)}
          sub={
            pendingSlipCount > 0 ? (
              <span style={{ color: AMBER_TEXT }}>รอเจ้าหน้าที่ตรวจสอบ</span>
            ) : (
              <span style={{ color: INK_3 }}>ไม่มีสลิปรอตรวจ</span>
            )
          }
          action={
            <button
              type="button"
              className={`${PILL_GHOST} w-full transition-[background-color,opacity,transform] duration-150 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 sm:w-fit sm:px-6`}
              style={
                pendingSlipCount > 0
                  ? { background: BTN_DARK, borderColor: BTN_DARK, color: BTN_DARK_TEXT }
                  : { borderColor: RULE, color: INK }
              }
              onClick={() => onOpenQueue('SLIP_PENDING')}
            >
              ตรวจสลิป
            </button>
          }
        />
        </HoverItem>
        <HoverItem k="seats" className="min-w-0">
        <Kpi
          label="ที่นั่งที่ใช้"
          value={
            <>
              {fmt(seats.held)}
              <span style={{ color: INK_3 }}>/{seats.capacity == null ? '—' : fmt(seats.capacity)}</span>
            </>
          }
          sub={
            <>
              {seats.over > 0 ? (
                <span className="block" style={{ color: DANGER }}>
                  เกินโควตา <span className="font-mono tabular-nums">{fmt(seats.over)}</span>
                </span>
              ) : seats.capacity == null ? (
                <span className="block" style={{ color: INK_3 }}>
                  กำลังโหลดโควตา…
                </span>
              ) : (
                <span className="block" style={{ color: INK_3 }}>
                  ว่าง <span className="font-mono tabular-nums">{fmt(seats.free)}</span>
                </span>
              )}
              {withdrawnCount > 0 ? (
                <span className="block" style={{ color: INK_3 }}>
                  ยกเลิกเอง <span className="font-mono tabular-nums">{fmt(withdrawnCount)}</span>
                </span>
              ) : null}
            </>
          }
        />
        </HoverItem>
        <HoverItem k="confirmed" className="min-w-0">
        <Kpi
          label="ยืนยันสิทธิ์แล้ว"
          value={fmt(confirmedCount)}
          sub={
            campFee != null && confirmedCount > 0 ? (
              <span style={{ color: INK_3 }}>
                ค่าสมัครรวม <span className="font-mono tabular-nums">{fmt(confirmedCount * campFee)}</span> บาท
              </span>
            ) : (
              <span style={{ color: INK_3 }}>ยังไม่มีผู้ยืนยันสิทธิ์</span>
            )
          }
        />
        </HoverItem>
        <HoverItem k="awaiting" className={`min-w-0 ${SPAN_PAIR}`}>
        <Kpi
          label="รอโอน/ส่งสลิป"
          value={fmt(awaitingPayCount)}
          sub={
            overduePayCount > 0 ? (
              <span style={{ color: AMBER_TEXT }}>
                เกินกำหนด <span className="font-mono tabular-nums">{fmt(overduePayCount)}</span>
              </span>
            ) : (
              <span style={{ color: INK_3 }}>ไม่มีรายการเกินกำหนด</span>
            )
          }
          action={
            <button
              type="button"
              className={`${PILL_GHOST} w-full transition-[background-color,transform] duration-150 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 sm:w-fit sm:px-6`}
              style={{ borderColor: RULE, color: INK }}
              onClick={() => onOpenQueue('AWAITING_PAY')}
            >
              ดูรายชื่อ
            </button>
          }
        />
        </HoverItem>
      </HoverGroup>

      <div className={CHART_GRID}>
        {/* Seats */}
        <ChartPanel
          title="ที่นั่ง"
          className={SPAN_FULL}
          caption={
            seats.capacity == null ? undefined : (
              <>
                ใช้แล้ว <span className="font-mono tabular-nums">{fmt(seats.held)}</span> จากโควตา{' '}
                <span className="font-mono tabular-nums">{fmt(seats.capacity)}</span>
              </>
            )
          }
        >
          {seats.capacity == null ? (
            <p className="flex items-center text-sm leading-[1.75]" style={{ color: INK_3, minHeight: SEATS_H }}>
              กำลังโหลดโควตา…
            </p>
          ) : (
            <>
              {seatsConfig ? (
                <ChartCanvas config={seatsConfig} label={seatsAria} height={SEATS_H} />
              ) : (
                <PlotPlaceholder height={SEATS_H} />
              )}
              <LegendList rows={seatLegend} />
            </>
          )}
        </ChartPanel>

        {totalApps === 0 ? (
          <div className={`${PANEL_CLASS} ${SPAN_FULL}`} style={PANEL_STYLE}>
            <p className="py-10 text-center text-base leading-[1.75]" style={{ color: INK_2 }}>
              ยังไม่มีใบสมัคร
            </p>
          </div>
        ) : (
          <>
            {/* Daily applications */}
            <ChartPanel
              title="ใบสมัครรายวัน"
              className={SPAN_DAILY}
              caption={
                <>
                  รวม <span className="font-mono tabular-nums">{fmt(totalApps)}</span> ใบ
                  {peakDay ? (
                    <>
                      {' '}
                      · สูงสุด {dayLabel(peakDay.date)}{' '}
                      <span className="font-mono tabular-nums">{fmt(peakDay.count)}</span> ใบ
                    </>
                  ) : null}
                </>
              }
            >
              {dailyConfig ? (
                <ChartCanvas
                  config={dailyConfig}
                  height={DAILY_H}
                  label={`ใบสมัครรายวัน ${daily.length} วัน รวม ${totalApps} ใบ${
                    peakDay ? ` สูงสุด ${dayLabel(peakDay.date)} ${peakDay.count} ใบ` : ''
                  }`}
                />
              ) : (
                <PlotPlaceholder height={DAILY_H} />
              )}
              <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-sm" style={{ color: INK_2 }}>
                <li className="flex items-center gap-2">
                  <Swatch color={TECH} />
                  สมัครในวันนั้น
                </li>
                <li className="flex items-center gap-2">
                  <Swatch color={INK_2} />
                  สะสม
                </li>
              </ul>
              <NumbersTable
                headers={['วันที่', 'สมัคร', 'สะสม']}
                rows={daily.map((d) => [dayLabel(d.date), d.count, d.cumulative])}
              />
            </ChartPanel>

            {/* Status */}
            <ChartPanel
              className={SPAN_THIRD}
              title="สถานะใบสมัคร"
              caption={
                <>
                  ทั้งหมด <span className="font-mono tabular-nums">{fmt(totalApps)}</span> ใบ
                </>
              }
            >
              {statusConfig ? (
                <ChartCanvas
                  config={statusConfig}
                  height={DOUGHNUT_H}
                  label={`สถานะใบสมัคร: ${statusRows.map((r) => `${STATUS_LABELS[r.status]} ${r.count}`).join(', ')}`}
                />
              ) : (
                <PlotPlaceholder height={DOUGHNUT_H} />
              )}
              <LegendList
                rows={statusRows.map((r) => ({
                  label: STATUS_LABELS[r.status],
                  count: r.count,
                  color: STATUS_CSS[r.status],
                }))}
              />
            </ChartPanel>

            {/* Province top 10 */}
            <ChartPanel title="จังหวัด" caption="10 อันดับแรก" className={SPAN_THIRD}>
              {provinceConfig ? (
                <ChartCanvas
                  config={provinceConfig}
                  height={barsHeight(provinces.length)}
                  label={rowsAria('จังหวัดของผู้สมัคร', provinces)}
                />
              ) : (
                <PlotPlaceholder height={barsHeight(provinces.length)} />
              )}
              <NumbersTable headers={['จังหวัด', 'คน']} rows={provinces.map((r) => [r.label, r.count])} />
            </ChartPanel>

            {/* Referral channels */}
            <ChartPanel
              className={SPAN_THIRD}
              title="ช่องทางที่รู้จักค่าย"
              caption={
                <>
                  ตอบแล้ว{' '}
                  <span className="font-mono tabular-nums">
                    {fmt(referrals.answered)}/{fmt(referrals.total)}
                  </span>
                </>
              }
            >
              {referralConfig ? (
                <ChartCanvas
                  config={referralConfig}
                  height={barsHeight(referralRows.length)}
                  label={rowsAria(`ช่องทางที่รู้จักค่าย ตอบแล้ว ${referrals.answered} จาก ${referrals.total}`, referralRows)}
                />
              ) : (
                <PlotPlaceholder height={barsHeight(referralRows.length)} />
              )}
              <NumbersTable headers={['ช่องทาง', 'คน']} rows={referralRows.map((r) => [r.label, r.count])} />
            </ChartPanel>

            {/* Grade */}
            <ChartPanel title="ระดับชั้น" className={SPAN_THIRD}>
              {gradeConfig ? (
                <ChartCanvas
                  config={gradeConfig}
                  height={barsHeight(grades.length)}
                  label={rowsAria('ระดับชั้นของผู้สมัคร', grades)}
                />
              ) : (
                <PlotPlaceholder height={barsHeight(grades.length)} />
              )}
              <NumbersTable headers={['ระดับชั้น', 'คน']} rows={grades.map((r) => [r.label, r.count])} />
            </ChartPanel>
          </>
        )}
      </div>
    </section>
  );
}
