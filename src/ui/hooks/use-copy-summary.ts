import { useEffect, useState } from 'react';
import type { CopySummary, SessionRef, SessionTarget } from '../../types.js';
import { getJson } from '../lib/api.js';
import { copyQuery, sessionPath } from '../lib/copy-targets.js';

/** What the copy dialog shows of the two ends (#587): read once per pair, `{}` while it loads. A read that fails answers the server's words. */
export function useCopySummary(from: SessionRef, to: SessionTarget): { summary?: CopySummary; error?: string } {
  const path = `${sessionPath(from)}/copy?${copyQuery(to)}`;
  const [result, setResult] = useState<{ path: string; summary?: CopySummary; error?: string }>();
  useEffect(() => {
    let isCurrent = true;
    getJson<CopySummary>(path).then(
      (summary) => { if (isCurrent) setResult({ path, summary }); },
      (err: Error) => { if (isCurrent) setResult({ path, error: err.message }); },
    );
    return () => { isCurrent = false; };
  }, [path]);
  return result?.path === path ? result : {};
}
