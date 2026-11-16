/**
 * Full-screen slip preview in a native modal <dialog> (showModal: top layer, inert page, focus trap,
 * Esc to close, focus returns to the opener). The image fills the viewport with no card frame;
 * a floating close pill and Esc are the only controls.
 */
import { useEffect, useRef } from 'react';
import '../../styles/slip-upload.css';

export function SlipLightbox({ src, open, onClose }: { src: string | null; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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
      aria-label="ตัวอย่างสลิปการโอนเงิน"
      onClose={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="su-btn su-btn--ghost su-lightbox__close"
        onClick={onClose}
        aria-label="ปิดตัวอย่างสลิป"
      >
        ปิด
      </button>
      {open && src && (
        <img className="su-lightbox__img" src={src} alt="สลิปการโอนเงิน ขนาดเต็ม" />
      )}
    </dialog>
  );
}
