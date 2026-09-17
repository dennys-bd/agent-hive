import { useCallback, useEffect, useState } from 'react';
import type { SetupInfo } from '../../types.js';
import { getJson } from '../lib/api.js';

export function useSetupInfo(): { info: SetupInfo | undefined; error: string | undefined; reload(): Promise<SetupInfo> } {
  const [info, setInfo] = useState<SetupInfo>();
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    const next = await getJson<SetupInfo>('/setup');
    setInfo(next);
    return next;
  }, []);
  useEffect(() => { reload().catch((err: Error) => setError(err.message)); }, [reload]);
  return { info, error, reload };
}
