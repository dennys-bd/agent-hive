// Settings › fluxo › sources (#514): the row summary, and the new-source dialog's types, rules and row. Pure, so node:test checks it.
import { WORKSPACE_NAME, isReservedSource } from '../../tasks.js';
import type { SourceFields, FilterRule, GithubAuth, GithubAuthStatus, ProjectSummary, TaskProp } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import { type SourceDraft, emptySource } from './settings-form.js';
import type { JiraDraft, JiraIssueType, JiraLinkType } from './settings-jira.js';
import { entryLabel, type FlowScope, PROP_LABEL, propMode } from './setup-source-task-props.js';

/** The types the dialog offers (#514, #822). */
export const NEW_SOURCE_TYPES = ['github', 'jira'] as const satisfies readonly SourceFields['type'][];
/** The type badge / read-only type field label; a Record, so a new source type fails tsc until it has one. */
export const TYPE_LABEL: Record<SourceFields['type'], MessageKey> = { github: 'settings.sources.type.github', jira: 'settings.sources.type.jira' };
/** Who a source belongs to, as its row and header show it (#820): GitHub's owner, a Jira source's site. */
export const sourceOwner = (source: SourceFields): string => (source.type === 'github' ? source.owner : source.site);
export interface NewSourceFields { type: SourceFields['type']; owner: string; number: string; jira: JiraDraft; name: string; workspace: string }
/** What the dialog hands the Settings page: the row, and the owner's projects it loaded, so the detail's select shows them at once. */
export interface NewSource { source: SourceDraft; projects: ProjectSummary[] }

// The names the defaults look for (#822, user): Jira's own defaults on a new project
const DONE_STATUS = 'Done';
const TASK_TYPE = 'Task';
const SUBTASK_TYPE = 'Subtask';
const BLOCKS_LINK = 'Blocks';
const named = (names: readonly string[], wanted: string): string => (names.includes(wanted) ? wanted : (names[0] ?? ''));

/** A new Jira row's defaults from its project's statuses and issue types and the site's link types (#822). The statuses route answers no
 * category, so Done is found by name, else the last in Jira's order; a project with no sub-task type leaves subtaskType empty, which
 * validateSettings refuses. */
export function jiraDefaults(statuses: readonly string[], issueTypes: readonly JiraIssueType[], linkTypes: readonly JiraLinkType[]): Omit<JiraDraft, 'site' | 'project'> {
  const typesOf = (subtask: boolean): string[] => issueTypes.filter((type) => type.subtask === subtask).map((type) => type.name);
  return {
    tree: { epics: true, subtasks: true },
    blockingLinkTypes: linkTypes.some((link) => link.name === BLOCKS_LINK) ? [BLOCKS_LINK] : [],
    issueType: named(typesOf(false), TASK_TYPE),
    subtaskType: named(typesOf(true), SUBTASK_TYPE),
    doneStatus: statuses.includes(DONE_STATUS) ? DONE_STATUS : (statuses.at(-1) ?? ''),
  };
}

export const needsGithubToken = (auth: GithubAuth, github?: GithubAuthStatus): boolean => auth === 'api' && !github?.connected;

// The row's place in its type (#822): GitHub's project number, a Jira site and project
function pickProblem(f: NewSourceFields): string | undefined {
  if (f.type === 'github') return f.number === '' ? t('settings.error.project') : undefined;
  if (f.jira.site === '') return t('newSource.error.site');
  return f.jira.project === '' ? t('settings.error.project') : undefined;
}

export function newSourceProblem(f: NewSourceFields, taken: readonly string[]): string | undefined {
  const picked = pickProblem(f);
  if (picked !== undefined) return picked;
  const name = f.name.trim();
  if (!WORKSPACE_NAME.test(name) || isReservedSource(name)) return t('newSource.error.name');
  if (taken.includes(name)) return t('settings.error.sourceDuplicate', { name });
  return f.workspace === '' ? t('newSource.error.workspace') : undefined;
}

export function newSourceDraft(f: NewSourceFields, flowId: string): SourceDraft {
  const row = { ...emptySource(f.workspace, flowId), name: f.name.trim() };
  return f.type === 'jira' ? { ...row, type: 'jira', jira: f.jira } : { ...row, type: 'github', owner: f.owner.trim(), number: f.number };
}

function ruleText(rule: FilterRule): string {
  if (rule.field === 'blocked') return `${t(rule.op === 'any' ? 'settings.filter.op.is' : 'settings.filter.op.isNot')} ${t('settings.filter.field.blocked')}`;
  const field = rule.field === 'projectField' ? rule.name : t(`settings.filter.field.${rule.field}` as MessageKey);
  return `${field} ${t(`settings.filter.op.${rule.op}` as MessageKey)} ${rule.values.join(', ')}`;
}

// The project part (#514): the loaded title once it joins the row, else the number alone.
function projectPart(source: SourceDraft, title?: string): string {
  if (source.type === 'jira') return source.jira.project === '' ? t('settings.sources.noProject') : source.jira.project; // #822: its key
  if (source.number === '') return t('settings.sources.noProject');
  return title === undefined ? `#${source.number}` : `#${source.number} ${title}`;
}

// The filter part (#514): none, one rule read out, or a count of several.
function filterPart(source: SourceDraft): string {
  if (source.filter.length === 0) return t('settings.sources.noFilter');
  return source.filter.length === 1 ? t('settings.sources.filter', { rule: ruleText(source.filter[0]) }) : t('settings.sources.filters', { n: source.filter.length });
}

// The summary's order (#670, handoff): the entry part right after the workspace part, before auto; not TASK_PROPS' order.
const SUMMARY_PROPS: readonly TaskProp[] = ['workspace', 'entry', 'auto'];

function fixedValue({ workspace, auto, entry }: SourceDraft['taskProps']['defaults'], prop: TaskProp, scope: FlowScope): string {
  if (prop === 'entry') return entryLabel(entry, scope);
  return prop === 'auto' ? t(auto ? 'settings.taskProps.yes' : 'settings.taskProps.no') : workspace || '—';
}

// One part per task property (#688): fixed reads its default, dynamic counts the rules that set it.
function propPart({ taskProps }: SourceDraft, prop: TaskProp, scope: FlowScope): string {
  const name = t(PROP_LABEL[prop]);
  const mode = propMode(taskProps, prop);
  if (mode !== 'fixed') return t(mode === 1 ? 'settings.sources.prop.one' : 'settings.sources.prop.other', { prop: name, n: mode });
  return t('settings.sources.prop.fixed', { prop: name, value: fixedValue(taskProps.defaults, prop, scope) });
}

/** A sources row's one-line summary (#514, #688): project · filter · one part per task property (workspace, entry, auto), joined by " · ". `title` is the loaded
 * project's, when it has joined the row yet. */
export const sourceSummary = (source: SourceDraft, scope: FlowScope, title?: string): string =>
  [projectPart(source, title), filterPart(source), ...SUMMARY_PROPS.map((prop) => propPart(source, prop, scope))].join(' · ');
