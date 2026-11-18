import { STATUS } from '../field-values.js';
import type { SourceField, StoredSourceItem } from '../read-model/source-items.js';
import type { ProjectField, ProjectView } from '../types.js';

// The stored kinds are exactly the ones the view's cells already draw (#827); a kind the mapping never stores reads as other
const TYPES: Readonly<Record<string, ProjectField['type']>> = { text: 'text', number: 'number', date: 'date', option: 'singleSelect', iteration: 'iteration' };
const CHOICES: ReadonlySet<ProjectField['type']> = new Set(['singleSelect', 'iteration']);

const typeOf = (kind: string | null): ProjectField['type'] => (kind !== null && Object.hasOwn(TYPES, kind) ? TYPES[kind] : 'other');
// The table's own comparison (ProjectTable's compare): case-insensitive, digits by value, so Sprint 9 comes before Sprint 10
const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The Status options in the stored order, Jira's answer to GET /project/{key}/statuses; withStages adds each one's stage. */
export function viewStatuses(fields: readonly SourceField[]): ProjectView['statuses'] {
  return (fields.find((f) => f.name === STATUS)?.options ?? []).map((name) => ({ name }));
}

/** Every stored field but Status, in the stored order. Jira gives no options, so a choice field's are the distinct values its issues carry,
 * one per stored value: a multi-valued field counts each. A field no issue has a value for has none. */
export function viewFields(fields: readonly SourceField[], stored: readonly Pick<StoredSourceItem, 'values'>[]): ProjectField[] {
  return fields.filter((f) => f.name !== STATUS).map((f): ProjectField => {
    const type = typeOf(f.kind);
    if (!CHOICES.has(type)) return { name: f.name, type };
    const options = [...new Set(stored.flatMap((s) => s.values.filter((v) => v.field === f.name).map((v) => v.value)))].sort(byText);
    return options.length === 0 ? { name: f.name, type } : { name: f.name, type, options };
  });
}
