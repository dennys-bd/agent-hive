import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useJiraSourceOptions } from '@/hooks/use-jira-source-options';
import type { SourceDraft } from '@/lib/settings-form';
import { EMPTY_JIRA } from '@/lib/settings-jira';

const row = { id: 'r1', jira: { ...EMPTY_JIRA, site: 'acme.atlassian.net', project: 'ABC' } } as SourceDraft;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Gate { respond(res: Response): void }
const pending: Gate[] = [];
const fetchMock = vi.fn((): Promise<Response> => new Promise((resolve) => { pending.push({ respond: resolve }); }));

beforeEach(() => { pending.length = 0; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('a project read in flight when the site changes lands nothing (#822)', async () => {
  const { result } = renderHook(() => useJiraSourceOptions());
  let read: Promise<void> = Promise.resolve();
  act(() => { read = result.current.loadProject(row); });
  act(() => { void result.current.loadSite(row); });
  await act(async () => {
    pending[0].respond(json([{ id: '1', name: 'Task', subtask: false }]));
    pending[1].respond(json([{ name: 'Blocks', inward: 'a', outward: 'b' }]));
    await read;
  });
  expect(result.current.rows.r1.issueTypes).toEqual([]);
  expect(result.current.rows.r1.linkTypes).toEqual([]);
});

test('a project read failure of the old site is cleared when the site changes (#822)', async () => {
  const { result } = renderHook(() => useJiraSourceOptions());
  act(() => { result.current.fail('r1', 'project', new Error('boom')); });
  expect(result.current.rows.r1.errors.project).toBeDefined();
  act(() => { void result.current.loadSite(row); });
  expect(result.current.rows.r1.errors.project).toBeUndefined();
});

test('a project guard goes stale once a newer project read starts or the site changes (#822)', () => {
  const { result } = renderHook(() => useJiraSourceOptions());
  act(() => { void result.current.loadProject(row); });
  const first = result.current.projectGuard('r1');
  expect(first()).toBe(true);
  act(() => { void result.current.loadProject(row); });
  expect(first()).toBe(false);
  const second = result.current.projectGuard('r1');
  act(() => { void result.current.loadSite(row); });
  expect(second()).toBe(false);
});
