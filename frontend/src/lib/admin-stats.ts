/**
 * Pure statistics helpers for the /admin overview and logistics panels.
 * No DOM access and no external dependencies.
 */
import { holdsSeat, type Application } from './api.ts';

const BANGKOK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' });
const TH_COLLATOR = new Intl.Collator('th');
const DAY_MS = 86_400_000;

function toBangkokDay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return BANGKOK_DAY.format(new Date(ms));
}

function utcDayStartMs(ymd: string): number {
  const parts = ymd.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt.getTime();
}

function formatUtcDay(ms: number): string {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface DailyPoint {
  /** YYYY-MM-DD in Asia/Bangkok. */
  date: string;
  count: number;
  cumulative: number;
}

/**
 * Contiguous days from the first createdAt (Bangkok) to max(today Bangkok, last createdAt),
 * zero-filled. Returns [] when there are no valid applications. Invalid dates are skipped.
 */
export function dailyApplications(apps: readonly Application[], nowMs: number): DailyPoint[] {
  const counts = new Map<string, number>();
  let firstDay: string | null = null;
  let lastDay: string | null = null;

  for (const app of apps) {
    if (typeof app.createdAt !== 'string' || app.createdAt.trim() === '') continue;
    const ms = Date.parse(app.createdAt);
    const day = toBangkokDay(ms);
    if (day === null) continue;

    counts.set(day, (counts.get(day) ?? 0) + 1);
    if (firstDay === null || day < firstDay) firstDay = day;
    if (lastDay === null || day > lastDay) lastDay = day;
  }

  if (firstDay === null || lastDay === null) return [];

  const today = toBangkokDay(nowMs);
  const endDay = today !== null && today > lastDay ? today : lastDay;

  const startMs = utcDayStartMs(firstDay);
  const endMs = utcDayStartMs(endDay);
  const points: DailyPoint[] = [];
  let cumulative = 0;

  for (let cur = startMs; cur <= endMs; cur += DAY_MS) {
    const date = formatUtcDay(cur);
    const count = counts.get(date) ?? 0;
    cumulative += count;
    points.push({ date, count, cumulative });
  }

  return points;
}

export interface CountRow {
  label: string;
  count: number;
}

/**
 * Trimmed values; empty/nullish values map to `emptyLabel`. Sorted by count descending, then
 * label using Thai (`th`) collation. Rows beyond `limit` are merged into one `otherLabel` row
 * appended last (only if its count is > 0).
 */
export function topCounts(
  values: readonly (string | null | undefined)[],
  limit: number,
  otherLabel: string = 'อื่นๆ',
  emptyLabel: string = 'ไม่ระบุ',
): CountRow[] {
  if (values.length === 0) return [];

  const counts = new Map<string, number>();
  for (const raw of values) {
    const trimmed = (raw ?? '').trim();
    const label = trimmed.length > 0 ? trimmed : emptyLabel;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const rows: CountRow[] = Array.from(counts, ([label, count]) => ({ label, count }));
  rows.sort((a, b) => b.count - a.count || TH_COLLATOR.compare(a.label, b.label));

  const cap = Number.isNaN(limit) ? 0 : Math.max(0, Math.floor(limit));
  if (rows.length <= cap) return rows;

  const top = rows.slice(0, cap);
  let otherCount = 0;
  for (const row of rows.slice(cap)) {
    otherCount += row.count;
  }
  if (otherCount > 0) {
    top.push({ label: otherLabel, count: otherCount });
  }
  return top;
}

export interface SeatBreakdown {
  capacity: number | null;
  held: number;
  confirmed: number;
  awaiting: number;
  free: number;
  over: number;
}

/**
 * held = holdsSeat(status); confirmed = status CONFIRMED; awaiting = held - confirmed;
 * free = capacity == null ? 0 : max(0, capacity - held);
 * over = capacity == null ? 0 : max(0, held - capacity).
 */
export function seatBreakdown(
  apps: readonly Application[],
  maxCapacity: number | null,
): SeatBreakdown {
  let held = 0;
  let confirmed = 0;

  for (const app of apps) {
    if (holdsSeat(app.status)) held += 1;
    if (app.status === 'CONFIRMED') confirmed += 1;
  }

  const awaiting = held - confirmed;
  const free = maxCapacity == null ? 0 : Math.max(0, maxCapacity - held);
  const over = maxCapacity == null ? 0 : Math.max(0, held - maxCapacity);

  return {
    capacity: maxCapacity,
    held,
    confirmed,
    awaiting,
    free,
    over,
  };
}
