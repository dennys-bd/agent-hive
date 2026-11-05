import { useContext, useState } from 'react';
import { HIVE_SOURCE } from '../../tasks';
import type { ProjectItem, State } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { CreateTargetsContext } from '@/lib/create-targets';

/** What + tarefa makes a task from (#756, #757): a source table's item, or an issue page's issue, which has no source item unless the page
 * was opened from a table row: no origin then. */
export type CreateFrom = Pick<ProjectItem, 'title' | 'body' | 'url' | 'workspaceHint'> & { itemId?: string };

interface CreateTaskButtonProps { item: CreateFrom; state: Pick<State, 'workspaces'> }

// POST /tasks's body (#566, #583 decision 10): a hive task with no stage and auto off, with the issue's title, body and link, its origin from a
// source item, and its workspace when the Hive knows the hint
function bodyOf(item: CreateFrom, workspaces: readonly string[]) {
  const workspace = item.workspaceHint !== undefined && workspaces.includes(item.workspaceHint) ? item.workspaceHint : undefined;
  return {
    title: item.title, body: item.body, auto: false, url: item.url, source: HIVE_SOURCE,
    ...(item.itemId === undefined ? {} : { origin: item.itemId }), ...(workspace === undefined ? {} : { workspace }),
  };
}

/** + tarefa (#583, handoff §5): one click, no popover, makes the issue a hive task outside the flow; the tooltip says nothing syncs. It stays
 * where it is: the row's cell reads sem fluxo › once the state carries the task. Disabled while the request runs; absent while the hive source
 * is off (#846), since the task would be a hive task. A refusal is act's toast. */
export function CreateTaskButton({ item, state }: CreateTaskButtonProps) {
  const [isCreating, setIsCreating] = useState(false);
  const { hiveSource } = useContext(CreateTargetsContext);
  if (!hiveSource) return null;
  const create = (): void => {
    setIsCreating(true);
    void act('/tasks', bodyOf(item, state.workspaces)).finally(() => setIsCreating(false)); // act never rejects
  };
  return (
    <Button type="button" size="xs" variant="outline" title={t('project.task.createHint')} disabled={isCreating} onClick={create}>
      {t('project.task.create')}
    </Button>
  );
}
