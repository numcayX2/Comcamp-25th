/**
 * Full-size slip preview in a native modal <dialog> (showModal: top layer, inert page, focus trap,
 * Esc to close, focus returns to the opener). The card is centred by slip-upload.css.
 * A backdrop press closes it only when the pointer goes down AND comes up outside the card, so a
 * drag or scroll that starts on the image never dismisses it. closedby="any" is set as a
 * progressive enhancement for browsers with native light dismiss.
 */
import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import '../../styles/slip-upload.css';

function outsideCard(dlg: HTMLDialogElement, e: ReactPointerEvent<HTMLDialogElement>): boolean {
  const r = dlg.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

export function SlipLightbox({ src, open, onClose }: { src: string | null; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const downOutside = useRef(false);

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

  return (
    <dialog
      ref={ref}
      className="su-lightbox"
      aria-label="รูปสลิปขนาดเต็ม"
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
      <div className="su-lightbox__body">
        {open && src && <img src={src} alt="สลิปการโอนเงิน ขนาดเต็ม" />}
        <button ref={closeRef} type="button" className="su-btn su-btn--ghost" onClick={onClose}>
          ปิด
        </button>
      </div>
    </dialog>
  );
}
