import { useEffect, useState } from 'react';
import { getJson } from '@/lib/api';
import type { CheckerState, FormatterState } from '../../types';

// A Settings detection list, read once (#780, #782): undefined while it reads or when it fails, and the rows show no detection
function useDetected<T>(path: string): T[] | undefined {
  const [states, setStates] = useState<T[]>();
  useEffect(() => {
    let live = true;
    getJson<unknown>(path).then((value) => { if (live && Array.isArray(value)) setStates(value as T[]); }, () => undefined);
    return () => { live = false; };
  }, [path]);
  return states;
}

/** GET /settings/formatters once (#780). */
export const useFormatterStates = (): FormatterState[] | undefined => useDetected<FormatterState>('/settings/formatters');
/** GET /settings/checkers once (#782). */
export const useCheckerStates = (): CheckerState[] | undefined => useDetected<CheckerState>('/settings/checkers');
