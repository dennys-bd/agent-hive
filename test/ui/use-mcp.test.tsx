import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ExternalMcpServer } from '../../src/types';
import { type Mcp, useMcp } from '@/hooks/use-mcp';
import { MCP_READ, stubMcp, withServer } from './mcp-fixtures';
import { json } from './plugins-fixtures';

afterEach(() => vi.unstubAllGlobals());
const NEW_SERVER: ExternalMcpServer = { name: 'docs', url: 'https://docs.example.com/mcp', authHeader: 'X-Api-Key', workspace: null, on: true };
const toolOn = (mcp: Mcp, name: string): boolean | undefined => mcp.read?.tools.find((tool) => tool.name === name)?.on;

test('the first read lands the tools and the servers; a failed read sets hasFailed and leaves read undefined (#334)', async () => {
  stubMcp();
  const ok = renderHook(() => useMcp());
  expect(ok.result.current.read).toBeUndefined();
  await waitFor(() => expect(ok.result.current.read).toEqual(MCP_READ));
  expect(ok.result.current.hasFailed).toBe(false);
  ok.unmount();
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));
  const failed = renderHook(() => useMcp());
  await waitFor(() => expect(failed.result.current.hasFailed).toBe(true));
  expect(failed.result.current.read).toBeUndefined();
});

test('a read that answers after a newer one is dropped: the newer answer stays (#334)', async () => {
  const answers: Array<(r: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) =>
    (init?.method === undefined ? new Promise<Response>((resolve) => answers.push(resolve)) : Promise.resolve(json({ ok: true })))));
  const { result } = renderHook(() => useMcp());
  await waitFor(() => expect(answers).toHaveLength(1));
  act(() => { void result.current.removeServer('figma'); });
  await waitFor(() => expect(answers).toHaveLength(2));
  const newer = withServer('figma', { on: false, state: 'off' });
  await act(async () => answers[1]?.(json(newer)));
  await act(async () => answers[0]?.(json(MCP_READ)));
  expect(result.current.read).toEqual(newer);
});

test("a tool switch shows at once and sends PUT with on; a 400 puts it back with the refusal's copy (#334)", async () => {
  let answer: (r: Response) => void = () => undefined;
  const { calls } = stubMcp(undefined, () => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result } = renderHook(() => useMcp());
  await waitFor(() => expect(result.current.read).toBeDefined());
  let done: Promise<void> = Promise.resolve();
  act(() => { done = result.current.setTool('hive_applied', false); });
  expect(toolOn(result.current, 'hive_applied')).toBe(false);
  expect(calls).toEqual([{ method: 'PUT', path: '/api/mcp/tools/hive_applied', body: { on: false } }]);
  await act(async () => {
    answer(json({ error: 'the route words' }, 400));
    await done;
  });
  expect(toolOn(result.current, 'hive_applied')).toBe(true);
  expect(result.current.error).toBe('plugins.mcp.refused');
});

test("a server's switch sends PUT with the bare definition and shows checking until the re-read answers its state (#334)", async () => {
  let read = withServer('playwright', { on: false, state: 'off' });
  let answer: (r: Response) => void = () => undefined;
  const { calls } = stubMcp(() => read, () => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result } = renderHook(() => useMcp());
  await waitFor(() => expect(result.current.read).toBeDefined());
  const row = result.current.read!.servers[0]!;
  let done: Promise<void> = Promise.resolve();
  act(() => { done = result.current.setServer('playwright', { ...row, on: true }); });
  expect(result.current.read?.servers[0]?.state).toBe('checking');
  expect(calls).toEqual([{ method: 'PUT', path: '/api/mcp/servers/playwright', body: { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'], workspace: null, on: true } }]);
  read = MCP_READ;
  await act(async () => {
    answer(json({ ok: true }));
    await done;
  });
  expect(result.current.read?.servers[0]?.state).toBe('connected');
});

test('saveServer posts a new server, then its value; an edit PUTs; a refused value answers valueNotSaved; null deletes it; each save reads again (#334)', async () => {
  const { calls, mock } = stubMcp(undefined, (call) =>
    (call.method === 'PUT' && (call.body as { value?: string } | undefined)?.value === 'refused-value' ? json({ error: 'the route words' }, 400) : json({ ok: true })));
  const { result } = renderHook(() => useMcp());
  await waitFor(() => expect(result.current.read).toBeDefined());
  let answer: unknown = 'unset';
  await act(async () => { answer = await result.current.saveServer(undefined, { server: NEW_SERVER, value: 'header-value' }); });
  expect(answer).toBeUndefined();
  expect(calls).toEqual([
    { method: 'POST', path: '/api/mcp/servers', body: NEW_SERVER },
    { method: 'PUT', path: '/api/mcp/servers/docs/value', body: { value: 'header-value' } },
  ]);
  await act(async () => { answer = await result.current.saveServer('docs', { server: NEW_SERVER, value: 'refused-value' }); });
  expect(answer).toBe('plugins.mcp.valueNotSaved');
  expect(result.current.error).toBe('plugins.mcp.valueNotSaved');
  expect(calls.at(-2)).toEqual({ method: 'PUT', path: '/api/mcp/servers/docs', body: NEW_SERVER });
  await act(async () => { answer = await result.current.saveServer('docs', { server: NEW_SERVER, value: null }); });
  expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/mcp/servers/docs/value' });
  await act(async () => { await result.current.saveServer('docs', { server: NEW_SERVER }); });
  expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/api/mcp/servers/docs', body: NEW_SERVER }); // undefined: no value call
  expect(mock.mock.calls.filter(([path, init]) => path === '/api/mcp' && init === undefined)).toHaveLength(5); // mount + four saves
});

test("a refused write answers its status's copy, never the route's words; a refused definition sends no value (#334)", async () => {
  for (const [status, key] of [[400, 'plugins.mcp.refused'], [404, 'plugins.mcp.gone'], [500, 'plugins.mcp.failed']] as const) {
    const { calls } = stubMcp(undefined, () => json({ error: 'the route words' }, status));
    const { result, unmount } = renderHook(() => useMcp());
    await waitFor(() => expect(result.current.read).toBeDefined());
    let answer: unknown;
    await act(async () => { answer = await result.current.removeServer('figma'); });
    expect(answer).toBe(key);
    await act(async () => { answer = await result.current.saveServer(undefined, { server: NEW_SERVER, value: 'header-value' }); });
    expect(answer).toBe(key);
    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'POST']);
    unmount();
  }
});
