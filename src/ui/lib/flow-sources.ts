// Settings › fluxo › sources (#514): the row summary, and the new-source dialog's types, rules and row. Pure, so node:test checks it.
import { WORKSPACE_NAME, isReservedSource } from '../../tasks.js';
import { TASK_PROPS, type SourceFields, type FilterRule, type GithubAuth, type GithubAuthStatus, type ProjectSummary, type TaskProp } from '../../types.js';
import { type MessageKey, t } from '../i18n.js';
import { type SourceDraft, emptySource } from './settings-form.js';
import { PROP_LABEL, propMode } from './setup-source-task-props.js';

/** The types the dialog offers (#514): Jira has no adapter yet; a new adapter joins here with its spec. */
export const NEW_SOURCE_TYPES = ['github'] as const satisfies readonly SourceFields['type'][];
/** The type badge / read-only type field label; a Record, so a new source type fails tsc until it has one. */
export const TYPE_LABEL: Record<SourceFields['type'], MessageKey> = { github: 'settings.sources.type.github' };
export interface NewSourceFields { owner: string; number: string; name: string; workspace: string }
/** What the dialog hands the Settings page: the row, and the owner's projects it loaded, so the detail's select shows them at once. */
export interface NewSource { source: SourceDraft; projects: ProjectSummary[] }

export const needsGithubToken = (auth: GithubAuth, github?: GithubAuthStatus): boolean => auth === 'api' && !github?.connected;

export function newSourceProblem(f: NewSourceFields, taken: readonly string[]): string | undefined {
  const name = f.name.trim();
  if (f.number === '') return t('settings.error.project');
  if (!WORKSPACE_NAME.test(name) || isReservedSource(name)) return t('newSource.error.name');
  if (taken.includes(name)) return t('settings.error.sourceDuplicate', { name });
  return f.workspace === '' ? t('newSource.error.workspace') : undefined;
}

export const newSourceDraft = (f: NewSourceFields): SourceDraft =>
  ({ ...emptySource(f.workspace), type: 'github', name: f.name.trim(), owner: f.owner.trim(), number: f.number });

function ruleText(rule: FilterRule): string {
  if (rule.field === 'blocked') return `${t(rule.op === 'any' ? 'settings.filter.op.is' : 'settings.filter.op.isNot')} ${t('settings.filter.field.blocked')}`;
  const field = rule.field === 'projectField' ? rule.name : t(`settings.filter.field.${rule.field}` as MessageKey);
  return `${field} ${t(`settings.filter.op.${rule.op}` as MessageKey)} ${rule.values.join(', ')}`;
}

// The project part (#514): the loaded title once it joins the row, else the number alone.
function projectPart(source: SourceDraft, title?: string): string {
  if (source.number === '') return t('settings.sources.noProject');
  return title === undefined ? `#${source.number}` : `#${source.number} ${title}`;
}

// The filter part (#514): none, one rule read out, or a count of several.
function filterPart(source: SourceDraft): string {
  if (source.filter.length === 0) return t('settings.sources.noFilter');
  return source.filter.length === 1 ? t('settings.sources.filter', { rule: ruleText(source.filter[0]) }) : t('settings.sources.filters', { n: source.filter.length });
}

// One part per task property (#688), in registry order: fixed reads its default, dynamic counts the rules that set it.
function propPart({ taskProps }: SourceDraft, prop: TaskProp): string {
  const name = t(PROP_LABEL[prop]);
  const mode = propMode(taskProps, prop);
  if (mode !== 'fixed') return t(mode === 1 ? 'settings.sources.prop.one' : 'settings.sources.prop.other', { prop: name, n: mode });
  const { workspace, auto } = taskProps.defaults;
  const value = prop === 'auto' ? t(auto ? 'settings.taskProps.yes' : 'settings.taskProps.no') : workspace || '—';
  return t('settings.sources.prop.fixed', { prop: name, value });
}

/** A sources row's one-line summary (#514, #688): project · filter · one part per task property, joined by " · ". `title` is the loaded
 * project's, when it has joined the row yet. */
export const sourceSummary = (source: SourceDraft, title?: string): string =>
  [projectPart(source, title), filterPart(source), ...TASK_PROPS.map((prop) => propPart(source, prop))].join(' · ');
