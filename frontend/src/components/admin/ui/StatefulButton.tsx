import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FADE, SIZE_SPRING } from './motion';

type NativeButton = Omit<
  ComponentProps<'button'>,
  'children' | 'onAnimationStart' | 'onAnimationEnd' | 'onDrag' | 'onDragStart' | 'onDragEnd' | 'ref'
>;

type Props = NativeButton & {
  /** The action is running: spinner + `busyLabel`, the button is disabled and aria-busy. */
  busy: boolean;
  /** Text while busy (AGENTS §9.2 busy labels), e.g. "กำลังบันทึก…". */
  busyLabel: ReactNode;
  /** Bump after a successful action (see `useDoneSignal`) to play the check beat. */
  doneSignal?: number;
  /** Text during the success beat; defaults to the idle label. */
  doneLabel?: ReactNode;
  /** Optional leading icon shown while idle. */
  icon?: ReactNode;
  children: ReactNode;
};

const DONE_MS = 1600;

/**
 * Aceternity "Stateful Button": idle → spinner while the work runs → a drawn check on success,
 * then back to idle. The caller still owns the work and its synchronous `useRef` lock; this only
 * renders the state it is given, so a disabled/busy button can never fire twice.
 */
export function StatefulButton({
  busy,
  busyLabel,
  doneSignal,
  doneLabel,
  icon,
  children,
  disabled,
  className = '',
  type = 'button',
  ...rest
}: Props) {
  const [done, setDone] = useState(false);
  const seen = useRef(doneSignal);

  useEffect(() => {
    if (doneSignal === undefined || doneSignal === seen.current) return;
    seen.current = doneSignal;
    setDone(true);
    const t = window.setTimeout(() => setDone(false), DONE_MS);
    return () => window.clearTimeout(t);
  }, [doneSignal]);

  useEffect(() => {
    if (busy) setDone(false);
  }, [busy]);

  const phase: 'idle' | 'busy' | 'done' = busy ? 'busy' : done ? 'done' : 'idle';

  return (
    <motion.button
      layout
      transition={SIZE_SPRING}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 ${className}`}
      {...rest}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {phase === 'busy' && (
          <motion.span
            key="busy"
            aria-hidden="true"
            className="inline-flex shrink-0"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.4 }}
            transition={FADE}
          >
            <Spinner />
          </motion.span>
        )}
        {phase === 'done' && (
          <motion.span
            key="done"
            aria-hidden="true"
            className="inline-flex shrink-0"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.4 }}
            transition={FADE}
          >
            <Check />
          </motion.span>
        )}
        {phase === 'idle' && icon && (
          <motion.span
            key="icon"
            aria-hidden="true"
            className="inline-flex shrink-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE}
          >
            {icon}
          </motion.span>
        )}
      </AnimatePresence>
      <motion.span layout="position" transition={SIZE_SPRING} className="whitespace-nowrap">
        {phase === 'busy' ? busyLabel : phase === 'done' ? (doneLabel ?? children) : children}
      </motion.span>
      {phase === 'done' && (
        <span role="status" className="sr-only">
          {doneLabel ?? 'สำเร็จ'}
        </span>
      )}
    </motion.button>
  );
}

function Spinner() {
  return (
    <motion.svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      animate={{ rotate: 360 }}
      transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </motion.svg>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <motion.path
        d="M5 12.5l4.5 4.5L19 7.5"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  );
}
