import { useContext, useState } from 'react';
import { HIVE_SOURCE } from '../../tasks';
import type { ProjectItem, State } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { CreateTargetsContext } from '@/lib/create-targets';

interface CreatedTask { id: string; itemId: string } // what POST /tasks answers

// The copy's **…** part in foreground, the rest muted (handoff 01: "sem sync")
function Emphasized({ text }: { text: string }) {
  return <>{text.split('**').map((part, i) => (i % 2 === 1 ? <span key={part} className="text-foreground">{part}</span> : part))}</>;
}

/** What fluxo… creates a task from (#756, #757): a native view's item, or an issue page's issue, which has no source item unless it was
 * opened from a native view row: no origin then. */
export type CreateFrom = Pick<ProjectItem, 'id' | 'title' | 'body' | 'url' | 'workspaceHint'> & { itemId?: string };

interface ProjectCreatePopoverProps { item: CreateFrom; source: string; state: State; onCreated(taskId: string): void }

/** fluxo… (#756, handoff 01): an issue the source's filter or epics: hide keeps out, or any issue out of the flow on its page (#757),
 * becomes a task of the hive source, after a warning that nothing syncs. The task is born with auto off (no worker starts on its own), in
 * the flow's first stage, with the issue's title, body and link and, from a source item, its origin; its workspace is the issue's hint when
 * the Comb has it. Offered only while the hive source is on (#846). A refusal is act's toast and the popover stays. */
export function ProjectCreatePopover({ item, source, state, onCreated }: ProjectCreatePopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const { hiveSource } = useContext(CreateTargetsContext);
  const stage = state.stages[0]?.name;
  const workspace = item.workspaceHint !== undefined && state.workspaces.includes(item.workspaceHint) ? item.workspaceHint : undefined;
  const create = (): void => {
    setIsCreating(true);
    const body = {
      title: item.title, body: item.body, stage, auto: false, url: item.url, source: HIVE_SOURCE,
      ...(item.itemId === undefined ? {} : { origin: item.itemId }), ...(workspace === undefined ? {} : { workspace }),
    };
    void act<CreatedTask>('/tasks', body).then((created) => {
      setIsCreating(false);
      if (created === undefined) return;
      setIsOpen(false);
      onCreated(created.itemId);
    });
  };
  if (!hiveSource) return null; // #846: it creates a hive task, which cannot exist while hive is off
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline">{t('project.action.create')}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[320px] flex-col gap-2.5 rounded-lg p-3 shadow-lg">
        <p className="font-semibold text-sm">{t('project.create.title')}</p>
        <p className="text-muted-foreground text-xs leading-[18px]"><Emphasized text={t('project.create.body', { issue: `#${item.id}`, source })} /></p>
        <div className="flex justify-end gap-2">
          <Button type="button" size="xs" variant="outline" onClick={() => setIsOpen(false)}>{t('project.create.cancel')}</Button>
          <Button type="button" size="xs" disabled={isCreating || stage === undefined} onClick={create}>{t('project.create.confirm')}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
