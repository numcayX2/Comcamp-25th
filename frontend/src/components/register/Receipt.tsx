/** Step 06 — receipt + payment instructions, shown after a successful submit. */
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, FileDown, MapPin, Phone, TriangleAlert } from 'lucide-react';
import {
  DOCS_READY,
  PARENT_CONSENT_FILENAME,
  PARENT_CONSENT_NOTE,
  PARENT_CONSENT_PDF,
  PARENT_CONSENT_WHERE,
} from '../../lib/camp-facts';
import {
  ApiHttpError,
  getApplicationStatus,
  hasSlip,
  isPhoneLookup,
  withdrawApplication,
  type ApiSource,
  type ApplicationStatus,
  type SlipStatus,
} from '../../lib/api';
import { HUMAN_CHECK_COPY, WITHDRAW_MISMATCH_COPY, cleanPhoneInput, describeRateLimit } from '../../lib/slip-upload';
import { NO_QR_NOTE, PAY_ACCOUNT, PAY_ACCOUNT_DIGITS, copyText } from '../../lib/payment';
import {
  DORM_MAPS_URL,
  DORM_NAME,
  FB_URL,
  CAMP_FEE_TEXT,
  LINE_OPENCHAT_QR_SRC,
  LINE_OPENCHAT_URL,
  PAYMENT_WINDOW_DAYS,
  PAYMENT_WINDOW_HOURS,
  RECEIPT_META,
  RECEIPT_STEP,
  STAFF_CONTACTS,
  describeApplicantPaymentDeadline,
} from './model';
import { clearReceipt } from './storage';
import { SlipBlock } from './SlipBlock';
import { HumanCheckDialog } from '../slip/HumanCheckDialog';
import { StepHeader } from './parts';

type CopyState = 'idle' | 'copied' | 'failed';

/** Thai copy for a failed withdrawal, keyed by the backend error code. */
function describeWithdrawError(err: unknown): ReactNode {
  if (err instanceof ApiHttpError) {
    if (err.code === 'CAPTCHA_REQUIRED') return HUMAN_CHECK_COPY;
    if (err.code === 'CAPTCHA_FAILED') return 'การยืนยันไม่ผ่านหรือหมดอายุ กรุณากดยืนยันอีกครั้ง';
    if (err.code === 'RATE_LIMITED' || err.status === 429) return describeRateLimit(err);
    if (err.status === 409) {
      return (
        <>
          ใบสมัครนี้ยกเลิกเองไม่ได้แล้ว (ยืนยันสิทธิ์ ส่งสลิป หรือปิดรายการแล้ว) กรุณาติดต่อทีมงานผ่าน{' '}
          <a href={FB_URL} className="rw-inline-link" target="_blank" rel="noopener noreferrer">
            เพจ Facebook ของโครงการ
          </a>{' '}
          หรือโทร{' '}
          {STAFF_CONTACTS.map((c, idx) => (
            <Fragment key={c.tel}>
              {idx > 0 && ' / '}
              <a href={`tel:${c.tel}`} className="rw-inline-link font-mono tabular-nums">
                {c.phone}
              </a>{' '}
              · {c.name}
            </Fragment>
          ))}{' '}
          เพื่อแจ้งสละสิทธิ์
        </>
      );
    }
    // An unknown code and a wrong phone are the same 404 on purpose: never say which part was wrong.
    if (err.status === 404) return WITHDRAW_MISMATCH_COPY;
    if (err.status >= 500) return 'ระบบขัดข้องชั่วคราว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
  }
  return 'ยกเลิกใบสมัครไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง';
}

/**
 * Self-service withdrawal. Collapsed to one quiet link; opening it asks for the full phone number
 * used to register (owner ruling R24: code + phone), because cancelling gives the seat away for
 * good. The phone lives in this component's state only (never in browser storage) and is cleared on
 * close and on success. A failure never says which part was wrong.
 */
function WithdrawBlock({ appId, onWithdrawn }: { appId: string; onWithdrawn: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const phoneReady = /^0\d{9}$/.test(phone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const busyRef = useRef(false);
  const uid = useId();
  const ids = { panel: `${uid}-panel`, title: `${uid}-title`, warn: `${uid}-warn`, phone: `${uid}-phone`, hint: `${uid}-hint`, err: `${uid}-err` };

  // A disabled input cannot keep focus: after a failed attempt, refocus the phone once busy has cleared.
  const refocusPhone = useRef(false);
  useEffect(() => {
    if (!busy && refocusPhone.current) {
      refocusPhone.current = false;
      phoneRef.current?.focus();
      phoneRef.current?.select();
    }
  }, [busy]);

  useEffect(() => {
    if (open) phoneRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [open]);

  function close() {
    if (busy || busyRef.current) return;
    restoreFocus.current = true;
    setOpen(false);
    setPhone('');
    setError(null);
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (busyRef.current || busy || !phoneReady) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await withdrawApplication(appId, phone);
      busyRef.current = false;
      setPhone('');
      onWithdrawn(appId);
    } catch (err) {
      setError(describeWithdrawError(err));
      refocusPhone.current = true;
      busyRef.current = false;
      setBusy(false);
    }
  }

  function onKeyDown(ev: KeyboardEvent<HTMLFormElement>) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  if (!open) {
    return (
      <div className="rw-withdraw">
        <button
          ref={toggleRef}
          type="button"
          className="rw-textlink rw-textlink--btn"
          aria-expanded={false}
          aria-controls={ids.panel}
          onClick={() => setOpen(true)}
        >
          เปลี่ยนใจ? ขอยกเลิกใบสมัครนี้
        </button>
      </div>
    );
  }

  return (
    <form
      id={ids.panel}
      className="rw-withdraw rw-withdraw--open"
      aria-labelledby={ids.title}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      noValidate
    >
      <h3 id={ids.title} className="rw-block__title">
        ยกเลิกใบสมัคร
      </h3>
      <p id={ids.warn} className="rw-withdraw__warn">
        หากยกเลิก ใบสมัคร <span className="font-mono tabular-nums whitespace-nowrap select-all">{appId}</span> จะถูกนำออกจากระบบและคืนที่นั่งว่างทันที
        ยกเลิกแล้วกู้คืนไม่ได้ แต่สมัครใหม่ได้หากยังมีที่นั่งว่าง
      </p>
      <label className="rw-label" htmlFor={ids.phone}>
        เบอร์โทรที่ใช้สมัคร
      </label>
      <input
        ref={phoneRef}
        id={ids.phone}
        className="rw-input rw-input--mono rw-withdraw__phone"
        value={phone}
        // Digits only, max 10: Thai digits become 0-9; dashes, spaces and zero-width characters go (§9.2.2).
        onChange={(e) => {
          setPhone(cleanPhoneInput(e.target.value));
          if (error) setError(null);
        }}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        spellCheck={false}
        placeholder="08XXXXXXXX"
        aria-invalid={error ? true : undefined}
        aria-describedby={[ids.warn, ids.hint, error ? ids.err : ''].filter(Boolean).join(' ')}
        disabled={busy}
      />
      <p id={ids.hint} className="rw-withdraw__hint">
        กรอกเบอร์โทรศัพท์ <span className="font-mono tabular-nums">10</span> หลักที่ใช้สมัคร แล้วกดยืนยันเพื่อยกเลิกใบสมัครนี้ ระบบไม่บันทึกเบอร์นี้ไว้ในเครื่อง
      </p>
      <p id={ids.err} className="rw-withdraw__err" role="alert">
        {error}
      </p>
      <div className="rw-actions rw-actions--tight">
        <button
          ref={confirmRef}
          type="submit"
          className="rw-btn rw-btn--danger rw-btn--sm"
          disabled={busy || !phoneReady}
          aria-busy={busy || undefined}
          aria-describedby={[ids.warn, error ? ids.err : ''].filter(Boolean).join(' ')}
        >
          {busy ? 'กำลังยกเลิก…' : 'ยืนยันยกเลิกใบสมัคร'}
        </button>
        <button type="button" className="rw-btn rw-btn--ghost rw-btn--sm" onClick={close} disabled={busy}>
          ไม่ยกเลิก (กลับ)
        </button>
      </div>
    </form>
  );
}

export function Receipt({
  appId,
  source,
  showSource,
  feeText = CAMP_FEE_TEXT,
  headingRef,
  onWithdrawn,
}: {
  appId: string;
  source: ApiSource | null;
  showSource: boolean;
  feeText?: string;
  headingRef: Ref<HTMLHeadingElement>;
  onWithdrawn: (id: string, missing?: boolean) => void;
}) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const [acctCopy, setAcctCopy] = useState<CopyState>('idle');
  const [refCopy, setRefCopy] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);
  const acctTimer = useRef<number | undefined>(undefined);
  const refTimer = useRef<number | undefined>(undefined);
  // Slip + application status synced from the server, so a receipt restored after a refresh is accurate.
  const [slip, setSlip] = useState<SlipStatus | null>(null);
  const [appStatus, setAppStatus] = useState<ApplicationStatus | null>(null);
  const [createdAt, setCreatedAt] = useState<string>(() => new Date().toISOString());
  const [updatedAt, setUpdatedAt] = useState<string | undefined>(undefined);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [synced, setSynced] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    setSynced(false);
    setNotFound(false);
    // A background sync: never opens the human check (the applicant did not ask for anything yet).
    getApplicationStatus(appId, { prompt: false })
      .then((res) => {
        if (!alive) return;
        const d = res.data;
        if (isPhoneLookup(d)) return; // never happens for a code query; keeps the types honest
        setAppStatus(d.status);
        setSlip(hasSlip(d) ? (d.slipStatus ?? 'PENDING') : null);
        if (d.createdAt) setCreatedAt(d.createdAt);
        setUpdatedAt(d.updatedAt);
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiHttpError && err.status === 404) {
          clearReceipt();
          setNotFound(true);
        }
        /* offline: the upload form still works and the server re-checks every rule */
      })
      .finally(() => {
        if (alive) setSynced(true);
      });
    return () => {
      alive = false;
    };
  }, [appId]);

  // A slip waiting for review or approved (or a confirmed seat) blocks self-withdrawal: the server answers 409.
  const slipLocksWithdraw = slip === 'PENDING' || slip === 'APPROVED' || appStatus === 'CONFIRMED';
  const deadline = describeApplicantPaymentDeadline(createdAt, updatedAt, nowMs);

  useEffect(() => {
    if (slipLocksWithdraw) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [slipLocksWithdraw]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(acctTimer.current);
      window.clearTimeout(refTimer.current);
    },
    [],
  );

  async function onCopy() {
    const ok = await copyText(appId);
    setCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopy('idle'), ok ? 2200 : 5000);
  }

  async function onCopyRef() {
    const ok = await copyText(appId);
    setRefCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(refTimer.current);
    refTimer.current = window.setTimeout(() => setRefCopy('idle'), ok ? 2200 : 5000);
  }

  /** Copies the digits only, so banking apps accept the paste. */
  async function onCopyAccount() {
    const ok = await copyText(PAY_ACCOUNT_DIGITS);
    setAcctCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(acctTimer.current);
    acctTimer.current = window.setTimeout(() => setAcctCopy('idle'), ok ? 2200 : 5000);
  }

  if (notFound) {
    return (
      <div className="rw-receipt">
        <StepHeader
          no={RECEIPT_STEP + 1}
          title="ไม่พบใบสมัครนี้ในระบบ"
          lead={`ใบสมัครรหัส ${appId} อาจถูกยกเลิกหรือนำออกจากระบบแล้ว`}
          headingRef={headingRef}
        />
        <div className="rw-actions">
          <button type="button" className="rw-btn rw-btn--primary" onClick={() => onWithdrawn(appId, true)}>
            กลับไปหน้าสมัครค่าย
          </button>
          <a href="/status" className="rw-btn rw-btn--ghost rw-btn--forward">
            ไปหน้าตรวจสอบสถานะ
            <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="rw-receipt">
      <StepHeader
        no={RECEIPT_STEP + 1}
        title={RECEIPT_META.title}
        lead="ที่นั่งของคุณถูกจองแล้ว บันทึกรหัสด้านล่างไว้ ใช้ตรวจสอบสถานะและส่งสลิปการชำระเงิน"
        headingRef={headingRef}
      />

      <section className="rw-block" aria-label="รหัสใบสมัคร">
        <p className="rw-block__label">รหัสใบสมัคร</p>
        <p className="rw-id whitespace-nowrap select-all" data-app-id>{appId}</p>
        <div className="rw-copyrow">
          <button type="button" className="rw-btn rw-btn--ghost rw-btn--sm" onClick={onCopy}>
            {copy === 'copied' ? <Check size={18} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={18} strokeWidth={1.5} aria-hidden="true" />}
            {copy === 'copied' ? 'คัดลอกแล้ว' : 'คัดลอกรหัสใบสมัคร'}
          </button>
          <p className="rw-copyrow__msg" role="status" aria-live="polite">
            {copy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่รหัสแล้วเลือกคัดลอก'}
          </p>
        </div>
        <p className="rw-keep">
          <strong>เก็บรหัสใบสมัครนี้ไว้ให้ดีและอย่าส่งต่อให้ผู้อื่น</strong> รหัส{' '}
          <span className="font-mono tabular-nums whitespace-nowrap">{appId}</span>{' '}
          คือกุญแจส่วนตัวของน้องสำหรับหน้าตรวจสอบสถานะ ใช้ส่งสลิปและจัดการใบสมัคร แนะนำให้คัดลอกหรือแคปหน้าจอเก็บไว้
          ระบบส่งรหัสนี้ไปทางอีเมลด้วย ส่วนการค้นหาด้วยเบอร์โทรจะแสดงเพียงสถานะโดยย่อเท่านั้น
        </p>
        <p className="rw-keep rw-keep--quiet">ไม่พบอีเมล? ลองดูในโฟลเดอร์ Spam / จดหมายขยะ หรือแท็บ Promotions (Gmail)</p>
      </section>

      <section className="rw-block" aria-labelledby="rw-pay-title">
        <h3 id="rw-pay-title" className="rw-block__title">
          ชำระค่าสมัคร
        </h3>
        {!slipLocksWithdraw && (
          <aside
            className={`rw-due${deadline.isOverdue ? ' rw-due--over' : ''}`}
            role="note"
            aria-labelledby="rw-due-title"
          >
            <p id="rw-due-title" className="rw-due__title">
              <TriangleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
              <span>
                {slip === 'REJECTED'
                  ? <>แจ้งเตือน: สลิปไม่ผ่านการตรวจสอบ <span className="whitespace-nowrap">กรุณาแนบสลิปใหม่</span></>
                  : deadline.isOverdue
                    ? 'แจ้งเตือน: เลยกำหนดชำระเงินแล้ว'
                    : <>แจ้งเตือน: คุณยังไม่ได้แนบ<span className="whitespace-nowrap">สลิปชำระเงิน</span></>}
              </span>
            </p>
            <div className="rw-due__body">
              <p className="rw-due__left tabular-nums">{deadline.remainingText}</p>
              <p className="rw-due__when">
                ครบกำหนด <strong className="tabular-nums">{deadline.deadlineText}</strong>
              </p>
              <ul className="rw-due__rules">
                <li>
                  โอน <strong className="font-mono tabular-nums">{feeText}</strong> บาท และแนบสลิปภายใน{' '}
                  <span className="font-mono tabular-nums">{PAYMENT_WINDOW_DAYS}</span> วัน (<span className="font-mono tabular-nums">{PAYMENT_WINDOW_HOURS}</span> ชม.) หลังสมัคร
                </li>
                <li>
                  <strong className="rw-due__flag">เกินกำหนด ระบบตัดสิทธิ์และคืนที่นั่งอัตโนมัติ</strong>
                </li>
              </ul>
              <a className="rw-due__jump" href="#rw-slip-title">
                ไปแนบสลิป
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" style={{ transform: 'rotate(90deg)' }} />
              </a>
            </div>
          </aside>
        )}

        <article className="rw-ticket" aria-label="รายละเอียดการโอนเงิน">
          <header className="rw-ticket__head">
            <p className="rw-ticket__label">ยอดโอนชำระค่าสมัคร</p>
            <p className="rw-ticket__amount">
              <span className="font-mono tabular-nums">{feeText}</span>
              <span className="rw-ticket__unit">บาท</span>
            </p>
          </header>

          <div className="rw-ticket__stub">
          <div className="rw-ticket__body">
            <p className="rw-ticket__label">เลขที่บัญชี · {PAY_ACCOUNT.bank}</p>
            <p className="rw-ticket__acct font-mono tabular-nums whitespace-nowrap select-all">{PAY_ACCOUNT.number}</p>
            <div className="rw-copyrow rw-copyrow--tight">
              <button type="button" className="rw-btn rw-btn--ghost rw-btn--sm" onClick={onCopyAccount}>
                {acctCopy === 'copied' ? <Check size={18} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={18} strokeWidth={1.5} aria-hidden="true" />}
                {acctCopy === 'copied' ? 'คัดลอกเลขบัญชีแล้ว' : 'คัดลอกเลขบัญชี'}
              </button>
              <p className="rw-copyrow__msg" role="status" aria-live="polite">
                {acctCopy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่เลขบัญชีแล้วเลือกคัดลอก'}
              </p>
            </div>

            <dl className="rw-ticket__meta">
              <div>
                <dt>ชื่อบัญชี</dt>
                <dd>
                  {PAY_ACCOUNT.name}
                  <span className="rw-ticket__holders">{PAY_ACCOUNT.holders}</span>
                </dd>
              </div>
              <div>
                <dt>อ้างอิง</dt>
                <dd>
                  <span className="font-mono tabular-nums whitespace-nowrap select-all">{appId}</span>
                  <span className="rw-ticket__holders">ใส่ในบันทึกช่วยจำตอนโอน (ถ้าแอปธนาคารให้ใส่ได้)</span>
                  <div className="rw-copyrow rw-copyrow--tight">
                    <button type="button" className="rw-btn rw-btn--ghost rw-btn--sm" onClick={onCopyRef}>
                      {refCopy === 'copied' ? <Check size={18} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={18} strokeWidth={1.5} aria-hidden="true" />}
                      {refCopy === 'copied' ? 'คัดลอกรหัสใบสมัครแล้ว' : 'คัดลอกรหัสใบสมัคร'}
                    </button>
                    <p className="rw-copyrow__msg" role="status" aria-live="polite">
                      {refCopy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่รหัสใบสมัครแล้วเลือกคัดลอก'}
                    </p>
                  </div>
                </dd>
              </div>
            </dl>
          </div>

          <footer className="rw-ticket__foot">{NO_QR_NOTE}</footer>
          </div>
        </article>
      </section>

      <SlipBlock appId={appId} slip={slip} appStatus={appStatus} synced={synced} onUploaded={setSlip} />

      {slipLocksWithdraw && (
        <section className="rw-block" aria-labelledby="rw-line-title">
          <h3 id="rw-line-title" className="rw-block__title">เข้ากลุ่ม LINE OpenChat</h3>
          <p className="rw-block__label">สำหรับผู้ที่ส่งสลิปแล้ว</p>
          <div className="rw-line-card">
            <img
              className="rw-line-card__qr"
              src={LINE_OPENCHAT_QR_SRC}
              alt="QR Code สำหรับเข้ากลุ่ม LINE OpenChat ค่าย ComCamp #25"
              width="176"
              height="176"
              loading="lazy"
              decoding="async"
            />
            <div className="rw-line-card__body">
              <p>สแกน QR หรือกดปุ่มด้านล่างเพื่อเข้ากลุ่ม รับข่าวสารและติดต่อสื่อสารกับพี่ค่ายก่อนวันจัดค่าย</p>
              <a href={LINE_OPENCHAT_URL} target="_blank" rel="noopener noreferrer" className="rw-btn rw-btn--primary rw-btn--forward">
                เข้ากลุ่ม LINE OpenChat ทันที
                <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      )}

      <section className="rw-block" aria-labelledby="rw-next-title">
        <h3 id="rw-next-title" className="rw-block__title">ขั้นตอนถัดไป</h3>
        <ol className="rw-steps">
          <li>
            โอนเงินและแนบสลิปภายใน <span className="font-mono tabular-nums">{PAYMENT_WINDOW_DAYS}</span> วัน (<span className="font-mono tabular-nums">{PAYMENT_WINDOW_HOURS}</span> ชั่วโมง)
            หลังสมัคร เกินกำหนดระบบคืนที่นั่งว่างอัตโนมัติ
          </li>
          <li>
            แนบสลิปในหน้านี้ได้ทันที หรือส่งทีหลังที่หน้าตรวจสอบสถานะ โดยค้นหาด้วยรหัสใบสมัคร
            (หากเปิดจาก LINE / Facebook แล้วสลับไปใช้ Chrome หรือ Safari ข้อมูลชั่วคราวในแท็บเดิมอาจหายไป ให้ใช้รหัสใบสมัครจากหน้านี้หรือจากอีเมลค้นหาที่หน้า{' '}
            <span className="font-mono">/status</span> ส่วนเบอร์โทรใช้ดูสถานะโดยย่อได้อย่างเดียว)
          </li>
          <li>
            <strong>ระบบส่งอีเมลแจ้งยืนยันให้อัตโนมัติ <span className="font-mono tabular-nums">2</span> ช่วง</strong>{' '}
            (1. อีเมลแจ้งรับใบสมัครและรายละเอียดโอนเงิน และ 2. อีเมลยืนยันสิทธิ์สมบูรณ์พร้อมพิกัดเรือนพักและลิงก์เข้ากลุ่มหลังทีมงานอนุมัติสลิป)
            — ทั้งนี้น้องสามารถอัปโหลดสลิปและเช็กสถานะบนหน้าเว็บได้ทันทีโดยไม่ต้องรออีเมล
          </li>
          <li>
            หลังส่งสลิปแล้ว <strong>สามารถเข้ากลุ่ม LINE OpenChat ของค่ายได้ทันที</strong> (แสดงขึ้นเหนือส่วนนี้หลังอัปโหลดสลิป และเปิดดูซ้ำได้ที่หน้า{' '}
            <span className="font-mono">/status</span>) จากนั้นรอทีมงานตรวจสลิปและยืนยันสิทธิ์
          </li>
        </ol>
        <div className="rw-actions">
          <a href="/status" className="rw-btn rw-btn--ghost rw-btn--forward">
            ไปหน้าตรวจสอบสถานะ
            <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
          </a>
          {DOCS_READY && (
            <a href={PARENT_CONSENT_PDF} download={PARENT_CONSENT_FILENAME} className="rw-btn rw-btn--ghost rw-btn--doc">
              <FileDown size={18} strokeWidth={1.5} aria-hidden="true" />
              ดาวน์โหลดใบขออนุญาตผู้ปกครอง (PDF)
            </a>
          )}
          <a href={FB_URL} className="rw-textlink" target="_blank" rel="noopener noreferrer">
            เพจ Facebook โครงการ
          </a>
        </div>
        {DOCS_READY && (
          <p className="rw-doc-note">
            {PARENT_CONSENT_NOTE} {PARENT_CONSENT_WHERE}
          </p>
        )}
      </section>

      <section className="rw-block" aria-labelledby="rw-camp-title">
        <h3 id="rw-camp-title" className="rw-block__title">ข้อมูลวันจัดค่ายและช่องทางติดต่อ</h3>
        <dl className="rw-dl rw-dl--info">
          <div className="rw-dl__row">
            <dt>วันจัดค่าย</dt>
            <dd>
              <strong className="rw-dl__lead">
                <span className="font-mono tabular-nums">5–7</span> กุมภาพันธ์ <span className="font-mono tabular-nums">2570</span>
              </strong>
              <span className="rw-dl__sub">
                <span className="font-mono tabular-nums">3</span> วัน <span className="font-mono tabular-nums">2</span> คืน ณ อาคาร 60 ปี แม่โจ้ ชั้น 6 (สาขาวิชาวิทยาการคอมพิวเตอร์ คณะวิทยาศาสตร์ มหาวิทยาลัยแม่โจ้)
              </span>
            </dd>
          </div>
          <div className="rw-dl__row">
            <dt>สิทธิพิเศษ</dt>
            <dd>
              <span className="rw-dl__sub">หากผ่านการเข้าค่ายจะได้รับพิจารณาเป็นพิเศษเมื่อสมัครเรียนต่อที่สาขาวิชาวิทยาการคอมพิวเตอร์ มหาวิทยาลัยแม่โจ้</span>
            </dd>
          </div>
          <div className="rw-dl__row">
            <dt>ที่พักค่าย</dt>
            <dd>
              <strong className="rw-dl__lead">{DORM_NAME}</strong>
              <a href={DORM_MAPS_URL} className="rw-dl__link" target="_blank" rel="noopener noreferrer">
                <MapPin size={16} strokeWidth={1.5} aria-hidden="true" />
                <span>ดูแผนที่เรือนพัก (Google Maps)</span>
                <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden="true" />
              </a>
            </dd>
          </div>
          <div className="rw-dl__row">
            <dt>ติดต่อทีมงาน</dt>
            <dd>
              <ul className="rw-contacts">
                <li>
                  <a href={FB_URL} className="rw-dl__link" target="_blank" rel="noopener noreferrer">
                    <span>เพจ Facebook โครงการ</span>
                    <ArrowUpRight size={14} strokeWidth={1.5} aria-hidden="true" />
                  </a>
                </li>
                {STAFF_CONTACTS.map((c) => (
                  <li key={c.tel}>
                    <a href={`tel:${c.tel}`} className="rw-dl__link">
                      <Phone size={16} strokeWidth={1.5} aria-hidden="true" />
                      <span className="font-mono tabular-nums">{c.phone}</span>
                    </a>
                    <span className="rw-contacts__name">{c.name}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      </section>

      <section className="rw-block" aria-label="ยกเลิกใบสมัคร">
        {slipLocksWithdraw ? (
          <p className="rw-slip__note">
            ส่งสลิปหรือยืนยันสิทธิ์แล้ว จึงยกเลิกใบสมัครเองไม่ได้ หากต้องการแจ้งสละสิทธิ์ กรุณาติดต่อทีมงานผ่าน{' '}
            <a href={FB_URL} className="rw-inline-link" target="_blank" rel="noopener noreferrer">
              เพจ Facebook ของโครงการ
            </a>{' '}
            หรือโทร{' '}
            {STAFF_CONTACTS.map((c, idx) => (
              <Fragment key={c.tel}>
                {idx > 0 && ' / '}
                <a href={`tel:${c.tel}`} className="rw-inline-link font-mono tabular-nums">
                  {c.phone}
                </a>{' '}
                · {c.name}
              </Fragment>
            ))}{' '}
          </p>
        ) : (
          <WithdrawBlock appId={appId} onWithdrawn={onWithdrawn} />
        )}
      </section>

      {showSource && source && (
        <p className="rw-devnote">
          <span className="font-mono">source: {source}</span>
        </p>
      )}
      <HumanCheckDialog />
    </div>
  );
}
