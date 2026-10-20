import { vi } from 'vitest';
import { BLOCKS } from '../../src/protocol';
import type { ProtocolPassageView, ProtocolRead } from '@/hooks/use-protocol';
import { CATALOGUE, json } from './plugins-fixtures';

/** GET /api/protocol as #336 answers it with no tool turned off and no passage. */
export const PROTOCOL_READ: ProtocolRead = {
  blocks: BLOCKS.map(({ id, stage, session, tool }) => ({ id, stage, session, off: false, ...(tool === undefined ? {} : { tool }) })),
  passages: [],
};

/** A saved passage as the route answers it: header `after:` only, then `body`. */
export const passageOf = (id: string, after: string, body: string, extra: Partial<ProtocolPassageView> = {}): ProtocolPassageView =>
  ({ id, after, text: `---\nafter: ${after}\n---\n${body}`, orphan: false, errors: {}, ...extra });
export const withPassages = (...passages: ProtocolPassageView[]): ProtocolRead => ({ ...PROTOCOL_READ, passages });

export interface ProtocolCall { method: string; path: string; body?: unknown }
interface ProtocolServer {
  read?(): ProtocolRead | Response;
  write?(call: ProtocolCall): Response;
  render?(workspace: string): Response;
}

/** fetch for the protocol screen: GET /api/protocol answers `read()`, GET /api/protocol/render `render(workspace)`, GET /api/items the
 * catalogue, any other GET ok; every write is logged in `calls` before its answer and answered by `write` (201 with p1 by default). */
export function stubProtocol({
  read = () => PROTOCOL_READ,
  write = () => json({ id: 'p1' }, 201),
  render = (workspace: string) => json({ stage: `stage of ${workspace}\n`, session: `session of ${workspace}\n` }),
}: ProtocolServer = {}) {
  const calls: ProtocolCall[] = [];
  const mock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const url = new URL(path, 'http://hive');
    if (method === 'GET' && url.pathname === '/api/protocol') {
      const answer = read();
      return answer instanceof Response ? answer : json(answer);
    }
    if (method === 'GET' && url.pathname === '/api/protocol/render') return render(url.searchParams.get('workspace') ?? '');
    if (method === 'GET') return json(url.pathname === '/api/items' ? CATALOGUE : { ok: true });
    const call: ProtocolCall = init?.body === undefined ? { method, path } : { method, path, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return write(call);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}
