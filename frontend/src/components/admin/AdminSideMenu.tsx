import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { Ellipsis, LogOut, PanelLeftClose, PanelLeftOpen, RotateCw, type LucideIcon } from 'lucide-react';
import { AMBER_TEXT, BTN_DARK, BTN_DARK_TEXT, FOCUS, INK, INK_2, INK_3, RULE, TECH, WARNING } from '../admin-ui';
import { FADE, PILL_SPRING, SIZE_SPRING, isFinePointer } from './ui/motion';

export type AdminMenuItem<K extends string = string> = {
  key: K;
  label: string;
  Icon: LucideIcon;
  /** Count shown at the right (hidden when 0). */
  n?: number;
  /** Screen-reader text for the count (the visible number is aria-hidden). */
  srCount?: string;
  /** Amber dot beside the count: something needs attention. */
  alert?: boolean;
};

type Props<K extends string> = {
  items: AdminMenuItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  onRefresh: () => void;
  onLogout: () => void;
  busy: boolean;
};

/**
 * The /admin view menu, two Aceternity patterns over the same items:
 * - xl and up, "Sidebar": a raised dock that can fold to an icon rail; a folded rail opens over the
 *   page while the pointer or keyboard focus is in it. A pressed-in well glides to the active view.
 * - below xl, "Floating Dock": a pill of icons fixed to the bottom of the screen with a "more"
 *   stack for refresh / log out. It steps aside while a text field has focus (on-screen keyboards).
 * Both are plain buttons with aria-current, so the menu works without motion.
 */
export function AdminSideMenu<K extends string>(props: Props<K>) {
  return (
    <>
      <AdminSidebar {...props} />
      <AdminDock {...props} />
    </>
  );
}

/* ───────────────────────── Sidebar (xl and up) ───────────────────────── */

const WIDE = 224;
const RAIL = 76;

function AdminSidebar<K extends string>({ items, active, onSelect, onRefresh, onLogout, busy }: Props<K>) {
  const [open, setOpen] = useState(true);
  const [peek, setPeek] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const timer = useRef(0);
  const groupId = useId();
  const expanded = open || peek;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const startPeek = () => {
    if (open) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPeek(true), 120);
  };
  const endPeek = () => {
    window.clearTimeout(timer.current);
    setPeek(false);
  };

  const row = (key: string, label: string, icon: ReactNode, extra: ReactNode, onClick: () => void, opts: { current?: boolean; disabled?: boolean } = {}) => (
    <li
      key={key}
      className="relative"
      onPointerEnter={(e) => isFinePointer(e) && setHover(key)}
    >
      {opts.current && (
        <motion.span
          aria-hidden="true"
          layoutId={`${groupId}-well`}
          transition={PILL_SPRING}
          className="pointer-events-none absolute inset-0 rounded-full bg-[var(--bg-surface)] [box-shadow:var(--shadow-well)]"
        />
      )}
      <AnimatePresence>
        {hover === key && !opts.current && (
          <motion.span
            aria-hidden="true"
            layoutId={`${groupId}-hover`}
            transition={PILL_SPRING}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15, delay: 0.1 } }}
            className="pointer-events-none absolute inset-0 rounded-full bg-[var(--color-btn-ghost-hover)]"
          />
        )}
      </AnimatePresence>
      <button
        type="button"
        aria-current={opts.current ? 'page' : undefined}
        disabled={opts.disabled}
        aria-busy={opts.disabled || undefined}
        onClick={onClick}
        className={`group relative flex min-h-11 w-full items-center rounded-full text-left text-sm disabled:opacity-60 ${opts.current ? 'font-semibold' : 'font-medium'} ${FOCUS}`}
        style={{ color: opts.current ? INK : INK_2 }}
      >
        <span className="relative flex w-[52px] shrink-0 items-center justify-center">{icon}</span>
        <motion.span
          className="min-w-0 flex-1 overflow-hidden whitespace-nowrap pr-4"
          animate={{ opacity: expanded ? 1 : 0 }}
          transition={FADE}
        >
          {label}
        </motion.span>
        {expanded && extra}
      </button>
    </li>
  );

  return (
    <motion.div
      className="relative z-30 hidden self-start xl:sticky xl:top-[calc(var(--admin-nav-h,0px)+1rem)] xl:block print:hidden"
      initial={false}
      animate={{ width: open ? WIDE : RAIL }}
      transition={SIZE_SPRING}
    >
      <motion.div
        initial={false}
        animate={{ width: expanded ? WIDE : RAIL }}
        transition={SIZE_SPRING}
        onPointerEnter={(e) => isFinePointer(e) && startPeek()}
        onPointerLeave={() => {
          endPeek();
          setHover(null);
        }}
        onFocusCapture={startPeek}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) endPeek();
        }}
        className="absolute left-0 top-0 overflow-hidden rounded-[28px] bg-[var(--bg-card)] p-3 transition-shadow duration-200"
        style={{ boxShadow: peek && !open ? 'var(--shadow-float)' : 'var(--shadow-card)' }}
      >
        <div className="mb-1 flex justify-start">
          <button
            type="button"
            onClick={() => {
              setOpen((v) => !v);
              setPeek(false);
            }}
            aria-expanded={open}
            aria-label={open ? 'ย่อเมนูเหลือไอคอน' : 'ขยายเมนู'}
            className={`inline-flex h-11 w-[52px] items-center justify-center rounded-full transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
            style={{ color: INK_3 }}
          >
            {open ? <PanelLeftClose aria-hidden="true" size={17} strokeWidth={1.5} /> : <PanelLeftOpen aria-hidden="true" size={17} strokeWidth={1.5} />}
          </button>
        </div>

        <nav aria-label="เมนูผู้ดูแลระบบ">
          <ul className="flex flex-col gap-1">
            {items.map(({ key, label, Icon, n, srCount, alert }) => {
              const isActive = active === key;
              const count = n !== undefined && n > 0;
              return row(
                key,
                label,
                <>
                  <Icon
                    aria-hidden="true"
                    size={17}
                    strokeWidth={1.5}
                    className="transition-[translate,color] duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                    style={{ color: isActive ? TECH : INK_3 }}
                  />
                  {count && !expanded && (
                    <span
                      aria-hidden="true"
                      className="absolute right-3 top-0 size-2 rounded-full ring-2 ring-[var(--bg-card)]"
                      style={{ backgroundColor: alert ? WARNING : INK_3 }}
                    />
                  )}
                  {count && srCount && !expanded && <span className="sr-only">{srCount}</span>}
                </>,
                count ? (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 pr-3 font-mono text-xs tabular-nums" style={{ color: alert ? AMBER_TEXT : INK_3 }}>
                    {alert && <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: WARNING }} />}
                    <span aria-hidden="true">{n}</span>
                    {srCount && <span className="sr-only">{srCount}</span>}
                  </span>
                ) : null,
                () => onSelect(key),
                { current: isActive },
              );
            })}
          </ul>
        </nav>

        <ul className="mt-2 flex flex-col gap-1 border-t pt-2" style={{ borderColor: RULE }}>
          {row(
            'refresh',
            busy ? 'กำลังโหลด…' : 'รีเฟรช',
            <RotateCw
              aria-hidden="true"
              size={17}
              strokeWidth={1.5}
              className={`transition-[rotate] duration-300 group-hover:rotate-90 motion-reduce:transition-none motion-reduce:group-hover:rotate-0 ${busy ? 'motion-safe:animate-spin' : ''}`}
              style={{ color: INK_3 }}
            />,
            null,
            onRefresh,
            { disabled: busy },
          )}
          {row(
            'logout',
            'ออกจากระบบ',
            <LogOut
              aria-hidden="true"
              size={17}
              strokeWidth={1.5}
              className="transition-[translate] duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              style={{ color: INK_3 }}
            />,
            null,
            onLogout,
          )}
        </ul>
      </motion.div>
    </motion.div>
  );
}

/* ───────────────────────── Floating dock (below xl) ───────────────────────── */

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(el.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

function AdminDock<K extends string>({ items, active, onSelect, onRefresh, onLogout, busy }: Props<K>) {
  const groupId = useId();
  const moreId = `${groupId}-more`;
  const reduce = useReducedMotion();
  const mouseX = useMotionValue(Infinity);
  const [typing, setTyping] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const moreWrap = useRef<HTMLDivElement>(null);

  // Step aside for on-screen keyboards: a text field anywhere on the page hides the dock.
  useEffect(() => {
    const sync = () => setTyping(isTextEntry(document.activeElement));
    const later = () => window.setTimeout(sync, 0);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', later);
    };
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!moreWrap.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        moreBtn.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const hidden = typing && !moreOpen;

  return (
    <motion.div
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-2 xl:hidden print:hidden"
      style={{ bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
      initial={false}
      animate={hidden ? { y: 96, opacity: 0 } : { y: 0, opacity: 1 }}
      transition={SIZE_SPRING}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <nav
        aria-label="เมนูผู้ดูแลระบบ"
        className="pointer-events-auto relative flex items-end gap-0.5 rounded-full bg-[var(--bg-card)] p-1.5 [box-shadow:var(--shadow-float)]"
        onPointerMove={(e) => isFinePointer(e) && !reduce && mouseX.set(e.clientX)}
        onPointerLeave={() => mouseX.set(Infinity)}
      >
        {items.map(({ key, label, Icon, n, srCount, alert }) => (
          <DockItem
            key={key}
            mouseX={mouseX}
            label={label}
            current={active === key}
            showLabel={flash === key}
            wellId={`${groupId}-well`}
            badge={n !== undefined && n > 0 ? (alert ? WARNING : INK_3) : null}
            srCount={n !== undefined && n > 0 ? srCount : undefined}
            onClick={() => {
              setMoreOpen(false);
              onSelect(key);
              setFlash(key);
            }}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.5} />
          </DockItem>
        ))}

        <span aria-hidden="true" className="mx-0.5 mb-3 h-5 w-px self-end" style={{ backgroundColor: RULE }} />

        <div ref={moreWrap} className="relative">
          <AnimatePresence>
            {moreOpen && (
              <motion.ul
                id={moreId}
                className="absolute bottom-full right-0 mb-3 flex flex-col items-end gap-2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { delay: 0.1 } }}
              >
                {[
                  { key: 'refresh', label: busy ? 'กำลังโหลด…' : 'รีเฟรชข้อมูล', Icon: RotateCw, onClick: onRefresh, disabled: busy },
                  { key: 'logout', label: 'ออกจากระบบ', Icon: LogOut, onClick: onLogout, disabled: false },
                ].map((a, idx, arr) => (
                  <motion.li
                    key={a.key}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: (arr.length - 1 - idx) * 0.05 } }}
                    exit={{ opacity: 0, y: 10, transition: { delay: idx * 0.05 } }}
                  >
                    <button
                      type="button"
                      disabled={a.disabled}
                      aria-busy={a.disabled || undefined}
                      onClick={() => {
                        setMoreOpen(false);
                        a.onClick();
                      }}
                      className={`inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full bg-[var(--bg-card)] px-4 text-sm font-medium [box-shadow:var(--shadow-float)] disabled:opacity-60 ${FOCUS}`}
                      style={{ color: INK }}
                    >
                      <a.Icon
                        aria-hidden="true"
                        size={17}
                        strokeWidth={1.5}
                        className={a.key === 'refresh' && busy ? 'motion-safe:animate-spin' : ''}
                        style={{ color: INK_3 }}
                      />
                      {a.label}
                    </button>
                  </motion.li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
          <button
            ref={moreBtn}
            type="button"
            aria-label="เมนูเพิ่มเติม: รีเฟรช, ออกจากระบบ"
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? moreId : undefined}
            onClick={() => setMoreOpen((v) => !v)}
            className={`relative inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-btn-ghost-hover)] ${FOCUS}`}
            style={{ color: INK_2, backgroundColor: moreOpen ? 'var(--color-btn-ghost-hover)' : undefined }}
          >
            {busy ? (
              <RotateCw aria-hidden="true" size={18} strokeWidth={1.5} className="motion-safe:animate-spin" />
            ) : (
              <Ellipsis aria-hidden="true" size={18} strokeWidth={1.5} />
            )}
          </button>
        </div>
      </nav>
    </motion.div>
  );
}

function DockItem({
  mouseX,
  label,
  current,
  showLabel,
  wellId,
  badge,
  srCount,
  onClick,
  children,
}: {
  mouseX: MotionValue<number>;
  label: string;
  current: boolean;
  showLabel: boolean;
  wellId: string;
  badge: string | null;
  srCount?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  // Aceternity dock magnification, toned down: 44px at rest, up to 54px under a mouse pointer.
  const distance = useTransform(mouseX, (x) => {
    const b = ref.current?.getBoundingClientRect();
    return b ? x - b.left - b.width / 2 : Infinity;
  });
  const size = useSpring(useTransform(distance, [-110, 0, 110], [44, 54, 44]), { mass: 0.1, stiffness: 170, damping: 14 });

  return (
    <motion.button
      ref={ref}
      type="button"
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      onClick={onClick}
      onPointerEnter={(e) => isFinePointer(e) && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(e) => setHovered(e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setHovered(false)}
      style={{ width: size, height: size, color: current ? BTN_DARK_TEXT : INK_2 }}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${FOCUS}`}
    >
      {current && (
        <motion.span
          aria-hidden="true"
          layoutId={wellId}
          transition={PILL_SPRING}
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: BTN_DARK }}
        />
      )}
      <span className="relative">{children}</span>
      {badge && (
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 size-2 rounded-full ring-2 ring-[var(--bg-card)]"
          style={{ backgroundColor: badge }}
        />
      )}
      {srCount && <span className="sr-only">{srCount}</span>}
      <AnimatePresence>
        {(hovered || showLabel) && (
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 0, y: 8, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 2, x: '-50%' }}
            transition={FADE}
            className="pointer-events-none absolute bottom-full left-1/2 mb-2.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold [box-shadow:var(--shadow-float)]"
            style={{ backgroundColor: BTN_DARK, color: BTN_DARK_TEXT }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}
