import { vi } from 'vitest';
import type { CatalogueItem, ItemVersion } from '../../src/types';
import type { BasedOn } from '../../src/template';

const version = (name: string): ItemVersion => ({ name, from: 'original', workspaces: [], unknownWorkspaces: [], updateAvailable: false });

/** A catalogue item as GET /api/items answers it, `origin:name` as its id: a skill, the hive original or a workspace's own unless `extra` says. */
export function itemOf(id: string, extra: Partial<CatalogueItem> = {}): CatalogueItem {
  const [origin = '', name = ''] = id.split(':');
  return { id, origin, kind: 'skill', name, description: '', userCreated: false, state: origin === 'hive' ? 'original' : 'workspace', versions: [], onOriginal: [], files: [], usage: [], ...extra };
}

export const BASED_ON: BasedOn = { name: 'superpowers:executing-plans', repo: 'obra/superpowers', ref: 'v4.3.0', license: 'MIT', url: 'https://example.com/superpowers' };
export const WORKSPACES = ['agent-hive', 'hive-site'];
export const CATALOGUE: CatalogueItem[] = [
  itemOf('hive:new-spec', { description: 'writes the task spec', usage: [{ kind: 'stage', stage: 'spec' }] }),
  itemOf('hive:new-build', { description: 'builds the plan', state: 'customized', versions: [version('mine'), version('tdd')], basedOn: BASED_ON, usage: [{ kind: 'stage', stage: 'build' }, { kind: 'caller', id: 'hive:new-spec' }] }),
  itemOf('hive:new-plan', { description: 'slices the spec', state: 'update available', versions: [version('mine')] }),
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
