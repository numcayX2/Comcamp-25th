import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Search, X } from 'lucide-react';

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

/**
 * Aceternity "Placeholders And Vanish Input", adapted to a live filter: the empty field cycles
 * through what can be searched, and clearing (the ✕ button or Escape) turns the old text into
 * particles that drift away while the list resets at once. Reduced motion: one static hint, an
 * instant clear.
 */
export function VanishSearchInput({ id, label, value, onChange, placeholders, className = '', inputClassName = '', style }: Props) {
  const reduce = useReducedMotion();
  const [hint, setHint] = useState(0);
  const [vanishing, setVanishing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);

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

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const vanish = () => {
    const input = inputRef.current;
    const canvas = canvasRef.current;
    const text = input?.value ?? '';
    onChange('');
    input?.focus();
    if (reduce || !input || !canvas || !text) return;

    const cs = getComputedStyle(input);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = input.clientWidth;
    const h = input.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, parseFloat(cs.paddingLeft) || 0, h / 2);

    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const dots: Dot[] = [];
    const step = Math.max(1, Math.round(dpr));
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const i = (y * canvas.width + x) * 4;
        const a = img[i + 3];
        if (a > 40) dots.push({ x: x / dpr, y: y / dpr, r: 1.1, color: `rgba(${img[i]},${img[i + 1]},${img[i + 2]},${a / 255})` });
      }
    }
    if (!dots.length) return;

    setVanishing(true);
    let pos = dots.reduce((m, d) => Math.max(m, d.x), 0);
    let live = dots;
    let frames = 0;
    const frame = () => {
      live = live.filter((d) => {
        if (d.x < pos) return true;
        d.x += Math.random() > 0.5 ? 1 : -1;
        d.y += Math.random() > 0.5 ? 1 : -1;
        d.r -= 0.05 * Math.random();
        return d.r > 0;
      });
      ctx.clearRect(0, 0, w, h);
      for (const d of live) {
        ctx.fillStyle = d.color;
        ctx.fillRect(d.x, d.y, d.r, d.r);
      }
      pos -= 8;
      frames += 1;
      if (live.length && frames < 150) raf.current = requestAnimationFrame(frame);
      else {
        ctx.clearRect(0, 0, w, h);
        setVanishing(false);
      }
    };
    cancelAnimationFrame(raf.current);
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
        onChange={(e) => onChange(e.target.value)}
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
              initial={{ y: 6, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -12, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="block truncate text-base"
              style={{ color: 'var(--color-ink-subtle)' }}
            >
              {placeholders[hint] ?? placeholders[0]}
            </motion.span>
          </AnimatePresence>
        </div>
      )}
      {hasValue && (
        <button
          type="button"
          onClick={vanish}
          aria-label="ล้างคำค้นหา"
          className="absolute right-1 top-1/2 z-10 inline-flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full outline-none transition-colors hover:bg-[var(--color-btn-ghost-hover)] focus-visible:ring-2 focus-visible:ring-[var(--color-tech)]"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          <X aria-hidden="true" strokeWidth={1.5} size={16} />
        </button>
      )}
    </div>
  );
}
