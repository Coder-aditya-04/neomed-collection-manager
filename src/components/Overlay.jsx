import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Anything that covers the screen — drawers, dialogs — goes through here.
 *
 * WHY A PORTAL. A fixed-position element is normally placed against the
 * viewport, but that stops being true the moment any ancestor has a
 * transform, a filter, `backdrop-filter`, `contain`, or `will-change` naming
 * one of those. Any of them turns that ancestor into the containing block,
 * and the drawer is then laid out inside a box the size of the screen it was
 * opened from: the backdrop darkens only part of the page, the panel lands in
 * the wrong place, and the content can be clipped away entirely.
 *
 * This interface is full of exactly those properties now — glass panels blur
 * their backdrop, screens animate in on a transform, long tables use
 * `contain`. Rather than police which ancestors are allowed which effects,
 * every overlay renders into document.body, where nothing can catch it.
 *
 * It also owns the two things every overlay needs and one of them always
 * forgets: Escape to close, and holding the page behind still.
 */
export default function Overlay({ children, onClose, label }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Pauses the drifting background while an overlay is open. A long table
    // scrolling above animated light repaints both on every frame.
    document.body.classList.add('dialog-open');

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      document.body.classList.remove('dialog-open');
    };
  }, [onClose]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={label} className="overlay-root">
      <div className="overlay-backdrop" onClick={onClose} aria-hidden />
      {children}
    </div>,
    document.body
  );
}
