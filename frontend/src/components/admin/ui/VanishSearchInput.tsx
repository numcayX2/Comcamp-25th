import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Search, X } from 'lucide-react';
import { EASE_OUT, FADE, FADE_EXIT, ICON_SPRING, TAP_SCALE } from './motion';

type Props = {
  id: string;
  /** Screen-reader label (the rotating hints are decoration and aria-hidden). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Hints that take turns in the empty field; the first one is the static fallback. */
  placeholders: string[];
  className?: string;
  inputClassName?: string;
  style?: CSSProperties;
};

type Dot = { x: number; y: number; r: number; color: string };

const ROTATE_MS = 3000;
const MAX_VANISH_MS = 850;

/**
 * Aceternity "Placeholders And Vanish Input", adapted to a live filter: the empty field cycles
 * through what can be searched, and clearing (the ✕ button or Escape) turns the old text into
 * particles that drift away while the list resets at once. Typing immediately interrupts any
 * running particle animation. Reduced motion: one static hint, an instant clear.
 */
export function VanishSearchInput({ id, label, value, onChange, placeholders, className = '', inputClassName = '', style }: Props) {
  const reduce = Boolean(useReducedMotion());
  const [hint, setHint] = useState(0);
  const [vanishing, setVanishing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);

  const stopVanish = useCallback(() => {
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    }
    const canvas = canvasRef.current;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    setVanishing(false);
  }, []);

  useEffect(() => {
    setHint(0);
    if (reduce || placeholders.length < 2) return;
    let timer = 0;
    const start = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => setHint((h) => (h + 1) % placeholders.length), ROTATE_MS);
    };
    const onVis = () => (document.visibilityState === 'visible' ? start() : window.clearInterval(timer));
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [placeholders, reduce]);

  // Typing again (or enabling reduced motion) immediately cancels any leftover particles so
  // old particles never smear over newly entered text.
  useEffect(() => {
    if (value.length > 0 || reduce) stopVanish();
  }, [value, reduce, stopVanish]);

  useEffect(() => () => stopVanish(), [stopVanish]);

  const vanish = () => {
    const input = inputRef.current;
    const canvas = canvasRef.current;
    const text = input?.value ?? '';
    stopVanish();
    onChange('');
    input?.focus();
    if (reduce || !input || !canvas || !text) return;

    const w = input.clientWidth;
    const h = input.clientHeight;
    if (w <= 0 || h <= 0) return;

    const cs = getComputedStyle(input);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (cw <= 0 || ch <= 0) return;

    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${input.clientLeft}px`;
    canvas.style.top = `${input.clientTop}px`;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const clipWidth = Math.max(0, w - padLeft - padRight);
    if (clipWidth <= 0) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;

    // Center using font ascender/descender metrics so Thai vowels and tone marks sit on the exact
    // same baseline as the native input and never clip at the top or bottom edge.
    const metrics = ctx.measureText(text);
    const hasBoxMetrics =
      typeof metrics.fontBoundingBoxAscent === 'number' &&
      typeof metrics.fontBoundingBoxDescent === 'number' &&
      metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent > 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, 0, clipWidth, h);
    ctx.clip();
    if (hasBoxMetrics) {
      ctx.textBaseline = 'alphabetic';
      const baselineY = (h + metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
      ctx.fillText(text, padLeft - input.scrollLeft, baselineY);
    } else {
      ctx.textBaseline = 'middle';
      ctx.fillText(text, padLeft - input.scrollLeft, h / 2);
    }
    ctx.restore();

    const img = ctx.getImageData(0, 0, cw, ch).data;
    const dots: Dot[] = [];
    const step = Math.max(1, Math.round(dpr));
    for (let y = 0; y < ch; y += step) {
      for (let x = 0; x < cw; x += step) {
        const i = (y * cw + x) * 4;
        const a = img[i + 3];
        if (a > 40) {
          dots.push({ x: x / dpr, y: y / dpr, r: 1.1, color: `rgba(${img[i]},${img[i + 1]},${img[i + 2]},${a / 255})` });
        }
      }
    }
    if (!dots.length) return;

    setVanishing(true);
    let pos = dots.reduce((m, d) => Math.max(m, d.x), 0);
    const startedAt = performance.now();
    let lastAt = startedAt;

    const frame = (now: number) => {
      const dt = Math.min(32, Math.max(4, now - lastAt)) / 16.667;
      lastAt = now;
      let write = 0;
      for (let idx = 0; idx < dots.length; idx++) {
        const d = dots[idx];
        if (d.x < pos) {
          dots[write++] = d;
          continue;
        }
        d.x += (Math.random() > 0.5 ? 1 : -1) * dt;
        d.y += (Math.random() > 0.5 ? 1 : -1) * dt;
        d.r -= 0.055 * Math.random() * dt;
        if (d.r > 0) dots[write++] = d;
      }
      dots.length = write;

      ctx.clearRect(0, 0, w, h);
      for (let idx = 0; idx < dots.length; idx++) {
        const d = dots[idx];
        ctx.fillStyle = d.color;
        ctx.fillRect(d.x, d.y, d.r, d.r);
      }
      pos -= 9 * dt;
      if (dots.length && now - startedAt < MAX_VANISH_MS) {
        raf.current = requestAnimationFrame(frame);
      } else {
        raf.current = 0;
        ctx.clearRect(0, 0, w, h);
        setVanishing(false);
      }
    };
    raf.current = requestAnimationFrame(frame);
  };

  const hasValue = value.length > 0;

  return (
    <div className={`relative ${className}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden="true"
        strokeWidth={1.5}
        size={16}
        className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2"
        style={{ color: 'var(--color-ink-subtle)' }}
      />
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={(e) => {
          if (vanishing) stopVanish();
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && hasValue) {
            e.preventDefault();
            vanish();
          }
        }}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        className={`relative ${inputClassName} ${hasValue ? 'pr-12' : 'pr-4'}`}
        style={style}
      />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0"
        style={{ opacity: vanishing ? 1 : 0 }}
      />
      {!hasValue && !vanishing && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-10 right-4 flex items-center overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={hint}
              initial={reduce ? { opacity: 0 } : { y: 6, opacity: 0 }}
              animate={{ y: 0, opacity: 1, transition: { duration: 0.22, ease: EASE_OUT } }}
              exit={reduce ? { opacity: 0, transition: FADE_EXIT } : { y: -6, opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }}
              className="block truncate text-base"
              style={{ color: 'var(--color-ink-subtle)' }}
            >
              {placeholders[hint] ?? placeholders[0]}
            </motion.span>
          </AnimatePresence>
        </div>
      )}
      <div className="pointer-events-none absolute inset-y-0 right-1 z-10 flex items-center">
        <AnimatePresence initial={false}>
          {hasValue && (
            <motion.button
              key="clear"
              type="button"
              onClick={vanish}
              aria-label="ล้างคำค้นหา"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0, transition: FADE_EXIT } : { opacity: 0, scale: 0.6, transition: FADE_EXIT }}
              whileTap={TAP_SCALE}
              transition={reduce ? FADE : ICON_SPRING}
              className="pointer-events-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-full outline-none transition-colors hover:bg-[var(--color-btn-ghost-hover)] focus-visible:ring-2 focus-visible:ring-[var(--color-tech)] motion-reduce:transition-none"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              <X aria-hidden="true" strokeWidth={1.5} size={16} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
