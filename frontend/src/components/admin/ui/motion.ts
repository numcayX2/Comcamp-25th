import { useCallback, useEffect, useState } from 'react';
import type { Transition } from 'motion/react';

/**
 * Motion vocabulary for /admin (Aceternity UI patterns, restyled with the site's own tokens).
 * Every motion component sits under `<MotionConfig reducedMotion="user">` in AdminSection, so
 * transform and layout animations stop for `prefers-reduced-motion: reduce`.
 */

/** Shared ease-out curve for enters and exits across /admin. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Sliding pills, wells, and hover plates (snappy, critically damped — zero overshoot jitter). */
export const PILL_SPRING: Transition = { type: 'spring', stiffness: 480, damping: 38, mass: 0.8 };

/** Width/size and reorder changes (sidebar collapse/peek, list reorder, card lift). */
export const SIZE_SPRING: Transition = { type: 'spring', stiffness: 420, damping: 36, mass: 0.85 };

/** Contextual icon swaps (spinner ↔ check ↔ idle icon): zero bounce for optical calm. */
export const ICON_SPRING: Transition = { type: 'spring', duration: 0.3, bounce: 0 };

/** Short opacity fades for labels, tooltips, and trackers (exit is faster/softer than enter). */
export const FADE: Transition = { duration: 0.16, ease: EASE_OUT };
export const FADE_EXIT: Transition = { duration: 0.12, ease: EASE_OUT };

/** Row panels opening/closing under an applicant or sponsor item (exit faster than enter). */
export const EXPAND: Transition = { duration: 0.24, ease: EASE_OUT };
export const COLLAPSE: Transition = { duration: 0.18, ease: EASE_OUT };

/** Tactile button press scale (subtle, disabled automatically under reduced motion). */
export const TAP_SCALE = { scale: 0.96 } as const;

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

/** SSR-safe media query hook used to guard `layoutId` elements that are CSS-hidden at other breakpoints. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return matches;
}
