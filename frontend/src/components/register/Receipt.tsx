/** Step 06 — receipt + payment instructions, shown after a successful submit. */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, Ref } from 'react';
import { ArrowRight, Check, Copy } from 'lucide-react';
import {
  ApiHttpError,
  getApplicationStatus,
  hasSlip,
  withdrawApplication,
  type ApiSource,
  type ApplicationStatus,
  type SlipStatus,
} from '../../lib/api';
import { cleanVerifyCode } from '../../lib/slip-upload';
import { NO_QR_NOTE, PAY_ACCOUNT, PAY_ACCOUNT_DIGITS, copyText } from '../../lib/payment';
import { FB_URL, FEE_TEXT, RECEIPT_META, RECEIPT_STEP } from './model';
import { SlipBlock } from './SlipBlock';
import { StepHeader } from './parts';

type CopyState = 'idle' | 'copied' | 'failed';

/** Thai copy for a failed withdrawal, keyed by the backend error code. */
function describeWithdrawError(err: unknown): string {
  if (err instanceof ApiHttpError) {
    if (err.code === 'INVALID_VERIFY_CODE') return 'เลข 4 ตัวท้ายไม่ตรงกับบัตรประชาชนที่ใช้สมัคร กรุณาตรวจสอบแล้วลองอีกครั้ง';
    if (err.code === 'RATE_LIMITED') return 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
    if (err.status === 409) return 'ใบสมัครนี้ยกเลิกเองไม่ได้แล้ว (ยืนยันสิทธิ์ ส่งสลิป หรือปิดรายการแล้ว) กรุณาติดต่อทีมงานผ่านเพจ Facebook ของโครงการเพื่อขอยกเลิกและคืนเงิน';
    if (err.status === 404) return 'ไม่พบใบสมัครนี้ในระบบ อาจถูกยกเลิกไปแล้ว ตรวจสอบได้ที่หน้าตรวจสอบสถานะ';
    if (err.status === 400) return 'กรุณากรอกเลข 4 ตัวท้ายของบัตรประชาชนให้ครบ';
  }
  return 'ยกเลิกใบสมัครไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง';
}

/**
 * Self-service withdrawal. Collapsed to one quiet link; opening it asks for the last 4 digits of
 * the national ID (same second factor as /status, AGENTS.md §13.5, kept in memory only).
 */
function WithdrawBlock({ appId, onWithdrawn }: { appId: string; onWithdrawn: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const uid = useId();
  const ids = { panel: `${uid}-panel`, title: `${uid}-title`, warn: `${uid}-warn`, input: `${uid}-code`, err: `${uid}-err` };

  // A disabled input cannot take focus: after a failed attempt, refocus once busy has cleared.
  const refocusInput = useRef(false);
  useEffect(() => {
    if (!busy && refocusInput.current) {
      refocusInput.current = false;
      inputRef.current?.focus();
    }
  }, [busy]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [open]);

  function close() {
    if (busy) return;
    restoreFocus.current = true;
    setOpen(false);
    setCode('');
    setError(null);
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (busy || code.length !== 4) return;
    setBusy(true);
    setError(null);
    try {
      await withdrawApplication(appId, code);
      setCode('');
      onWithdrawn(appId);
    } catch (err) {
      setError(describeWithdrawError(err));
      refocusInput.current = true;
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
        หากยกเลิก ใบสมัคร <span className="font-mono tabular-nums">{appId}</span> จะถูกนำออกจากระบบและคืนที่นั่งว่างทันที
        ยกเลิกแล้วกู้คืนไม่ได้ แต่สมัครใหม่ได้หากยังมีที่นั่งว่าง
      </p>
      <label className="rw-label" htmlFor={ids.input}>
        กรอกเลข 4 ตัวท้ายของบัตรประชาชนเพื่อยืนยัน
      </label>
      <input
        ref={inputRef}
        id={ids.input}
        className="rw-input rw-input--mono rw-withdraw__code"
        value={code}
        // Digits only, max 4: also drops zero-width characters pasted from LINE (§9.2.2).
        onChange={(e) => {
          setCode(cleanVerifyCode(e.target.value));
          if (error) setError(null);
        }}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder="0000"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${ids.warn} ${ids.err}` : ids.warn}
        disabled={busy}
      />
      <p id={ids.err} className="rw-withdraw__err" role="alert">
        {error}
      </p>
      <div className="rw-actions rw-actions--tight">
        <button type="submit" className="rw-btn rw-btn--danger rw-btn--sm" disabled={busy || code.length !== 4} aria-busy={busy || undefined}>
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
  headingRef,
  onWithdrawn,
}: {
  appId: string;
  source: ApiSource | null;
  showSource: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onWithdrawn: (id: string) => void;
}) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const [acctCopy, setAcctCopy] = useState<CopyState>('idle');
  const timer = useRef<number | undefined>(undefined);
  const acctTimer = useRef<number | undefined>(undefined);
  // Slip + application status synced from the server, so a receipt restored after a refresh is accurate.
  const [slip, setSlip] = useState<SlipStatus | null>(null);
  const [appStatus, setAppStatus] = useState<ApplicationStatus | null>(null);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    let alive = true;
    setSynced(false);
    getApplicationStatus(appId)
      .then((res) => {
        if (!alive) return;
        setAppStatus(res.data.status);
        setSlip(hasSlip(res.data) ? (res.data.slipStatus ?? 'PENDING') : null);
      })
      .catch(() => {
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

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(acctTimer.current);
    },
    [],
  );

  async function onCopy() {
    const ok = await copyText(appId);
    setCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopy('idle'), ok ? 2200 : 5000);
  }

  /** Copies the digits only, so banking apps accept the paste. */
  async function onCopyAccount() {
    const ok = await copyText(PAY_ACCOUNT_DIGITS);
    setAcctCopy(ok ? 'copied' : 'failed');
    window.clearTimeout(acctTimer.current);
    acctTimer.current = window.setTimeout(() => setAcctCopy('idle'), ok ? 2200 : 5000);
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
        <p className="rw-id" data-app-id>{appId}</p>
        <div className="rw-copyrow">
          <button type="button" className="rw-btn rw-btn--ghost rw-btn--sm" onClick={onCopy}>
            {copy === 'copied' ? <Check size={18} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={18} strokeWidth={1.5} aria-hidden="true" />}
            {copy === 'copied' ? 'คัดลอกแล้ว' : 'คัดลอกรหัส'}
          </button>
          <p className="rw-copyrow__msg" role="status" aria-live="polite">
            {copy === 'failed' && 'คัดลอกอัตโนมัติไม่ได้ แตะค้างที่รหัสแล้วเลือกคัดลอก'}
          </p>
        </div>
      </section>

      <section className="rw-block" aria-labelledby="rw-pay-title">
        <h3 id="rw-pay-title" className="rw-block__title">
          ชำระค่าสมัคร
        </h3>

        <article className="rw-ticket" aria-label="รายละเอียดการโอนเงิน">
          <header className="rw-ticket__head">
            <p className="rw-ticket__label">ยอดที่ต้องโอน</p>
            <p className="rw-ticket__amount">
              <span className="font-mono tabular-nums">{FEE_TEXT}</span>
              <span className="rw-ticket__unit">บาท</span>
            </p>
          </header>

          <div className="rw-ticket__stub">
          <div className="rw-ticket__body">
            <p className="rw-ticket__label">เลขที่บัญชี · {PAY_ACCOUNT.bank}</p>
            <p className="rw-ticket__acct font-mono tabular-nums">{PAY_ACCOUNT.number}</p>
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
                  <span className="font-mono tabular-nums">{appId}</span>
                  <span className="rw-ticket__holders">ใส่ในบันทึกช่วยจำตอนโอน (ถ้าแอปธนาคารให้ใส่ได้)</span>
                </dd>
              </div>
            </dl>
          </div>

          <footer className="rw-ticket__foot">{NO_QR_NOTE}</footer>
          </div>
        </article>
      </section>

      <SlipBlock appId={appId} slip={slip} appStatus={appStatus} synced={synced} onUploaded={setSlip} />

      <section className="rw-block" aria-labelledby="rw-next-title">
        <h3 id="rw-next-title" className="rw-block__title">ขั้นตอนถัดไป</h3>
        <ol className="rw-steps">
          <li>โอนเงินตามรายละเอียดด้านบน แล้วบันทึกหรือแคปหน้าจอสลิป</li>
          <li>แนบสลิปในหน้านี้ได้ทันที หรือส่งทีหลังที่หน้าตรวจสอบสถานะ โดยค้นหาด้วยรหัสใบสมัคร เลขบัตรประชาชน หรือเบอร์โทรศัพท์</li>
          <li>รอทีมงานตรวจสอบสลิปและยืนยันสิทธิ์ ติดตามประกาศได้ที่หน้าตรวจสอบสถานะและเพจ Facebook ของโครงการ</li>
        </ol>
        <div className="rw-actions">
          <a href="/status" className="rw-btn rw-btn--ghost">
            ไปหน้าตรวจสอบสถานะ
            <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
          </a>
          <a href={FB_URL} className="rw-textlink" target="_blank" rel="noopener noreferrer">
            เพจ Facebook โครงการ
          </a>
        </div>
      </section>

      <section className="rw-block" aria-label="ยกเลิกใบสมัคร">
        {slipLocksWithdraw ? (
          <p className="rw-slip__note">
            ส่งสลิปหรือยืนยันสิทธิ์แล้ว จึงยกเลิกใบสมัครเองไม่ได้ หากต้องการยกเลิกหรือขอคืนเงิน กรุณาติดต่อทีมงานผ่าน{' '}
            <a href={FB_URL} className="rw-textlink" target="_blank" rel="noopener noreferrer">
              เพจ Facebook ของโครงการ
            </a>
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
    </div>
  );
}
