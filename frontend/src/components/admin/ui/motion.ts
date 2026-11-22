import { useCallback, useState } from 'react';
import type { Transition } from 'motion/react';

/**
 * Motion vocabulary for /admin (Aceternity UI patterns, restyled with the site's own tokens).
 * Every motion component sits under `<MotionConfig reducedMotion="user">` in AdminSection, so
 * transform and layout animations stop for `prefers-reduced-motion: reduce`.
 */

/** Sliding pills and wells (Aceternity "Animated Tabs"), a little calmer than the original bounce. */
export const PILL_SPRING: Transition = { type: 'spring', bounce: 0.18, duration: 0.5 };

/** Width/size changes (sidebar, dock magnification). */
export const SIZE_SPRING: Transition = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 };

/** Short opacity fades for labels and trackers. */
export const FADE: Transition = { duration: 0.16, ease: [0.22, 1, 0.36, 1] };

/** Row panels opening under an applicant (Aceternity "Expandable Card", in place). */
export const EXPAND: Transition = { duration: 0.28, ease: [0.22, 1, 0.36, 1] };

/**
 * A counter that a successful action bumps; pass it as `doneSignal` to StatefulButton so the
 * button plays its success beat. Kept in component state only.
 */
export function useDoneSignal(): [number, () => void] {
  const [n, setN] = useState(0);
  const bump = useCallback(() => setN((v) => v + 1), []);
  return [n, bump];
}

/** True for a mouse or pen pointer (hover effects never fire for touch). */
export function isFinePointer(e: { pointerType?: string }): boolean {
  return e.pointerType === 'mouse' || e.pointerType === 'pen';
}
