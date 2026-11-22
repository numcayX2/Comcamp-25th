import { useEffect, useId, useState, type RefObject } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { BTN_DARK, BTN_DARK_TEXT, DANGER, FOCUS, INK, INK_2, INK_3, RULE, WARNING } from '../admin-ui';
import { FADE, FADE_EXIT, PILL_SPRING, isFinePointer, useMediaQuery } from './ui/motion';

export type FilterTab<K extends string = string> = { key: K; label: string; n: number };

type Props<K extends string> = {
  tabs: FilterTab<K>[];
  active: K;
  onSelect: (key: K) => void;
  /** Key of the tab that is the slip queue (amber dot while it has items). */
  slipKey: K;
  /** Key of the tab that shows the overdue counter, and that counter. */
  awaitKey: K;
  overduePayCount: number;
  hidden?: boolean;
  /** Focus fallback target for the parent (the group is a programmatic focus stop). */
  groupRef?: RefObject<HTMLDivElement | null>;
};

/**
 * Status filter pills (md and up), Aceternity "Animated Tabs": the dark selected pill springs to
 * the chosen tab (shared layout) and a soft plate follows the mouse. The tabs are plain toggle
 * buttons; the pill is drawn inside the active button, so it is never missing before motion runs.
 * `layoutId` is detached whenever the bar is hidden or below `md` so the pill never flies from
 * a zero-rect box when switching back from another view.
 */
export function AdminFilterTabs<K extends string>({
  tabs,
  active,
  onSelect,
  slipKey,
  awaitKey,
  overduePayCount,
  hidden,
  groupRef,
}: Props<K>) {
  const groupId = useId();
  const mdUp = useMediaQuery('(min-width: 768px)');
  const [hover, setHover] = useState<K | null>(null);
  const animatePill = !hidden && mdUp;

  useEffect(() => {
    if (!animatePill) setHover(null);
  }, [animatePill]);

  return (
    <LayoutGroup id={groupId}>
      <motion.div
        layoutScroll
        ref={(el) => {
          if (groupRef) groupRef.current = el;
        }}
        hidden={hidden}
        tabIndex={-1}
        role="group"
        aria-label="กรองตามสถานะ"
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
        className={`relative -mx-4 hidden gap-2 overflow-x-auto border-b px-4 py-3 [scrollbar-width:thin] sm:-mx-8 sm:px-8 md:flex lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 ${FOCUS}`}
        style={{ borderColor: INK }}
      >
        {tabs.map((t) => {
          const isActive = active === t.key;
          const isSlipQueue = t.key === slipKey;
          const overdue = t.key === awaitKey ? overduePayCount : 0;
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelect(t.key)}
              onPointerEnter={(e) => isFinePointer(e) && setHover(t.key)}
              className={`relative inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 py-2 text-sm transition-colors duration-200 motion-reduce:transition-none ${FOCUS}`}
              style={{
                color: isActive ? BTN_DARK_TEXT : INK_2,
                borderColor: isActive ? BTN_DARK : isSlipQueue && t.n > 0 ? WARNING : overdue > 0 ? DANGER : RULE,
                fontWeight: isActive ? 600 : 500,
              }}
            >
              {isActive &&
                (animatePill ? (
                  <motion.span
                    aria-hidden="true"
                    layoutId={`${groupId}-pill`}
                    transition={PILL_SPRING}
                    className="pointer-events-none absolute -inset-px rounded-full"
                    style={{ backgroundColor: BTN_DARK, borderRadius: 9999 }}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-px rounded-full"
                    style={{ backgroundColor: BTN_DARK }}
                  />
                ))}
              <AnimatePresence initial={false}>
                {animatePill && hover === t.key && !isActive && (
                  <motion.span
                    aria-hidden="true"
                    layoutId={`${groupId}-hover`}
                    style={{ borderRadius: 9999 }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: FADE }}
                    exit={{ opacity: 0, transition: FADE_EXIT }}
                    transition={{ layout: PILL_SPRING }}
                    className="pointer-events-none absolute inset-0 rounded-full bg-[var(--color-btn-ghost-hover)]"
                  />
                )}
              </AnimatePresence>
              <span className="relative inline-flex items-center gap-1.5">
                {isSlipQueue && (
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ backgroundColor: isActive ? BTN_DARK_TEXT : t.n > 0 ? WARNING : INK_3 }}
                  />
                )}
                <span>{t.label}</span>
                <span className="font-mono text-xs tabular-nums" style={{ opacity: isActive ? 0.9 : 0.75 }}>
                  {t.n}
                </span>
                {overdue > 0 && (
                  <span className="text-xs font-semibold" style={{ color: isActive ? BTN_DARK_TEXT : DANGER }}>
                    · เกินกำหนด <span className="font-mono tabular-nums">{overdue}</span>
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </motion.div>
    </LayoutGroup>
  );
}
