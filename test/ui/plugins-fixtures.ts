import { vi } from 'vitest';
import type { CatalogueItem, ItemRead, ItemVersion, LintInputRead } from '../../src/types';
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
export const SECOND_ORIGIN: BasedOn = { name: 'ecc:planner', repo: 'affaan-m/ECC', ref: 'v2.2.1', license: 'MIT', url: 'https://example.com/ecc' };
export const WORKSPACES = ['agent-hive', 'hive-site'];
export const CATALOGUE: CatalogueItem[] = [
  itemOf('hive:new-spec', { description: 'writes the task spec', usage: [{ kind: 'stage', stage: 'spec' }] }),
  itemOf('hive:new-build', { description: 'builds the plan', state: 'customized', versions: [versionOf('mine'), versionOf('tdd')], basedOn: [BASED_ON], usage: [{ kind: 'stage', stage: 'build' }, { kind: 'caller', id: 'hive:new-spec' }] }),
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
export interface NewVersionBody { name: string; from: string }
export interface DismissedBody { version: string | null; keys: string[] }
export interface AssignBody { workspace: string; version: string | null }
/** The editor's server (#319, #320): `reads` keyed `id@version` ('' for the original); a test may swap `catalogue` from its hooks. #327: the lint
 * input (empty when absent) and the dismissals, keyed as `reads`, which a PUT writes unless `putDismissed` answers it. */
export interface ItemsServer {
  catalogue: CatalogueItem[];
  reads: Record<string, ItemRead>;
  save?(id: string, body: SaveBody): Response;
  revert?(id: string, version: string): Response;
  createVersion?(id: string, body: NewVersionBody): Response; // POST …/versions
  rename?(id: string, version: string, body: { name: string }): Response; // PATCH …/versions/:version
  assign?(id: string, body: AssignBody): Response; // POST …/assign
  lintInput?: LintInputRead;
  dismissed?: Record<string, string[]>;
  putDismissed?(id: string, body: DismissedBody): Response;
}

function answerDismissed(server: ItemsServer, id: string, url: URL, init?: RequestInit): Response {
  if (init?.method !== 'PUT') return json(server.dismissed?.[`${id}@${url.searchParams.get('version') ?? ''}`] ?? []);
  const body = JSON.parse(String(init.body)) as DismissedBody;
  if (server.putDismissed) return server.putDismissed(id, body);
  server.dismissed = { ...server.dismissed, [`${id}@${body.version ?? ''}`]: body.keys };
  return json(body.keys);
}

/** The catalogue once a write made `name` (#320): the item lists it, customized, as GET /api/items answers after the store wrote it. */
export const withVersion = (catalogue: CatalogueItem[], id: string, name: string): CatalogueItem[] =>
  catalogue.map((i) => (i.id !== id || i.versions.some((v) => v.name === name) ? i : { ...i, state: 'customized', versions: [...i.versions, versionOf(name)] }));

const notServed = (what: string): Response => json({ error: `no ${what}` }, 500);

// One write of the editor: the body parsed, the test's answer, a 500 when the test gave none
function writeOf(server: ItemsServer, id: string, sub: string | undefined, version: string, init: RequestInit): Response {
  const body: unknown = JSON.parse(String(init.body ?? 'null'));
  if (init.method === 'PUT') return server.save?.(id, body as SaveBody) ?? notServed('save');
  if (init.method === 'DELETE') return server.revert?.(id, version) ?? notServed('revert');
  if (init.method === 'PATCH') return server.rename?.(id, version, body as { name: string }) ?? notServed('rename');
  if (sub === 'assign') return server.assign?.(id, body as AssignBody) ?? notServed('assign');
  return server.createVersion?.(id, body as NewVersionBody) ?? notServed('create');
}

/** fetch for the editor: GET /api/items, GET /api/items/:id[?version=], the writes of #319 and #320, GET /api/lint-input and GET / PUT …/dismissed (#327). */
export function stubItems(server: ItemsServer) {
  const mock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, 'http://hive');
    if (url.pathname === '/api/lint-input') return json(server.lintInput ?? { catalogue: [], scripts: [] });
    const [, , , rawId, sub, version] = url.pathname.split('/'); // '', 'api', 'items', id, 'files' | 'versions' | 'assign' | 'dismissed', version
    if (rawId === undefined) return json(server.catalogue);
    const id = decodeURIComponent(rawId);
    if (sub === 'dismissed') return answerDismissed(server, id, url, init);
    if (init?.method !== undefined && init.method !== 'GET') return writeOf(server, id, sub, decodeURIComponent(version ?? ''), init);
    const read = server.reads[`${id}@${url.searchParams.get('version') ?? ''}`];
    return read === undefined ? json({ error: `no item ${id}` }, 404) : json(read);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** The variables pane's template (#321). Lines: delivery 4 (from hive), e2eCommand 5 (required, no value for agent-hive, an entry of a
 * workspace no longer configured), reviewDepth 6 (unused), testCommand 7 (from hive, default null), the description 8 (a main file is saved only with name and description), the fence 9; the body uses e2eCommand
 * and testCommand on line 11, delivery on 12. */
export const VARS_TEXT = [
  '---',
  'name: new-build',
  'variables:',
  '  delivery: { values: [stacked, single], default: single, workspaces: { hive-site: stacked } }',
  '  e2eCommand: { required: true, workspaces: { hive-site: pnpm e2e, old-site: x } }',
  '  reviewDepth: { default: full }',
  '  testCommand: { default: null }',
  'description: builds a slice',
  '---',
  '',
  'Run {{ e2eCommand }}, then {{ testCommand }}.',
  '{% if delivery == "stacked" %}',
  'One PR per slice.',
  '{% endif %}',
  '',
].join('\n');
/** new-build's original for the pane: it declares delivery and testCommand, so the others are "yours". */
export const VARS_ORIGINAL = '---\nname: new-build\nvariables:\n  delivery: { values: [stacked, single], default: single }\n  testCommand: { default: null }\n---\n{{ testCommand }} {{ delivery }}\n';
