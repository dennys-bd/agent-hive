import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { LaunchOptions } from '../../types';
import { getJson } from '@/lib/api';

/** GET /launch-options once per open (#257), for the workspace the session will run in (#316): its specialized agents are the ones its plugin
 * folder delivers. The fields work with the defaults at once, the lists fill in when the answer comes; a failure is a toast. Nova sessão and the
 * Start dialog (#290). Another workspace refetches. */
export function useLaunchOptions(workspace?: string): LaunchOptions | undefined {
  const [options, setOptions] = useState<LaunchOptions>();
  useEffect(() => {
    let isLive = true;
    const query = workspace === undefined ? '' : `?workspace=${encodeURIComponent(workspace)}`;
    getJson<LaunchOptions>(`/launch-options${query}`).then((answer) => { if (isLive) setOptions(answer); }, (err: Error) => { toast.error(err.message); });
    return () => { isLive = false; };
  }, [workspace]);
  return options;
}
