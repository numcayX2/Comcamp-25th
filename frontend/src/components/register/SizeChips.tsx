/**
 * Shirt-size picker: native radios (keyboard arrows, form semantics, screen readers) with one
 * sliding "selected" pill driven by GSAP. Every tween uses overwrite:'auto', so clicking another
 * size mid-flight re-targets from wherever the pill currently is instead of queueing or jumping.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { SHIRT_SIZES, SIZE_CHEST } from './model';
import type { ShirtSize } from '../../lib/api';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SizeChips({
  value,
  invalid,
  onChange,
}: {
  value: ShirtSize | '';
  invalid: boolean;
  onChange: (size: ShirtSize) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  /** Geometry of the selected chip, relative to the grid (the chips' offsetParent). */
  function target(): { x: number; y: number; width: number; height: number } | null {
    const chip = box.current?.querySelector<HTMLElement>('.rw-chip.is-on');
    return chip ? { x: chip.offsetLeft, y: chip.offsetTop, width: chip.offsetWidth, height: chip.offsetHeight } : null;
  }

  useLayoutEffect(() => {
    const el = thumb.current;
    const root = box.current;
    if (!el || !root) return;
    const to = target();
    if (!to) {
      placed.current = false;
      gsap.killTweensOf(el);
      gsap.set(el, { autoAlpha: 0 });
      root.removeAttribute('data-thumb');
      return;
    }
    root.setAttribute('data-thumb', '');
    if (!placed.current || prefersReducedMotion()) {
      // First pick (or reduced motion): appear in place, growing from the centre.
      gsap.killTweensOf(el);
      gsap.set(el, to);
      if (prefersReducedMotion()) gsap.set(el, { autoAlpha: 1, scale: 1 });
      else gsap.fromTo(el, { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.35, ease: 'back.out(1.8)', overwrite: 'auto' });
      placed.current = true;
    } else {
      // Moving between sizes: slide, with a small stretch while in motion.
      gsap.to(el, { ...to, autoAlpha: 1, duration: 0.5, ease: 'back.out(1.25)', overwrite: 'auto' });
      gsap.fromTo(el, { scaleX: 1.06 }, { scaleX: 1, duration: 0.5, ease: 'power2.out' });
    }
  }, [value]);

  // Keep the pill glued to its chip when the grid reflows (4 columns <-> 7, font load, rotation).
  useEffect(() => {
    const root = box.current;
    const el = thumb.current;
    if (!root || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const to = target();
      if (to && placed.current) gsap.set(el, to);
    });
    ro.observe(root);
    return () => {
      ro.disconnect();
      gsap.killTweensOf(el);
    };
  }, []);

  /** Tactile press: shrinks while held, springs back. Interruptible like everything else here. */
  function press(face: HTMLElement | null, down: boolean) {
    if (!face || prefersReducedMotion()) return;
    gsap.to(face, down
      ? { scale: 0.93, duration: 0.12, ease: 'power2.out', overwrite: 'auto' }
      : { scale: 1, duration: 0.55, ease: 'elastic.out(1, 0.45)', overwrite: 'auto' });
  }

  return (
    <div className="rw-chips" ref={box}>
      <span className="rw-chips__thumb" ref={thumb} aria-hidden="true" />
      {SHIRT_SIZES.map((s, i) => {
        const id = i === 0 ? 'shirtSize' : `shirtSize-${s}`;
        const chest = SIZE_CHEST[s];
        return (
          <label
            key={s}
            className={`rw-chip${value === s ? ' is-on' : ''}`}
            htmlFor={id}
            onPointerDown={(e) => press(e.currentTarget.querySelector('.rw-chip__face'), true)}
            onPointerUp={(e) => press(e.currentTarget.querySelector('.rw-chip__face'), false)}
            onPointerLeave={(e) => press(e.currentTarget.querySelector('.rw-chip__face'), false)}
            onPointerCancel={(e) => press(e.currentTarget.querySelector('.rw-chip__face'), false)}
          >
            <input
              type="radio"
              id={id}
              name="shirtSize"
              value={s}
              checked={value === s}
              onChange={() => onChange(s)}
              aria-describedby={invalid ? 'shirtSize-err' : undefined}
            />
            <span className="rw-chip__face">
              <span className="font-mono">{s}</span>
              {chest !== null && (
                <small className="rw-chip__chest font-mono">
                  {chest}&quot;
                </small>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
