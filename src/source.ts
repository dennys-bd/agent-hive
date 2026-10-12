import { isDeepStrictEqual } from 'node:util';
import { gqlFor, loggedGql } from './sources/github-gql.js';
import { createGithubSource } from './sources/github.js';
import { RelationRereadError } from './sources/github-blockers.js';
import { citedColumns } from './tasks.js';
import { parseAuth } from './config.js';
import type { Logger } from './log.js';
import type { Source, SourceConfig, SourceSpec, Config, FieldValue, FieldWrite, Gql, Item, ItemBlockers, BlockerRef, ProjectView } from './types.js';

export interface SourceDeps {
  gql?: Gql; // GraphQL runner, injectable for tests; the default is the transport `auth.github` names
  log?: Logger; // every GraphQL call is logged at debug
}

/** What the server hands createSource for one entry (#180): that source (its epics keys included, #30) next to the Comb's stages and the transport. */
export const sourceSpec = ({ auth, comb }: Config, source: SourceConfig): SourceSpec => ({ auth, source, stages: comb.stages, transitions: comb.transitions });

/** One adapter for one source (#180): it reads only its own source's entries of the stages' and transitions' maps. */
export function createSource(spec: SourceSpec, deps: SourceDeps): Source {
  const { auth, source, stages, transitions } = spec;
  const cited = citedColumns(stages, transitions, source.name);
  switch (source.type) {
    case 'github': {
      // The log wraps whichever runner is in play, the configured transport or an injected one, so a test sees the same debug lines.
      // parseConfig requires auth next to a github source; a hand-built spec without it fails with that same message.
      const gql = deps.gql ?? gqlFor((auth ?? parseAuth(undefined)).github);
      return createGithubSource(source, cited, deps.log ? loggedGql(gql, deps.log) : gql, deps.log);
    }
  }
}

const SHORT_REF = /^\d+$/; // #56: a blocker in the item's own repository; `owner/repo#n` names another

/** #56: a source's blocker ids as its tasks' own ids read. Under qualifyId a short ref takes the shown prefix on the way out (`12` -> `foo-12`)
 * and drops it on the way in; `owner/repo#n` passes both ways as it is. */
interface BlockerIds { shownRef(r: BlockerRef): BlockerRef; shownBlockers(b: ItemBlockers): ItemBlockers; ownRef(ref: string): string }
function blockerIds(qualifyId: boolean, shown: string): BlockerIds {
  const shownRef = (r: BlockerRef): BlockerRef => (qualifyId && SHORT_REF.test(r.id) ? { ...r, id: `${shown}-${r.id}` } : r);
  const ownRef = (ref: string): string => {
    const rest = ref.slice(shown.length + 1);
    return qualifyId && ref.startsWith(`${shown}-`) && SHORT_REF.test(rest) ? rest : ref;
  };
  return { shownRef, shownBlockers: (b) => ({ blockedBy: b.blockedBy.map(shownRef), blocking: b.blocking.map(shownRef) }), ownRef };
}

// #56: relate under the listed ids, in and out; a write whose re-read failed still carries its relations under them
function shownRelate(relate: NonNullable<Source['relate']>, own: (itemId: string) => string, ids: BlockerIds, item: (t: Item) => Item): NonNullable<Source['relate']> {
  return async (itemId, change) => {
    try {
      const written = await relate(own(itemId), { ...change, ref: ids.ownRef(change.ref) });
      return { blockers: ids.shownBlockers(written.blockers), ...(written.entry ? { entry: { ...written.entry, item: item(written.entry.item) } } : {}) };
    } catch (err) {
      throw err instanceof RelationRereadError ? new RelationRereadError(err.message, err.blockers && ids.shownBlockers(err.blockers)) : err;
    }
  };
}

/** One adapter behind its entry's name (#180): what it lists is namespaced (`<name>:<id>`, `source` set, the id qualified under qualifyId with
 * the prefix, else the name) and what it is handed is stripped back to its own id. The adapter never sees the prefix. */
export function namespaced(entry: SourceConfig, adapter: Source): Source {
  const prefix = `${entry.name}:`;
  const own = (itemId: string): string => (itemId.startsWith(prefix) ? itemId.slice(prefix.length) : itemId);
  const shown = entry.prefix ?? entry.name;
  const named = (id: string): string => `${prefix}${id}`;
  // #28: the tree links name items too, so they carry the same prefix as itemId; an absent key stays absent
  const tree = ({ parent, children, closedChildren }: Item): Partial<Item> => ({
    ...(parent === undefined ? {} : { parent: named(parent) }),
    ...(children === undefined ? {} : { children: children.map(named) }),
    ...(closedChildren === undefined ? {} : { closedChildren: closedChildren.map(named) }),
  });
  const ids = blockerIds(entry.qualifyId, shown);
  const item = (t: Item): Item => ({
    ...t, ...tree(t), ...(t.blockers ? { blockers: ids.shownBlockers(t.blockers) } : {}),
    itemId: named(t.itemId), source: entry.name, ...(entry.qualifyId ? { id: `${shown}-${t.id}` } : {}),
  });
  const { comments, project, fieldsOf, setField, create, relate, findBlockers } = adapter;
  // #756: the native view's rows under the same namespaced ids the listed tasks carry, so a row finds its task; the id stays the issue number
  const rows = (view: ProjectView): ProjectView => ({ ...view, items: view.items.map((i) => ({ ...i, itemId: `${prefix}${i.itemId}` })) });
  // #686: a write's answer under the ids the listed tasks carry: the row as the native view's, the entry as listItems' own
  const written = (w: FieldWrite): FieldWrite => ({
    ...w, row: { ...w.row, itemId: `${prefix}${w.row.itemId}` }, ...(w.entry ? { entry: { ...w.entry, item: item(w.entry.item) } } : {}),
  });
  return {
    ...adapter,
    listItems: async () => (await adapter.listItems()).map((c) => ({ ...c, item: item(c.item) })),
    setColumn: (itemId, column) => adapter.setColumn(own(itemId), column),
    apply: (itemId, action) => adapter.apply(own(itemId), action),
    ...(create ? { create: async (fields: Parameters<NonNullable<Source['create']>>[0]) => `${prefix}${await create(fields)}` } : {}),
    ...(comments ? { comments: (itemId: string) => comments(own(itemId)) } : {}),
    ...(project ? { project: async () => rows(await project()) } : {}),
    ...(fieldsOf ? { fieldsOf: (itemId: string) => fieldsOf(own(itemId)) } : {}),
    ...(setField ? { setField: async (itemId: string, field: string, value: FieldValue) => written(await setField(own(itemId), field, value)) } : {}),
    ...(relate ? { relate: shownRelate(relate, own, ids, item) } : {}),
    // #57: the search under the listed ids, so a found issue reads as the section's rows and tasks do
    ...(findBlockers ? { findBlockers: async (itemId: string, text: string) => (await findBlockers(own(itemId), text)).map(ids.shownRef) } : {}),
  };
}

// What an adapter bakes in at creation, per entry: the entry (its epics keys included, #30), its cited columns and the transport. A change of
// any needs a new instance.
const bakedIn = (config: Config, name: string): unknown[] => [
  config.comb.sources.find((b) => b.name === name), citedColumns(config.comb.stages, config.comb.transitions, name), config.auth,
];

/** One namespaced source per comb.sources entry, in order, keyed by name (#180). With `reuse` (the live config and sources) an entry whose
 * baked-in parts did not change keeps its live instance, so a write already in flight keeps its chain. */
export function createSources(config: Config, build: (spec: SourceSpec) => Source, reuse?: { config: Config; sources: ReadonlyMap<string, Source> }): Map<string, Source> {
  return new Map(config.comb.sources.map((entry): [string, Source] => {
    const kept = reuse?.sources.get(entry.name);
    const same = reuse !== undefined && kept !== undefined && isDeepStrictEqual(bakedIn(reuse.config, entry.name), bakedIn(config, entry.name));
    return [entry.name, same && kept ? kept : namespaced(entry, build(sourceSpec(config, entry)))];
  }));
}

/** resolveFields on every source, in order; the first failure rejects naming its source (#180): what boot and a save refuse with. */
export async function resolveSources(sources: ReadonlyMap<string, Source>): Promise<void> {
  for (const [name, source] of sources) {
    await source.resolveFields().catch((err: unknown) => {
      throw new Error(`source ${name}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
