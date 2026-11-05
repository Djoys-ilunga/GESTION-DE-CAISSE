import { useEffect, useRef, useState } from 'react';
import type { FormBuffer, FormBufferInput } from '@caissepro/shared';
import type { AuthGateway } from '../auth/gateway';

// Une saisie incomplète ne devient jamais un brouillon transmis automatiquement.
export function useFormBuffer(gateway: AuthGateway, input: FormBufferInput, enabled: boolean) {
  const latest = useRef(input);
  latest.current = input;
  const [state, setState] = useState<'capturing' | 'captured' | 'unavailable'>('capturing');
  const serialized = JSON.stringify(input);
  useEffect(() => {
    let active = true;
    if (!enabled) return;
    setState('capturing');
    const timer = setTimeout(() => {
      void gateway
        .saveFormBuffer(latest.current)
        .then(() => {
          if (active) setState('captured');
        })
        .catch(() => {
          if (active) setState('unavailable');
        });
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [gateway, serialized, enabled]);
  const discard = () => {
    void gateway.removeFormBuffer(input.id).catch(() => {});
  };
  return { state, discard };
}
export function bufferedFields(buffer: FormBuffer | undefined) {
  return buffer?.fields ?? {};
}
