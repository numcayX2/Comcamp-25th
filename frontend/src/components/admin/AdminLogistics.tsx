import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ChevronDown, Copy } from 'lucide-react';
import { holdsSeat, type Application } from '../../lib/api';
import { summarizeShirtSizes } from '../../lib/applicant-tools';
import { SHIRT_SIZES } from '../register/model';
import { BG_CARD, FOCUS, INK, INK_2, INK_3, PILL_GHOST, RULE, TECH } from '../admin-ui';
import { HoverGroup, HoverItem } from './ui/HoverHighlight';

export interface AdminLogisticsProps {
  apps: Application[];
}

/** Raised panel (home-page "soft raised" look). Never nested: split inside with hairlines only. */
const PANEL = 'min-w-0 rounded-[24px] p-[clamp(20px,2.4vw,28px)]';
const PANEL_STYLE = { background: BG_CARD, boxShadow: 'var(--shadow-card)' } as const;
/** Green text token (the fill green is too light for text on light canvases). */
const FERN_TEXT = 'var(--color-fern-text)';

interface NoteEntry {
  id: string;
  fullName: string;
  nickname: string;
  confirmed: boolean;
  note: string;
}

/** Answers that mean "nothing to report"; compared after normalizeNote. */
const NON_ANSWERS: Record<string, true> = {
  'ไม่มี': true, 'ไม่': true, '-': true, '—': true, '–': true,
  none: true, no: true, 'n/a': true, na: true, nil: true,
  'ไม่มีโรค': true, 'ไม่มีโรคประจำตัว': true, 'ไม่แพ้': true, 'ไม่แพ้อะไร': true, 'ไม่แพ้อาหาร': true, 'ไม่มีอาการแพ้': true,
};
/** Trailing spaces/punctuation (dashes kept: "-" alone is a non-answer itself). */
const TRAILING_PUNCT = /[\s.,!?;:…~"'’”)]+$/u;
/** Trailing polite particles, longest first so "นะครับ" wins over "ครับ". */
const TRAILING_PARTICLE = /(?:นะครับ|นะคะ|ครับ|ค่ะ|คะ)$/u;

function normalizeNote(s: string): string {
  let v = s.trim().toLowerCase();
  for (;;) {
    const next = v.replace(TRAILING_PUNCT, '').replace(TRAILING_PARTICLE, '').trimEnd();
    if (next === v) return v;
    v = next;
  }
}

/** True when a free-text health note says something real (not blank, not "ไม่มี" / "-" / "none" and friends). */
export function isMeaningfulNote(s?: string): boolean {
  if (!s) return false;
  const v = normalizeNote(s);
  return v !== '' && NON_ANSWERS[v] !== true;
}

function seatHoldersWith(apps: readonly Application[], pick: (a: Application) => string | undefined): NoteEntry[] {
  return apps
    .filter((a) => holdsSeat(a.status))
    .map((a) => ({ a, note: (pick(a) ?? '').trim() }))
    .filter(({ note }) => isMeaningfulNote(note))
    .sort((x, y) => x.a.createdAt.localeCompare(y.a.createdAt) || x.a.id.localeCompare(y.a.id))
    .map(({ a, note }) => ({
      id: a.id,
      fullName: a.fullName,
      nickname: a.nickname ?? '',
      confirmed: a.status === 'CONFIRMED',
      note,
    }));
}

function displayName(fullName: string, nickname: string): string {
  return nickname ? `${fullName} (${nickname})` : fullName;
}

/** Plain-text list for pasting into chat/notes: one block per person, note lines indented. */
function toPlainText(title: string, entries: readonly NoteEntry[]): string {
  const lines = [`${title} (${entries.length} คน)`];
  entries.forEach((e, i) => {
    lines.push(`${i + 1}. ${displayName(e.fullName, e.nickname)} - ${e.id}`);
    for (const l of e.note.split(/\r?\n/)) {
      if (l.trim()) lines.push(`   ${l.trim()}`);
    }
  });
  return lines.join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const active = document.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  active?.focus();
  return ok;
}

function CopyButton({ title, entries }: { title: string; entries: readonly NoteEntry[] }): JSX.Element {
  const [status, setStatus] = useState('');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onCopy = async () => {
    const ok = await copyText(toPlainText(title, entries));
    setStatus(ok ? 'คัดลอกแล้ว' : 'คัดลอกไม่สำเร็จ');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(''), 2000);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => void onCopy()}
        disabled={entries.length === 0}
        className={`${PILL_GHOST} gap-2`}
        style={{ borderColor: RULE, color: INK }}
      >
        <Copy aria-hidden="true" size={16} strokeWidth={1.5} />
        คัดลอกรายการ
      </button>
      <span role="status" className="text-xs leading-6" style={{ color: INK_2 }}>
        {status}
      </span>
    </div>
  );
}

function NotePanel({
  title,
  headingId,
  entries,
  emptyText,
}: {
  title: string;
  headingId: string;
  entries: readonly NoteEntry[];
  emptyText: string;
}): JSX.Element {
  return (
    <section aria-labelledby={headingId} className={`${PANEL} h-full`} style={PANEL_STYLE}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-lg font-semibold leading-[1.3]" style={{ color: INK }}>
            {title}{' '}
            <span className="text-sm font-normal" style={{ color: INK_3 }}>
              <span className="font-mono tabular-nums">{entries.length}</span> คน
            </span>
          </h3>
          <p className="mt-1 text-xs leading-6" style={{ color: INK_3 }}>
            ไม่นับคำตอบ "ไม่มี"
          </p>
        </div>
        <CopyButton title={title} entries={entries} />
      </div>
      {entries.length === 0 ? (
        <p className="mt-4 border-t pt-4 text-sm leading-7" style={{ borderColor: RULE, color: INK_3 }}>
          {emptyText}
        </p>
      ) : (
        <ul className="mt-4 border-t" style={{ borderColor: RULE }}>
          {entries.map((e) => (
            <li key={e.id} className="border-b py-3 last:border-b-0" style={{ borderColor: RULE }}>
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm leading-6">
                <span className="break-words font-semibold" style={{ color: INK }}>
                  {displayName(e.fullName, e.nickname)}
                </span>
                <span className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                  {e.id}
                </span>
                <span className="text-xs" style={{ color: e.confirmed ? FERN_TEXT : INK_3 }}>
                  {e.confirmed ? 'ยืนยันแล้ว' : 'รอชำระ'}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-line break-words text-sm leading-7" style={{ color: INK_2 }}>
                {e.note}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdminLogistics({ apps }: AdminLogisticsProps): JSX.Element {
  const shirt = useMemo(() => summarizeShirtSizes(apps, SHIRT_SIZES), [apps]);
  const allergies = useMemo(() => seatHoldersWith(apps, (a) => a.allergies), [apps]);
  const medical = useMemo(() => seatHoldersWith(apps, (a) => a.medicalConditions), [apps]);

  return (
    <div className="min-w-0">
      <h2
        tabIndex={-1}
        data-view-heading
        className={`rounded-xl text-2xl font-semibold leading-[1.25] ${FOCUS}`}
        style={{ color: INK }}
      >
        เตรียมงานค่าย
      </h2>
      <p className="mt-2 text-sm leading-7" style={{ color: INK_2 }}>
        นับเฉพาะผู้ที่ถือที่นั่งอยู่ (ยืนยันสิทธิ์แล้ว และรอชำระเงิน) ไม่รวมผู้ที่หมดสิทธิ์ ไม่ผ่าน คืนเงิน หรือยกเลิก
      </p>
      <p className="mt-1 text-xs leading-6" style={{ color: INK_3 }}>
        ข้อมูลสุขภาพใช้เพื่อดูแลผู้เข้าค่ายเท่านั้น ห้ามส่งต่อ
      </p>

      {/* Aceternity "Hover Effect": one soft plate slides between the sibling cards. */}
      <HoverGroup className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── Shirt sizes ─────────────────────────────────────── */}
        <HoverItem k="shirt" className="min-w-0 lg:col-span-2">
        <section aria-labelledby="logistics-shirt" className={`${PANEL} h-full`} style={PANEL_STYLE}>
          <h3 id="logistics-shirt" className="text-lg font-semibold leading-[1.3]" style={{ color: INK }}>
            ไซส์เสื้อ{' '}
            <span className="text-sm font-normal" style={{ color: INK_3 }}>
              <span className="font-mono tabular-nums">{shirt.total}</span> ตัว
            </span>
          </h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <caption className="sr-only">จำนวนเสื้อแยกตามไซส์และสถานะ</caption>
              <thead>
                <tr className="border-b text-left text-xs" style={{ borderColor: RULE, color: INK_3 }}>
                  <th scope="col" className="py-2 pr-4 font-semibold">ไซส์</th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">ยืนยันแล้ว</th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">รอชำระ</th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">รวม</th>
                  <th scope="col" className="w-[40%] py-2 font-semibold">สัดส่วน</th>
                </tr>
              </thead>
              <tbody>
                {shirt.rows.map((r) => {
                  const pct = shirt.total > 0 ? Math.round((r.total / shirt.total) * 100) : 0;
                  const empty = r.total === 0;
                  const cell = (n: number, bold: boolean) =>
                    empty ? (
                      <>
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">0</span>
                      </>
                    ) : (
                      <span className={bold ? 'font-semibold' : undefined} style={{ color: n ? INK : INK_3 }}>{n}</span>
                    );
                  return (
                    <tr key={r.size} className="border-b" style={{ borderColor: RULE }}>
                      <th
                        scope="row"
                        className={`py-2 pr-4 text-left font-mono tabular-nums ${empty ? 'font-normal' : 'font-semibold'}`}
                        style={{ color: empty ? INK_3 : INK }}
                      >
                        {r.size}
                      </th>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums" style={{ color: INK_3 }}>
                        {cell(r.confirmed, false)}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums" style={{ color: INK_3 }}>
                        {cell(r.awaiting, false)}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums" style={{ color: INK_3 }}>
                        {cell(r.total, true)}
                      </td>
                      <td className="py-2">
                        {!empty && (
                          <div className="flex items-center gap-2">
                            <div
                              aria-hidden="true"
                              className="h-2 min-w-[3rem] flex-1 overflow-hidden rounded-full"
                              style={{ background: RULE }}
                            >
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: TECH }} />
                            </div>
                            <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                              {pct}%
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className="py-2 pr-4 text-left font-semibold" style={{ color: INK }}>
                    รวม
                  </th>
                  <td className="py-2 pr-4 text-right font-mono font-semibold tabular-nums" style={{ color: INK }}>
                    {shirt.confirmed}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono font-semibold tabular-nums" style={{ color: INK }}>
                    {shirt.awaiting}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono font-semibold tabular-nums" style={{ color: INK }}>
                    {shirt.total}
                  </td>
                  <td className="py-2" />
                </tr>
              </tfoot>
            </table>
          </div>

          {shirt.total > 0 && (
            <div className="mt-4 border-t pt-3" style={{ borderColor: RULE }}>
              <p className="text-xs font-semibold leading-6" style={{ color: INK_3 }}>
                รายชื่อตามไซส์
              </p>
              <ul className="mt-1">
                {shirt.rows
                  .filter((r) => r.total > 0)
                  .map((r) => (
                    <li key={r.size} className="border-t first:border-t-0" style={{ borderColor: RULE }}>
                      <details className="group/size">
                        <summary
                          className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl py-2 text-sm [&::-webkit-details-marker]:hidden ${FOCUS}`}
                          style={{ color: INK }}
                        >
                          <ChevronDown
                            aria-hidden="true"
                            size={14}
                            strokeWidth={1.5}
                            className="shrink-0 transition-transform group-open/size:rotate-180 motion-reduce:transition-none"
                          />
                          <span>
                            ไซส์ <span className="font-mono font-semibold tabular-nums">{r.size}</span>
                          </span>
                          <span className="text-xs" style={{ color: INK_3 }}>
                            <span className="font-mono tabular-nums">{r.total}</span> คน
                          </span>
                        </summary>
                        <ol className="mb-2 space-y-1 pl-6">
                          {r.people.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 text-sm leading-6" style={{ color: INK_2 }}>
                              <span className="break-words" style={{ color: INK }}>
                                {displayName(p.fullName, p.nickname)}
                              </span>
                              <span className="font-mono text-xs tabular-nums" style={{ color: INK_3 }}>
                                {p.id}
                              </span>
                              <span className="text-xs" style={{ color: p.confirmed ? FERN_TEXT : INK_3 }}>
                                {p.confirmed ? 'ยืนยันแล้ว' : 'รอชำระ'}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>
        </HoverItem>

        {/* ── Dietary restrictions / allergies ─────────────────── */}
        <HoverItem k="allergies" className="min-w-0">
          <NotePanel
            title="อาหารและการแพ้"
            headingId="logistics-allergies"
            entries={allergies}
            emptyText="ไม่มีผู้แจ้งข้อจำกัดด้านอาหาร"
          />
        </HoverItem>

        {/* ── Medical conditions / medication ──────────────────── */}
        <HoverItem k="medical" className="min-w-0">
          <NotePanel
            title="โรคประจำตัว / ยา"
            headingId="logistics-medical"
            entries={medical}
            emptyText="ไม่มีผู้แจ้งโรคประจำตัวหรือยาที่ใช้"
          />
        </HoverItem>
      </HoverGroup>
    </div>
  );
}
