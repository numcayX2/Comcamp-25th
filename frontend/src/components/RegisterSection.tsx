/**
 * /register — editorial split-screen wizard.
 *
 * Desktop: dark sticky sidebar (vertical stepper) + paper form canvas.
 * Mobile:  sidebar collapses into a sticky top bar with a progress meter.
 *
 * Steps 01–05 are form steps; 06 is the receipt/payment state after submit.
 * All form state lives here, so going back and forth never loses input.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FocusEvent, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Moon, RotateCw, Sun, TriangleAlert } from 'lucide-react';
import {
  ApiHttpError,
  fetchPublicSettings,
  sanitizeDigits,
  submitApplication,
  type ApiSource,
  type Application,
  type ApplicationPayload,
  type ShirtSize,
} from '../lib/api';
import {
  EMPTY_FORM,
  FEE_TEXT,
  GRADES,
  GRADE_OTHER,
  GRADE_OTHER_MAX,
  gradeValue,
  LAST_FORM_STEP,
  MOCK_FORM,
  RECEIPT_META,
  RECEIPT_STEP,
  SEATS,
  SHIRT_SIZES,
  SIZE_CHEST,
  STEPS,
  TOTAL_STEPS,
  firstErrorKey,
  formatNationalId,
  formatPhone,
  validateField,
  validateStep,
  type FieldErrors,
  type FieldKey,
  type FormState,
} from './register/model';
import { FieldShell, StepHeader, TextField } from './register/parts';
import { SizeChips } from './register/SizeChips';
import { Receipt } from './register/Receipt';
import { TurnstileField, type TurnstileFieldHandle } from './register/TurnstileField';
import {
  clearDraft,
  clearIdempotencyKey,
  clearReceipt,
  loadDraft,
  loadIdempotencyKey,
  loadReceipt,
  newIdempotencyKey,
  saveDraft,
  saveIdempotencyKey,
  saveReceipt,
} from './register/storage';
import '../styles/register.css';

type GateState = 'checking' | 'open' | 'pre_open' | 'full' | 'closed' | 'error';

const GATE_COPY: Record<Exclude<GateState, 'checking' | 'open'>, { title: string; body: string }> = {
  pre_open: {
    title: 'ยังไม่เปิดรับสมัคร — เปิดรับ 16 พ.ย. 2569 เวลา 00:00 น.',
    body: 'แบบฟอร์มจะเปิดให้กรอกทันทีเมื่อถึงกำหนด ระหว่างนี้สามารถอ่านรายละเอียดค่ายและเตรียมข้อมูลส่วนตัวไว้ล่วงหน้าได้',
  },
  full: {
    title: 'ที่นั่งเต็มจำนวนแล้ว',
    body: 'ผู้สมัครครบ 30 ที่นั่งแล้ว ติดตามประกาศรายชื่อสำรองได้ที่หน้าตรวจสอบสถานะ',
  },
  closed: {
    title: 'ปิดรับสมัครแล้ว',
    body: 'ปิดรับใบสมัครตามกำหนดการแล้ว หากมีข้อสงสัยติดต่อทีมงานผ่านเพจ Facebook ของโครงการ',
  },
  // AGENTS §8: when the server can't be reached, say so and offer a retry — never guess a state.
  error: {
    title: 'ตรวจสอบสถานะการรับสมัครไม่ได้ในขณะนี้',
    body: 'เชื่อมต่อระบบรับสมัครไม่สำเร็จ อาจเป็นเพราะสัญญาณอินเทอร์เน็ต ลองใหม่อีกครั้งในอีกสักครู่',
  },
};

const isTextEntry = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !['radio', 'checkbox', 'button', 'submit'].includes(el.type));

const timeText = (ms: number) =>
  new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });

/* Cloudflare Turnstile (bot check on submit). The public site key is inlined by Astro at build time.
   widget: render it and require a token. dev-skip: `astro dev` without a key, the API bypasses the
   check too. missing-key: a production build without a key can never pass the server's check. */
const TURNSTILE_SITE_KEY = String(import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();
const CAPTCHA_MODE: 'widget' | 'dev-skip' | 'missing-key' = TURNSTILE_SITE_KEY
  ? 'widget'
  : import.meta.env.DEV
    ? 'dev-skip'
    : 'missing-key';
const CAPTCHA_FAILED_MESSAGE = 'การยืนยันตัวตนไม่ผ่านหรือหมดอายุ กรุณายืนยันใหม่อีกครั้งแล้วกดส่งอีกครั้ง';
const CAPTCHA_MISSING_MESSAGE = 'ยังไม่ได้ยืนยันตัวตน กรุณารอให้ช่องยืนยันด้านบนขึ้นเครื่องหมายถูก แล้วกดส่งใบสมัครอีกครั้ง';
const CAPTCHA_UNAVAILABLE_MESSAGE = 'ระบบยืนยันตัวตนยังไม่พร้อมใช้งาน ใบสมัครจึงยังส่งไม่ได้ กรุณาแจ้งทีมงานค่าย';

/**
 * Thai copy for a failed submit. A connection failure is always safe to retry: the resend carries
 * the same X-Idempotency-Key, so the server returns the saved application instead of a duplicate.
 */
function describeSubmitError(err: unknown): string {
  if (err instanceof ApiHttpError) {
    switch (err.code) {
      case 'DUPLICATE_APPLICATION':
        return 'เลขบัตรประชาชน เบอร์โทรศัพท์ หรืออีเมลนี้เคยใช้สมัครแล้ว จึงไม่บันทึกใบสมัครซ้ำ ตรวจสอบใบสมัครเดิมได้ที่หน้าตรวจสอบสถานะ';
      case 'IDEMPOTENCY_KEY_REUSED':
        return 'แบบฟอร์มนี้ถูกใช้ส่งใบสมัครไปแล้วด้วยเลขบัตรประชาชนอื่น ตรวจสอบสถานะใบสมัครเดิม หรือกด “ล้างข้อมูลร่าง” เพื่อเริ่มใบสมัครใหม่';
      case 'RATE_LIMITED':
        return 'มีการส่งข้อมูลถี่เกินไป ข้อมูลที่กรอกยังอยู่ครบ กรุณารอสักครู่แล้วกดส่งอีกครั้ง';
      case 'QUOTA_FULL':
        return 'ที่นั่งเต็มจำนวนแล้ว (30 ที่นั่ง) ใบสมัครยังไม่ถูกบันทึก ติดตามประกาศรายชื่อสำรองได้ที่หน้าตรวจสอบสถานะ';
      case 'CAPTCHA_FAILED':
        return CAPTCHA_FAILED_MESSAGE;
      case 'SERVICE_UNAVAILABLE':
        // 503: the midnight queue timed out, settings were unreachable, or Cloudflare could not be
        // asked to verify the captcha. Nothing was saved.
        return 'ระบบยุ่งหรือตรวจสอบการยืนยันตัวตนไม่ได้ชั่วคราว (อาจมีผู้สมัครพร้อมกันจำนวนมาก) ใบสมัครยังไม่ถูกบันทึก ข้อมูลที่กรอกยังอยู่ครบ รอสักครู่แล้วกดส่งอีกครั้งได้เลย ระบบจะไม่บันทึกใบสมัครซ้ำ';
      case 'VALIDATION_ERROR':
        if (err.message.includes('national ID') || err.message.includes('check digit')) {
          return 'เลขประจำตัวประชาชน 13 หลักไม่ถูกต้อง กรุณาตรวจสอบตัวเลขอีกครั้ง';
        }
        if (err.message.includes('phone')) {
          return 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลักและขึ้นต้นด้วย 0';
        }
        if (err.message.includes('shirt')) {
          return 'ขนาดเสื้อไม่ถูกต้อง กรุณาเลือกไซส์ใหม่อีกครั้ง';
        }
        return 'ข้อมูลที่กรอกไม่ผ่านการตรวจสอบ กรุณาตรวจทานข้อมูลในแต่ละขั้นตอนแล้วลองส่งอีกครั้ง';
    }
    if (err.status === 403) return 'ระบบปิดรับใบสมัครในขณะนี้ ใบสมัครยังไม่ถูกบันทึก';
    if (err.status >= 400 && err.status < 500)
      return 'ระบบไม่รับข้อมูลบางส่วน ใบสมัครยังไม่ถูกบันทึก กรุณาตรวจทานข้อมูลแล้วลองส่งใหม่อีกครั้ง';
  }
  return 'ส่งใบสมัครไม่สำเร็จเนื่องจากการเชื่อมต่อขัดข้อง ข้อมูลที่กรอกยังอยู่ครบ กรุณากดส่งอีกครั้ง ระบบจะไม่บันทึกใบสมัครซ้ำ';
}

const ICON = { size: 18, strokeWidth: 1.5, 'aria-hidden': true } as const;

/* ───────────────────────── Theme toggle ─────────────────────────
   Same storage key / classes as SiteNav, so the choice carries across pages
   and the inline anti-FOUC script in BaseLayout keeps working. Icon swap is
   pure CSS (html.dark) so there is no flash before hydration. */
function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains('dark'));
    read();
    window.addEventListener('theme-changed', read);
    document.addEventListener('astro:after-swap', read);
    return () => {
      window.removeEventListener('theme-changed', read);
      document.removeEventListener('astro:after-swap', read);
    };
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
    try {
      localStorage.setItem('comcamp-theme', next ? 'dark' : 'light');
    } catch {
      /* storage blocked (private mode / in-app browser): the choice just won't persist */
    }
    window.dispatchEvent(new CustomEvent('theme-changed', { detail: { dark: next } }));
    setDark(next);
  }

  return (
    <button
      type="button"
      className="rw-theme"
      onClick={toggle}
      aria-pressed={dark}
      aria-label="สลับโหมดสว่าง/มืด (Light / Dark Mode)"
      title="สลับโหมดสว่าง/มืด"
    >
      <Sun className="rw-ic-sun" {...ICON} />
      <Moon className="rw-ic-moon" {...ICON} />
    </button>
  );
}

/* ───────────────────────── Sidebar stepper ───────────────────────── */

type StepState = 'active' | 'done' | 'visited' | 'upcoming';

function Stepper({
  current,
  furthest,
  locked,
  onJump,
}: {
  current: number;
  furthest: number;
  locked: boolean;
  onJump: (i: number) => void;
}) {
  const labels = [...STEPS.map((s) => s.label), RECEIPT_META.label];

  const stateOf = (i: number): StepState => {
    if (current < 0) return 'upcoming';
    if (i === current) return 'active';
    if (i < furthest) return 'done';
    if (i === furthest) return 'visited';
    return 'upcoming';
  };

  return (
    <ol className="rw-stepper">
      {labels.map((label, i) => {
        const state = stateOf(i);
        const clickable = !locked && (state === 'done' || state === 'visited');
        const dot = (
          <span className="rw-step__dot" aria-hidden="true">
            {state === 'done' ? <Check size={15} strokeWidth={2} /> : <span className="font-mono">{i + 1}</span>}
          </span>
        );
        return (
          <li key={label} className="rw-step" data-state={state}>
            {clickable ? (
              <button type="button" className="rw-step__row" onClick={() => onJump(i)}>
                {dot}
                <span className="rw-step__label">{label}</span>
                <span className="sr-only">{state === 'done' ? ' (เสร็จแล้ว กดเพื่อกลับไปแก้ไข)' : ' (กดเพื่อไปยังขั้นตอนนี้)'}</span>
              </button>
            ) : (
              <div className="rw-step__row" aria-current={state === 'active' ? 'step' : undefined}>
                {dot}
                <span className="rw-step__label">{label}</span>
                {state === 'done' && <span className="sr-only"> (เสร็จแล้ว)</span>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ───────────────────────── Review card ───────────────────────── */

function ReviewGroup({
  title,
  onEdit,
  rows,
}: {
  title: string;
  onEdit: () => void;
  rows: [string, ReactNode][];
}) {
  return (
    <section className="rw-group">
      <div className="rw-group__head">
        <h3 className="rw-group__title">{title}</h3>
        <button type="button" className="rw-textlink rw-textlink--btn" onClick={onEdit}>
          แก้ไข<span className="sr-only">{title}</span>
        </button>
      </div>
      <dl className="rw-dl">
        {rows.map(([k, v]) => (
          <div className="rw-dl__row" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const Empty = () => <span className="rw-muted">ไม่ได้กรอก</span>;

/* ───────────────────────── Wizard ───────────────────────── */

export function RegisterSection() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [consent, setConsent] = useState(false);
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appId, setAppId] = useState<string | null>(null);
  const [source, setSource] = useState<ApiSource | null>(null);
  const [gate, setGate] = useState<GateState>('checking');
  const [draftReady, setDraftReady] = useState(false);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [typing, setTyping] = useState(false);
  const [live, setLive] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const captchaRef = useRef<TurnstileFieldHandle>(null);
  /** Success notice after a self-service withdrawal. */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const noticeFocus = useRef(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const submittingRef = useRef(false);
  /** X-Idempotency-Key of the current attempt. Mirrors sessionStorage (register/storage.ts) and
      keeps working in memory where storage is blocked. Empty until the first submit. */
  const idemKeyRef = useRef('');
  const gateRun = useRef(0);
  const pending = useRef<{ field?: FieldKey; heading?: boolean } | null>(null);
  const isDev = Boolean(import.meta.env.DEV);

  /** Polite screen-reader announcement; a trailing NBSP forces a repeat of the same text to be re-read. */
  const announce = (msg: string) => setLive((prev) => (prev === msg ? `${msg} ` : msg));

  /* Registration gate — server-authoritative. Query overrides are dev-only. */
  const checkGate = useCallback(() => {
    const run = ++gateRun.current;
    setGate('checking');
    fetchPublicSettings()
      .then(({ settings, offsetMs, live: reachable }) => {
        if (run !== gateRun.current) return;
        if (!reachable) return setGate('error');
        const serverNow = Date.now() + offsetMs;
        const opensAt = new Date(settings.registrationOpenAt).getTime();
        const capacity = settings.maxCapacity && settings.maxCapacity > 0 ? settings.maxCapacity : SEATS;
        const remaining = Math.max(0, capacity - (settings.currentCount ?? 0));

        if (serverNow < opensAt && !settings.isOpen) setGate('pre_open');
        else if (remaining <= 0) setGate('full');
        else if (!settings.isOpen) setGate('closed');
        else setGate('open');
      })
      .catch(() => {
        if (run === gateRun.current) setGate('error');
      });
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) {
      const p = new URLSearchParams(window.location.search);
      const devState = p.get('dev') || p.get('state') || p.get('test');
      const forced: Record<string, GateState> = { open: 'open', true: 'open', full: 'full', closed: 'closed', pre_open: 'pre_open', error: 'error' };
      if (devState && forced[devState]) return setGate(forced[devState]);
    }
    checkGate();
    return () => {
      gateRun.current++; // ignore a response that lands after unmount
    };
  }, [checkGate]);

  /* Restore: a receipt from this tab wins; otherwise a ≤24h draft. Runs once, after hydration. */
  useEffect(() => {
    const receipt = loadReceipt();
    if (receipt) {
      setAppId(receipt.id);
      setSource(receipt.source);
      setStep(RECEIPT_STEP);
      setFurthest(RECEIPT_STEP);
    } else {
      const draft = loadDraft();
      // A submission still unanswered in this tab (refresh after a timeout) keeps its key, so
      // the retry is replayed instead of duplicated. A pre-v2.4 draft hands its key over too.
      const pendingKey = loadIdempotencyKey() ?? draft?.legacyKey ?? null;
      if (pendingKey) {
        idemKeyRef.current = pendingKey;
        saveIdempotencyKey(pendingKey);
      }
      if (draft) {
        setForm(draft.form);
        setRestoredAt(draft.savedAt);
        // Let the sidebar jump straight to the first step that still needs input.
        let reach = LAST_FORM_STEP;
        for (let i = 0; i < LAST_FORM_STEP; i++) {
          if (firstErrorKey(i, validateStep(i, draft.form, false))) {
            reach = i;
            break;
          }
        }
        setFurthest(reach);
      }
    }
    setDraftReady(true);
  }, []);

  /* Autosave (allowlisted fields only — see register/storage.ts). Stops once submitted. */
  useEffect(() => {
    if (!draftReady || appId) return;
    saveDraft(form);
  }, [form, draftReady, appId]);

  /* Focus management: move focus to the step heading after navigation, or to the
     first invalid field after a failed validation. Never steals focus on first mount. */
  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    if (target.field) document.getElementById(target.field)?.focus();
    else headingRef.current?.focus({ preventScroll: true });
  }, [step, errors, appId]);

  /* ── helpers ── */

  function show(next: number, focus: { field?: FieldKey; heading?: boolean }) {
    pending.current = focus;
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    // Only re-check a field that is already showing an error — never nag while typing.
    if (errors[key]) {
      const message = validateField(key, { ...form, [key]: value }, consent);
      setErrors((e) => ({ ...e, [key]: message }));
    }
  }

  function blur(key: FieldKey) {
    const message = validateField(key, form, consent);
    if (message && message !== errors[key]) announce(message);
    setErrors((e) => (e[key] === message ? e : { ...e, [key]: message }));
  }

  function failAt(i: number, errs: FieldErrors) {
    const bad = firstErrorKey(i, errs);
    const count = Object.values(errs).filter(Boolean).length;
    announce(count > 1 ? `ข้อมูลยังไม่ครบหรือไม่ถูกต้อง ${count} ช่อง` : 'ข้อมูลยังไม่ครบหรือไม่ถูกต้อง 1 ช่อง');
    setErrors(errs);
    setError(null);
    if (i === step) pending.current = { field: bad };
    else show(i, { field: bad });
  }

  /* ── navigation ── */

  function handleNext() {
    if (busy || submittingRef.current) return;
    if (gate !== 'open') {
      setError('ยังไม่เปิดรับสมัครในขณะนี้ กรุณาตรวจสอบอีกครั้งเมื่อถึงกำหนดเปิดรับ');
      return;
    }
    const errs = validateStep(step, form, consent);
    // The captcha is checked like the consent box: a clear inline message, never a silent no-op.
    const captchaMissing = step === LAST_FORM_STEP && CAPTCHA_MODE !== 'dev-skip' && !turnstileToken;
    if (captchaMissing) {
      setCaptchaError(CAPTCHA_MODE === 'missing-key' ? CAPTCHA_UNAVAILABLE_MESSAGE : CAPTCHA_MISSING_MESSAGE);
    }
    if (firstErrorKey(step, errs)) return failAt(step, errs);
    if (captchaMissing) {
      announce(CAPTCHA_MODE === 'missing-key' ? CAPTCHA_UNAVAILABLE_MESSAGE : CAPTCHA_MISSING_MESSAGE);
      captchaRef.current?.focus();
      return;
    }

    setErrors({});
    if (step === LAST_FORM_STEP) {
      void submit();
      return;
    }
    const next = returnTo ?? step + 1;
    setReturnTo(null);
    setFurthest((f) => Math.max(f, next));
    show(next, { heading: true });
  }

  function goBack() {
    if (step === 0) return;
    setReturnTo(null);
    setErrors({});
    show(step - 1, { heading: true });
  }

  /** Sidebar jump. Backwards is free; forwards re-validates every step in between. */
  function goTo(target: number) {
    if (appId || gate !== 'open' || target === step || target > furthest) return;
    for (let i = step; i < target; i++) {
      const errs = validateStep(i, form, consent);
      if (firstErrorKey(i, errs)) return failAt(i, errs); // blocked: keep returnTo so the user still lands on review
    }
    setReturnTo(null);
    setErrors({});
    show(target, { heading: true });
  }

  function editFromReview(i: number) {
    setReturnTo(LAST_FORM_STEP);
    setErrors({});
    show(i, { heading: true });
  }

  /* ── submit ── */

  async function submit() {
    if (submittingRef.current) return;

    // Re-check every step: a step revisited from the sidebar may have been edited into an invalid state.
    for (let i = 0; i <= LAST_FORM_STEP; i++) {
      const errs = validateStep(i, form, consent);
      if (firstErrorKey(i, errs)) return failAt(i, errs);
    }

    submittingRef.current = true; // ref, not state: blocks a double tap before React re-renders
    setBusy(true);
    setError(null);
    setCaptchaError(null);

    const finish = (app: Application, src: ApiSource) => {
      // Answered (201, or 200 replay): the attempt is settled; a next application gets a new key.
      clearIdempotencyKey();
      idemKeyRef.current = '';
      clearDraft();
      setNotice(null);
      saveReceipt(app.id, src);
      pending.current = { heading: true };
      setAppId(app.id);
      setSource(src);
      setStep(RECEIPT_STEP);
      setFurthest(RECEIPT_STEP);
      window.scrollTo({ top: 0 });
    };

    try {
      const payload: ApplicationPayload = {
        fullName: form.fullName.trim(),
        nickname: form.nickname.trim(),
        // Digits only: drops zero-width characters and hyphens pasted from LINE (§9.2.2).
        nationalId: sanitizeDigits(form.nationalId),
        phone: sanitizeDigits(form.phone),
        email: form.email.trim(),
        school: form.school.trim(),
        province: form.province.trim(),
        grade: gradeValue(form),
        shirtSize: form.shirtSize as ShirtSize,
        motivation: form.motivation.trim(),
        turnstileToken: turnstileToken || undefined,
      };
      // Same key on every retry: if an earlier attempt was saved but its answer was lost (timeout,
      // dropped connection, 5xx), the server returns that application (200, Idempotent-Replayed)
      // instead of a duplicate. Written to sessionStorage before sending, so a refresh while the
      // request is in flight still retries with it.
      if (!idemKeyRef.current) idemKeyRef.current = loadIdempotencyKey() ?? newIdempotencyKey();
      saveIdempotencyKey(idemKeyRef.current);
      const res = await submitApplication(payload, idemKeyRef.current);
      finish(res.data, res.source);
    } catch (err) {
      // Turnstile tokens are single-use and the server may already have spent this one, so every
      // failure asks for a fresh token. The idempotency key is unchanged: if the failed attempt
      // was in fact saved, the next send is answered as a replay without a captcha.
      setTurnstileToken('');
      captchaRef.current?.reset();
      if (err instanceof ApiHttpError && err.code === 'CAPTCHA_FAILED') {
        setCaptchaError(CAPTCHA_FAILED_MESSAGE);
        announce(CAPTCHA_FAILED_MESSAGE);
      } else {
        setError(describeSubmitError(err));
        window.scrollTo({ top: 0 });
      }
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  function onFormSubmit(ev: FormEvent) {
    ev.preventDefault(); // Enter in any single-line field lands here
    handleNext();
  }

  function onTextareaKey(ev: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter must stay a newline in a textarea; Ctrl/Cmd+Enter advances.
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      handleNext();
    }
  }

  function fillMockData() {
    setForm(MOCK_FORM);
    setConsent(true);
    setErrors({});
    setError(null);
  }

  function clearAll() {
    clearDraft();
    // Starting over is a new application: the next submit generates a new key.
    clearIdempotencyKey();
    idemKeyRef.current = '';
    setForm(EMPTY_FORM);
    setConsent(false);
    setErrors({});
    setError(null);
    setFurthest(0);
    setReturnTo(null);
    setRestoredAt(null);
    setConfirmClear(false);
    announce('ล้างข้อมูลร่างแล้ว');
    pending.current = { field: 'fullName' };
    setStep(0);
  }

  /** The applicant withdrew from the receipt: the seat is free, so start over with a clean form. */
  function onWithdrawn(id: string) {
    clearReceipt();
    clearIdempotencyKey();
    idemKeyRef.current = '';
    clearDraft();
    setForm(EMPTY_FORM);
    setConsent(false);
    setErrors({});
    setError(null);
    setFurthest(0);
    setReturnTo(null);
    setRestoredAt(null);
    setConfirmClear(false);
    setAppId(null);
    setSource(null);
    setStep(0);
    noticeFocus.current = true;
    setNotice(`ยกเลิกใบสมัคร ${id} เรียบร้อยแล้ว คืนโควตาที่นั่งแล้ว คุณสามารถเริ่มต้นสมัครใหม่ได้ทันที`);
    window.scrollTo({ top: 0 });
    checkGate(); // the freed seat may reopen a full camp
  }

  /* The receipt (and the focused button) is gone: move focus to the notice that replaced it, once
     the gate re-check has settled (the notice re-mounts when the view switches to the form). */
  useEffect(() => {
    if (!notice || !noticeFocus.current || gate === 'checking') return;
    noticeFocus.current = false;
    noticeRef.current?.focus({ preventScroll: true });
  }, [notice, gate]);

  /* Phones: while the keyboard is up, let the top bar scroll away so the field keeps the room. */
  function onFormFocus(ev: FocusEvent<HTMLFormElement>) {
    if (isTextEntry(ev.target)) setTyping(true);
  }
  function onFormBlur(ev: FocusEvent<HTMLFormElement>) {
    if (!isTextEntry(ev.relatedTarget)) setTyping(false);
  }

  /* ── derived view state ── */

  const wizard = gate === 'open' && appId === null;
  const stepNo = Math.min(step, LAST_FORM_STEP);
  const current = gate === 'open' || appId ? step : -1;
  // One scale everywhere: the sidebar shows 6 steps (5 form steps + payment), so does the phone bar.
  const percent = current < 0 ? 0 : Math.round(((current + 1) / TOTAL_STEPS) * 100);
  const stepOfText = `ขั้นตอน ${current + 1} จาก ${TOTAL_STEPS}`;
  const nextLabel = busy
    ? 'กำลังส่งข้อมูล…'
    : step === LAST_FORM_STEP
      ? 'ส่งใบสมัคร'
      : returnTo !== null
        ? 'กลับไปตรวจทาน'
        : 'ถัดไป';

  const progressText: ReactNode =
    current < 0 ? (
      'สมัครเข้าร่วมค่าย'
    ) : (
      <>
        ขั้นตอน <span className="font-mono">{current + 1}/{TOTAL_STEPS}</span>
        {' · '}
        {appId ? RECEIPT_META.label : STEPS[step].label}
      </>
    );

  /* ───────────────────────── Step bodies ───────────────────────── */

  const formIsEmpty = JSON.stringify(form) === JSON.stringify(EMPTY_FORM);

  function renderStep(): ReactNode {
    switch (step) {
      case 0:
        return (
          <>
          <div className="rw-draft">
            {confirmClear ? (
              <>
                <p className="rw-draft__text">ล้างข้อมูลที่กรอกไว้ทั้งหมดใช่ไหม</p>
                <div className="rw-draft__actions">
                  <button type="button" className="rw-textlink rw-textlink--btn rw-textlink--danger" onClick={clearAll}>
                    ยืนยันล้างข้อมูล
                  </button>
                  <button type="button" className="rw-textlink rw-textlink--btn" onClick={() => setConfirmClear(false)}>
                    ยกเลิก
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="rw-draft__text">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.5" />
                    <path d="M8 4.5V8l2.2 1.4" />
                  </svg>
                  <span>
                  {restoredAt ? (
                    <>
                      กู้คืนข้อมูลที่กรอกค้างไว้ (บันทึกเมื่อ <span className="font-mono">{timeText(restoredAt)}</span> น.)
                      {' '}เลขบัตรประชาชนไม่ถูกบันทึกในเครื่องตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล (PDPA) กรุณากรอกอีกครั้ง
                    </>
                  ) : (
                    'ข้อมูลที่กรอกจะบันทึกเป็นร่างไว้ในเครื่องนี้ 24 ชม. ยกเว้นเลขบัตรประชาชนและข้อมูลสุขภาพตาม PDPA'
                  )}
                  </span>
                </p>
                {!formIsEmpty && (
                  <button type="button" className="rw-textlink rw-textlink--btn rw-textlink--quiet" onClick={() => setConfirmClear(true)}>
                    ล้างข้อมูลร่าง
                  </button>
                )}
              </>
            )}
          </div>
          <div className="rw-fields">
            <TextField
              id="fullName"
              label="ชื่อ-นามสกุล"
              span={4}
              value={form.fullName}
              error={errors.fullName}
              onChange={(v) => set('fullName', v)}
              onBlur={() => blur('fullName')}
              autoComplete="name"
              placeholder="เช่น สมชาย ใจดี"
            />
            <TextField
              id="nickname"
              label="ชื่อเล่น"
              span={2}
              value={form.nickname}
              error={errors.nickname}
              onChange={(v) => set('nickname', v)}
              onBlur={() => blur('nickname')}
              autoComplete="nickname"
              placeholder="เช่น ชาย"
            />
            <TextField
              id="nationalId"
              label="เลขบัตรประชาชน"
              hint={<span className={form.nationalId.length === 13 ? 'rw-hint--ok' : undefined}><span className="font-mono">{form.nationalId.length}/13</span> หลัก</span>}
              groups={[1, 4, 5, 2, 1]}
              span={3}
              mono
              digits={13}
              inputMode="numeric"
              autoComplete="off"
              value={form.nationalId}
              error={errors.nationalId}
              onChange={(v) => set('nationalId', v)}
              onBlur={() => blur('nationalId')}
              placeholder="X-XXXX-XXXXX-XX-X"
            />
            <TextField
              id="phone"
              label="เบอร์โทรศัพท์มือถือ"
              hint={<span className={form.phone.length === 10 ? 'rw-hint--ok' : undefined}><span className="font-mono">{form.phone.length}/10</span> หลัก</span>}
              groups={[3, 3, 4]}
              span={3}
              mono
              digits={10}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={form.phone}
              error={errors.phone}
              onChange={(v) => set('phone', v)}
              onBlur={() => blur('phone')}
              placeholder="08X-XXX-XXXX"
            />
            <TextField
              id="email"
              label="อีเมล"
              hint="ไม่บังคับ"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={form.email}
              error={errors.email}
              onChange={(v) => set('email', v)}
              onBlur={() => blur('email')}
              placeholder="name@example.com"
            />
          </div>
          </>
        );

      case 1:
        return (
          <div className="rw-fields">
            <TextField
              id="school"
              label="โรงเรียน / สถานศึกษา"
              autoComplete="organization"
              value={form.school}
              error={errors.school}
              onChange={(v) => set('school', v)}
              onBlur={() => blur('school')}
              placeholder="ชื่อโรงเรียน"
            />
            <TextField
              id="province"
              label="จังหวัด"
              span={3}
              autoComplete="address-level1"
              value={form.province}
              error={errors.province}
              onChange={(v) => set('province', v)}
              onBlur={() => blur('province')}
              placeholder="เช่น เชียงใหม่"
            />
            <FieldShell id="grade" label="ระดับชั้น" span={3} error={errors.grade}>
              <select
                id="grade"
                name="grade"
                className={`rw-input rw-select${form.grade ? '' : ' is-empty'}`}
                value={form.grade}
                onChange={(e) => set('grade', e.target.value)}
                onBlur={() => blur('grade')}
                aria-invalid={errors.grade ? true : undefined}
                aria-describedby={errors.grade ? 'grade-err' : undefined}
              >
                <option value="" disabled>
                  เลือกระดับชั้น
                </option>
                {GRADES.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                <option value={GRADE_OTHER}>{GRADE_OTHER} (ระบุเอง)</option>
              </select>
            </FieldShell>
            {form.grade === GRADE_OTHER && (
              <TextField
                id="gradeOther"
                label="ระบุระดับชั้น"
                hint={<span className="font-mono">{form.gradeOther.trim().length}/{GRADE_OTHER_MAX}</span>}
                span={6}
                value={form.gradeOther}
                error={errors.gradeOther}
                onChange={(v) => set('gradeOther', v)}
                onBlur={() => blur('gradeOther')}
                placeholder="เช่น ปวส.1, ม.3, กำลังรอเข้าเรียน"
              />
            )}
          </div>
        );

      case 2:
        return (
          <div className="rw-fields">
            <div className="rw-field rw-span-6">
              <fieldset className="rw-fieldset">
                <legend className="rw-label">
                  <span>ไซส์เสื้อ</span>
                </legend>
                <SizeChips value={form.shirtSize} invalid={Boolean(errors.shirtSize)} onChange={(v) => set('shirtSize', v)} />
                {errors.shirtSize && (
                  <p id="shirtSize-err" className="rw-err">
                    {errors.shirtSize}
                  </p>
                )}
              </fieldset>
            </div>

            <div className="rw-field rw-span-6">
              {/* TODO(content): รอประกาศอย่างเป็นทางการ — ตารางรอบอกของไซส์ XS / 2XL / 3XL (ดู SIZE_CHEST ใน register/model.ts) */}
              <table className="rw-table">
                <caption>ตารางขนาดเสื้อค่าย</caption>
                <thead>
                  <tr>
                    <th scope="col">ไซส์</th>
                    <th scope="col">รอบอก (นิ้ว)</th>
                  </tr>
                </thead>
                <tbody>
                  {SHIRT_SIZES.map((s) => (
                    <tr key={s} data-selected={form.shirtSize === s ? 'true' : undefined}>
                      <th scope="row">
                        <span className="font-mono">{s}</span>
                      </th>
                      <td>
                        {SIZE_CHEST[s] !== null ? (
                          <span className="font-mono">{SIZE_CHEST[s]}</span>
                        ) : (
                          <span className="rw-todo">รอประกาศ</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );

      case 3:
        return (
          <div className="rw-fields">
            <FieldShell id="motivation" label="ความสนใจด้าน IoT / ไมโครคอนโทรลเลอร์" hint="ไม่บังคับ">
              <textarea
                id="motivation"
                name="motivation"
                className="rw-input rw-textarea"
                rows={7}
                value={form.motivation}
                onChange={(e) => set('motivation', e.target.value)}
                onKeyDown={onTextareaKey}
                placeholder="เช่น อยากลองต่อวงจรเซนเซอร์ หรืออยากทำหน้าเว็บสั่งงานบอร์ดผ่านมือถือ"
              />
            </FieldShell>
          </div>
        );

      default:
        return (
          <>
            <div className="rw-card">
              <ReviewGroup
                title="ข้อมูลผู้สมัคร"
                onEdit={() => editFromReview(0)}
                rows={[
                  ['ชื่อ-นามสกุล', form.fullName.trim()],
                  ['ชื่อเล่น', form.nickname.trim()],
                  ['เลขบัตรประชาชน', <span className="font-mono" key="nid">{formatNationalId(form.nationalId)}</span>],
                  ['เบอร์โทรศัพท์', <span className="font-mono" key="ph">{formatPhone(form.phone)}</span>],
                  ['อีเมล', form.email.trim() || <Empty key="em" />],
                ]}
              />
              <ReviewGroup
                title="ข้อมูลการศึกษา"
                onEdit={() => editFromReview(1)}
                rows={[
                  ['สถานศึกษา', form.school.trim()],
                  ['จังหวัด', form.province.trim()],
                  ['ระดับชั้น', gradeValue(form)],
                ]}
              />
              <ReviewGroup
                title="เสื้อค่าย"
                onEdit={() => editFromReview(2)}
                rows={[['ไซส์', <span className="font-mono" key="sz">{form.shirtSize}</span>]]}
              />
              <ReviewGroup
                title="แรงบันดาลใจ"
                onEdit={() => editFromReview(3)}
                rows={[['ความสนใจ', form.motivation.trim() ? <span className="rw-pre" key="mo">{form.motivation.trim()}</span> : <Empty key="mo" />]]}
              />
            </div>

            <section className="rw-fee" aria-labelledby="rw-fee-title">
              <div className="rw-fee__head">
                <h3 id="rw-fee-title" className="rw-fee__title">
                  ขั้นตอนรับสิทธิ์และค่าสมัครเข้าร่วมค่าย
                </h3>
                <p className="rw-fee__amount">
                  <span className="font-mono tabular-nums">{FEE_TEXT}</span> บาท
                </p>
              </div>
              <ol className="rw-fee__steps">
                <li>
                  <strong>ส่งใบสมัครเพื่อรับสิทธิ์ทันที</strong>
                  มาก่อนได้ก่อน จำกัด <span className="font-mono tabular-nums">{SEATS}</span> ที่นั่ง เมื่อส่งสำเร็จจะได้รหัส{' '}
                  <span className="font-mono">CC25-XXXXXX</span>
                </li>
                <li>
                  <strong>
                    โอนค่าสมัคร <span className="font-mono tabular-nums">{FEE_TEXT}</span> บาท หลังส่งใบสมัคร
                  </strong>
                  หน้าถัดไปจะแสดงเลขบัญชีธนาคารสำหรับโอน (ไม่มี QR Code) ยังไม่ต้องโอนก่อนกดส่ง
                </li>
                <li>
                  <strong>แนบสลิปเพื่อยืนยันสิทธิ์สมบูรณ์</strong>
                  อัปโหลดต่อได้ทันทีในหน้าใบตอบรับหลังกดส่ง หรือส่งทีหลังที่หน้าตรวจสอบสถานะ (<span className="font-mono">/status</span>)
                </li>
              </ol>
            </section>

            <label className="rw-consent" htmlFor="consent">
              <input
                id="consent"
                name="consent"
                type="checkbox"
                checked={consent}
                onChange={(e) => {
                  setConsent(e.target.checked);
                  if (errors.consent) setErrors((x) => ({ ...x, consent: undefined }));
                }}
                aria-invalid={errors.consent ? true : undefined}
                aria-describedby={errors.consent ? 'consent-err' : undefined}
              />
              <span>
                ข้าพเจ้ายินยอมให้โครงการเก็บและใช้ข้อมูลส่วนบุคคลข้างต้น เพื่อการคัดเลือก ติดต่อประสานงาน และดำเนินกิจกรรมค่ายเท่านั้น
                และรับทราบรายละเอียดค่าสมัคร <span className="font-mono tabular-nums">{FEE_TEXT}</span> บาท (ชำระหลังส่งใบสมัคร)
              </span>
            </label>
            {/* Outside the label so the error isn't folded into the checkbox's accessible name. */}
            {errors.consent && (
              <p id="consent-err" className="rw-err rw-consent__err">
                {errors.consent}
              </p>
            )}

            {CAPTCHA_MODE === 'widget' && (
              <TurnstileField
                ref={captchaRef}
                siteKey={TURNSTILE_SITE_KEY}
                errorId="captcha-err"
                error={captchaError}
                onToken={(token) => {
                  setTurnstileToken(token ?? '');
                  // Only the "verify first" hint clears itself; a rejection message stays until the next send.
                  if (token) setCaptchaError((e) => (e === CAPTCHA_MISSING_MESSAGE ? null : e));
                }}
              />
            )}
            {CAPTCHA_MODE === 'dev-skip' && (
              <p className="rw-captcha__hint rw-captcha__hint--dev">
                [DEV] ยังไม่ได้ตั้ง <span className="font-mono">PUBLIC_TURNSTILE_SITE_KEY</span> จึงข้ามการยืนยันตัวตน (เซิร์ฟเวอร์ dev ที่ไม่มี secret ก็ข้ามเช่นกัน)
              </p>
            )}
            {CAPTCHA_MODE === 'missing-key' && (
              <p id="captcha-err" className="rw-err" role="alert">
                {CAPTCHA_UNAVAILABLE_MESSAGE}
              </p>
            )}
          </>
        );
    }
  }

  /* ───────────────────────── Shared bits ───────────────────────── */

  const devBar = isDev && (
    <aside className="rw-dev" aria-label="Developer testing toolbar">
      <div className="rw-dev__state">
        <strong>[DEV MODE]</strong>
        <span>
          สถานะ Gate: <b>{gate}</b>
        </span>
      </div>
      <div className="rw-dev__actions">
        <button type="button" data-on={gate === 'open'} onClick={() => setGate('open')}>
          เปิดฟอร์ม (Open)
        </button>
        <button type="button" data-on={gate === 'pre_open'} onClick={() => setGate('pre_open')}>
          ยังไม่เปิด (Pre-open)
        </button>
        <button type="button" data-on={gate === 'full'} onClick={() => setGate('full')}>
          เต็มแล้ว (Full)
        </button>
        {gate === 'open' && !appId && (
          <button type="button" className="rw-dev__fill" onClick={fillMockData}>
            เติมข้อมูลตัวอย่าง (Auto-fill)
          </button>
        )}
      </div>
    </aside>
  );

  const errorBanner = error && (
    <div className="rw-banner" role="alert">
      <p>
        <TriangleAlert {...ICON} />
        <span>{error}</span>
      </p>
      <button type="button" className="rw-textlink rw-textlink--btn" onClick={() => setError(null)}>
        ปิด
      </button>
    </div>
  );

  const noticeBanner = notice && (
    <div ref={noticeRef} className="rw-banner rw-banner--ok" role="status" tabIndex={-1}>
      <p>
        <Check {...ICON} />
        <span>{notice}</span>
      </p>
      <button type="button" className="rw-textlink rw-textlink--btn" onClick={() => setNotice(null)}>
        ปิด
      </button>
    </div>
  );

  return (
    <div className={`rw${typing ? ' is-typing' : ''}`}>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      <a className="rw-skip" href="#rw-content">
        ข้ามไปยังเนื้อหาหลัก
      </a>

      <aside className="rw-side" aria-label="ความคืบหน้าการสมัคร">
        <div className="rw-side__top">
          <a className="rw-back" href="/">
            <ArrowLeft {...ICON} />
            <span>กลับหน้าหลัก</span>
          </a>
          <ThemeToggle />
        </div>

        <div className="rw-side__brand">
          <img className="rw-side__logo" src="/assets/logo/comcamp25-logo-sm.png" alt="" width="42" height="30" decoding="async" />
          <h1 className="rw-side__title">สมัครเข้าร่วมค่าย</h1>
          <p className="rw-side__sub">
            ComCamp <span className="font-mono">#25</span> · <span className="nowrap">มหาวิทยาลัยแม่โจ้</span>
          </p>
        </div>

        {/* Mobile: compact progress meter (the vertical stepper below is desktop-only) */}
        <div className="rw-prog">
          <div className="rw-prog__row">
            <span className="rw-prog__label">{progressText}</span>
            <span className="rw-prog__pct font-mono">{percent}%</span>
          </div>
          <div
            className="rw-prog__bar"
            role="progressbar"
            aria-label="ความคืบหน้าการสมัคร"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={current < 0 ? 'ยังไม่เริ่ม' : stepOfText}
          >
            <i style={{ ['--p' as string]: percent / 100 }} />
          </div>
        </div>

        <Stepper current={current} furthest={furthest} locked={Boolean(appId) || gate !== 'open'} onJump={goTo} />

        <p className="rw-colophon">
          <span className="nowrap">
            ComCamp <span className="font-mono">#25</span> · <span className="font-mono">{SEATS}</span> ที่นั่ง
          </span>{' '}
          ·{' '}
          <span className="nowrap">
            ค่าสมัคร <span className="font-mono">{FEE_TEXT}</span> บาท
          </span>
        </p>
      </aside>

      {wizard ? (
        <form
          className="rw-main"
          onSubmit={onFormSubmit}
          onFocus={onFormFocus}
          onBlur={onFormBlur}
          noValidate
          aria-label={`แบบฟอร์มสมัครค่าย ${stepOfText}`}
        >
          <div className="rw-content" id="rw-content" tabIndex={-1}>
            {devBar}
            {noticeBanner}
            {errorBanner}
            <div className="rw-step-view" key={step}>
              <StepHeader no={stepNo + 1} title={STEPS[stepNo].title} lead={STEPS[stepNo].lead} headingRef={headingRef} />
              <div className="rw-body">{renderStep()}</div>
            </div>
          </div>

          <div className="rw-foot">
            <div className="rw-foot__inner">
              {step > 0 && (
                <button type="button" className="rw-btn rw-btn--ghost" onClick={goBack} disabled={busy}>
                  <ArrowLeft {...ICON} />
                  ย้อนกลับ
                </button>
              )}
              <button
                type="submit"
                className={`rw-btn ${step === LAST_FORM_STEP ? 'rw-btn--submit' : 'rw-btn--primary'} rw-btn--next`}
                // Not `disabled`: a tap before ticking the consent still runs handleNext(), which
                // moves focus to #consent and shows its message instead of failing silently.
                aria-disabled={
                  step === LAST_FORM_STEP && (!consent || (CAPTCHA_MODE !== 'dev-skip' && !turnstileToken)) ? true : undefined
                }
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {nextLabel}
                {!busy && <ArrowRight {...ICON} />}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="rw-main">
          <div className="rw-content" id="rw-content" tabIndex={-1}>
            {devBar}
            {noticeBanner}
            {errorBanner}
            {appId ? (
              <Receipt appId={appId} source={source} showSource={isDev} headingRef={headingRef} onWithdrawn={onWithdrawn} />
            ) : gate === 'checking' ? (
              <p className="rw-checking" role="status">
                กำลังตรวจสอบสถานะการรับสมัคร…
              </p>
            ) : (
              <section className="rw-gate" role="status">
                <h2 className="rw-gate__title">{GATE_COPY[gate as Exclude<GateState, 'checking' | 'open'>].title}</h2>
                <p className="rw-gate__body">{GATE_COPY[gate as Exclude<GateState, 'checking' | 'open'>].body}</p>
                <div className="rw-actions rw-actions--tight">
                  {gate === 'error' && (
                    <button type="button" className="rw-btn rw-btn--primary rw-btn--sm" onClick={checkGate}>
                      <RotateCw {...ICON} />
                      ลองใหม่อีกครั้ง
                    </button>
                  )}
                  <a href="/status" className="rw-textlink">
                    ตรวจสอบสถานะใบสมัคร
                  </a>
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
