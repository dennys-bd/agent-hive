import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { IssuePage } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type IssuePatch, issuePath, type Optimistic } from '@/hooks/use-issue';
import { readQuotaJson } from '@/hooks/use-project';
import { repoPath } from '@/hooks/use-repositories';
import { t } from '@/i18n';

// The labels as the write leaves them (#183): the removed ones out, the added ones after the rest
const labelPatch = (add: string[], remove: string[]): IssuePatch => (issue) => ({
  ...issue, labels: [...issue.labels.filter((label) => !remove.includes(label)), ...add.filter((label) => !issue.labels.includes(label))],
});

/** A label write (#757): shown at once (#183), then straight to GitHub; once it took it, the page reads the issue again, and only then is the
 * shown change dropped, so the label never flickers. A refusal drops it at once and is act's toast. */
export async function writeLabels(issue: IssuePage, add: string[], remove: string[], onChanged: () => Promise<void>, optimistic: Optimistic): Promise<void> {
  const settle = optimistic(labelPatch(add, remove));
  const answer = await act<unknown>(`${issuePath(issue.repository, issue.number)}/labels`, { add, remove });
  if (answer !== undefined) await onChanged();
  settle();
}

/** labels + (#757, handoff 01): the repository's labels, read when the popover opens, as checkboxes; a toggle adds or removes at once. */
export function IssueLabelsPopover({ issue, onChanged, optimistic }: { issue: IssuePage; onChanged(): Promise<void>; optimistic: Optimistic }) {
  const [labels, setLabels] = useState<string[]>();
  const [isOpen, setIsOpen] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const open = (next: boolean): void => {
    setIsOpen(next);
    if (!next) return;
    setHasFailed(false);
    readQuotaJson<string[]>(`${repoPath(issue.repository)}/labels`).then(setLabels, (err: unknown) => {
      setHasFailed(true);
      toast.error(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <Popover open={isOpen} onOpenChange={open}>
      <PopoverTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" className="size-5 text-muted-foreground" aria-label={t('issue.labels.add')}><PlusIcon /></Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[320px] w-[240px] flex-col gap-1 overflow-y-auto p-2">
        {labels === undefined
          ? <p className="text-muted-foreground text-xs">{t(hasFailed ? 'issue.labels.failed' : 'project.loading')}</p>
          : labels.map((label) => {
            const isOn = issue.labels.includes(label);
            return (
              <label key={label} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted">
                <input type="checkbox" checked={isOn} onChange={() => void writeLabels(issue, isOn ? [] : [label], isOn ? [label] : [], onChanged, optimistic)} />
                {label}
              </label>
            );
          })}
      </PopoverContent>
    </Popover>
  );
}
