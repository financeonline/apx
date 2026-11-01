'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A native modal `<dialog>` driven by `open` (the prototype's `showModal()` / `close()`): Escape,
 * the close buttons and a click on the backdrop close it, and the browser returns focus to the
 * control that opened it. The prototype's `.dialog-top` / `#dialog-title` styling applies because
 * the dialog stays inside `.apx-dash` in the DOM (the top layer does not move it).
 */
export function NativeDialog({
  open, onClose, id, className, labelledBy, onOpen, children,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
  className?: string;
  labelledBy: string;
  /** Runs after the dialog opened (the prototype focuses a field). */
  onOpen?: (dialog: HTMLDialogElement) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onOpenRef = useRef(onOpen);
  useEffect(() => { onOpenRef.current = onOpen; });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      onOpenRef.current?.(dialog);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      id={id}
      className={className}
      // Tailwind's preflight zeroes a dialog's margin; the prototype relies on the browser's centring.
      style={{ margin: 'auto' }}
      aria-labelledby={labelledBy}
      // Escape and `dialog.close()` both end here, so the owner's state always follows the element.
      onClose={onClose}
      onClick={(event) => {
        // The prototype's backdrop test: a click on the dialog element outside its own box.
        const dialog = ref.current;
        if (!dialog || event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
      }}
    >
      {children}
    </dialog>
  );
}
