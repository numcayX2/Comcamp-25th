/**
 * Full-size slip preview in a native modal <dialog> (showModal: top layer, inert page, focus trap,
 * Esc to close, focus returns to the opener). The card is centred by slip-upload.css.
 * A backdrop press closes it only when the pointer goes down AND comes up outside the card, so a
 * drag or scroll that starts on the image never dismisses it. closedby="any" is set as a
 * progressive enhancement for browsers with native light dismiss.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import '../../styles/slip-upload.css';

const ZOOM_LEVELS = [
  { value: 1, label: '100%' },
  { value: 1.5, label: '150%' },
  { value: 2, label: '200%' },
] as const;

type ZoomLevel = (typeof ZOOM_LEVELS)[number]['value'];

function outsideCard(dlg: HTMLDialogElement, e: ReactPointerEvent<HTMLDialogElement>): boolean {
  const r = dlg.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

export function SlipLightbox({ src, open, onClose }: { src: string | null; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const downOutside = useRef(false);
  const titleId = useId();
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [baseWidth, setBaseWidth] = useState<number | null>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    // Not in React's DOM typings yet; an unknown attribute is harmless where unsupported.
    dlg.setAttribute('closedby', 'any');
  }, []);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      closeRef.current?.focus();
    }
    if (!open && dlg.open) dlg.close();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setZoom(1);
      setBaseWidth(null);
    }
  }, [open, src]);

  function selectZoom(next: ZoomLevel) {
    if (next !== 1 && zoom === 1 && imgRef.current && imgRef.current.clientWidth > 0) {
      setBaseWidth(imgRef.current.clientWidth);
    }
    setZoom(next);
    if (next === 1) stageRef.current?.scrollTo({ top: 0, left: 0 });
  }

  return (
    <dialog
      ref={ref}
      className="su-lightbox"
      data-zoom={zoom === 1 ? '100' : zoom === 1.5 ? '150' : '200'}
      aria-labelledby={titleId}
      onClose={onClose}
      onPointerDown={(e) => {
        const dlg = ref.current;
        downOutside.current = !!dlg && e.target === dlg && outsideCard(dlg, e);
      }}
      onPointerUp={(e) => {
        const dlg = ref.current;
        const close = downOutside.current && !!dlg && e.target === dlg && outsideCard(dlg, e);
        downOutside.current = false;
        if (close) onClose();
      }}
      onPointerCancel={() => {
        downOutside.current = false;
      }}
    >
      <div className="su-lightbox__frame">
        <header className="su-lightbox__head">
          <h2 id={titleId} className="su-lightbox__title">
            ตัวอย่างสลิปการโอนเงิน
          </h2>
          <div className="su-lightbox__controls">
            <div className="su-lightbox__zoom" role="group" aria-label="ระดับการขยายรูปสลิป">
              {ZOOM_LEVELS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="su-lightbox__zoom-btn"
                  aria-pressed={zoom === item.value}
                  onClick={() => selectZoom(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              ref={closeRef}
              type="button"
              className="su-btn su-btn--ghost su-lightbox__close"
              onClick={onClose}
              aria-label="ปิดตัวอย่างสลิป"
            >
              ปิด
            </button>
          </div>
        </header>
        <div ref={stageRef} className="su-lightbox__stage">
          {open && src && (
            <img
              ref={imgRef}
              className="su-lightbox__img"
              src={src}
              alt="สลิปการโอนเงิน ขนาดเต็ม"
              style={zoom !== 1 && baseWidth ? { width: `${Math.round(baseWidth * zoom)}px` } : undefined}
              onLoad={() => {
                if (zoom === 1 && imgRef.current && imgRef.current.clientWidth > 0) {
                  setBaseWidth(imgRef.current.clientWidth);
                }
              }}
            />
          )}
        </div>
      </div>
    </dialog>
  );
}
