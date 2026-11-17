import { parseEpicKeys } from './config-epics.js';
import { BARE_HOST } from './sources/jira-fetch.js';
import { PROJECT_KEY } from './sources/jira-queries.js';
import { parseSourceTaskProps } from './task-props.js';
import type { FilterRule, JiraTree, SourceFields, TaskFilter } from './types.js';

// A Jira source's keys in hive.config.json (#820), out of config.ts, which is over 400 lines. The prefix is config.ts's CONFIG_FILE written
// out, and the filter parser comes by argument: config.ts calls this file, so importing it back would make the two import each other.
const FILE = 'hive.config.json';
// A source filter belongs to one type: a criterion an issue cannot hold would never match, so it is refused when the file is read
const NOT_JIRA_CRITERIA: readonly FilterRule['field'][] = ['milestone', 'repository'];

export type JiraSourceFields = Extract<SourceFields, { type: 'jira' }>;

const fail = (field: string, what: string): never => {
  throw new Error(`${FILE}: "${field}" ${what}`);
};
const matching = (value: unknown, rule: RegExp, field: string, what: string): string => (typeof value === 'string' && rule.test(value) ? value : fail(field, what));
const text = (value: unknown, field: string): string => (typeof value === 'string' && value.trim() !== '' ? value : fail(field, 'must be a non-empty string'));

function tree(value: unknown, field: string): JiraTree {
  const t = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return typeof t.epics === 'boolean' && typeof t.subtasks === 'boolean' ? { epics: t.epics, subtasks: t.subtasks } : fail(field, 'must be { "epics": true | false, "subtasks": true | false }');
}

function linkTypes(value: unknown, field: string): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '') ? [...(value as string[])] : fail(field, 'must be an array of non-empty strings');
}

function jiraFilter(filter: TaskFilter, field: string): TaskFilter {
  const i = filter.findIndex((rule) => NOT_JIRA_CRITERIA.includes(rule.field));
  return i === -1 ? filter : fail(`${field}[${i}].field`, `"${filter[i].field}" is not a criterion of a jira source`);
}

/** Every key required, none defaulted (#820), each refusal naming its key, in the member's order: the object literal evaluates left to right. */
export function parseJiraSource(raw: Record<string, unknown>, field: string, workspaces: readonly string[], parseFilter: (raw: unknown, field: string) => TaskFilter): JiraSourceFields {
  return {
    type: 'jira',
    site: matching(raw.site, BARE_HOST, `${field}.site`, 'must be a bare host, as acme.atlassian.net'),
    project: matching(raw.project, PROJECT_KEY, `${field}.project`, 'must be a Jira project key, as ABC'),
    filter: jiraFilter(parseFilter(raw.filter, `${field}.filter`), `${field}.filter`),
    taskProps: parseSourceTaskProps(raw.taskProps, `${field}.taskProps`, workspaces),
    ...parseEpicKeys(raw, field),
    tree: tree(raw.tree, `${field}.tree`),
    blockingLinkTypes: linkTypes(raw.blockingLinkTypes, `${field}.blockingLinkTypes`),
    issueType: text(raw.issueType, `${field}.issueType`),
    subtaskType: text(raw.subtaskType, `${field}.subtaskType`),
    doneStatus: text(raw.doneStatus, `${field}.doneStatus`),
  };
}
