/**
 * Shirt-size picker: native radios (keyboard arrows, form semantics, screen readers) with one
 * sliding "selected" pill driven by GSAP. Every tween uses overwrite:'auto', so clicking another
 * size mid-flight re-targets from wherever the pill currently is instead of queueing or jumping.
 */
import { useLayoutEffect, useRef } from 'react';
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
  const ctxRef = useRef<gsap.Context | null>(null);
  const placed = useRef(false);
  const mounted = useRef(false);

  /** Geometry of the selected chip, relative to the grid (the chips' offsetParent). */
  function target(): { x: number; y: number; width: number; height: number } | null {
    const chip = box.current?.querySelector<HTMLElement>('.rw-chip.is-on');
    return chip ? { x: chip.offsetLeft, y: chip.offsetTop, width: chip.offsetWidth, height: chip.offsetHeight } : null;
  }

  // Scope all GSAP tweens (thumb + tactile press) to this grid for clean unmount revert, and keep
  // the pill snapped to its chip across reflows (3 <-> 5 columns at 360px, font load, rotation).
  useLayoutEffect(() => {
    const root = box.current;
    const el = thumb.current;
    if (!root || !el) return;
    const ctx = gsap.context(() => {}, root);
    ctxRef.current = ctx;

    let alive = true;
    const snap = () => {
      if (!alive || !placed.current) return;
      const to = target();
      if (!to) return;
      ctx.add(() => {
        gsap.killTweensOf(el);
        gsap.set(el, { ...to, autoAlpha: 1, scaleX: 1, scaleY: 1 });
      });
    };

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(snap) : null;
    if (ro) {
      ro.observe(root);
      root.querySelectorAll('.rw-chip').forEach((chip) => ro.observe(chip));
    }
    document.fonts?.ready.then(snap).catch(() => {});

    return () => {
      alive = false;
      ro?.disconnect();
      ctx.revert();
      ctxRef.current = null;
      placed.current = false;
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const el = thumb.current;
    const root = box.current;
    const ctx = ctxRef.current;
    if (!el || !root || !ctx) return;

    const to = target();
    const isInitialMount = !mounted.current;
    mounted.current = true;

    ctx.add(() => {
      if (!to) {
        placed.current = false;
        gsap.killTweensOf(el);
        gsap.set(el, { autoAlpha: 0, scaleX: 1, scaleY: 1 });
        root.removeAttribute('data-thumb');
        return;
      }
      root.setAttribute('data-thumb', '');
      if (isInitialMount || prefersReducedMotion()) {
        // Pre-selected on mount (restored draft / Back navigation) or reduced motion: snap in place.
        gsap.killTweensOf(el);
        gsap.set(el, { ...to, autoAlpha: 1, scaleX: 1, scaleY: 1 });
        placed.current = true;
        return;
      }
      if (!placed.current) {
        // First pick by the user: grow cleanly from the centre.
        gsap.killTweensOf(el);
        gsap.set(el, to);
        gsap.fromTo(
          el,
          { autoAlpha: 0, scaleX: 0.88, scaleY: 0.88 },
          { autoAlpha: 1, scaleX: 1, scaleY: 1, duration: 0.22, ease: 'back.out(1.2)', overwrite: 'auto' },
        );
        placed.current = true;
        return;
      }
      // Moving between sizes: kill prior tweens (keeping live interpolated x/y/size) so rapid clicks
      // smoothly retarget from mid-flight and can never leave scaleX/scaleY stuck stretched.
      const prevX = Number(gsap.getProperty(el, 'x')) || 0;
      const prevY = Number(gsap.getProperty(el, 'y')) || 0;
      const horizontal = Math.abs(to.x - prevX) >= Math.abs(to.y - prevY);
      gsap.killTweensOf(el);
      gsap.to(el, { ...to, autoAlpha: 1, duration: 0.26, ease: 'back.out(0.6)', overwrite: 'auto' });
      gsap.fromTo(
        el,
        horizontal ? { scaleX: 1.03, scaleY: 1 } : { scaleX: 1, scaleY: 1.03 },
        { scaleX: 1, scaleY: 1, duration: 0.26, ease: 'power2.out', overwrite: 'auto' },
      );
    });
  }, [value]);

  /** Tactile press: a firm dip while held, crisp settle on release (no wobble). Interruptible. */
  function press(face: HTMLElement | null, down: boolean) {
    if (!face || prefersReducedMotion()) return;
    const run = () => {
      gsap.to(
        face,
        down
          ? { scale: 0.96, duration: 0.08, ease: 'power2.out', overwrite: 'auto' }
          : { scale: 1, duration: 0.18, ease: 'power2.out', overwrite: 'auto' },
      );
    };
    if (ctxRef.current) ctxRef.current.add(run);
    else run();
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
              <small className="rw-chip__chest font-mono">
                {chest}&quot;
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
}
