import { useEffect, useState } from 'react';
import type { ReferenceData } from '@caissepro/shared';
import type { AuthGateway } from '../auth/gateway';
export function useReferences(gateway: AuthGateway, online = true) {
  const [data, setData] = useState<ReferenceData | null>(null);
  useEffect(() => {
    let current = true;
    setData(null);
    if (online)
      void gateway
        .referenceData()
        .then((v) => {
          if (current) setData(v);
        })
        .catch(() => {
          /* A free-form draft remains possible without the online suggestions. */
        });
    return () => {
      current = false;
    };
  }, [gateway, online]);
  return data;
}
