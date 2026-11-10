/**
 * Small presentational pieces shared by the wizard and the receipt.
 * Everything here is defined at module level on purpose: components declared
 * inside another component's render get a new identity each render and would
 * drop input focus on every keystroke.
 */
import type { ReactNode, Ref } from 'react';
import { pad2 } from './model';

export function StepHeader({
  no,
  title,
  lead,
  headingRef,
}: {
  no: number;
  title: string;
  lead?: string;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="rw-head">
      <h2 className="rw-head__title" ref={headingRef} tabIndex={-1}>
        <span className="rw-head__no">{pad2(no)}</span>
        <span className="rw-head__dash" aria-hidden="true">—</span>
        <span>{title}</span>
      </h2>
      {lead && <p className="rw-head__lead">{lead}</p>}
    </header>
  );
}

/** Not a live region on purpose: the wizard announces one summary instead of N simultaneous alerts,
    and the message is read with its field through aria-describedby. */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={`${id}-err`} className="rw-err">
      {message}
    </p>
  );
}

type Span = 2 | 3 | 4 | 6;

export function FieldShell({
  id,
  label,
  hint,
  span = 6,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  span?: Span;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rw-field rw-span-${span}`}>
      <label className="rw-label" htmlFor={id}>
        <span>{label}</span>
        {hint && <span className="rw-hint">{hint}</span>}
      </label>
      {children}
      <FieldError id={id} message={error} />
    </div>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  hint?: ReactNode;
  span?: Span;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  type?: 'text' | 'email' | 'tel';
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
  autoComplete?: string;
  placeholder?: string;
  mono?: boolean;
  /** Characters kept after stripping non-digits; enables digits-only mode. */
  digits?: number;
}

export function TextField({
  id,
  label,
  hint,
  span,
  value,
  error,
  onChange,
  onBlur,
  type = 'text',
  inputMode,
  autoComplete,
  placeholder,
  mono,
  digits,
}: TextFieldProps) {
  return (
    <FieldShell id={id} label={label} hint={hint} span={span} error={error}>
      <input
        id={id}
        name={id}
        className={`rw-input${mono ? ' rw-input--mono' : ''}`}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        // No maxLength: pasting "081-234-5678" must not be truncated before the dashes are stripped.
        onChange={(e) => {
          const raw = e.target.value;
          onChange(digits ? raw.replace(/\D/g, '').slice(0, digits) : raw);
        }}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        spellCheck={false}
      />
    </FieldShell>
  );
}
