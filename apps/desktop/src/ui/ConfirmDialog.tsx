import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck } from 'lucide-react';
export function ConfirmDialog({
  title,
  children,
  confirm = 'Confirmer',
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirm?: string;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const titleId = useId(),
    ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => before?.focus();
  }, []);
  return createPortal(
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="confirm-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.preventDefault();
            onCancel();
          }
          if (e.key === 'Tab') {
            const controls = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]',
              ) ?? [],
            );
            const first = controls[0],
              last = controls.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <ShieldCheck size={28} />
        <h2 id={titleId}>{title}</h2>
        <div className="confirmation-copy">{children}</div>
        <div className="action-buttons">
          <button disabled={busy} className="secondary-button" onClick={onCancel}>
            Annuler
          </button>
          <button disabled={busy} className="primary-button" onClick={onConfirm}>
            {busy ? 'Validation…' : confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
