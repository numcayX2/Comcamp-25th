import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

type Box = { x: number; y: number; w: number; h: number };

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

const SLIDE = '.28s var(--ease-out)';

/**
 * Two indicators for a row or column of buttons: a "well" that glides to the active item and a soft
 * tracker that follows the pointer. Render both as absolutely positioned, `pointer-events-none`
 * spans inside the (position: relative) list, behind the buttons, and spread the returned styles on
 * them. Motion is transform / opacity / size only, and it is off for reduced motion and until the
 * first measurement has painted. The buttons stay ordinary buttons, so this is enhancement only.
 *
 * `signature` must change whenever the set (or the labels/counts) of items changes, so items are
 * re-observed; sizes are tracked with a ResizeObserver, which also covers web-font swaps.
 */
export function useSlidingMarker<K extends string>(active: K, signature: string) {
  const listEl = useRef<HTMLElement | null>(null);
  const itemEls = useRef(new Map<string, HTMLElement>());
  const [well, setWell] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [hover, setHover] = useState<{ key: K | null; box: Box | null; slides: boolean }>({
    key: null,
    box: null,
    slides: false,
  });

  const measure = useCallback((key: string | null): Box | null => {
    const el = key ? itemEls.current.get(key) : undefined;
    return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
  }, []);

  const listRef = useCallback((el: HTMLElement | null) => {
    listEl.current = el;
  }, []);

  const itemRef = useCallback(
    (key: K) => (el: HTMLElement | null) => {
      if (el) itemEls.current.set(key, el);
      else itemEls.current.delete(key);
    },
    [],
  );

  useLayoutEffect(() => {
    const update = () =>
      setWell((prev) => {
        const next = measure(active);
        return sameBox(prev, next) ? prev : next;
      });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    if (listEl.current) ro.observe(listEl.current);
    itemEls.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [active, signature, measure]);

  useEffect(() => {
    // The first position is applied without a transition so the well does not slide in on load.
    const id = requestAnimationFrame(() => setReady(true));
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => {
      cancelAnimationFrame(id);
      mq.removeEventListener('change', onChange);
    };
  }, []);

  const animate = ready && !reduced;
  const trackerVisible = hover.key !== null && hover.key !== active && hover.box !== null;

  const wellStyle: CSSProperties | undefined = well
    ? {
        width: well.w,
        height: well.h,
        transform: `translate(${well.x}px, ${well.y}px)`,
        transition: animate ? `transform ${SLIDE}, width ${SLIDE}, height ${SLIDE}` : 'none',
      }
    : undefined;

  const trackerStyle: CSSProperties | undefined = hover.box
    ? {
        width: hover.box.w,
        height: hover.box.h,
        transform: `translate(${hover.box.x}px, ${hover.box.y}px)`,
        opacity: trackerVisible ? 1 : 0,
        // Slide only between two hovered items; a fresh hover fades in where it lands.
        transition: animate
          ? `opacity .16s var(--ease-out)${hover.slides ? `, transform ${SLIDE}, width ${SLIDE}, height ${SLIDE}` : ''}`
          : 'none',
      }
    : undefined;

  /** Spread on each item's wrapper (the element passed to `itemRef`). */
  const onItemPointerEnter = (key: K) => (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    setHover((h) => ({ key, box: measure(key), slides: h.key !== null }));
  };
  /** Put on the list element. */
  const onListPointerLeave = () => setHover((h) => ({ ...h, key: null }));

  return {
    listRef,
    itemRef,
    wellStyle,
    trackerStyle,
    /** False until the well has been measured; give the active button its own fill meanwhile. */
    positioned: well !== null,
    onItemPointerEnter,
    onListPointerLeave,
  };
}
