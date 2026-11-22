import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { motion, useIsPresent, useReducedMotion } from 'motion/react';
import { EXPAND, FADE, FADE_EXIT } from './motion';

/**
 * Panel that opens under a ledger row or sponsor item (details, slip check, edit, confirm strips).
 * Animates opacity and a small rise only: animating `height` would re-lay-out the whole list on
 * every frame. While exiting, the panel is inert and gives up focus at once, so the parent's
 * focus-return effects (which check `document.activeElement === body`) still run.
 */
export function RevealPanel({ children }: { children: ReactNode }) {
  const reduce = Boolean(useReducedMotion());
  const isPresent = useIsPresent();
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (isPresent) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && ref.current?.contains(active)) active.blur();
  }, [isPresent]);

  return (
    <motion.div
      ref={ref}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: FADE_EXIT }}
      transition={reduce ? FADE : EXPAND}
      inert={!isPresent || undefined}
      aria-hidden={!isPresent || undefined}
    >
      {children}
    </motion.div>
  );
}
