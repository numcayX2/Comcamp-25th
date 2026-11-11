/** Full-size slip preview in a native modal <dialog>: Esc, the close button or a backdrop click closes it. */
import { useEffect, useRef } from 'react';
import '../../styles/slip-upload.css';

export function SlipLightbox({ src, open, onClose }: { src: string | null; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="su-lightbox"
      aria-label="รูปสลิปขนาดเต็ม"
      onClose={onClose}
      onClick={(e) => {
        // A click on the dialog box itself (outside the content) is a backdrop click.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="su-lightbox__body">
        {open && src && <img src={src} alt="สลิปการโอนเงิน ขนาดเต็ม" />}
        <button type="button" className="su-btn su-btn--ghost" onClick={onClose}>
          ปิด
        </button>
      </div>
    </dialog>
  );
}
