/**
 * The 4-digit verify code field (last 4 digits of the national ID, AGENTS.md section 13.5), shared
 * by the receipt slip form and /status. One boxed input, no masking dots, no maxLength: the value
 * is normalised in cleanVerifyCode so a LINE paste with zero-width characters or Thai digits still
 * works. The code lives in React state only and is never written to browser storage.
 */
import { useId, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { cleanVerifyCode, hasThaiKeyboardChars } from '../../lib/slip-upload';
import '../../styles/slip-upload.css';

export function VerifyCodeField({
  id,
  value,
  onChange,
  error,
  label,
  hint,
  notPhone,
  hintId,
  enterKeyHint,
  disabled,
  inputRef,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | null;
  label?: ReactNode;
  /** Extra sentence shown after the example (e.g. what the code is used for on /status). */
  hint?: ReactNode;
  /** Adds "(ไม่ใช่เบอร์โทรศัพท์)": on /status the phone number is also on screen. */
  notPhone?: boolean;
  /** Override the id of the hint paragraph, for buttons elsewhere that point at it with aria-describedby. */
  hintId?: string;
  enterKeyHint?: 'send' | 'done' | 'go';
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const uid = useId();
  const ids = { hint: hintId ?? `${uid}-hint`, kb: `${uid}-kb`, err: `${uid}-err` };
  const [thaiKb, setThaiKb] = useState(false);
  const described = [ids.hint, thaiKb ? ids.kb : null, error ? ids.err : null].filter(Boolean).join(' ');

  return (
    <div className="su-field">
      <label className="su-label" htmlFor={id}>
        {label ?? 'เลข 4 ตัวท้ายของบัตรประชาชน'}
      </label>
      <p id={ids.hint} className="su-hint">
        เช่น <span className="su-num">1-2345-67890-12-3</span> → กรอก <strong className="su-num">0123</strong> · ใช้สำหรับตรวจสอบเท่านั้น
        {notPhone && ' (ไม่ใช่เบอร์โทรศัพท์)'}
        {hint && <> {hint}</>}
      </p>
      <input
        ref={inputRef}
        id={id}
        className="su-code"
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          setThaiKb(hasThaiKeyboardChars(raw));
          onChange(cleanVerifyCode(raw));
        }}
        inputMode="numeric"
        enterKeyHint={enterKeyHint}
        autoComplete="off"
        spellCheck={false}
        placeholder="0000"
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
      />
      {thaiKb && (
        <p id={ids.kb} className="su-msg su-msg--warn" role="alert">
          แป้นพิมพ์เป็นภาษาไทยอยู่ กรุณาสลับเป็นภาษาอังกฤษแล้วพิมพ์เลข 4 หลัก
        </p>
      )}
      {error && (
        <p id={ids.err} className="su-msg su-msg--err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
