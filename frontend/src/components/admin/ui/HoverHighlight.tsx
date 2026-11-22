import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { FADE, FADE_EXIT, PILL_SPRING, isFinePointer } from './motion';

type Ctx = { id: string; active: string | null; set: (k: string | null) => void };
const HoverCtx = createContext<Ctx | null>(null);

/**
 * Aceternity "Hover Effect": one soft plate slides between the items of a grid as the mouse (or
 * keyboard focus) moves across them. Wrap the grid in `HoverGroup` and each cell in `HoverItem`.
 * Touch never shows the plate; nothing is hidden without it.
 */
export function HoverGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  const id = useId();
  const [active, set] = useState<string | null>(null);
  return (
    <HoverCtx.Provider value={{ id, active, set }}>
      <LayoutGroup id={id}>
        <div
          className={className}
          onPointerLeave={(e) => {
            if (!isFinePointer(e)) return;
            if (!e.currentTarget.querySelector(':focus-visible')) set(null);
          }}
          onPointerCancel={() => set(null)}
        >
          {children}
        </div>
      </LayoutGroup>
    </HoverCtx.Provider>
  );
}

export function HoverItem({ k, children, className = '' }: { k: string; children: ReactNode; className?: string }) {
  const ctx = useContext(HoverCtx);
  if (!ctx) throw new Error('HoverItem must be inside HoverGroup');
  const on = ctx.active === k;
  return (
    <div
      className={`relative ${className}`}
      onPointerEnter={(e) => isFinePointer(e) && ctx.set(k)}
      onFocusCapture={(e) => {
        if ((e.target as HTMLElement).matches?.(':focus-visible')) ctx.set(k);
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && ctx.active === k) {
          ctx.set(null);
        }
      }}
    >
      <AnimatePresence initial={false}>
        {on && (
          <motion.span
            aria-hidden="true"
            layoutId={`${ctx.id}-plate`}
            className="pointer-events-none absolute -inset-2 block rounded-[28px] bg-[var(--color-btn-ghost-hover)]"
            style={{ borderRadius: 28 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: FADE }}
            exit={{ opacity: 0, transition: FADE_EXIT }}
            transition={{ layout: PILL_SPRING }}
          />
        )}
      </AnimatePresence>
      <div className="relative h-full">{children}</div>
    </div>
  );
}
