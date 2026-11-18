import { MAX_TEXT, STATUS } from '../field-values.js';
import { WireError } from '../read-model/normalize.js';
import type { SourceField, SourceItem, SourceItemValue } from '../read-model/source-items.js';
import { type AdfNode, adfToMarkdown } from './adf.js';
import { type JiraFieldDef, type JiraIssue, type JiraSchema, type JiraStatus, utcIso } from './jira-queries.js';

/** One issue link as data.links keeps it (6.3 and 6.4 read it). linkId (#828): the link's own id, what DELETE /issueLink takes; id is the other
 * issue's. A type alias, not an interface, so it is assignable to the store's JsonValue. */
export type JiraLink = {
  type: string;
  direction: 'inward' | 'outward';
  phrase: string;
  linkId: string;
  id: string;
  key: string;
  title: string | null;
  statusCategory: string | null;
};
export interface JiraItemRows { item: SourceItem; values: SourceItemValue[] }

type Json = Record<string, unknown>;
// What data and the parent columns already hold: never a value row too, or one fact would live in two places that can disagree.
// issuetype is not here: the kind table maps it and the facets read it as a field (settled decision 1)
const OWN_FIELDS: ReadonlySet<string> = new Set(['summary', 'description', 'status', 'assignee', 'labels', 'issuelinks', 'parent', 'created', 'updated']);
const OPTION_TYPES: ReadonlySet<string> = new Set(['option', 'priority', 'issuetype', 'resolution', 'component', 'version']);

// Lenient readers: a field value of the wrong shape gives no row, never a refusal (the spec's unknown-kind criterion)
const recordOf = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
// exported for the blocker search (#828), which reads a found issue's category as the mapping does
export const statusCategoryOf = (fields: Json | undefined): string | null => textOf(recordOf(recordOf(fields?.status)?.statusCategory)?.key) ?? null;

/** Jira Software's sprint field and Jira's multi-line text field (#826), told apart from any other json or string field by their custom type. */
export const SPRINT_FIELD = 'com.pyxis.greenhopper.jira:gh-sprint';
export const TEXTAREA_FIELD = 'com.atlassian.jira.plugin.system.customfieldtypes:textarea';

/** The issue's sprint as one name (#826): the one not closed, else its last; the stored value and the panel's both read it. */
export function sprintName(value: unknown): string | undefined {
  const sprints = (Array.isArray(value) ? value : []).map(recordOf).filter((s): s is Json => s !== undefined && textOf(s.name) !== undefined);
  const open = sprints.find((s) => s.state !== 'closed');
  return textOf((open ?? sprints.at(-1))?.name);
}

// An array's kind is its elements'
const elementType = (schema: JiraSchema): string => (schema.type === 'array' ? (schema.items ?? '') : schema.type);

function kindOf(schema: JiraSchema | null | undefined): SourceItemValue['kind'] | undefined {
  if (schema === null || schema === undefined) return undefined;
  if (schema.custom === SPRINT_FIELD) return 'option';
  if (schema.custom === TEXTAREA_FIELD) return 'text';
  const type = elementType(schema);
  if (type === 'string' || type === 'user') return 'text';
  if (type === 'number') return 'number';
  if (type === 'date' || type === 'datetime') return 'date';
  return OPTION_TYPES.has(type) ? 'option' : undefined;
}

function scalarOf(type: string, value: unknown): string | undefined {
  if (type === 'string') return textOf(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
  if (type === 'date' || type === 'datetime') return utcIso(value);
  if (type === 'user') return textOf(recordOf(value)?.displayName);
  const option = recordOf(value);
  return textOf(option?.value) ?? textOf(option?.name);
}

// A field's scalars in Jira's order: a sprint is one name, a textarea its Markdown cut to the facet's cap, anything else one per element
function scalarsOf(s: JiraSchema, value: unknown): string[] {
  if (s.custom === SPRINT_FIELD) return [sprintName(value)].filter((v): v is string => v !== undefined);
  if (s.custom === TEXTAREA_FIELD) {
    // the codec checks every node before reading it (adf.ts), so the unchecked wire value is safe to hand it
    const markdown = typeof value === 'string' ? value : adfToMarkdown(value as AdfNode | null | undefined);
    return markdown === '' ? [] : [markdown.slice(0, MAX_TEXT)];
  }
  const elements = s.type === 'array' ? (Array.isArray(value) ? value : []) : [value];
  return elements.flatMap((e) => [scalarOf(elementType(s), e)].filter((v): v is string => v !== undefined));
}

// One row per element, in Jira's order: the store keeps a multi-valued field's order by position
function valuesOf(fields: Json, names: Record<string, string>, schema: Record<string, JiraSchema>): SourceItemValue[] {
  return Object.entries(fields).flatMap(([id, value]): SourceItemValue[] => {
    // own keys only: an id such as `constructor` must not find an inherited member of the plain objects the wire built
    const s = Object.hasOwn(schema, id) ? schema[id] : undefined;
    const kind = kindOf(s);
    if (OWN_FIELDS.has(id) || s === undefined || kind === undefined) return [];
    const named = Object.hasOwn(names, id) ? names[id] : undefined;
    const field = typeof named === 'string' ? named : id;
    return scalarsOf(s, value).map((scalar): SourceItemValue => ({ field, kind, value: scalar }));
  });
}

function linkOf(entry: unknown): JiraLink[] {
  const link = recordOf(entry);
  const type = recordOf(link?.type);
  const outward = recordOf(link?.outwardIssue);
  const other = outward ?? recordOf(link?.inwardIssue);
  const direction = outward === undefined ? 'inward' : 'outward';
  const [name, linkId, id, key] = [textOf(type?.name), textOf(link?.id), textOf(other?.id), textOf(other?.key)];
  if (name === undefined || linkId === undefined || id === undefined || key === undefined) return [];
  const fields = recordOf(other?.fields);
  return [{ type: name, direction, phrase: textOf(type?.[direction]) ?? name, linkId, id, key, title: textOf(fields?.summary) ?? null, statusCategory: statusCategoryOf(fields) }];
}

export const linksOf = (issue: JiraIssue): JiraLink[] => (Array.isArray(issue.fields.issuelinks) ? issue.fields.issuelinks.flatMap(linkOf) : []);

function dataOf(issue: JiraIssue): SourceItem['data'] {
  const { fields } = issue;
  const status = recordOf(fields.status);
  const type = recordOf(fields.issuetype);
  const assignee = textOf(recordOf(fields.assignee)?.displayName);
  return {
    title: textOf(fields.summary) ?? '',
    // the codec checks every node before reading it (adf.ts), so the unchecked wire value is safe to hand it
    body: adfToMarkdown(fields.description as AdfNode | null | undefined),
    status: textOf(status?.name) ?? null,
    statusCategory: statusCategoryOf(fields),
    issueType: textOf(type?.name) ?? null,
    hierarchyLevel: typeof type?.hierarchyLevel === 'number' ? type.hierarchyLevel : null,
    assignees: assignee === undefined ? [] : [assignee],
    labels: Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === 'string') : [],
    links: linksOf(issue),
    createdAt: utcIso(fields.created) ?? null,
  };
}

// A consistent comparator: a multi-valued field has several rows of one field, and the sort is stable for them
const byField = (a: SourceItemValue, b: SourceItemValue): number => Number(a.field > b.field) - Number(a.field < b.field);

/** One issue as its rows. Without an id, a key or updated it throws: the caller maps before its transaction, so a half-stored round never happens. */
export function jiraItemOf(source: string, project: string, issue: JiraIssue, names: Record<string, string>, schema: Record<string, JiraSchema>): JiraItemRows {
  const id = textOf(issue.id);
  const key = textOf(issue.key);
  const updatedAt = utcIso(issue.fields.updated); // UTC: the replace rule compares updated_at as text
  if (id === undefined) throw new WireError('jira issue id');
  if (key === undefined) throw new WireError('jira issue key');
  if (updatedAt === undefined) throw new WireError('jira issue updated');
  const values = valuesOf(issue.fields, names, schema);
  const parent = recordOf(issue.fields.parent);
  return {
    item: {
      source,
      nodeId: id,
      scope: project,
      key,
      updatedAt,
      valuesSig: JSON.stringify([...values].sort(byField)),
      parentId: textOf(parent?.id) ?? null,
      parentKey: textOf(parent?.key) ?? null,
      parentTitle: textOf(recordOf(parent?.fields)?.summary) ?? null,
      contentId: null,
      data: dataOf(issue),
    },
    values,
  };
}

/** The kind the sync stores a field's values under, or undefined when it stores none: an own field, a field with no schema or an
 * unknown kind (#821). fieldRowsOf and the Settings filter options both read it, so the two name one set of fields. */
export function storedKindOf(field: JiraFieldDef): SourceItemValue['kind'] | undefined {
  return OWN_FIELDS.has(field.id) ? undefined : kindOf(field.schema);
}

/** The rows setFields stores: Status first with the workflow's statuses, then each field the mapping can give a value, by its kind. */
export function fieldRowsOf(fields: readonly JiraFieldDef[], statuses: readonly JiraStatus[]): SourceField[] {
  const known = fields.flatMap((f): SourceField[] => {
    const kind = storedKindOf(f);
    return kind === undefined ? [] : [{ name: f.name, kind, options: null }];
  });
  return [{ name: STATUS, kind: 'option', options: statuses.map((s) => s.name) }, ...known];
}
