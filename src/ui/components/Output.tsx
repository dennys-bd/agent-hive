import { useEffect, useRef } from 'react';
import { renderOutput } from '@/highlight';

interface OutputProps { lines: string[] }

/** The worker's transcript excerpt, already escaped and marked up by renderOutput; follows the output as it grows. */
export function Output({ lines }: OutputProps) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines only triggers the scroll, its content is read through the DOM
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderOutput escapes every worker character before adding markup
    <div ref={ref} className="output max-h-72 overflow-auto rounded-md bg-background p-2" dangerouslySetInnerHTML={{ __html: renderOutput(lines) }} />
  );
}
