/**
 * /status result as a bento dashboard (owner-approved variant D, 2026-11-26).
 *
 * One grid; tiles of different sizes lock into shared rows so the edges in a row line up, and tiles
 * stretch to the row (their last zone is pinned to the bottom). DOM order = reading order = Tab
 * order: placement is CSS grid areas per layout, never CSS `order`.
 *
 *   task    seat held, no slip waiting: status, pay & send slip (big), parent letter, LINE (locked),
 *           packing list, camp day, record, staff
 *   calm    slip sent or approved: the same tiles, payment shrinks to a receipt, LINE opens
 *   closed  no seat (forfeited, rejected, refunded...): status, record, staff
 *
 * Motion is GSAP and enhance-only: CSS never hides anything, every tween clears its props, and with
 * prefers-reduced-motion: reduce the finished layout appears with no motion at all.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import { ArrowUpRight, Check, Copy, Download, Lock, MapPin, Phone, TriangleAlert } from 'lucide-react';
import { hasSlip, type ApiSource, type Application, type SlipStatus } from '../../lib/api';
import {
  CAMP_BRING_LIST,
  CAMP_CHECKIN_TEXT,
  CAMP_DATES_TEXT,
  CAMP_FEE_INCLUDES,
  CAMP_FIRST_DAY,
  CAMP_LENGTH_TEXT,
  CAMP_VENUE,
  CAMP_VENUE_SUB,
  DOCS_READY,
  PARENT_CONSENT_FILENAME,
  PARENT_CONSENT_NOTE,
  PARENT_CONSENT_PDF,
} from '../../lib/camp-facts';
import { NO_QR_NOTE, PAY_ACCOUNT, PAY_ACCOUNT_DIGITS, copyText, describePaymentDue, paymentDueMs } from '../../lib/payment';
import {
  DORM_MAPS_URL,
  DORM_NAME,
  FB_URL,
  LINE_OPENCHAT_QR_SRC,
  LINE_OPENCHAT_URL,
  PAYMENT_WINDOW_DAYS,
  PAYMENT_WINDOW_HOURS,
  PROJECT_ADVISOR,
  SIZE_CHEST,
  SIZE_LENGTH,
  STAFF_CONTACTS,
} from '../register/model';
import { SlipUploadPanel } from '../slip/SlipUploadPanel';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BANGKOK_OFFSET_MS = 7 * HOUR_MS;

type Tone = 'tech' | 'warning' | 'danger' | 'success' | 'neutral';
export type DashboardLayout = 'task' | 'calm' | 'closed';

interface Headline {
  tone: Tone;
  /** Head-bar text; a narrow screen breaks it only at " · ". */
  badge: string;
  title: string;
  body: string;
  /** No seat any more: offer the staff phone right in the status tile. */
  contact?: boolean;
}

/** One place that decides the headline for every status / slip combination. */
function describeHeadline(app: Application, seats: number, feeText: string, urgent: boolean): Headline {
  const slip = hasSlip(app) ? (app.slipStatus ?? 'PENDING') : null;
  const paid: Headline = {
    tone: 'success',
    badge: 'ยืนยันสิทธิ์แล้ว',
    title: 'ยืนยันสิทธิ์เข้าร่วมค่ายสมบูรณ์แล้ว',
    body: 'สลิปผ่านการตรวจสอบแล้ว น้องมีที่นั่งในค่าย ComCamp #25 เข้ากลุ่ม LINE OpenChat เพื่อรับข่าวสารและกำหนดการวันเข้าค่ายจากพี่ค่ายได้เลย',
  };
  const rejected: Headline = {
    tone: 'danger',
    badge: 'สลิปไม่ผ่าน · ส่งใหม่',
    title: 'สลิปไม่ผ่านการตรวจสอบ กรุณาส่งสลิปใหม่',
    body: `โปรดตรวจสอบยอดโอน ${feeText} บาท และความชัดเจนของรูป แล้วส่งสลิปใหม่ภายในกำหนด (มิฉะนั้นระบบอาจคืนที่นั่งเมื่อพ้นกำหนด)`,
  };

  switch (app.status) {
    case 'CONFIRMED':
      if (slip === 'APPROVED') return paid;
      if (slip === 'REJECTED') return rejected;
      if (slip === 'PENDING') {
        return {
          tone: 'warning',
          badge: 'ยืนยันสิทธิ์แล้ว · รอตรวจสลิป',
          title: 'ยืนยันสิทธิ์แล้ว อยู่ระหว่างรอทีมงานตรวจสลิป',
          body: 'ทีมงานได้รับสลิปเรียบร้อยแล้ว กำลังตรวจสอบหลักฐานการโอนเงินให้โดยเร็วที่สุด ระหว่างนี้เข้ากลุ่ม LINE OpenChat เพื่อรอรับข่าวสารได้เลย',
        };
      }
      return {
        tone: 'success',
        badge: 'ยืนยันสิทธิ์แล้ว · ยังไม่พบสลิป',
        title: 'ยืนยันสิทธิ์แล้ว แต่ยังไม่พบสลิปค่าสมัครในระบบ',
        body: `หากยังไม่ได้ส่งสลิป กรุณาโอนค่าสมัคร ${feeText} บาท แล้วส่งสลิปในช่องการชำระเงิน (หากทีมงานยืนยันสิทธิ์กรณีพิเศษให้แล้ว เข้ากลุ่ม LINE OpenChat เพื่อรอรับข่าวสารได้เลย)`,
      };
    case 'REFUND_PENDING':
      return {
        tone: 'warning',
        badge: 'รอคืนเงิน',
        title: 'อยู่ระหว่างดำเนินการคืนเงินค่าสมัคร',
        body: 'ที่นั่งของใบสมัครนี้ถูกคืนให้น้องคนอื่นแล้ว ทีมงานกำลังดำเนินการคืนเงินให้ หากมีข้อสงสัยสามารถติดต่อทีมงานได้เลยนะ',
        contact: true,
      };
    case 'REFUNDED':
      return {
        tone: 'neutral',
        badge: 'คืนเงินแล้ว',
        title: 'ดำเนินการคืนเงินค่าสมัครเรียบร้อยแล้ว',
        body: 'ใบสมัครนี้ปิดรายการแล้ว หากต้องการสมัครอีกครั้งหรือมีข้อสงสัย กรุณาติดต่อทีมงาน',
        contact: true,
      };
    case 'REJECTED':
      return {
        tone: 'danger',
        badge: 'ไม่ผ่าน',
        title: 'ใบสมัครนี้ไม่ผ่านการพิจารณา',
        body: 'ที่นั่งของใบสมัครนี้ถูกปล่อยคืนแล้ว หากคิดว่าเกิดความผิดพลาดหรือมีข้อสงสัย กรุณาติดต่อทีมงาน',
        contact: true,
      };
    case 'FORFEITED':
      return {
        tone: 'danger',
        badge: 'หมดสิทธิ์',
        title: 'ใบสมัครนี้หมดสิทธิ์เนื่องจากไม่ได้ชำระเงินตามกำหนด',
        body: `ใบสมัครถูกตัดสิทธิ์เพราะไม่ได้ชำระเงินและแนบสลิปภายใน ${PAYMENT_WINDOW_DAYS} วัน (${PAYMENT_WINDOW_HOURS} ชั่วโมง) หลังสมัคร ที่นั่งจึงถูกคืนให้ผู้สมัครคนอื่นแล้ว หากชำระเงินไปแล้วหรือคิดว่าเกิดความผิดพลาด กรุณาติดต่อพี่ค่าย`,
        contact: true,
      };
    case 'RESERVE':
      return {
        tone: 'neutral',
        badge: 'ตัวสำรอง',
        title: 'อยู่ในรายชื่อตัวสำรอง',
        body: 'หากมีที่นั่งว่างทีมงานจะติดต่อกลับ ระหว่างนี้ขอให้น้องคอยติดตามข่าวสารจากเพจของโครงการ',
        contact: true,
      };
    case 'PENDING':
      return {
        tone: 'warning',
        badge: 'รอพิจารณา',
        title: 'ใบสมัครอยู่ระหว่างรอทีมงานพิจารณา',
        body: 'ทีมงานกำลังตรวจสอบใบสมัครของน้อง เมื่อมีผลแล้วสถานะจะอัปเดตในหน้านี้ ลองกลับมาตรวจสอบอีกครั้งภายหลังนะ',
      };
    default:
      break;
  }

  // PASSED: register (PASSED) -> pay & send the slip -> staff approve (CONFIRMED).
  if (slip === 'APPROVED') return paid;
  if (slip === 'REJECTED') return rejected;
  if (slip === 'PENDING') {
    return {
      tone: 'warning',
      badge: 'ได้รับสลิปแล้ว · รอทีมงานตรวจสลิป',
      title: 'ได้รับสลิปแล้ว กำลังรอทีมงานตรวจสอบ',
      body: 'ทีมงานกำลังตรวจสอบสลิปให้โดยเร็วที่สุด ไม่ต้องส่งสลิปซ้ำ เมื่อสลิปผ่านการตรวจสอบ สถานะจะอัปเดตเป็น “ยืนยันสิทธิ์สมบูรณ์” โดยอัตโนมัติ',
    };
  }
  return {
    tone: urgent ? 'warning' : 'tech',
    badge: 'สมัครทันแล้ว · รอชำระเงิน',
    title: 'เย้! ดีใจด้วย คุณสมัครทันแล้ว ได้ที่นั่งในค่าย ComCamp #25',
    body: `ระบบจองที่นั่งให้คุณเรียบร้อยแล้ว (สิทธิ์แบบมาก่อนได้ก่อน จำกัด ${seats} ที่นั่ง) กรุณาโอนค่าสมัคร ${feeText} บาท และส่งสลิปภายในกำหนด มิฉะนั้นระบบจะตัดสิทธิ์และคืนที่นั่งว่างอัตโนมัติ`,
  };
}

/** Digits (and Latin glued to them, like ESP8266 or 2XL) in IBM Plex Mono; Thai stays in the sans face. */
const NUM_RE = /[A-Za-z]*[0-9]+(?:[,.:–-][0-9]+)*[A-Za-z]*/g;
function Digits({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(NUM_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <span key={at} className="font-mono tabular-nums">
        {m[0]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const reduceMotion = () =>
  typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function TileHead({ num, id, title, aside }: { num: string; id: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="sd-head">
      <div className="sd-head__main">
        <span className="sd-num font-mono" aria-hidden="true">
          {num}
        </span>
        <h2 id={id} className="sd-head__title">
          {title}
        </h2>
      </div>
      {aside}
    </div>
  );
}

const SelfCheck = () => <span className="sd-badge">น้องเช็กเอง</span>;

/* ── Status tile pieces ─────────────────────────────────────────── */

type Readout =
  | { kind: 'deadline'; parts: [number, string][]; danger: boolean; due: string }
  | { kind: 'overdue'; due: string }
  | { kind: 'camp'; days: number };

/** The transfer deadline the server enforces, in whole days / hours / minutes left. Red once the
    slip was rejected or less than a day is left. */
function deadlineReadout(app: Application, nowMs: number, rejected: boolean): Readout | null {
  const due = paymentDueMs(app.createdAt, app.updatedAt);
  if (!Number.isFinite(due)) return null;
  const text = describePaymentDue(due, nowMs).deadlineText;
  const left = due - nowMs;
  if (left <= 0) return { kind: 'overdue', due: text };
  const days = Math.floor(left / DAY_MS);
  const hours = Math.floor((left % DAY_MS) / HOUR_MS);
  const mins = Math.max(1, Math.ceil((left % HOUR_MS) / 60_000));
  const parts: [number, string][] =
    days > 0 ? [[days, 'วัน'], [hours, 'ชั่วโมง']] : hours > 0 ? [[hours, 'ชั่วโมง'], [mins, 'นาที']] : [[mins, 'นาที']];
  return { kind: 'deadline', parts, danger: rejected || left < DAY_MS, due: text };
}

/** Calendar days (Asia/Bangkok) from today to the first camp day. */
function daysToCamp(nowMs: number): number {
  const today = Math.floor((nowMs + BANGKOK_OFFSET_MS) / DAY_MS);
  const first = Math.floor(Date.parse(`${CAMP_FIRST_DAY}T00:00:00Z`) / DAY_MS);
  return first - today;
}

function ReadoutZone({ r }: { r: Readout }) {
  if (r.kind === 'overdue') {
    return (
      <div className="sd-zone sd-top__readout">
        <p className="sd-readout__label">
          <span className="sd-led" data-tone="danger" aria-hidden="true" />
          กำหนดส่งสลิป
        </p>
        <p className="sd-readout__calm" data-tone="danger">
          ครบกำหนดแล้ว
        </p>
        <p className="sd-readout__sub">
          <Digits text={`ครบกำหนดเมื่อ ${r.due}`} /> หากโอนแล้วกรุณาส่งสลิปและติดต่อพี่ค่ายโดยเร็ว
        </p>
      </div>
    );
  }
  if (r.kind === 'camp') {
    return (
      <div className="sd-zone sd-top__readout">
        <p className="sd-readout__label">
          <span className="sd-led" data-tone="success" aria-hidden="true" />
          นับถอยหลังวันค่าย
        </p>
        <p className="sd-readout__display">
          {r.days > 0 ? (
            <>
              <span className="sd-readout__unit">อีก</span>
              <span className="sd-readout__num font-mono" data-tone="success" data-count={r.days}>
                {r.days}
              </span>
              <span className="sd-readout__unit">วันถึงวันค่าย</span>
            </>
          ) : (
            <span className="sd-readout__calm" data-tone="success">
              วันนี้วันค่าย
            </span>
          )}
        </p>
        <p className="sd-readout__sub">
          <Digits text={`${CAMP_DATES_TEXT} (${CAMP_LENGTH_TEXT})`} />
        </p>
      </div>
    );
  }
  const tone = r.danger ? 'danger' : 'tech';
  return (
    <div className="sd-zone sd-top__readout">
      <p className="sd-readout__label">
        <span className="sd-led" data-tone={tone} aria-hidden="true" />
        เหลือเวลาส่งสลิป
      </p>
      <p className="sd-readout__display">
        {r.parts.map(([n, unit], i) => (
          <span key={unit} className="sd-readout__pair">
            {i > 0 && <span className="sd-readout__tick" aria-hidden="true" />}
            <span className="sd-readout__num font-mono" data-tone={r.danger ? 'danger' : undefined} data-count={n}>
              {n}
            </span>
            <span className="sd-readout__unit">{unit}</span>
          </span>
        ))}
      </p>
      <p className="sd-readout__sub">
        ภายใน <Digits text={r.due} />
      </p>
    </div>
  );
}

interface Step {
  label: string;
  note: string;
  state: 'done' | 'current' | 'todo';
  danger?: boolean;
}

function stepsFor(app: Application, slip: SlipStatus | null): Step[] {
  const confirmed = app.status === 'CONFIRMED' || slip === 'APPROVED';
  const sent = slip === 'PENDING' || slip === 'APPROVED' || (app.status === 'CONFIRMED' && slip !== 'REJECTED');
  return [
    { label: 'สมัคร', note: 'ได้ที่นั่งแล้ว', state: 'done' },
    {
      label: 'โอน + ส่งสลิป',
      note: slip === 'REJECTED' ? 'สลิปไม่ผ่าน ส่งใหม่' : sent ? 'ส่งสลิปแล้ว' : 'ยังไม่ส่งสลิป',
      state: sent ? 'done' : 'current',
      danger: slip === 'REJECTED',
    },
    {
      label: 'ทีมงานยืนยันสิทธิ์',
      note: confirmed ? 'ยืนยันแล้ว' : slip === 'PENDING' ? 'กำลังตรวจสลิป' : 'หลังส่งสลิป',
      state: confirmed ? 'done' : slip === 'PENDING' ? 'current' : 'todo',
    },
    { label: 'วันค่าย', note: CAMP_CHECKIN_TEXT, state: confirmed ? 'current' : 'todo' },
  ];
}

const STEP_WORD = { done: 'เสร็จแล้ว', current: 'ขั้นตอนนี้', todo: 'ถัดไป' } as const;

function StepRail({ steps }: { steps: Step[] }) {
  return (
    <ol className="sd-steps" aria-label="ขั้นตอนการสมัคร">
      {steps.map((s, i) => (
        <li key={s.label} className="sd-step" data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
          {i < steps.length - 1 && <span className="sd-step__trace" aria-hidden="true" />}
          <span className="sd-step__led" aria-hidden="true">
            {s.state === 'done' && <Check size={14} strokeWidth={2.25} />}
          </span>
          <span className="sd-step__body">
            <span className="sd-step__meta">
              <span className="sd-step__idx font-mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="sd-step__word">{STEP_WORD[s.state]}</span>
            </span>
            <span className="sd-step__label">{s.label}</span>
            <span className="sd-step__note" data-tone={s.danger ? 'danger' : undefined}>
              <Digits text={s.note} />
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ── Copy button with a little pop when it worked ───────────────── */

function CopyButton({ text, label, doneLabel, failNote }: { text: string; label: string; doneLabel: string; failNote: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  const iconRef = useRef<HTMLSpanElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (state !== 'copied' || reduceMotion() || !iconRef.current) return;
    const tw = gsap.fromTo(
      iconRef.current,
      { scale: 0.3, rotate: -40 },
      { scale: 1, rotate: 0, duration: 0.45, ease: 'back.out(3)', clearProps: 'transform' },
    );
    return () => {
      tw.revert();
    };
  }, [state]);
  async function onCopy() {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), ok ? 2200 : 5000);
  }
  return (
    <>
      <button type="button" className="sd-btn sd-btn--ghost" onClick={onCopy}>
        <span ref={iconRef} className="sd-btn__icon" aria-hidden="true">
          {state === 'copied' ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={1.5} />}
        </span>
        <span>{state === 'copied' ? doneLabel : label}</span>
      </button>
      <span role="status" aria-live="polite" className="sd-live">
        {state === 'failed' ? failNote : ''}
      </span>
    </>
  );
}

/* ── Packing list: switches remembered on this device only ───────── */

const BRING_KEY = 'cc25-status-bring';

function loadTicks(): Set<string> {
  try {
    const raw = window.localStorage.getItem(BRING_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.ids)) {
      return new Set(parsed.ids.filter((x: unknown): x is string => typeof x === 'string'));
    }
  } catch {
    /* storage blocked (private mode, in-app browser): start empty */
  }
  return new Set();
}

function BringTile({ num }: { num: string }) {
  const groups = CAMP_BRING_LIST.map((g) => ({ ...g, items: g.items.filter((it) => DOCS_READY || !it.docs) }));
  const required = groups.flatMap((g) => g.items.filter((it) => !it.optional).map((it) => it.id));
  const [ticks, setTicks] = useState<Set<string>>(loadTicks);
  const pipsRef = useRef<HTMLSpanElement>(null);
  const done = required.filter((id) => ticks.has(id)).length;
  const prevDone = useRef(done);

  // A pip that lights up hops; completing the list sends a wave along the pips.
  useLayoutEffect(() => {
    const before = prevDone.current;
    prevDone.current = done;
    const box = pipsRef.current;
    if (!box || done <= before || reduceMotion()) return;
    const pips = Array.from(box.children) as HTMLElement[];
    const tw =
      done === required.length
        ? gsap.fromTo(
            pips,
            { y: 0 },
            { y: -6, duration: 0.18, ease: 'power2.out', yoyo: true, repeat: 1, stagger: 0.05, clearProps: 'transform' },
          )
        : gsap.fromTo(
            pips[done - 1],
            { scaleY: 2.4, scaleX: 0.7 },
            { scaleY: 1, scaleX: 1, duration: 0.6, ease: 'elastic.out(1.1, 0.4)', clearProps: 'transform' },
          );
    return () => {
      tw.progress(1).kill();
    };
  }, [done, required.length]);

  function toggle(id: string, on: boolean) {
    setTicks((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      try {
        window.localStorage.setItem(BRING_KEY, JSON.stringify({ v: 1, ids: [...next] }));
      } catch {
        /* not saved; the switches still work for this visit */
      }
      return next;
    });
  }

  return (
    <section className="sd-tile sd-bring" aria-labelledby="sd-bring-title">
      <TileHead num={num} id="sd-bring-title" title="วันค่ายเตรียมอะไรมา" aside={<SelfCheck />} />
      <div className="sd-zone sd-progress">
        <p className="sd-progress__text" aria-live="polite">
          เตรียมแล้ว{' '}
          <span className="font-mono tabular-nums">
            {done}/{required.length}
          </span>{' '}
          รายการ
        </p>
        <span ref={pipsRef} className="sd-pips" aria-hidden="true">
          {required.map((id, i) => (
            <span key={id} className="sd-pip" data-on={i < done || undefined} />
          ))}
        </span>
      </div>
      <div className="sd-zone sd-zone--grow sd-bring__groups">
        {groups.map((g) => (
          <div key={g.group} className="sd-bring__group">
            <h3 className="sd-bring__title">{g.group}</h3>
            {g.items.map((it) => {
              const on = ticks.has(it.id);
              return (
                <label key={it.id} className="sd-toggle" data-on={on || undefined}>
                  <span className="sd-toggle__text">
                    <Digits text={it.text} />
                    {it.optional && <span className="sd-toggle__opt"> · ไม่บังคับ</span>}
                  </span>
                  <span className="sd-toggle__control">
                    <input type="checkbox" className="sd-toggle__input" checked={on} onChange={(e) => toggle(it.id, e.target.checked)} />
                    <span className="sd-toggle__track" aria-hidden="true">
                      <span className="sd-toggle__thumb" />
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
      <p className="sd-zone sd-zone--bottom sd-fine">ติ๊กไว้ในเครื่องนี้เท่านั้น ไม่ได้ส่งให้ทีมงาน</p>
    </section>
  );
}

/* ── The dashboard ───────────────────────────────────────────────── */

export function StatusDashboard({
  app,
  seats,
  feeText,
  nowMs,
  source,
  onUploaded,
  footer,
}: {
  app: Application;
  seats: number;
  feeText: string;
  nowMs: number;
  source: ApiSource | null;
  onUploaded: (status: SlipStatus, message: string, source: ApiSource) => void;
  /** The quiet cancel zone under the grid (owned by StatusSection, which owns the withdraw state). */
  footer?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const slip: SlipStatus | null = hasSlip(app) ? (app.slipStatus ?? 'PENDING') : null;
  const payFlow = app.status === 'PASSED' || app.status === 'CONFIRMED';
  const moneyHeld = slip === 'PENDING' || slip === 'APPROVED';
  const layout: DashboardLayout = !payFlow ? 'closed' : moneyHeld ? 'calm' : 'task';
  const task = layout === 'task';
  const lineOpen = moneyHeld || app.status === 'CONFIRMED';
  const showConsent = payFlow && DOCS_READY;

  const deadline = app.status === 'PASSED' && !moneyHeld ? deadlineReadout(app, nowMs, slip === 'REJECTED') : null;
  const urgent = deadline?.kind === 'overdue' || (deadline?.kind === 'deadline' && deadline.danger && slip !== 'REJECTED');
  const campDays = daysToCamp(nowMs);
  const readout: Readout | null = deadline ?? (app.status === 'CONFIRMED' && campDays >= 0 ? { kind: 'camp', days: campDays } : null);
  const h = describeHeadline(app, seats, feeText, urgent);

  // Module numbers follow the tiles actually shown.
  const tiles = ['status', ...(payFlow ? ['payment', ...(showConsent ? ['consent'] : []), 'line', 'bring', 'camp'] : []), 'record', 'staff'];
  const num = (key: string) => String(tiles.indexOf(key) + 1).padStart(2, '0');

  /* Intro: tiles pop into place in reading order, the status dot springs, the step LEDs light up
     one by one and the numbers count up. Runs once per application (the parent keys us by id). */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const q = gsap.utils.selector(root);
      const tl = gsap.timeline();
      tl.from(q('.sd-tile'), {
        autoAlpha: 0,
        y: 26,
        scale: 0.95,
        duration: 0.6,
        ease: 'back.out(1.6)',
        stagger: 0.06,
        clearProps: 'opacity,visibility,transform',
      })
        .from(q('.sd-bar .sd-led'), { scale: 0, duration: 0.55, ease: 'back.out(4)', clearProps: 'transform' }, 0.2)
        .from(
          q('.sd-bar__part'),
          { x: -16, autoAlpha: 0, duration: 0.45, ease: 'power3.out', stagger: 0.09, clearProps: 'opacity,visibility,transform' },
          0.22,
        )
        .from(q('.sd-step__led'), { scale: 0, rotate: -90, duration: 0.5, ease: 'back.out(2.6)', stagger: 0.1, clearProps: 'transform' }, 0.4)
        .from(
          q('.sd-step__trace'),
          { clipPath: 'inset(0 100% 100% 0)', duration: 0.45, ease: 'power2.inOut', stagger: 0.1, clearProps: 'clipPath' },
          0.5,
        );
      const counters = q('[data-count]') as HTMLElement[];
      for (const el of counters) {
        const node = el.firstChild;
        const end = Number(el.dataset.count);
        if (!node || !Number.isFinite(end) || end <= 0) continue;
        const o = { v: 0 };
        // Writes the text node React owns in place, and always lands on React's current value.
        tl.to(
          o,
          {
            v: end,
            duration: 0.9,
            ease: 'power2.out',
            onUpdate: () => {
              node.nodeValue = String(Math.round(o.v));
            },
            onComplete: () => {
              node.nodeValue = el.dataset.count ?? String(end);
            },
          },
          0.35,
        );
      }
      return () => {
        for (const el of counters) if (el.firstChild) el.firstChild.nodeValue = el.dataset.count ?? '';
      };
    });
    return () => mm.revert();
  }, []);

  /* A slip sent from this page re-packs the grid (task -> calm): the tiles glide to their new spots. */
  const flipState = useRef<Flip.FlipState | null>(null);
  function handleUploaded(status: SlipStatus, message: string, src: ApiSource) {
    const root = rootRef.current;
    if (root && !reduceMotion()) {
      gsap.registerPlugin(Flip);
      flipState.current = Flip.getState(root.querySelectorAll('.sd-tile'));
    }
    onUploaded(status, message, src);
  }
  useLayoutEffect(() => {
    const state = flipState.current;
    flipState.current = null;
    if (!state || reduceMotion()) return;
    const tl = Flip.from(state, { duration: 0.7, ease: 'power3.inOut', stagger: 0.03, nested: false, prune: true });
    const bar = rootRef.current?.querySelector('.sd-bar__text');
    if (bar) tl.from(bar, { y: 10, autoAlpha: 0, duration: 0.4, ease: 'power3.out', clearProps: 'opacity,visibility,transform' }, 0.2);
    return () => {
      tl.progress(1).kill();
    };
  }, [layout]);

  const parts = h.badge.split(' · ');
  const firstStaff = STAFF_CONTACTS[0];

  return (
    <div ref={rootRef} className="sd">
      <p className="sd-meta">
        <span>
          รหัสใบสมัคร <span className="sd-meta__code select-all font-mono">{app.id}</span>
        </span>
        {app.nickname && (
          <>
            <span className="sd-meta__sep" aria-hidden="true" />
            <span>
              น้อง<span className="sd-meta__nick">{app.nickname}</span>
            </span>
          </>
        )}
        {import.meta.env.DEV && source && <span className="sd-meta__src font-mono">{source}</span>}
      </p>

      <div className="sd-grid" data-layout={layout} data-docs={DOCS_READY ? undefined : 'off'}>
        {/* 01 · Status: the head bar says it in one line, big; the steps run underneath. */}
        <section className={`sd-tile sd-status${task ? '' : ' sd-tile--dock'}`} data-tone={h.tone} aria-labelledby="sd-status-title">
          <div className="sd-bar" role="status">
            <span className="sd-led sd-led--lg" aria-hidden="true" />
            <h2 id="sd-status-title" className="sd-bar__text">
              <span className="sr-only">สถานะปัจจุบัน: </span>
              {parts.map((p, i) => (
                <span key={p}>
                  {i > 0 && ' · '}
                  <span className="sd-bar__part">
                    <Digits text={p} />
                  </span>
                </span>
              ))}
            </h2>
            <span className="sd-num sd-bar__num font-mono" aria-hidden="true">
              {num('status')}
            </span>
          </div>
          <div className="sd-top">
            <div className="sd-zone sd-top__text">
              <p className="sd-status__title">
                <Digits text={h.title} />
              </p>
              <p className="sd-status__body">
                <Digits text={h.body} />
              </p>
            </div>
            {readout && <ReadoutZone r={readout} />}
          </div>
          {payFlow && (
            <div className="sd-zone sd-zone--bottom">
              <StepRail steps={stepsFor(app, slip)} />
            </div>
          )}
          {!payFlow && h.contact && (
            <div className="sd-zone sd-zone--bottom sd-actions">
              <a className="sd-btn sd-btn--dark" href={`tel:${firstStaff.tel}`}>
                <Phone aria-hidden="true" size={16} strokeWidth={1.5} />
                <span>
                  โทรหาพี่ค่าย <span className="font-mono tabular-nums">{firstStaff.phone}</span>
                </span>
              </a>
              <a className="sd-btn sd-btn--ghost" href="#sd-staff">
                ดูช่องทางติดต่อทั้งหมด
              </a>
            </div>
          )}
        </section>

        {payFlow && (
          <>
            {/* 02 · Payment. SlipUploadPanel keeps the same place in the tree across task -> calm, so its
                "sent" message and focus survive the re-pack. */}
            <section
              id="slip-section"
              tabIndex={-1}
              className={`sd-tile sd-payment${task ? ' sd-tile--dock sd-tile--current' : ''}`}
              aria-labelledby="sd-payment-title"
            >
              <TileHead
                num={num('payment')}
                id="sd-payment-title"
                title={!task ? 'การชำระเงิน' : slip === 'REJECTED' ? 'ส่งสลิปการโอนเงินใหม่' : 'โอนค่าสมัครและส่งสลิป'}
                aside={
                  task ? (
                    <span className="sd-fee">
                      <span className="sd-fee__amount font-mono">{feeText}</span> บาท
                    </span>
                  ) : undefined
                }
              />
              <div className="sd-pay" data-split={task || undefined}>
                {task && (
                  <div className="sd-zone sd-pay__acct" role="group" aria-label="ข้อมูลการโอนเงิน">
                    {app.status === 'CONFIRMED' && (
                      <p className="sd-text sd-pay__note">ยืนยันสิทธิ์แล้ว แต่ยังไม่พบไฟล์สลิป หากโอนแล้ว ส่งสลิปไว้เป็นหลักฐานได้ที่นี่</p>
                    )}
                    <p className="sd-fine">
                      ค่าสมัคร <span className="font-mono tabular-nums">{feeText}</span> บาท (รวม <Digits text={CAMP_FEE_INCLUDES} />)
                    </p>
                    <div className="sd-acct">
                      <span className="sd-acct__num select-all font-mono">{PAY_ACCOUNT.number}</span>
                      <span className="sd-acct__copy">
                        <CopyButton
                          text={PAY_ACCOUNT_DIGITS}
                          label="คัดลอกเลขบัญชี"
                          doneLabel="คัดลอกแล้ว"
                          failNote="คัดลอกอัตโนมัติไม่ได้ แตะค้างที่เลขบัญชีแล้วเลือกคัดลอก"
                        />
                      </span>
                    </div>
                    <dl className="sd-spec">
                      <div className="sd-spec__row">
                        <dt>ธนาคาร</dt>
                        <dd>{PAY_ACCOUNT.bank}</dd>
                      </div>
                      <div className="sd-spec__row">
                        <dt>ชื่อบัญชี</dt>
                        <dd>{PAY_ACCOUNT.name}</dd>
                      </div>
                      <div className="sd-spec__row">
                        <dt>ผู้ถือบัญชี</dt>
                        <dd>{PAY_ACCOUNT.holders}</dd>
                      </div>
                      <div className="sd-spec__row">
                        <dt>บันทึกช่วยจำ</dt>
                        <dd>
                          <span className="select-all font-mono">{app.id}</span>
                          <span className="sd-spec__sub">พิมพ์รหัสนี้ในช่องบันทึกตอนโอน (ถ้าแอปธนาคารมีช่องให้พิมพ์)</span>
                          <span className="sd-spec__act">
                            <CopyButton
                              text={app.id}
                              label="คัดลอกรหัสใบสมัคร"
                              doneLabel="คัดลอกแล้ว"
                              failNote="คัดลอกอัตโนมัติไม่ได้ แตะค้างที่รหัสแล้วเลือกคัดลอก"
                            />
                          </span>
                        </dd>
                      </div>
                    </dl>
                    <p className="sd-noqr">
                      <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.5} />
                      <span>{NO_QR_NOTE}</span>
                    </p>
                  </div>
                )}
                {slip === 'APPROVED' ? (
                  <div className="sd-zone sd-zone--grow sd-paid">
                    <span className="sd-paid__icon" aria-hidden="true">
                      <Check size={16} strokeWidth={2.25} />
                    </span>
                    <span>
                      <span className="sd-paid__title">ชำระเงินเรียบร้อยแล้ว</span>
                      <span className="sd-paid__sub">สลิปผ่านการตรวจสอบและยืนยันที่นั่งในค่ายเรียบร้อยแล้ว</span>
                    </span>
                  </div>
                ) : (
                  <div className="sd-zone sd-zone--grow sd-pay__slip">
                    {task && <h3 className="sd-zone__title">แนบรูปสลิปการโอนเงิน</h3>}
                    <SlipUploadPanel
                      key={app.id}
                      appId={app.id}
                      slip={slip}
                      submitLabel={slip === 'REJECTED' ? 'ส่งสลิปใหม่' : 'ยืนยันและส่งหลักฐานสลิป'}
                      onUploaded={handleUploaded}
                    />
                  </div>
                )}
              </div>
              {!task && (
                <dl className="sd-zone sd-zone--bottom sd-spec sd-spec--flush">
                  <div className="sd-spec__row">
                    <dt>ค่าสมัคร</dt>
                    <dd>
                      <span className="font-mono tabular-nums">{feeText}</span> บาท
                    </dd>
                  </div>
                  <div className="sd-spec__row">
                    <dt>โอนเข้า</dt>
                    <dd>{PAY_ACCOUNT.bank}</dd>
                  </div>
                  <div className="sd-spec__row">
                    <dt>สลิป</dt>
                    <dd>{slip === 'APPROVED' ? 'ผ่านการตรวจสอบแล้ว' : 'รอทีมงานตรวจ'}</dd>
                  </div>
                </dl>
              )}
            </section>

            {showConsent && (
              <section className="sd-tile sd-consent" aria-labelledby="sd-consent-title">
                <TileHead num={num('consent')} id="sd-consent-title" title="ใบขออนุญาตผู้ปกครอง" aside={<SelfCheck />} />
                <div className="sd-zone sd-zone--grow">
                  <p className="sd-text">{PARENT_CONSENT_NOTE}</p>
                  <div className="sd-actions sd-actions--end">
                    <a className="sd-btn sd-btn--ghost" href={PARENT_CONSENT_PDF} download={PARENT_CONSENT_FILENAME}>
                      <Download aria-hidden="true" size={16} strokeWidth={1.5} />
                      <span>ดาวน์โหลดใบขออนุญาต (PDF)</span>
                    </a>
                  </div>
                </div>
              </section>
            )}

            <section id="line-openchat" className="sd-tile sd-line" aria-labelledby="sd-line-title">
              <TileHead num={num('line')} id="sd-line-title" title="กลุ่ม LINE ค่าย" aside={<SelfCheck />} />
              <div className="sd-zone sd-zone--grow">
                {lineOpen ? (
                  <div className="sd-qr">
                    <img
                      className="sd-qr__img"
                      src={LINE_OPENCHAT_QR_SRC}
                      alt="QR Code สำหรับเข้ากลุ่ม LINE OpenChat ค่าย ComCamp #25"
                      width={124}
                      height={124}
                      loading="lazy"
                      decoding="async"
                    />
                    <div className="sd-qr__detail">
                      <p className="sd-text">เข้ากลุ่มเพื่อรับข่าวสาร ประกาศสำคัญ และนัดหมายวันลงทะเบียนจากพี่ค่าย</p>
                      <a className="sd-btn sd-btn--dark" href={LINE_OPENCHAT_URL} target="_blank" rel="noopener noreferrer">
                        <span>เข้ากลุ่ม LINE OpenChat</span>
                        <ArrowUpRight aria-hidden="true" size={16} strokeWidth={1.5} />
                      </a>
                    </div>
                  </div>
                ) : (
                  <div className="sd-locked">
                    <Lock aria-hidden="true" size={20} strokeWidth={1.5} />
                    <div>
                      <p className="sd-locked__title">เปิดได้หลังส่งสลิป</p>
                      <p className="sd-text">เมื่อส่งสลิปการโอนเงินแล้ว QR Code และลิงก์เข้ากลุ่ม LINE OpenChat จะแสดงที่ช่องนี้</p>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <BringTile num={num('bring')} />

            <section className="sd-tile sd-camp" aria-labelledby="sd-camp-title">
              <TileHead num={num('camp')} id="sd-camp-title" title="วันค่าย: ที่ไหน เมื่อไร" />
              <dl className="sd-zone sd-zone--grow sd-spec sd-spec--flush">
                <div className="sd-spec__row">
                  <dt>กำหนดการ</dt>
                  <dd>
                    <Digits text={`${CAMP_DATES_TEXT} (${CAMP_LENGTH_TEXT})`} />
                    <span className="sd-spec__sub">
                      <Digits text={`วันลงทะเบียนเข้าค่าย ${CAMP_CHECKIN_TEXT}`} />
                    </span>
                  </dd>
                </div>
                <div className="sd-spec__row">
                  <dt>สถานที่อบรม</dt>
                  <dd>
                    <Digits text={CAMP_VENUE} />
                    <span className="sd-spec__sub">{CAMP_VENUE_SUB}</span>
                  </dd>
                </div>
                <div className="sd-spec__row">
                  <dt>ที่พัก</dt>
                  <dd>
                    {DORM_NAME}
                    <span className="sd-spec__sub">แยกโซนชาย-หญิง</span>
                    <span className="sd-spec__act">
                      <a className="sd-btn sd-btn--ghost" href={DORM_MAPS_URL} target="_blank" rel="noopener noreferrer">
                        <MapPin aria-hidden="true" size={16} strokeWidth={1.5} />
                        <span>ดูแผนที่ (Google Maps)</span>
                      </a>
                    </span>
                  </dd>
                </div>
              </dl>
              <p className="sd-zone sd-zone--bottom sd-row">
                <span className="sd-row__label">เสื้อค่ายของน้อง</span>
                <span className="sd-row__value">
                  ไซส์ <span className="font-mono tabular-nums">{app.shirtSize}</span>
                  {SIZE_CHEST[app.shirtSize] && SIZE_LENGTH[app.shirtSize] && (
                    <>
                      {' '}
                      (อก <span className="font-mono tabular-nums">{SIZE_CHEST[app.shirtSize]}"</span> ยาว{' '}
                      <span className="font-mono tabular-nums">{SIZE_LENGTH[app.shirtSize]}"</span>)
                    </>
                  )}
                </span>
              </p>
            </section>
          </>
        )}

        <section className="sd-tile sd-record" aria-labelledby="sd-record-title">
          <TileHead num={num('record')} id="sd-record-title" title="ข้อมูลใบสมัคร" />
          <dl className="sd-zone sd-zone--grow sd-spec sd-spec--flush">
            {[
              { k: 'รหัสใบสมัคร', v: <span className="select-all font-mono font-bold">{app.id}</span> },
              { k: 'ชื่อ–นามสกุล', v: app.fullName },
              { k: 'ชื่อเล่น', v: app.nickname || '–' },
              { k: 'เบอร์โทร', v: <span className="font-mono tabular-nums">{app.phone}</span> },
              ...(app.email ? [{ k: 'อีเมล', v: <span className="break-all">{app.email}</span> }] : []),
              { k: 'โรงเรียน', v: app.school },
              ...(app.province ? [{ k: 'จังหวัด', v: app.province }] : []),
              { k: 'ระดับชั้น', v: <Digits text={app.grade} /> },
            ].map((row) => (
              <div key={row.k} className="sd-spec__row">
                <dt>{row.k}</dt>
                <dd>{row.v}</dd>
              </div>
            ))}
          </dl>
          <p className="sd-zone sd-zone--bottom sd-fine">
            ต้องการแก้ไขข้อมูล?{' '}
            <a className="sd-link" href="#sd-staff">
              ติดต่อพี่ค่าย
            </a>{' '}
            พร้อมแจ้งรหัสใบสมัคร
          </p>
        </section>

        <section id="sd-staff" className="sd-tile sd-staff" aria-labelledby="sd-staff-title" tabIndex={-1}>
          <TileHead num={num('staff')} id="sd-staff-title" title="ติดต่อพี่ค่าย" />
          <div className="sd-zone">
            <ul className="sd-staff__list">
              {STAFF_CONTACTS.map((c) => (
                <li key={c.tel} className="sd-staff__row">
                  <span className="sd-staff__name">{c.name}</span>
                  <a className="sd-btn sd-btn--ghost" href={`tel:${c.tel}`}>
                    <Phone aria-hidden="true" size={16} strokeWidth={1.5} />
                    <span className="font-mono tabular-nums">{c.phone}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="sd-zone sd-zone--grow">
            <div className="sd-qr">
              <img
                className="sd-qr__img sd-qr__img--sm"
                src="/assets/facebook-page-qr.svg"
                alt="QR Code เพจ Facebook ComCamp (CCCSMJU)"
                width={96}
                height={96}
                loading="lazy"
                decoding="async"
              />
              <div className="sd-qr__detail">
                <p className="sd-text">สอบถามผ่านแชตเพจค่ายได้ตลอดเวลา</p>
                <a className="sd-btn sd-btn--ghost" href={FB_URL} target="_blank" rel="noopener noreferrer">
                  <span>
                    เพจ Facebook <span className="font-mono">ComCamp CSMJU</span>
                  </span>
                  <ArrowUpRight aria-hidden="true" size={16} strokeWidth={1.5} />
                </a>
              </div>
            </div>
          </div>
          <p className="sd-zone sd-zone--bottom sd-row">
            <span className="sd-row__label">อาจารย์ผู้รับผิดชอบโครงการ</span>
            <span className="sd-row__value">{PROJECT_ADVISOR}</span>
          </p>
        </section>
      </div>

      {footer}
    </div>
  );
}
