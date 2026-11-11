/**
 * Cloudflare Turnstile widget for the last registration step.
 *
 * - Explicit rendering: the script is loaded once with ?render=explicit and the widget is created
 *   and removed from effects. Astro's <ClientRouter /> swaps pages without a reload, so the implicit
 *   `.cf-turnstile` auto-scan would miss a widget that mounts after navigation.
 * - Tokens are single-use: the parent calls reset() after any failed submit to get a fresh one.
 * - The widget theme follows <html class="dark"> (the site toggle), not only the OS setting.
 * - The token lives in React state only; it is never written to browser storage.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  size?: 'normal' | 'flexible' | 'compact';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: (code?: string | number) => boolean | void;
  'timeout-callback'?: () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Loads api.js once per page lifetime (survives client-side navigations); a failure can be retried. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const fail = (el?: HTMLScriptElement) => {
      el?.remove();
      scriptPromise = null; // let the "try again" button start over
      reject(new Error('turnstile script failed'));
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile-api]');
    const el = existing ?? document.createElement('script');
    el.addEventListener('load', () => (window.turnstile ? resolve(window.turnstile) : fail(el)), { once: true });
    el.addEventListener('error', () => fail(el), { once: true });
    if (!existing) {
      el.src = SCRIPT_SRC;
      el.async = true;
      el.defer = true;
      el.dataset.turnstileApi = '';
      document.head.appendChild(el);
    } else if (window.turnstile) {
      resolve(window.turnstile);
    }
  });
  return scriptPromise;
}

const currentTheme = (): 'light' | 'dark' => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

export interface TurnstileFieldHandle {
  /** Ask Cloudflare for a fresh single-use token (call after any failed submit). */
  reset(): void;
  /** Move focus to the widget so a keyboard / screen-reader user lands on the check. */
  focus(): void;
}

interface Props {
  siteKey: string;
  /** A token when solved, null when it expired, errored or was reset. */
  onToken: (token: string | null) => void;
  /** Inline message under the widget (e.g. "please verify first"). */
  error?: string | null;
  errorId: string;
}

export const TurnstileField = forwardRef<TurnstileFieldHandle, Props>(function TurnstileField(
  { siteKey, onToken, error, errorId },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useImperativeHandle(ref, () => ({
    reset() {
      onTokenRef.current(null);
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
    },
    focus() {
      boxRef.current?.focus();
    },
  }));

  // Follow the site theme toggle (<html class="dark">).
  useEffect(() => {
    setTheme(currentTheme());
    const mo = new MutationObserver(() => setTheme(currentTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // Create / remove the widget. A theme change re-renders it (Turnstile has no setTheme), which
  // asks for a new token; the previous one is dropped first so a stale token is never submitted.
  useEffect(() => {
    let cancelled = false;
    setLoad('loading');
    loadTurnstile().then(
      (api) => {
        if (cancelled || !boxRef.current) return;
        onTokenRef.current(null);
        widgetId.current = api.render(boxRef.current, {
          sitekey: siteKey,
          theme,
          language: 'th',
          size: 'flexible',
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => {
            onTokenRef.current(null);
          },
          'timeout-callback': () => onTokenRef.current(null),
        });
        setLoad('ready');
      },
      () => {
        if (!cancelled) setLoad('failed');
      },
    );
    return () => {
      cancelled = true;
      const id = widgetId.current;
      widgetId.current = null;
      if (id && window.turnstile) {
        try {
          window.turnstile.remove(id);
        } catch {
          /* the widget is already gone */
        }
      }
      onTokenRef.current(null);
    };
  }, [siteKey, theme, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <section className="rw-captcha" aria-labelledby="captcha-label">
      <p id="captcha-label" className="rw-captcha__label">
        ยืนยันว่าไม่ใช่โปรแกรมอัตโนมัติ
      </p>
      <div
        ref={boxRef}
        className="rw-captcha__box"
        tabIndex={-1}
        data-state={load}
        aria-describedby={error ? errorId : undefined}
      />
      {load === 'loading' && (
        <p className="rw-captcha__hint" role="status">
          กำลังโหลดการยืนยันตัวตน…
        </p>
      )}
      {load === 'failed' && (
        <div className="rw-captcha__failed" role="alert">
          <p>
            โหลดการยืนยันตัวตนไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง
            หากยังไม่ขึ้น ให้เปิดหน้านี้ใน Chrome หรือ Safari แทนเบราว์เซอร์ในแอป Facebook / LINE ข้อมูลที่กรอกยังอยู่ครบ
          </p>
          <button type="button" className="rw-btn rw-btn--ghost rw-btn--sm" onClick={retry}>
            <RotateCw size={18} strokeWidth={1.5} aria-hidden="true" />
            ลองใหม่อีกครั้ง
          </button>
        </div>
      )}
      {error && (
        <p id={errorId} className="rw-err" role="alert">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 4.5v4M8 11v.01" />
          </svg>
          <span>{error}</span>
        </p>
      )}
    </section>
  );
});
