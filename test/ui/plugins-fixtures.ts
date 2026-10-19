import { vi } from 'vitest';
import type { CatalogueItem, ItemRead, ItemVersion } from '../../src/types';
import type { BasedOn } from '../../src/template';

const EDITED_AT = '2026-10-19T09:00:00.000Z';
/** A catalogue version as GET /api/items answers it (#320: with its editedAt). */
export const versionOf = (name: string, extra: Partial<ItemVersion> = {}): ItemVersion =>
  ({ name, from: 'original', workspaces: [], unknownWorkspaces: [], updateAvailable: false, editedAt: EDITED_AT, ...extra });

/** A catalogue item as GET /api/items answers it, `origin:name` as its id: a skill, the hive original or a workspace's own unless `extra` says. */
export function itemOf(id: string, extra: Partial<CatalogueItem> = {}): CatalogueItem {
  const [origin = '', name = ''] = id.split(':');
  return { id, origin, kind: 'skill', name, description: '', userCreated: false, state: origin === 'hive' ? 'original' : 'workspace', versions: [], onOriginal: [], files: [], usage: [], ...extra };
}

export const BASED_ON: BasedOn = { name: 'superpowers:executing-plans', repo: 'obra/superpowers', ref: 'v4.3.0', license: 'MIT', url: 'https://example.com/superpowers' };
export const WORKSPACES = ['agent-hive', 'hive-site'];
export const CATALOGUE: CatalogueItem[] = [
  itemOf('hive:new-spec', { description: 'writes the task spec', usage: [{ kind: 'stage', stage: 'spec' }] }),
  itemOf('hive:new-build', { description: 'builds the plan', state: 'customized', versions: [versionOf('mine'), versionOf('tdd')], basedOn: BASED_ON, usage: [{ kind: 'stage', stage: 'build' }, { kind: 'caller', id: 'hive:new-spec' }] }),
  itemOf('hive:new-plan', { description: 'slices the spec', state: 'update available', versions: [versionOf('mine')] }),
  itemOf('hive:architect', { kind: 'specialist', description: 'designs' }),
  itemOf('hive-site:deploy', { description: 'publishes the preview' }),
  itemOf('agent-hive:release', { description: 'release notes' }),
];

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** fetch answering GET /api/items with `catalogue()` and POST /api/items with `post`'s answer; any other path ok. */
export function stubFetch(post: (body: unknown) => Response = (body) => json(itemOf(`hive:${(body as { name: string }).name}`), 201), catalogue: () => CatalogueItem[] = () => CATALOGUE) {
  const mock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/items' && init?.method === 'POST') return post(JSON.parse(String(init.body)));
    return path === '/api/items' ? json(catalogue()) : json({ ok: true });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** new-build's template in the editor's tests (#319). Lines: header 1–6, `# new-build` 7, the introduction 9, `## Input` 11, a chain 14–18
 * (if 14, else 16, endif 18), `## Stops` 20. */
export const BUILD_TEXT = [
  '---',
  'name: new-build',
  'description: builds the plan',
  'variables:',
  '  delivery: { values: [stacked, single], default: single, workspaces: { hive-site: stacked } }',
  '---',
  '# new-build',
  '',
  'Intro, then /hive:new-pr.',
  '',
  '## Input',
  '',
  'Read the plan for {{ workspace }}.',
  '{% if delivery == "stacked" %}',
  'One PR per slice.',
  '{% else %}',
  'A single PR.',
  '{% endif %}',
  '',
  '## Stops',
  '',
  'Stop at the end.',
  '',
].join('\n');
/** new-spec's original: a plain SKILL.md with a header and no Liquid. */
export const SPEC_TEXT = '---\nname: new-spec\ndescription: writes the task spec\n---\n# new-spec\n\n## Input\n\nThe issue.\n';

/** A read as GET /api/items/:id answers it: the catalogue's item, the version, each file (with savedAt when given). */
export function readOf(id: string, version: string | null, files: Record<string, string>, savedAt?: string): ItemRead {
  const item = CATALOGUE.find((i) => i.id === id) ?? itemOf(id);
  return { item, version, files: Object.entries(files).map(([path, text]) => ({ path, text, ...(savedAt === undefined ? {} : { savedAt }) })) };
}

export interface SaveBody { version: string | null; path: string; text: string; from?: string }
/** The editor's server (#319): `reads` keyed `id@version` ('' for the original); a test may swap `catalogue` from its hooks. */
export interface ItemsServer {
  catalogue: CatalogueItem[];
  reads: Record<string, ItemRead>;
  save?(id: string, body: SaveBody): Response;
  revert?(id: string, version: string): Response;
}

/** fetch for the editor: GET /api/items, GET /api/items/:id[?version=], PUT …/files and DELETE …/versions/:version. */
export function stubItems(server: ItemsServer) {
  const mock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, 'http://hive');
    const [, , , rawId, , version] = url.pathname.split('/'); // '', 'api', 'items', id, 'files' | 'versions', version
    if (rawId === undefined) return json(server.catalogue);
    const id = decodeURIComponent(rawId);
    if (init?.method === 'PUT') return server.save?.(id, JSON.parse(String(init.body)) as SaveBody) ?? json({ error: 'no save' }, 500);
    if (init?.method === 'DELETE') return server.revert?.(id, decodeURIComponent(version ?? '')) ?? json({ error: 'no revert' }, 500);
    const read = server.reads[`${id}@${url.searchParams.get('version') ?? ''}`];
    return read === undefined ? json({ error: `no item ${id}` }, 404) : json(read);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
