// The blocker refs each source type reads (#810): one table the server, namespaced, the MCP texts and the add row share. Pure, no node import,
// so the UI imports it as it imports tasks.ts. A new source type adds its entry here and its grammar beside its adapter
import { githubRefs } from './sources/github-refs.js';
import type { SourceConfig } from './types.js';

/** A source type's ref forms (#810 decision 3). refOf: the trimmed text in the form the route takes, undefined when the type does not read
 * it. isShort: the id is in the item's own scope, so it takes the shown prefix under qualifyId. forms: the forms as copy lists them. */
export interface RefGrammar { refOf(text: string): string | undefined; isShort(id: string): boolean; forms: string }

/** A task id (`HIVE-3`, a qualified `foo-12`), read by every source on top of its grammar and the only form a hive task reads (#56, #810). */
export const TASK_ID = /^[A-Za-z][\w.]*-\d+$/;

export const REF_GRAMMARS: Readonly<Record<SourceConfig['type'], RefGrammar>> = { github: githubRefs };

/** The ref `text` names: by the type's grammar, else as a task id; undefined when it is neither. No grammar: a hive task. */
export function readsRef(grammar: RefGrammar | undefined, text: string): string | undefined {
  const trimmed = text.trim();
  return grammar?.refOf(trimmed) ?? (TASK_ID.test(trimmed) ? trimmed : undefined);
}
