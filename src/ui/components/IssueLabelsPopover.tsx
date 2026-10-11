import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { IssuePage } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { issuePath, type Optimistic } from '@/hooks/use-issue';
import { readQuotaJson } from '@/hooks/use-project';
import { repoPath } from '@/hooks/use-repositories';
import { t } from '@/i18n';

/** A label write (#757): straight to GitHub. #765 spike: shown at once through `optimistic`; the reload after it reads the read model, which
 * holds the write's answer when GitHub took it and the old labels when it refused (act toasts that): the confirmation or the rollback. */
export async function writeLabels(issue: IssuePage, add: string[], remove: string[], onChanged: () => Promise<void>, optimistic?: Optimistic): Promise<void> {
  optimistic?.((shown) => ({ ...shown, labels: [...shown.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !shown.labels.includes(l))] }));
  await act<unknown>(`${issuePath(issue.repository, issue.number)}/labels`, { add, remove });
  await onChanged();
}

/** labels + (#757, handoff 01): the repository's labels, read when the popover opens, as checkboxes; a toggle adds or removes at once. */
export function IssueLabelsPopover({ issue, onChanged, optimistic }: { issue: IssuePage; onChanged(): Promise<void>; optimistic?: Optimistic }) {
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
