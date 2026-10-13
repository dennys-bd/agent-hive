import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { LaunchOptions } from '../../types';
import { getJson } from '@/lib/api';

/** GET /launch-options once per open (#257): the fields work with the defaults at once, the lists fill in when the answer comes; a failure is a
 * toast. Nova sessão and the Start dialog (#290). */
export function useLaunchOptions(): LaunchOptions | undefined {
  const [options, setOptions] = useState<LaunchOptions>();
  useEffect(() => {
    let isLive = true;
    getJson<LaunchOptions>('/launch-options').then((answer) => { if (isLive) setOptions(answer); }, (err: Error) => { toast.error(err.message); });
    return () => { isLive = false; };
  }, []);
  return options;
}
