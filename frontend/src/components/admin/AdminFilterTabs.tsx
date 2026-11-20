import type { RefObject } from 'react';
import { BTN_DARK, BTN_DARK_TEXT, DANGER, FOCUS, INK, INK_2, INK_3, RULE, WARNING } from '../admin-ui';
import { useSlidingMarker } from './useSlidingMarker';

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
 * Status filter pills (md and up). The dark "selected" pill glides to the chosen tab and a soft
 * tracker follows the pointer (`useSlidingMarker`); the tabs themselves are plain toggle buttons.
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
  const m = useSlidingMarker(active, tabs.map((t) => `${t.key}:${t.n}`).join('|') + `|${overduePayCount}`);

  return (
    <div
      ref={(el) => {
        m.listRef(el);
        if (groupRef) groupRef.current = el;
      }}
      hidden={hidden}
      tabIndex={-1}
      role="group"
      aria-label="กรองตามสถานะ"
      onPointerLeave={m.onListPointerLeave}
      className={`relative -mx-4 hidden gap-2 overflow-x-auto border-b px-4 py-3 [scrollbar-width:thin] sm:-mx-8 sm:px-8 md:flex lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 ${FOCUS}`}
      style={{ borderColor: INK }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-0 rounded-full bg-[var(--color-btn-ghost-hover)]"
        style={m.trackerStyle}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-0 rounded-full"
        style={{ ...m.wellStyle, backgroundColor: BTN_DARK }}
      />

      {tabs.map((t) => {
        const isActive = active === t.key;
        const isSlipQueue = t.key === slipKey;
        const overdue = t.key === awaitKey ? overduePayCount : 0;
        return (
          <button
            key={t.key}
            ref={m.itemRef(t.key)}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(t.key)}
            onPointerEnter={m.onItemPointerEnter(t.key)}
            className={`relative z-10 inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm transition-colors duration-200 motion-reduce:transition-none ${FOCUS}`}
            style={{
              // Before the first measurement the pill paints its own fill so it is never unreadable.
              backgroundColor: isActive && !m.positioned ? BTN_DARK : 'transparent',
              color: isActive ? BTN_DARK_TEXT : INK_2,
              borderColor: isActive ? BTN_DARK : isSlipQueue && t.n > 0 ? WARNING : overdue > 0 ? DANGER : RULE,
              fontWeight: isActive ? 600 : 500,
            }}
          >
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
          </button>
        );
      })}
    </div>
  );
}
