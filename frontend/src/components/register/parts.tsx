/**
 * Small presentational pieces shared by the wizard and the receipt.
 * Everything here is defined at module level on purpose: components declared
 * inside another component's render get a new identity each render and would
 * drop input focus on every keystroke.
 */
import { useRef, type ReactNode, type Ref } from 'react';
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
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5v4M8 11v.01" />
      </svg>
      <span>{message}</span>
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
  /** Display grouping for a digits-only field: group sizes joined with hyphens (state stays raw digits). */
  groups?: number[];
}

/** "1509900012345" + [1,4,5,2,1] -> "1-5099-00012-34-5"; partial input stays partial, no trailing hyphen. */
export function formatGroups(digits: string, groups: number[]): string {
  const out: string[] = [];
  let at = 0;
  for (const g of groups) {
    if (at >= digits.length) break;
    out.push(digits.slice(at, at + g));
    at += g;
  }
  return out.join('-');
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
  groups,
}: TextFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const shown = groups ? formatGroups(value, groups) : value;
  return (
    <FieldShell id={id} label={label} hint={hint} span={span} error={error}>
      <input
        id={id}
        name={id}
        ref={ref}
        className={`rw-input${mono ? ' rw-input--mono' : ''}`}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={shown}
        // No maxLength: pasting "081-234-5678" must not be truncated before the dashes are stripped.
        onChange={(e) => {
          const el = e.target;
          const raw = el.value;
          const next = digits ? raw.replace(/\D/g, '').slice(0, digits) : raw;
          onChange(next);
          if (groups) {
            // Hyphens are re-inserted by formatting, so put the caret back after the same digit.
            const caret = el.selectionStart ?? raw.length;
            const before = raw.slice(0, caret).replace(/\D/g, '').length;
            const text = formatGroups(next, groups);
            let pos = 0;
            for (let seen = 0; pos < text.length && seen < before; pos++) if (/\d/.test(text[pos])) seen++;
            requestAnimationFrame(() => {
              if (ref.current && document.activeElement === ref.current) ref.current.setSelectionRange(pos, pos);
            });
          }
        }}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        spellCheck={false}
      />
    </FieldShell>
  );
}
