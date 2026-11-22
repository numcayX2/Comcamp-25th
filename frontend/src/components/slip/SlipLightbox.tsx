/**
 * Full-screen slip preview in a native modal <dialog> (showModal: top layer, inert page, focus trap,
 * Esc to close, focus returns to the opener). The image fills the viewport with no card frame;
 * a floating close pill and Esc are the only controls.
 */
import { useEffect, useRef, useState } from 'react';
import '../../styles/slip-upload.css';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SlipLightbox({ src, open, onClose }: { src: string | null; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const clearTimer = useRef<number | undefined>(undefined);
  // Keep the image mounted briefly during the native <dialog> exit fade so it never snaps to blank.
  const [displaySrc, setDisplaySrc] = useState<string | null>(open ? src : null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    // Not in React's DOM typings yet; an unknown attribute is harmless where unsupported.
    dlg.setAttribute('closedby', 'any');
  }, []);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    window.clearTimeout(clearTimer.current);
    if (open) {
      if (src) setDisplaySrc(src);
      if (!dlg.open) {
        dlg.showModal();
        closeRef.current?.focus();
      }
      return;
    }
    if (dlg.open) dlg.close();
    if (prefersReducedMotion()) {
      setDisplaySrc(null);
    } else {
      clearTimer.current = window.setTimeout(() => setDisplaySrc(null), 240);
    }
  }, [open, src]);

  useEffect(
    () => () => {
      window.clearTimeout(clearTimer.current);
    },
    [],
  );

  const effectiveSrc = open && src ? src : displaySrc;

  return (
    <dialog
      ref={ref}
      className="su-lightbox"
      aria-label="ตัวอย่างสลิปการโอนเงิน"
      onClose={onClose}
      onTransitionEnd={(e) => {
        if (!open && e.target === ref.current) {
          window.clearTimeout(clearTimer.current);
          setDisplaySrc(null);
        }
      }}
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
      {effectiveSrc && (
        <img className="su-lightbox__img" src={effectiveSrc} alt="สลิปการโอนเงิน ขนาดเต็ม" />
      )}
    </dialog>
  );
}
