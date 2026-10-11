import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { activityOf } from '../../activities';
import { canMoveToStage, sourceOf } from '../../tasks';
import type { IssuePage, ItemField, State, Task } from '../../types';
import { act } from '@/components/actions';
import { SessionsList, StatusBox } from '@/components/DetailSections';
import { FieldEditor } from '@/components/FieldEditor';
import { useOpenActivity } from '@/components/FlowTask';
import { IssueLabelsPopover, writeLabels } from '@/components/IssueLabelsPopover';
import { ProjectCreatePopover } from '@/components/ProjectCreatePopover';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { type FieldAnswer, useItemFields } from '@/hooks/use-item-fields';
import { t } from '@/i18n';
import { workspaceColor } from '@/lib/workspace-color';

const MUTED = 'text-muted-foreground';
const CHIP = 'rounded-[4px] border px-1.5 text-muted-foreground text-xs';

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={MUTED}>{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1">{children}</dd>
    </>
  );
}

// etapa (handoff 01): the task's stage, moved through the flow's own move-to; disabled while canMoveToStage refuses, as the task menu is
function StageSelect({ task, state }: { task: Task; state: State }) {
  const path = `/tasks/${encodeURIComponent(task.item.itemId)}/move-to`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!canMoveToStage(task, state)}>
        <button type="button" aria-label={t('issue.props.stage')} className="flex max-w-full items-center gap-1 rounded-[5px] border px-2 py-0.5 text-xs disabled:opacity-50">
          <span className="truncate">{task.stage}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {state.stages.filter((s) => s.name !== task.stage).map((s) => (
          <DropdownMenuItem key={s.name} onSelect={() => void act(path, { stage: s.name })}>{s.name}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// atividade (handoff 01): the task's activity, its status box, branch and sessions, as the detail panel shows them; abrir atividade while a
// run of it is live
function ActivityBlock({ task, state, locale }: { task: Task; state: State; locale: string }) {
  const openActivity = useOpenActivity(task, state);
  const branch = activityOf(state, task.item.itemId)?.branch;
  return (
    <section aria-label={t('issue.activity')} className="flex flex-col gap-2.5 border-t pt-3.5">
      <h3 className={`${MUTED} text-xs`}>{t('issue.activity')}</h3>
      <StatusBox task={task} state={state} isActivity={false} />
      {branch !== undefined && <p className="truncate font-mono text-xs">{branch}</p>}
      <SessionsList task={task} state={state} locale={locale} />
      <Button type="button" size="xs" variant="outline" className="self-start" disabled={openActivity === undefined} onClick={() => openActivity?.()}>
        {t('issue.openActivity')}
      </Button>
    </section>
  );
}

// #686: the source's fields, the assignees first in the assignee row, then every other one in the project's order, labelled with its name.
// The labels keep their own row above (#757): the source's Labels field is not listed twice (#60)
function FieldRows({ itemId, fields, onWritten }: { itemId: string; fields: ItemField[]; onWritten(answer: FieldAnswer): void }) {
  const listed = fields.filter((f) => f.type !== 'labels');
  const ordered = [...listed.filter((f) => f.type === 'assignees'), ...listed.filter((f) => f.type !== 'assignees')];
  return (
    <>
      {ordered.map((f) => (
        <Prop key={f.name} label={f.type === 'assignees' ? t('issue.props.assignee') : f.name}>
          <FieldEditor itemId={itemId} field={f} onWritten={onWritten} />
        </Prop>
      ))}
    </>
  );
}

export interface IssuePropertiesProps {
  issue: IssuePage; task?: Task; state: State; locale: string;
  workspace?: string; // the task's, else the repository's
  itemId?: string; // the native view item the page came from: a task created here records it as its origin
  meta: string; // the source or owner/name the page was opened from: what fluxo…'s warning names
  onGoTo(taskId: string): void;
  onChanged(): Promise<void>; // the page's reload, after a label write
}

/** propriedades (#757, handoff 01): the stage and the labels (#757), then the source's fields (#686), each edited and written at once. The
 * fields are read for the task's source item, or for the native view item the page was opened from. An issue in no source shows its
 * assignees read only. A task shows its source and its activity; an issue out of the flow shows fluxo… in the stage's place (handoff 02). */
export function IssueProperties({ issue, task, state, locale, workspace, itemId, meta, onGoTo, onChanged }: IssuePropertiesProps) {
  const sourced = task?.item.source === undefined ? undefined : task;
  const fieldsItem = sourced?.item.itemId ?? itemId;
  const { fields, replace } = useItemFields(fieldsItem);
  const from = {
    id: String(issue.number), title: issue.title, body: issue.body, url: issue.url,
    ...(workspace === undefined ? {} : { workspaceHint: workspace }), ...(itemId === undefined ? {} : { itemId }),
  };
  return (
    <aside aria-label={t('issue.props')} className="flex w-[320px] shrink-0 flex-col border-l">
      <h2 className="flex h-10 shrink-0 items-center border-b px-3.5 font-medium text-[13px]">{t('issue.props')}</h2>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
        <dl className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-2 gap-y-3 text-xs">
          <Prop label={t('issue.props.stage')}>
            {task ? <StageSelect task={task} state={state} /> : <ProjectCreatePopover item={from} source={meta} state={state} onCreated={onGoTo} />}
          </Prop>
          <Prop label={t('issue.props.labels')}>
            {issue.labels.map((label) => (
              <span key={label} className={`flex items-center ${CHIP}`}>
                {label}
                <button type="button" aria-label={t('issue.labels.remove', { label })} className="pl-1 hover:text-foreground" onClick={() => void writeLabels(issue, [], [label], onChanged)}>×</button>
              </span>
            ))}
            <IssueLabelsPopover issue={issue} onChanged={onChanged} />
          </Prop>
          {fieldsItem !== undefined && fields !== undefined
            ? <FieldRows itemId={fieldsItem} fields={fields} onWritten={(answer) => replace(fieldsItem, answer.fields)} />
            : <Prop label={t('issue.props.assignee')}><span>{issue.assignees.length > 0 ? issue.assignees.join(', ') : '—'}</span></Prop>}
          {task && (
            <Prop label={t('issue.props.source')}>
              <span>{sourceOf(task)}</span><span className={MUTED}>{t(sourced ? 'flow.source.type.github' : 'flow.source.type.hive')}</span>
            </Prop>
          )}
          {workspace !== undefined && (
            <Prop label={t('issue.props.workspace')}>
              <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: workspaceColor(workspace) }} /><span>{workspace}</span>
            </Prop>
          )}
        </dl>
        {task && activityOf(state, task.item.itemId) && <ActivityBlock task={task} state={state} locale={locale} />}
      </div>
    </aside>
  );
}
