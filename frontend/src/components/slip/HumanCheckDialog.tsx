/**
 * Human check for the application-code endpoints (AGENTS.md §13.5). While many unknown codes are
 * being tried across the site, the server answers 429 CAPTCHA_REQUIRED instead of refusing
 * everyone; lib/api.ts asks the prompt registered here for a Turnstile token and sends the request
 * again with it, so the applicant's own action simply continues once the check passes.
 *
 * Native modal <dialog> like SlipLightbox (top layer, inert page, focus trap, Esc = cancel). The
 * widget mounts only while the dialog is open; the token lives in memory only and is handed over
 * once. Without a site key nothing is registered, and the caller shows the server's error copy.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { setHumanCheckPrompt, type HumanCheckReason } from '../../lib/api';
import { TurnstileField } from '../register/TurnstileField';
import '../../styles/slip-upload.css';

const TURNSTILE_SITE_KEY = String(import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();

export function HumanCheckDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const resolver = useRef<((token: string | null) => void) | null>(null);
  const [request, setRequest] = useState<{ id: number; reason: HumanCheckReason } | null>(null);
  const titleId = useId();
  const textId = useId();
  const errId = useId();

  const settle = useCallback((token: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(token);
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let seq = 0;
    const unregister = setHumanCheckPrompt(
      (reason) =>
        // Executor form on purpose: Promise.withResolvers is missing in older iOS in-app WebViews.
        new Promise<string | null>((resolve) => {
          resolver.current?.(null); // a newer request replaces one still waiting
          resolver.current = resolve;
          setRequest({ id: ++seq, reason });
        }),
    );
    return () => {
      unregister();
      resolver.current?.(null);
      resolver.current = null;
    };
  }, []);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (request && !dlg.open) {
      dlg.showModal();
      titleRef.current?.focus();
    } else if (!request && dlg.open) {
      dlg.close();
    }
  }, [request]);

  return (
    <dialog
      ref={ref}
      className="su-check"
      aria-labelledby={titleId}
      aria-describedby={textId}
      onCancel={(e) => {
        e.preventDefault();
        settle(null);
      }}
      onClose={() => {
        if (resolver.current) settle(null);
      }}
    >
      {request && (
        <>
          <h2 id={titleId} ref={titleRef} className="su-check__title" tabIndex={-1}>
            ยืนยันก่อนทำรายการต่อ
          </h2>
          <p id={textId} className="su-check__text">
            {request.reason === 'failed'
              ? 'การยืนยันไม่ผ่านหรือหมดอายุ กรุณายืนยันอีกครั้ง'
              : 'ขณะนี้มีผู้ลองกรอกรหัสใบสมัครที่ไม่ถูกต้องจำนวนมาก ระบบจึงขอให้ยืนยันว่าไม่ใช่โปรแกรมอัตโนมัติ เมื่อยืนยันแล้ว ระบบจะทำรายการของคุณต่อทันที'}
          </p>
          <TurnstileField
            key={request.id}
            siteKey={TURNSTILE_SITE_KEY}
            errorId={errId}
            onToken={(token) => {
              if (token) settle(token);
            }}
            failedMessage={
              <>
                โหลดการยืนยันไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง
                หากเปิดจากเบราว์เซอร์ในแอป LINE หรือ Facebook แล้วไม่ขึ้น แนะนำให้เปิดหน้านี้ใน Chrome หรือ Safari
              </>
            }
          />
          <div className="su-actions su-check__actions">
            <button type="button" className="su-btn su-btn--ghost" onClick={() => settle(null)}>
              ยกเลิก
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
