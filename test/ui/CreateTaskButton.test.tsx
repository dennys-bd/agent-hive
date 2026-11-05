import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CreateTaskButton } from '@/components/CreateTaskButton';
import { setLanguage } from '@/i18n';
import { CreateTargetsContext, HIVE_ONLY } from '@/lib/create-targets';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const ITEM = { title: 'Fix login', body: 'steps', url: 'https://github.com/acme/app/issues/12', itemId: 'roadmap:PVTI_12', workspaceHint: 'site' };
let settle: (res: Response) => void = () => undefined;
const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { settle = resolve; }));
const created = (): Response => new Response(JSON.stringify({ id: 'HIVE-1', itemId: 'local:1' }), { status: 201, headers: { 'content-type': 'application/json' } });
const bodyOf = (call: number): unknown => JSON.parse(String(fetchMock.mock.calls[call][1]?.body));

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('+ tarefa posts /tasks in one click, outside the flow: no stage, source hive, auto off, the origin and a known workspace; disabled while it runs; no popover (#583)', async () => {
  const user = userEvent.setup();
  render(<CreateTaskButton item={ITEM} state={{ workspaces: ['site'] }} />);
  const button = screen.getByRole('button', { name: '+ tarefa' });
  expect(button).toHaveAttribute('title', 'vira tarefa do Hive, fora do fluxo');
  await user.click(button);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0][0]).toBe('/tasks');
  expect(bodyOf(0)).toEqual({ title: 'Fix login', body: 'steps', auto: false, url: ITEM.url, source: 'hive', origin: 'roadmap:PVTI_12', workspace: 'site' });
  expect(button).toBeDisabled();
  expect(screen.queryByRole('dialog')).toBeNull();
  settle(created());
  await waitFor(() => expect(button).toBeEnabled());
});

test('a workspace hint the Hive does not know and an issue with no source item send neither; English copy; with the hive source off there is no button (#583, #846)', async () => {
  const user = userEvent.setup();
  setLanguage('en');
  const { unmount } = render(<CreateTaskButton item={{ ...ITEM, itemId: undefined, workspaceHint: 'gone' }} state={{ workspaces: ['site'] }} />);
  const button = screen.getByRole('button', { name: '+ task' });
  expect(button).toHaveAttribute('title', 'becomes a Hive task, outside the flow');
  await user.click(button);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(bodyOf(0)).toEqual({ title: 'Fix login', body: 'steps', auto: false, url: ITEM.url, source: 'hive' });
  unmount();
  render(<CreateTargetsContext.Provider value={{ ...HIVE_ONLY, hiveSource: false }}><CreateTaskButton item={ITEM} state={{ workspaces: ['site'] }} /></CreateTargetsContext.Provider>);
  expect(screen.queryByRole('button', { name: '+ task' })).toBeNull();
});
