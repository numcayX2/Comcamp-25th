/**
 * /sponsor — public sponsor inquiry form.
 *
 * - Every value lives in React state only: nothing is written to localStorage, sessionStorage or
 *   cookies (AGENTS.md §9.2 / §13.5).
 * - Synchronous useRef lock + disabled + aria-busy stop a double submit; there is no idempotency
 *   key here because a repeated inquiry is harmless and the server owns deduplication.
 * - Turnstile follows RegisterSection exactly: widget / dev-skip / missing-key.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Send, TriangleAlert } from 'lucide-react';
import {
  ApiHttpError,
  SPONSOR_DETAILS_MAX,
  SPONSOR_KIND_LABELS,
  SPONSOR_NAME_MAX,
  sanitizeDigits,
  stripZeroWidth,
  submitSponsorInquiry,
  type SponsorKind,
} from '../lib/api';
import { TurnstileField, type TurnstileFieldHandle } from './register/TurnstileField';

const TURNSTILE_SITE_KEY = String(import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();
const CAPTCHA_MODE: 'widget' | 'dev-skip' | 'missing-key' = TURNSTILE_SITE_KEY
  ? 'widget'
  : import.meta.env.DEV
    ? 'dev-skip'
    : 'missing-key';

const CAPTCHA_MISSING_MESSAGE =
  'ยังไม่ได้ยืนยันตัวตน กรุณารอให้ช่องยืนยันด้านบนขึ้นเครื่องหมายถูก แล้วกดส่งอีกครั้ง';
const CAPTCHA_FAILED_MESSAGE =
  'การยืนยันตัวตนไม่ผ่านหรือหมดอายุ กรุณายืนยันใหม่อีกครั้งแล้วกดส่งอีกครั้ง';
const CAPTCHA_UNAVAILABLE_MESSAGE =
  'ระบบยืนยันตัวตนยังไม่พร้อมใช้งาน จึงยังส่งข้อมูลไม่ได้ กรุณาโทรหาพี่ค่าย';
const SEND_FAILED_MESSAGE = 'ส่งไม่สำเร็จ กรุณาลองใหม่ หรือโทรหาพี่ค่าย';
const VALIDATION_FAILED_MESSAGE = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';

const KIND_OPTIONS: SponsorKind[] = ['money', 'goods'];

type FieldKey = 'name' | 'phone' | 'email' | 'kind';
type FieldErrors = Partial<Record<FieldKey, ReactNode>>;

function emailError(value: string): ReactNode | undefined {
  const email = stripZeroWidth(value).trim();
  if (!email) return undefined;

  const at = email.indexOf('@');
  const local = at >= 0 ? email.slice(0, at) : '';
  const domain = at >= 0 ? email.slice(at + 1) : '';
  const invalid =
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.includes('..') ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.');

  if (!invalid) return undefined;
  return (
    <>
      รูปแบบอีเมลไม่ถูกต้อง เช่น <span className="font-mono">name@example.com</span>
    </>
  );
}

function errorMessage(err: unknown): ReactNode {
  if (err instanceof ApiHttpError) {
    if (err.code === 'VALIDATION_ERROR') return VALIDATION_FAILED_MESSAGE;
    if (err.code === 'CAPTCHA_FAILED') return CAPTCHA_FAILED_MESSAGE;
    if (err.code === 'RATE_LIMITED') {
      const seconds = err.retryAfterSeconds;
      if (typeof seconds === 'number' && seconds > 0) {
        return (
          <>
            ส่งบ่อยเกินไป กรุณารอ <span className="font-mono tabular-nums">{seconds}</span> วินาที
          </>
        );
      }
      return 'ส่งบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    }
  }
  return SEND_FAILED_MESSAGE;
}

export default function SponsorInquiryForm() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<SponsorKind | ''>('');
  const [details, setDetails] = useState('');
  const [website, setWebsite] = useState('');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<ReactNode | null>(null);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const busyRef = useRef(false);
  const focusFormOnReset = useRef(false);
  const captchaRef = useRef<TurnstileFieldHandle>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done) {
      successRef.current?.focus();
    } else if (focusFormOnReset.current) {
      focusFormOnReset.current = false;
      nameRef.current?.focus();
    }
  }, [done]);

  useEffect(() => {
    setHydrated(true);
  }, []);

  function clearError(key: FieldKey) {
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  function firstInvalidField(next: FieldErrors): HTMLElement | null {
    if (next.name) return nameRef.current;
    if (next.phone) return phoneRef.current;
    if (next.email) return emailRef.current;
    if (next.kind) return kindRef.current;
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;

    const cleanName = stripZeroWidth(name).trim();
    const digits = sanitizeDigits(phone);
    const next: FieldErrors = {};

    if (!cleanName) {
      next.name = 'กรุณากรอกชื่อผู้สนับสนุน ร้าน หรือบริษัท';
    } else if (cleanName.length > SPONSOR_NAME_MAX) {
      next.name = 'ชื่อผู้สนับสนุนยาวเกินกำหนด';
    }

    if (!digits) {
      next.phone = (
        <>
          กรุณากรอกเบอร์โทรศัพท์มือถือ <span className="font-mono tabular-nums">10</span> หลัก
        </>
      );
    } else if (!/^0\d{9}$/.test(digits)) {
      next.phone = (
        <>
          เบอร์โทรต้องเป็นตัวเลข <span className="font-mono tabular-nums">10</span> หลักและขึ้นต้นด้วย{' '}
          <span className="font-mono tabular-nums">0</span>
        </>
      );
    }

    const mailError = emailError(email);
    if (mailError) next.email = mailError;
    if (!kind) next.kind = 'กรุณาเลือกประเภทการสนับสนุน';

    setErrors(next);
    setFormError(null);

    const firstInvalid = firstInvalidField(next);
    if (firstInvalid) {
      requestAnimationFrame(() => firstInvalid.focus());
      return;
    }

    if (!kind) return;

    if (CAPTCHA_MODE === 'missing-key') return;

    if (CAPTCHA_MODE === 'widget' && !turnstileToken) {
      setCaptchaError(CAPTCHA_MISSING_MESSAGE);
      captchaRef.current?.focus();
      return;
    }

    busyRef.current = true;
    setBusy(true);

    try {
      await submitSponsorInquiry({
        name: cleanName,
        phone: digits,
        email: stripZeroWidth(email).trim(),
        kind,
        details: stripZeroWidth(details).trim(),
        turnstileToken,
        website,
      });
      setDone(true);
    } catch (err) {
      const captchaFailed = err instanceof ApiHttpError && err.code === 'CAPTCHA_FAILED';
      setFormError(captchaFailed ? null : errorMessage(err));
      captchaRef.current?.reset();
      if (captchaFailed) {
        setCaptchaError(CAPTCHA_FAILED_MESSAGE);
        captchaRef.current?.focus();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function resetForm() {
    setName('');
    setPhone('');
    setEmail('');
    setKind('');
    setDetails('');
    setWebsite('');
    setErrors({});
    setFormError(null);
    setCaptchaError(null);
    setTurnstileToken('');
    focusFormOnReset.current = true;
    setDone(false);
  }

  return (
    <div className="sp-inquiry">
      <h2 id="sp-inquiry-title" className="sp-h2">
        แจ้งความประสงค์สนับสนุน
      </h2>
      <p className="sp-inquiry__lead">
        กรอกข้อมูลติดต่อและประเภทการสนับสนุน พี่ค่ายจะติดต่อกลับเพื่อยืนยันรายละเอียดและนัดหมายขั้นตอนถัดไป
      </p>

      {done ? (
        <div
          className="sp-success"
          ref={successRef}
          tabIndex={-1}
          aria-labelledby="sp-success-title"
          aria-describedby="sp-success-text"
        >
          <span className="sp-success__mark" aria-hidden="true">
            <Check size={16} strokeWidth={1.5} />
          </span>
          <h3 id="sp-success-title" className="sp-success__title">
            ได้รับข้อมูลแล้ว
          </h3>
          <p id="sp-success-text" className="sp-success__text">
            พี่ค่ายจะติดต่อกลับทางเบอร์ที่ให้ไว้
          </p>
          <button type="button" className="sp-btn sp-btn--secondary" onClick={resetForm}>
            ส่งอีกครั้ง
          </button>
        </div>
      ) : (
        <form className="sp-form" method="post" noValidate onSubmit={handleSubmit} aria-labelledby="sp-inquiry-title">
          <div className="sp-hp" aria-hidden="true">
            <label htmlFor="sp-website">Website</label>
            <input
              id="sp-website"
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </div>

          <div className="sp-field sp-field--full">
            <label className="sp-label" htmlFor="sp-name">
              <span>
                ชื่อผู้สนับสนุน / ร้าน / บริษัท <span className="sp-req" aria-hidden="true">*</span>
                <span className="sr-only"> (จำเป็น)</span>
              </span>
            </label>
            <input
              id="sp-name"
              name="name"
              ref={nameRef}
              className="sp-input"
              type="text"
              autoComplete="organization"
              maxLength={SPONSOR_NAME_MAX}
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                clearError('name');
              }}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'sp-name-err' : undefined}
            />
            {errors.name && (
              <p id="sp-name-err" className="sp-error">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>{errors.name}</span>
              </p>
            )}
          </div>

          <div className="sp-field">
            <label className="sp-label" htmlFor="sp-phone">
              <span>
                เบอร์โทรศัพท์มือถือ <span className="sp-req" aria-hidden="true">*</span>
                <span className="sr-only"> (จำเป็น)</span>
              </span>
            </label>
            <input
              id="sp-phone"
              name="phone"
              ref={phoneRef}
              className="sp-input sp-input--mono"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="08X-XXX-XXXX"
              required
              value={phone}
              onChange={(event) => {
                setPhone(sanitizeDigits(event.target.value).slice(0, 10));
                clearError('phone');
              }}
              aria-invalid={errors.phone ? true : undefined}
              aria-describedby={errors.phone ? 'sp-phone-err' : undefined}
            />
            {errors.phone && (
              <p id="sp-phone-err" className="sp-error">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>{errors.phone}</span>
              </p>
            )}
          </div>

          <div className="sp-field">
            <label className="sp-label" htmlFor="sp-email">
              <span>อีเมล</span>
              <span className="sp-label__optional">ไม่บังคับ</span>
            </label>
            <input
              id="sp-email"
              name="email"
              ref={emailRef}
              className="sp-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                clearError('email');
              }}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? 'sp-email-err' : undefined}
            />
            {errors.email && (
              <p id="sp-email-err" className="sp-error">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>{errors.email}</span>
              </p>
            )}
          </div>

          <fieldset
            className="sp-fieldset sp-field--full"
            aria-describedby={errors.kind ? 'sp-kind-err' : undefined}
          >
            <legend className="sp-label">
              <span>
                ประเภทการสนับสนุน <span className="sp-req" aria-hidden="true">*</span>
                <span className="sr-only"> (จำเป็น)</span>
              </span>
            </legend>
            <div className="sp-choices">
              {KIND_OPTIONS.map((option, index) => (
                <label className="sp-choice" key={option}>
                  <input
                    className="sp-choice__input"
                    type="radio"
                    name="kind"
                    value={option}
                    ref={index === 0 ? kindRef : undefined}
                    checked={kind === option}
                    required={index === 0}
                    onChange={() => {
                      setKind(option);
                      clearError('kind');
                    }}
                    aria-invalid={errors.kind ? true : undefined}
                    aria-describedby={errors.kind ? 'sp-kind-err' : undefined}
                  />
                  <span className="sp-choice__pill">{SPONSOR_KIND_LABELS[option]}</span>
                </label>
              ))}
            </div>
            {errors.kind && (
              <p id="sp-kind-err" className="sp-error">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>{errors.kind}</span>
              </p>
            )}
          </fieldset>

          <div className="sp-field sp-field--full">
            <label className="sp-label" htmlFor="sp-details">
              <span>
                รายละเอียดเพิ่มเติม <span className="sp-label__optional">ไม่บังคับ</span>
              </span>
              <span className="sp-hint" aria-hidden="true">
                <span className="font-mono tabular-nums">{details.length}</span>/
                <span className="font-mono tabular-nums">{SPONSOR_DETAILS_MAX}</span>
              </span>
            </label>
            <textarea
              id="sp-details"
              name="details"
              className="sp-input sp-textarea"
              rows={5}
              maxLength={SPONSOR_DETAILS_MAX}
              placeholder="เช่น จำนวนเงินโดยประมาณ หรือรายการสิ่งของ"
              value={details}
              onChange={(event) => setDetails(event.target.value)}
            />
          </div>

          <div className="sp-field sp-field--full sp-captcha">
            {CAPTCHA_MODE === 'widget' && (
              <TurnstileField
                ref={captchaRef}
                siteKey={TURNSTILE_SITE_KEY}
                errorId="sp-captcha-err"
                error={captchaError}
                onToken={(token) => {
                  setTurnstileToken(token ?? '');
                  if (token) setCaptchaError(null);
                }}
              />
            )}
            {CAPTCHA_MODE === 'dev-skip' && (
              <p className="sp-hint sp-hint--dev">
                [DEV] ยังไม่ได้ตั้ง <span className="font-mono">PUBLIC_TURNSTILE_SITE_KEY</span>{' '}
                จึงข้ามการยืนยันตัวตน (เซิร์ฟเวอร์ dev ที่ไม่มี secret ก็ข้ามเช่นกัน)
              </p>
            )}
            {CAPTCHA_MODE === 'missing-key' && (
              <p id="sp-captcha-err" className="sp-error" role="alert">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>{CAPTCHA_UNAVAILABLE_MESSAGE}</span>
              </p>
            )}
          </div>

          {formError && (
            <div className="sp-alert" role="alert">
              <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
              <div>{formError}</div>
            </div>
          )}

          <div className="sp-form__actions">
            <button
              type="submit"
              className="sp-btn sp-btn--primary"
              disabled={busy || !hydrated}
              aria-busy={busy || undefined}
            >
              {busy ? (
                'กำลังส่ง…'
              ) : (
                <>
                  <span>ส่งข้อมูลให้พี่ค่าย</span>
                  <Send className="sp-ico" size={16} strokeWidth={1.5} aria-hidden="true" />
                </>
              )}
            </button>
            <p className="sp-form__note">ข้อมูลนี้ใช้เพื่อติดต่อกลับเรื่องการสนับสนุนค่ายเท่านั้น</p>
          </div>
        </form>
      )}
    </div>
  );
}
