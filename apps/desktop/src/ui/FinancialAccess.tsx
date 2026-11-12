import { useId, type ReactNode } from 'react';
import type { SessionProfile } from '@caissepro/shared';

// Visibility is guidance only. Native and server authorization remain authoritative.
export function preparationRestriction(profile: SessionProfile, online: boolean) {
  if (!['draft:read_own', 'draft:write_own'].every((p) => profile.permissions.includes(p)))
    return 'Votre rôle ne permet pas de préparer cette opération. Demandez une attribution explicite d’un rôle financier et des caisses concernées dans Utilisateurs.';
  if (!online && !profile.permissions.includes('offline:access'))
    return 'La préparation hors connexion n’est pas autorisée pour votre session.';
  return '';
}

export function FinancialAction({
  label,
  reason,
  busy = false,
  onClick,
  children,
}: {
  label: string;
  reason: string;
  busy?: boolean;
  onClick(): void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="financial-action">
      <button
        className="primary-button"
        disabled={busy || !!reason}
        aria-describedby={reason ? id : undefined}
        onClick={onClick}
      >
        {label}
      </button>
      {reason && (
        <small id={id} className="block">
          {reason}
        </small>
      )}
      {children}
    </div>
  );
}
