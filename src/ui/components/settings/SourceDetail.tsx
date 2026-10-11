import { useId } from 'react';
import { FilterRules } from '@/components/settings/FilterRules';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { TaskDefaults } from '@/components/settings/TaskDefaults';
import { TaskRules } from '@/components/settings/TaskRules';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import { TYPE_LABEL } from '@/lib/flow-sources';
import type { SourceDraft } from '@/lib/settings-form';
import type { SourceTaskPropsDraft } from '@/lib/setup-source-task-props';
import { EPICS_MODES, type EpicsMode, type FilterOptions, type GithubAuth, type ProjectSummary } from '../../../types';

interface SourceDetailProps {
  source: SourceDraft; workspaces: string[]; githubProjects: ProjectSummary[]; needsToken: boolean; auth: GithubAuth;
  filterOptions?: FilterOptions; // #245: the source's real values, loaded with its columns
  onChange(patch: Partial<SourceDraft>): void; onRemove(): void; onLoadProjects(): void;
  /** Loads this row's columns; `number` when the project select passes its new value (the `source` prop still holds the one just left). */
  onLoadColumns(number?: string): void;
  /** Back to the sources list, its Connections group (#524): the field row's "change" link. */
  onOpenList(): void;
}

interface FieldsProps { id: string; source: SourceDraft; onChange(patch: Partial<SourceDraft>): void; onLoadColumns(number?: string): void }

const FIELD = 'flex flex-col gap-2'; // the design's label-over-control cell
const EPICS_LABEL: Record<EpicsMode, MessageKey> = { ignore: 'settings.epics.ignore', show: 'settings.epics.show', hide: 'settings.epics.hide' };

function GithubFields({ id, source, githubProjects, needsToken, onChange, onLoadProjects, onLoadColumns }: FieldsProps & Pick<SourceDetailProps, 'githubProjects' | 'needsToken' | 'onLoadProjects'>) {
  return (
    <>
      <div className={FIELD}>
        <Label htmlFor={`${id}-owner`}>{t('settings.owner')}</Label>
        <div className="flex gap-2">
          <Input id={`${id}-owner`} className="flex-1" defaultValue={source.owner} onChange={(e) => onChange({ owner: e.target.value })} />
          <Button type="button" variant="outline" disabled={needsToken} onClick={onLoadProjects}>{t('settings.load')}</Button>
        </div>
      </div>
      <div className={FIELD}>
        <Label htmlFor={`${id}-project`}>{t('settings.project')}</Label>
        <Select value={source.number} disabled={needsToken} onValueChange={(v) => { onChange({ number: v }); onLoadColumns(v); }}>
          <SelectTrigger id={`${id}-project`} className="w-full"><SelectValue placeholder={t('settings.projectPlaceholder')} /></SelectTrigger>
          <SelectContent>
            {githubProjects.map((p) => <SelectItem key={p.number} value={String(p.number)}>{`#${p.number} ${p.title}`}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

/** qualificar o id: the switch beside its label and hint; its prefix, when on, beside them on the same row (#524). */
function QualifyRow({ id, source, onChange }: Omit<FieldsProps, 'onLoadColumns'>) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Switch id={`${id}-qualify`} checked={source.qualifyId} onCheckedChange={(qualifyId) => onChange({ qualifyId })} />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={`${id}-qualify`}>{t('settings.sources.qualifyId')}</Label>
        <span className="text-muted-foreground text-xs">{t('settings.sources.qualifyId.hint')}</span>
      </div>
      {source.qualifyId && (
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={`${id}-prefix`}>{t('settings.sources.prefix')}</Label>
          <Input id={`${id}-prefix`} className="w-40" defaultValue={source.prefix} onChange={(e) => onChange({ prefix: e.target.value })} />
        </div>
      )}
    </div>
  );
}

const NONE = '__none__'; // Radix Select rejects value=""; '' (no repository) travels as this
// #846: the repository a task created in this source becomes an issue of: the Project's linked ones, the saved one kept while they load
function RepositoryRow({ id, source, linked, onChange }: { id: string; source: SourceDraft; linked: string[]; onChange(patch: Partial<SourceDraft>): void }) {
  const choices = [...new Set([...(source.repository === '' ? [] : [source.repository]), ...linked])];
  return (
    <div className="grid grid-cols-[320px_minmax(0,1fr)] items-end gap-3 border-t pt-3">
      <div className={FIELD}>
        <Label htmlFor={`${id}-repository`}>{t('settings.source.repository')}</Label>
        <Select value={source.repository || NONE} onValueChange={(v) => onChange({ repository: v === NONE ? '' : v })}>
          <SelectTrigger id={`${id}-repository`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('settings.source.repository.none')}</SelectItem>
            {choices.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <p className="pb-2.5 text-muted-foreground text-xs">{t('settings.source.repository.hint')}</p>
    </div>
  );
}

type FieldsGroupProps = Pick<SourceDetailProps, 'source' | 'githubProjects' | 'needsToken' | 'auth' | 'filterOptions' | 'onChange' | 'onLoadProjects' | 'onLoadColumns' | 'onOpenList'> & { id: string };

/** name, type, then the type's own fields, side by side in the design's one grid row (#524); GitHub ends on the connection line. */
function FieldsGroup({ id, source, githubProjects, needsToken, auth, filterOptions, onChange, onLoadProjects, onLoadColumns, onOpenList }: FieldsGroupProps) {
  return (
    <SettingsGroup title="settings.source.fields">
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))_minmax(0,1.4fr)_minmax(0,1fr)] items-end gap-3">
        <div className={FIELD}>
          <Label htmlFor={`${id}-name`}>{t('settings.sources.name')}</Label>
          <Input id={`${id}-name`} defaultValue={source.name} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div className={FIELD}>
          <Label htmlFor={`${id}-type`}>{t('settings.sourceType')}</Label>
          {/* read-only (#514): a source keeps the type it was added with */}
          <Input id={`${id}-type`} disabled value={t(TYPE_LABEL[source.type])} />
        </div>
        <GithubFields id={id} source={source} githubProjects={githubProjects} needsToken={needsToken} onChange={onChange} onLoadProjects={onLoadProjects} onLoadColumns={onLoadColumns} />
      </div>
      <QualifyRow id={id} source={source} onChange={onChange} />
      {source.type === 'github' && <RepositoryRow id={id} source={source} linked={filterOptions?.linkedRepositories ?? []} onChange={onChange} />}
      {source.type === 'github' && (
        <p className="border-t pt-3 text-muted-foreground text-xs">
          {t('settings.source.connection', { auth: t(auth === 'api' ? 'settings.auth.api' : 'settings.auth.cli') })}
          {' · '}
          <button type="button" className="text-review" onClick={onOpenList}>{t('settings.source.connection.change')}</button>
        </p>
      )}
    </SettingsGroup>
  );
}

type FilterGroupProps = Pick<SourceDetailProps, 'source' | 'filterOptions' | 'onChange'> & { id: string };

/** GitHub only: the task filter, then the source's own epics select (#524, #30), under the filter as the design has it. */
function FilterGroup({ id, source, filterOptions, onChange }: FilterGroupProps) {
  return (
    <SettingsGroup title="settings.source.filter" hint="settings.source.filterHint">
      <FilterRules inSettings rules={source.filter} options={filterOptions} onChange={(filter) => onChange({ filter })} />
      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-end gap-3 border-t pt-3">
        <div className={FIELD}>
          <Label htmlFor={`${id}-epics`}>{t('settings.epics')}</Label>
          <Select value={source.epics} onValueChange={(v) => onChange({ epics: v as EpicsMode })}>
            <SelectTrigger id={`${id}-epics`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {EPICS_MODES.map((mode) => <SelectItem key={mode} value={mode}>{t(EPICS_LABEL[mode])}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="pb-2.5 text-muted-foreground text-xs">{t('settings.source.epicsHint')}</p>
      </div>
    </SettingsGroup>
  );
}

type TaskPropsGroupProps = Pick<SourceDetailProps, 'source' | 'workspaces' | 'onChange'> & { id: string };

/** What the source sets on each task it lists, on entry (#688): the defaults, then the rules that replace them when they match. The mode of
 * each property is derived from the rules, never chosen. */
function TaskPropsGroup({ id, source, workspaces, onChange }: TaskPropsGroupProps) {
  const put = (taskProps: SourceTaskPropsDraft): void => onChange({ taskProps });
  return (
    <SettingsGroup title="settings.taskProps.title" hint="settings.taskProps.hint" flush>
      <div className="flex flex-col gap-5 p-5">
        <TaskDefaults id={`${id}-defaults`} draft={source.taskProps} workspaces={workspaces} onChange={put} />
        <TaskRules draft={source.taskProps} workspaces={workspaces} onChange={put} />
      </div>
    </SettingsGroup>
  );
}

/** One source's detail page, Settings › fluxo › sources › <source> (#514, #524): its fields, its task filter and epics (github only), and its
 * task properties group (#688), each its own SettingsGroup. The page around it supplies the column and the breadcrumb, so this returns a fragment. */
export function SourceDetail({ source, workspaces, githubProjects, needsToken, auth, filterOptions, onChange, onRemove, onLoadProjects, onLoadColumns, onOpenList }: SourceDetailProps) {
  const id = useId();
  return (
    <>
      <FieldsGroup id={id} source={source} githubProjects={githubProjects} needsToken={needsToken} auth={auth} filterOptions={filterOptions} onChange={onChange} onLoadProjects={onLoadProjects} onLoadColumns={onLoadColumns} onOpenList={onOpenList} />
      {source.type === 'github' && (
        <FilterGroup id={id} source={source} filterOptions={filterOptions} onChange={onChange} />
      )}
      <TaskPropsGroup id={id} source={source} workspaces={workspaces} onChange={onChange} />
      <Button type="button" variant="outline" className="self-start text-destructive" onClick={onRemove}>{t('settings.sources.remove')}</Button>
    </>
  );
}
