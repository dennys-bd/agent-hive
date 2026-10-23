import type { ReactNode } from 'react';
import { TONE_CLASS, type Tone } from '@/components/benchmark/result/result-view';

/** A card of the result screen (#466, the screen's .card), named by its title for a screen reader. */
export function ResultCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3.5 py-2 text-[13px]">
        <b className="flex-1 font-semibold">{title}</b>
        {meta !== undefined && <span className="text-muted-foreground text-xs">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** What a card shows when its data is missing: an errored or interrupted run can end with no evaluation or metrics. */
export const MissingLine = ({ text }: { text: string }) => <p className="px-3.5 py-2.5 text-muted-foreground text-xs">{text}</p>;

export const Dot = ({ tone }: { tone: Tone }) => <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-current ${TONE_CLASS[tone]}`} />;

// The shell's status chip (ExperimentHeader); a muted chip keeps the empty border, as the screen's .chip.done does
export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const border = tone === 'muted' ? 'border-empty' : 'border-current';
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg border px-1.5 text-[11px] ${border} ${TONE_CLASS[tone]}`}><Dot tone={tone} />{children}</span>;
}
