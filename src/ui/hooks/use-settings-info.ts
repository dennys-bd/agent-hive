import { useCallback, useEffect, useState } from 'react';
import type { SettingsInfo } from '../../types.js';
import { getJson } from '../lib/api.js';

export function useSettingsInfo(): { info: SettingsInfo | undefined; error: string | undefined; reload(): Promise<SettingsInfo> } {
  const [info, setInfo] = useState<SettingsInfo>();
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    const next = await getJson<SettingsInfo>('/settings');
    setInfo(next);
    return next;
  }, []);
  useEffect(() => { reload().catch((err: Error) => setError(err.message)); }, [reload]);
  return { info, error, reload };
}
