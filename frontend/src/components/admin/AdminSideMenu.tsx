import { LogOut, RotateCw, type LucideIcon } from 'lucide-react';
import { AMBER_TEXT, FOCUS, INK, INK_2, INK_3, RULE, TECH, WARNING } from '../admin-ui';
import { useSlidingMarker } from './useSlidingMarker';

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

const SESSION_BTN =
  'group inline-flex h-11 w-11 items-center justify-center gap-2.5 rounded-full text-sm font-medium transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-60 motion-reduce:transition-none max-xl:bg-[var(--bg-card)] max-xl:[box-shadow:var(--shadow-card)] xl:h-auto xl:min-h-11 xl:w-full xl:justify-start xl:px-4 xl:py-2 ' +
  FOCUS;

/**
 * The /admin view menu. Below xl it is a scroller of raised pills; from xl it is a raised dock where
 * the pressed-in "well" glides to the active item and a soft tracker follows the pointer
 * (`useSlidingMarker`). The buttons stay plain buttons (aria-current marks the page).
 */
export function AdminSideMenu<K extends string>({ items, active, onSelect, onRefresh, onLogout, busy }: Props<K>) {
  const m = useSlidingMarker(active, items.map((i) => `${i.key}:${i.n ?? ''}`).join('|'));

  return (
    <div className="flex items-center gap-2 xl:sticky xl:top-[calc(var(--admin-nav-h,0px)+1rem)] xl:flex-col xl:items-stretch xl:gap-0 xl:self-start xl:rounded-[28px] xl:bg-[var(--bg-card)] xl:p-3 xl:[box-shadow:var(--shadow-card)]">
      <nav aria-label="เมนูผู้ดูแลระบบ" className="-ml-4 min-w-0 flex-1 sm:-ml-8 xl:ml-0 xl:flex-none">
        <div className="overflow-x-auto py-2 pl-4 pr-2 [scrollbar-width:none] sm:pl-8 xl:overflow-visible xl:p-0">
          <ul ref={m.listRef} className="relative flex gap-2 xl:flex-col xl:gap-1" onPointerLeave={m.onListPointerLeave}>
            {/* Indicators sit behind the buttons and only exist in the dock layout (xl and up). */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 z-0 hidden rounded-full bg-[var(--color-btn-ghost-hover)] xl:block"
              style={m.trackerStyle}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 z-0 hidden rounded-full bg-[var(--bg-surface)] [box-shadow:var(--shadow-well)] xl:block"
              style={m.wellStyle}
            />

            {items.map(({ key, label, Icon, n, srCount, alert }) => {
              const isActive = active === key;
              return (
                <li key={key} className="shrink-0" ref={m.itemRef(key)} onPointerEnter={m.onItemPointerEnter(key)}>
                  <button
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => onSelect(key)}
                    className={`group relative z-10 flex min-h-11 w-full items-center gap-2.5 whitespace-nowrap rounded-full px-4 py-2 text-left text-sm transition-colors duration-200 motion-reduce:transition-none ${
                      isActive
                        ? `font-semibold max-xl:bg-[var(--bg-surface)] max-xl:[box-shadow:var(--shadow-well)] ${m.positioned ? '' : 'xl:bg-[var(--bg-surface)] xl:[box-shadow:var(--shadow-well)]'}`
                        : 'font-medium max-xl:bg-[var(--bg-card)] max-xl:[box-shadow:var(--shadow-card)] max-xl:hover:bg-[var(--color-btn-ghost-hover)]'
                    } ${FOCUS}`}
                    style={{ color: isActive ? INK : INK_2 }}
                  >
                    <Icon
                      aria-hidden="true"
                      size={17}
                      strokeWidth={1.5}
                      className="shrink-0 transition-[translate,color] duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                      style={{ color: isActive ? TECH : INK_3 }}
                    />
                    <span>{label}</span>
                    {n !== undefined && n > 0 && (
                      <span
                        className="ml-auto inline-flex items-center gap-1.5 pl-1 font-mono text-xs tabular-nums"
                        style={{ color: alert ? AMBER_TEXT : INK_3 }}
                      >
                        {alert && <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: WARNING }} />}
                        <span aria-hidden="true">{n}</span>
                        {srCount && <span className="sr-only">{srCount}</span>}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      {/* Session controls: icon buttons beside the menu (< xl), labelled rows under the dock menu (xl and up). */}
      <div
        className="flex shrink-0 items-center gap-2 xl:mt-2 xl:flex-col xl:items-stretch xl:gap-1 xl:border-t xl:pt-2"
        style={{ borderColor: RULE }}
      >
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          aria-busy={busy || undefined}
          className={SESSION_BTN}
          style={{ color: INK_2 }}
        >
          <RotateCw
            aria-hidden="true"
            size={17}
            strokeWidth={1.5}
            className={`shrink-0 transition-[rotate] duration-300 group-hover:rotate-90 motion-reduce:transition-none motion-reduce:group-hover:rotate-0 ${busy ? 'motion-safe:animate-spin' : ''}`}
            style={{ color: INK_3 }}
          />
          <span className="sr-only xl:not-sr-only">{busy ? 'กำลังโหลด…' : 'รีเฟรช'}</span>
        </button>
        <button type="button" onClick={onLogout} className={SESSION_BTN} style={{ color: INK_2 }}>
          <LogOut
            aria-hidden="true"
            size={17}
            strokeWidth={1.5}
            className="shrink-0 transition-[translate] duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
            style={{ color: INK_3 }}
          />
          <span className="sr-only xl:not-sr-only">ออกจากระบบ</span>
        </button>
      </div>
    </div>
  );
}
