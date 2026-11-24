import { ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { InfoTip } from '@/components/InfoTip';

/** A closed line on its own row under the name (handoff `.sum`), indented past the chevron (12px) and its gap (6px). */
export const SUMMARY_LINE = 'min-w-0 basis-full truncate pl-[18px] text-muted-foreground tabular-nums';

export interface DetailSectionProps { name: string; note?: string; summary: ReactNode; defaultOpen?: boolean; children: ReactNode }

/** A details panel section (#958, ui.detail-section): a native <details> whose summary says what it holds while closed. `defaultOpen` is
 * read on mount only; the user's toggles are the element's own, and DetailPanel keys each section by task so another task starts over.
 * The note is a tooltip for the eye and the summary's description for a screen reader. */
export function DetailSection({ name, note, summary, defaultOpen = false, children }: DetailSectionProps) {
  const noteId = useId();
  return (
    <details open={defaultOpen} aria-label={name} className="group/section flex flex-col text-xs">
      <summary
        aria-describedby={note === undefined ? undefined : noteId}
        className="-mx-1 flex cursor-pointer list-none flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded px-1 py-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 transition-transform group-open/section:rotate-90 motion-reduce:transition-none" />
        <span className="whitespace-nowrap font-medium text-foreground">{name}</span>
        {note !== undefined && <InfoTip note={note} />}
        {summary}
      </summary>
      {/* Outside the summary, so its accessible name stays short and the note is read once, as its description */}
      {note !== undefined && <span id={noteId} className="sr-only">{note}</span>}
      <div className="mt-2 flex flex-col gap-1.5">{children}</div>
    </details>
  );
}
