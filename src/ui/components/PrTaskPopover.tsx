import { useContext, useState } from 'react';
import { toast } from 'sonner';
import type { PrData, State } from '../../types';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { createTaskFromPr } from '@/lib/api';
import { CreateTargetsContext } from '@/lib/create-targets';

interface PrTaskPopoverProps { pr: PrData; state: State }

/** create task… (#68, handoff 7): a PR no task holds becomes a hive task linked to it (#67), after a confirmation that nothing syncs, with
 * the PR's title, the flow's first stage and auto off, as fluxo… creates one. Offered only while the hive source is on (#846). Success only
 * closes: the next state makes taskOfPr find the task, and the page shows the task PR. A refusal is a toast, as act's, and the popover stays. */
export function PrTaskPopover({ pr, state }: PrTaskPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const { hiveSource } = useContext(CreateTargetsContext);
  const stage = state.stages[0]?.name;
  const create = (): void => {
    if (stage === undefined) return;
    setIsCreating(true);
    void createTaskFromPr({ url: pr.url, title: pr.title, stage, auto: false })
      .then(() => setIsOpen(false), (err: Error) => { toast.error(err.message); })
      .finally(() => setIsCreating(false));
  };
  if (!hiveSource) return null;
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline">{t('pr.other.create')}</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-[320px] flex-col gap-2.5 rounded-lg p-3 shadow-lg">
        <p className="font-semibold text-sm">{t('project.create.title')}</p>
        <p className="text-muted-foreground text-xs leading-[18px]">{t('pr.other.createBody', { n: pr.number })}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="xs" variant="outline" onClick={() => setIsOpen(false)}>{t('project.create.cancel')}</Button>
          <Button type="button" size="xs" disabled={isCreating || stage === undefined} onClick={create}>{t('project.create.confirm')}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
