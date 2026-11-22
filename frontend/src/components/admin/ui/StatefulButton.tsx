import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { EASE_OUT, FADE, ICON_SPRING, TAP_SCALE } from './motion';

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
  style,
  type = 'button',
  ...rest
}: Props) {
  const reduce = Boolean(useReducedMotion());
  const [done, setDone] = useState(false);
  const [seenSignal, setSeenSignal] = useState(doneSignal);
  const prevBusy = useRef(busy);
  const timerRef = useRef<number | null>(null);

  // Callers clear `busy` and bump `doneSignal` in the same update. Switching to `done` while
  // rendering (React's "adjust state on prop change") avoids a frame of the idle label between
  // the spinner and the check. A signal dropping back to `undefined` (callers that share one
  // `{ id, n }` state across rows) is ignored rather than cancelling this row's beat.
  if (doneSignal !== undefined && doneSignal !== seenSignal) {
    setSeenSignal(doneSignal);
    if (doneSignal > 0) setDone(true);
  }

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Starting a new busy cycle always cancels any lingering success beat.
  useEffect(() => {
    if (busy && !prevBusy.current) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setDone(false);
    }
    prevBusy.current = busy;
  }, [busy]);

  // Each new success signal restarts the beat's timer.
  useEffect(() => {
    if (!done) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setDone(false);
    }, DONE_MS);
  }, [done, seenSignal]);

  const phase: 'idle' | 'busy' | 'done' = busy ? 'busy' : done ? 'done' : 'idle';
  const showSlot = phase === 'busy' || phase === 'done' || Boolean(icon);
  const isDisabled = Boolean(disabled || busy);

  // Opacity + scale only: `filter: blur()` repaints every frame and is not on the motion allow-list.
  const iconMotion = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: FADE }
    : {
        initial: { opacity: 0, scale: 0.25 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.25 },
        transition: ICON_SPRING,
      };

  return (
    <motion.button
      type={type}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      whileTap={isDisabled ? undefined : TAP_SCALE}
      transition={ICON_SPRING}
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ gap: 0, ...style }}
      {...rest}
    >
      {/* The 16px slot fades in; its width is never animated (that would reflow the row each frame).
          It leaves at once, in the same frame as the label change, so the width settles in one step. */}
      <AnimatePresence initial={false}>
        {showSlot && (
          <motion.span
            key="icon-slot"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0 } }}
            transition={FADE}
            className="relative mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {phase === 'busy' && (
                <motion.span key="busy" className="inline-flex items-center justify-center" {...iconMotion}>
                  <Spinner />
                </motion.span>
              )}
              {phase === 'done' && (
                <motion.span key="done" className="inline-flex items-center justify-center" {...iconMotion}>
                  <Check reduce={reduce} />
                </motion.span>
              )}
              {phase === 'idle' && icon && (
                <motion.span key="icon" className="inline-flex items-center justify-center" {...iconMotion}>
                  {icon}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.span>
        )}
      </AnimatePresence>
      <span className="whitespace-nowrap">
        {phase === 'busy' ? busyLabel : phase === 'done' ? (doneLabel ?? children) : children}
      </span>
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

function Check({ reduce }: { reduce: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <motion.path
        d="M5 12.5l4.5 4.5L19 7.5"
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.28, ease: EASE_OUT }}
      />
    </svg>
  );
}
