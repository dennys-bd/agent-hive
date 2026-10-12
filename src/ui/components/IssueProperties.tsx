import type { ReactNode } from 'react';
import { itemSource, sourceOf } from '../../tasks';
import type { IssuePage, State, Task } from '../../types';
import { IssueFieldsBox } from '@/components/IssueFieldsBox';
import { IssueLabelsPopover, writeLabels } from '@/components/IssueLabelsPopover';
import { ProjectCreatePopover } from '@/components/ProjectCreatePopover';
import { type FieldAnswer, useItemFields } from '@/hooks/use-item-fields';
import { t } from '@/i18n';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';

const MUTED = 'text-muted-foreground';
const CHIP = 'rounded-[4px] border px-1.5 text-muted-foreground text-xs';
const GRID = 'grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-2 gap-y-3 text-xs';

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={MUTED}>{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1">{children}</dd>
    </>
  );
}

interface RowsProps { issue: IssuePage; task?: Task; workspace?: string; create?: ReactNode; onChanged(): Promise<void> }

// #757's rows: an issue in no source's Project, or one whose fields are still read or failed to read (useItemFields tells neither apart),
// where these rows are a correct view all the same
function IssueRows({ issue, task, workspace, create, onChanged }: RowsProps) {
  return (
    <dl className={GRID}>
      {create && <Prop label={t('issue.props.flow')}>{create}</Prop>}
      <Prop label={t('issue.props.labels')}>
        {issue.labels.map((label) => (
          <span key={label} className={`flex items-center ${CHIP}`}>
            {label}
            <button type="button" aria-label={t('issue.labels.remove', { label })} className="pl-1 hover:text-foreground" onClick={() => void writeLabels(issue, [], [label], onChanged)}>×</button>
          </span>
        ))}
        <IssueLabelsPopover issue={issue} onChanged={onChanged} />
      </Prop>
      <Prop label={t('issue.props.assignee')}><span>{issue.assignees.length > 0 ? issue.assignees.join(', ') : '—'}</span></Prop>
      {task && (
        <Prop label={t('issue.props.source')}>
          <span>{sourceOf(task)}</span><span className={MUTED}>{t(task.item.source === undefined ? 'flow.source.type.hive' : 'flow.source.type.github')}</span>
        </Prop>
      )}
      {workspace !== undefined && (
        <Prop label={t('issue.props.workspace')}>
          <WorkspaceSquare name={workspace} /><span>{workspace}</span>
        </Prop>
      )}
    </dl>
  );
}

export interface IssuePropertiesProps {
  issue: IssuePage; task?: Task; state: State;
  workspace?: string; // the task's, else the repository's
  itemId?: string; // the native view item the page came from: a task created here records it as its origin
  meta: string; // the source or owner/name the page was opened from: what fluxo…'s warning names
  onGoTo(taskId: string): void;
  onChanged(): Promise<void>; // the page's reload, after a label or field write
}

/** The issue's block in the details panel's slot (#64). With the fields of its source item read (the task's, else the native view item the
 * page came from, #686), the this issue box (#65); otherwise #757's rows. An issue out of the flow shows fluxo… first (handoff 02). The
 * stage is moved on the flow's own menu: no stage select here (#65). */
export function IssueProperties({ issue, task, state, workspace, itemId, meta, onGoTo, onChanged }: IssuePropertiesProps) {
  const sourced = task?.item.source === undefined ? undefined : task;
  const fieldsItem = sourced?.item.itemId ?? itemId;
  const { fields, replace } = useItemFields(fieldsItem);
  const from = {
    id: String(issue.number), title: issue.title, body: issue.body, url: issue.url,
    ...(workspace === undefined ? {} : { workspaceHint: workspace }), ...(itemId === undefined ? {} : { itemId }),
  };
  const create = task === undefined ? <ProjectCreatePopover item={from} source={meta} state={state} onCreated={onGoTo} /> : undefined;
  if (fieldsItem === undefined || fields === undefined) return <IssueRows issue={issue} task={task} workspace={workspace} create={create} onChanged={onChanged} />;
  // The answer's fields at once, then the page's reload: the center reads the issue, not the item, so its labels and assignees follow
  const written = (answer: FieldAnswer): void => {
    replace(fieldsItem, answer.fields);
    void onChanged();
  };
  return (
    <div className="flex flex-col gap-4">
      {create && <dl className={GRID}><Prop label={t('issue.props.flow')}>{create}</Prop></dl>}
      {/* sourced only: a hive task's origin item has a Status that moves nothing, so no stage beside it and no note */}
      <IssueFieldsBox itemId={fieldsItem} source={itemSource(fieldsItem) ?? meta} fields={fields} task={sourced} onWritten={written} />
    </div>
  );
}
