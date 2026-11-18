// The Jira parts of a source's detail (#822): kept out of SourceDetail.tsx for the 400-line and 50-line limits.
import { asChoices, JiraReadNotice, JiraSelect, projectLabel } from '@/components/settings/JiraControls';
import { MultiSelect } from '@/components/settings/MultiSelect';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useJiraSites } from '@/hooks/use-jira-sites';
import type { JiraLoad, JiraRowOptions } from '@/hooks/use-jira-source-options';
import { type MessageKey, t } from '@/i18n';
import type { JiraDraft, SourceDraft } from '@/lib/settings-form';
import { withCurrent } from '@/lib/settings-jira';
import { settingAnchor } from '@/lib/settings-search';

interface JiraPartProps { id: string; source: SourceDraft; options: JiraRowOptions; onChange(patch: Partial<SourceDraft>): void }

/** The Jira labels of the Settings search (#822), each the anchor of its control. */
export const JIRA_KEY_LABELS: readonly MessageKey[] = [
  'settings.source.jira.keys', 'settings.source.jira.tree.epics', 'settings.source.jira.tree.subtasks', 'settings.source.jira.blockingLinkTypes',
  'settings.source.jira.issueType', 'settings.source.jira.subtaskType', 'settings.source.jira.doneStatus',
];

/** The site and project selects (#822), in the fields row where GitHub has its owner and project. A new site clears the project:
 * another site's key means nothing there. A new project keeps every other key. */
export function JiraFields({ id, source, options, onChange, onLoadJira }: JiraPartProps & { onLoadJira(jira: JiraDraft, load: JiraLoad): void }) {
  const { sites } = useJiraSites();
  const connected = (sites ?? []).filter((s) => s.state === 'connected').map((s) => s.site);
  const pick = (jira: JiraDraft, load: JiraLoad): void => { onChange({ jira }); onLoadJira(jira, load); };
  const projects = withCurrent(source.jira.project, options.projects.map((p) => p.key))
    .map((key) => { const p = options.projects.find((o) => o.key === key); return { value: key, label: p === undefined ? key : projectLabel(p) }; });
  return (
    <>
      <JiraSelect
        id={`${id}-jira-site`} label="settings.source.jira.site" value={source.jira.site} choices={asChoices(withCurrent(source.jira.site, connected))}
        placeholder="settings.source.jira.sitePlaceholder" anchor={settingAnchor('settings.source.jira.site', source.id)}
        onPick={(site) => pick({ ...source.jira, site, project: '' }, 'site')}
      />
      <JiraSelect
        id={`${id}-jira-project`} label="settings.source.jira.project" value={source.jira.project} choices={projects}
        placeholder="settings.source.jira.projectPlaceholder" anchor={settingAnchor('settings.source.jira.project', source.id)}
        onPick={(project) => pick({ ...source.jira, project }, 'project')}
      />
    </>
  );
}

/** The two reads' failures under the fields row (#822): the site's at its select, the project's at its. */
export function JiraNotices({ options, onOpenList }: { options: JiraRowOptions; onOpenList(): void }) {
  return (
    <>
      <JiraReadNotice error={options.errors.site} onOpenConnections={onOpenList} />
      <JiraReadNotice error={options.errors.project} onOpenConnections={onOpenList} />
    </>
  );
}

type PutJira = (patch: Partial<JiraDraft>) => void;

function TreeRow({ id, source, put }: { id: string; source: SourceDraft; put: PutJira }) {
  const { tree } = source.jira;
  const levels = [['epics', 'settings.source.jira.tree.epics'], ['subtasks', 'settings.source.jira.tree.subtasks']] as const;
  return (
    <div className="flex flex-wrap items-center gap-6">
      {levels.map(([level, label]) => (
        <div key={level} id={settingAnchor(label, source.id)} className="flex items-center gap-3">
          <Switch id={`${id}-tree-${level}`} checked={tree[level]} onCheckedChange={(on) => put({ tree: { ...tree, [level]: on } })} />
          <Label htmlFor={`${id}-tree-${level}`}>{t(label)}</Label>
        </div>
      ))}
    </div>
  );
}

function LinkTypesRow({ source, options, put }: { source: SourceDraft; options: JiraRowOptions; put: PutJira }) {
  const label = t('settings.source.jira.blockingLinkTypes');
  const listed = options.linkTypes;
  const describe = (name: string): string => { const link = listed.find((l) => l.name === name); return link === undefined ? name : `${name} · ${link.outward} / ${link.inward}`; };
  return (
    <div id={settingAnchor('settings.source.jira.blockingLinkTypes', source.id)} className="flex flex-col gap-2">
      <span className="font-medium text-sm">{label}</span>
      <MultiSelect
        ariaLabel={label} value={source.jira.blockingLinkTypes} options={listed.map((l) => l.name)} labelOf={describe}
        placeholder={t('settings.source.jira.blockingLinkTypesPlaceholder')} onChange={(blockingLinkTypes) => put({ blockingLinkTypes })}
      />
    </div>
  );
}

/** The Jira-only keys (#822): the tree, the blocking link types, the issue type, sub-task type and done status. */
export function JiraKeysGroup({ id, source, options, columns, onChange }: JiraPartProps & { columns: readonly string[] }) {
  const put: PutJira = (patch) => onChange({ jira: { ...source.jira, ...patch } });
  const typesOf = (subtask: boolean): string[] => options.issueTypes.filter((type) => type.subtask === subtask).map((type) => type.name);
  const hasNoSubtaskType = options.issueTypes.length > 0 && typesOf(true).length === 0;
  const { issueType, subtaskType, doneStatus } = source.jira;
  const select = (key: 'issueType' | 'subtaskType' | 'doneStatus', label: MessageKey, current: string, listed: readonly string[]) => (
    <JiraSelect
      id={`${id}-${key}`} label={label} value={current} choices={asChoices(withCurrent(current, listed))} anchor={settingAnchor(label, source.id)}
      onPick={(value) => put({ [key]: value })}
    />
  );
  return (
    <SettingsGroup title="settings.source.jira.keys" hint="settings.source.jira.keysHint" anchor={settingAnchor('settings.source.jira.keys', source.id)}>
      <TreeRow id={id} source={source} put={put} />
      <LinkTypesRow source={source} options={options} put={put} />
      <div className="grid grid-cols-3 items-start gap-3">
        {select('issueType', 'settings.source.jira.issueType', issueType, typesOf(false))}
        <div className="flex flex-col gap-2">
          {select('subtaskType', 'settings.source.jira.subtaskType', subtaskType, typesOf(true))}
          {hasNoSubtaskType && subtaskType === '' && <p className="text-destructive text-xs">{t('settings.source.jira.noSubtaskTypeHint')}</p>}
        </div>
        {select('doneStatus', 'settings.source.jira.doneStatus', doneStatus, columns)}
      </div>
    </SettingsGroup>
  );
}
