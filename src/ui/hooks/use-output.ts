import { useEffect, useState } from 'react';
import { getJson } from '../lib/api.js';

const OUTPUT_POLL_MS = 2_000;

/** The worker's transcript excerpt while a slot is selected; a new slot starts empty and a late answer for the old one is dropped. */
export function useOutput(slotId: string | undefined): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    if (!slotId) return;
    let live = true;
    const load = () => getJson<{ lines: string[] }>(`/slots/${slotId}/output`).then((r) => { if (live) setLines(r.lines); }).catch(() => undefined); // an unreadable transcript is not an error to toast every 2 s
    void load();
    const timer = setInterval(() => void load(), OUTPUT_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [slotId]);
  return lines;
}
