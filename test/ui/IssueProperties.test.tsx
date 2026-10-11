import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IssueProperties } from '@/components/IssueProperties';
import { setLanguage } from '@/i18n';
import type { IssuePage, ItemField, ProjectItem, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const URL12 = 'https://github.com/acme/site/issues/12';
const ISSUE: IssuePage = {
  repository: 'acme/site', number: 12, title: 'Pager breaks', url: URL12, labels: ['bug'], assignees: ['ana'], updatedAt: '2026-10-05T09:00:00Z',
  body: 'b', author: 'bia', createdAt: '2026-10-01T09:00:00Z', pullRequests: [], comments: [], commentCount: 0,
};
const TASK: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: URL12, source: 'roadmap' }, stage: 'dev', boardColumn: 'In review', auto: true };
const STATE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], tasks: [TASK], sourceOrder: [], localCount: 0,
  stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }, { name: 'review', from: { roadmap: ['In review'] }, prompt: 'y' }],
  activities: [{ id: 'A1', kind: 'task', workspace: 'site', branch: 'hive/12-pager' }], activityRecords: [{ id: 'A1', taskIds: [TASK.item.itemId], sessions: [] }],
  usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['site'], sourceWorkspaces: { roadmap: 'site' }, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonRes({ ok: true }));
beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const panel = () => within(document.body); // #64: no column of its own; the details panel's slot frames it

const FIELDS_PATH = '/sources/roadmap/items/roadmap%3APVTI_12/fields';
const FIELDS: ItemField[] = [
  { name: 'Status', type: 'singleSelect', value: 'In review', options: ['Ready', 'In review', 'Done'] },
  { name: 'Assignees', type: 'assignees', value: ['ana'], options: ['ana', 'bia'] },
  { name: 'Labels', type: 'labels', value: ['bug'], options: ['bug', 'docs'] },
  { name: 'Priority', type: 'singleSelect', value: 'P2', options: ['P0', 'P1', 'P2'] },
  { name: 'Repository', type: 'repository', value: 'acme/site', readOnly: true },
];
// The item's fields on a read of its route; anything else answers `other`
const withFields = (other: () => Response) => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  (String(input) === FIELDS_PATH && init?.method !== 'POST' ? jsonRes({ fields: FIELDS }) : other());
const terms = (): (string | null)[] => [...document.body.querySelectorAll('dt')].map((d) => d.textContent);

test('a task of a source: its stage as a select that moves it, its labels, then the assignees and every field of its source in the project\'s order, the read-only ones as text; its source and workspace; no frame, no header and no activity block, which the details panel draws (#757, #686, #64)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(withFields(() => jsonRes({ ok: true })));
  render(<IssueProperties issue={ISSUE} task={TASK} state={STATE} workspace="site" meta="acme/site" onGoTo={vi.fn()} onChanged={async () => {}} />);
  expect(await panel().findByText('P2')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(FIELDS_PATH);
  expect(terms()).toEqual(['etapa', 'labels', 'responsável', 'Status', 'Priority', 'Repository', 'source', 'workspace']);
  expect(panel().getByRole('button', { name: 'etapa' })).toHaveTextContent('dev');
  expect(panel().getByRole('button', { name: 'editar Status' })).toHaveTextContent('In review');
  expect(panel().getByRole('button', { name: 'editar Assignees' })).toHaveTextContent('ana');
  expect(panel().getByText('acme/site').closest('[title]')).toHaveAttribute('title', 'somente leitura');
  expect(panel().queryByRole('button', { name: 'editar Repository' })).not.toBeInTheDocument();
  expect(panel().getByText('bug')).toBeInTheDocument();
  expect(panel().getByText('roadmap')).toBeInTheDocument();
  expect(panel().getByText('github project')).toBeInTheDocument();
  expect(panel().getByText('site')).toBeInTheDocument();
  expect(panel().queryByRole('region', { name: 'atividade' })).not.toBeInTheDocument();
  expect(panel().queryByText('hive/12-pager')).not.toBeInTheDocument(); // the branch is the panel's properties grid
  expect(panel().queryByRole('button', { name: 'abrir atividade' })).not.toBeInTheDocument(); // the panel's footer
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'propriedades' })).not.toBeInTheDocument();
  panel().getByRole('button', { name: 'etapa' }).focus(); // Radix's menu opens on a key under jsdom
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'review' }));
  expect(fetchMock).toHaveBeenCalledWith('/tasks/roadmap%3APVTI_12/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'review' }) }));
});

test('a field written from the sidebar shows the value the source answered (#686)', async () => {
  const user = userEvent.setup();
  const row: ProjectItem = { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: 'b', url: URL12, labels: ['bug'], assignees: ['ana'], fields: { Priority: 'P0' }, pullRequests: [] };
  const written = FIELDS.map((f) => (f.name === 'Priority' ? { ...f, value: 'P0' } : f));
  fetchMock.mockImplementation(withFields(() => jsonRes({ fields: written, row })));
  render(<IssueProperties issue={ISSUE} task={TASK} state={STATE} workspace="site" meta="acme/site" onGoTo={vi.fn()} onChanged={async () => {}} />);
  (await panel().findByRole('button', { name: 'editar Priority' })).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'P0' }));
  await waitFor(() => expect(panel().getByRole('button', { name: 'editar Priority' })).toHaveTextContent('P0'));
  expect(fetchMock).toHaveBeenCalledWith(FIELDS_PATH, expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'Priority', value: 'P0' }) }));
});

test('outside the flow: fluxo… in place of the stage, no source, no activity block; the fields of the native view row it was opened from (#757, #686)', async () => {
  const user = userEvent.setup();
  const onGoTo = vi.fn();
  fetchMock.mockImplementation(withFields(() => jsonRes({ id: 'HIVE-1', itemId: 'local:1' }, 201)));
  render(<IssueProperties issue={ISSUE} state={{ ...STATE, tasks: [] }} workspace="site" itemId="roadmap:PVTI_12" meta="roadmap" onGoTo={onGoTo} onChanged={async () => {}} />);
  expect(await panel().findByText('P2')).toBeInTheDocument();
  expect(panel().queryByRole('button', { name: 'etapa' })).not.toBeInTheDocument();
  expect(panel().queryByText('roadmap')).not.toBeInTheDocument();
  expect(panel().queryByRole('region', { name: 'atividade' })).not.toBeInTheDocument();
  await user.click(panel().getByRole('button', { name: 'fluxo…' }));
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(onGoTo).toHaveBeenCalledWith('local:1'));
  expect(fetchMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({
    body: JSON.stringify({ title: 'Pager breaks', body: 'b', stage: 'dev', auto: false, url: URL12, source: 'hive', origin: 'roadmap:PVTI_12', workspace: 'site' }),
  }));
});

test('a repository\'s issue out of the flow creates its task with no origin: it came from no source item (#757)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => jsonRes({ id: 'HIVE-1', itemId: 'local:1' }, 201));
  render(<IssueProperties issue={ISSUE} state={{ ...STATE, tasks: [] }} workspace="site" meta="acme/site" onGoTo={vi.fn()} onChanged={async () => {}} />);
  await user.click(panel().getByRole('button', { name: 'fluxo…' }));
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({
    body: JSON.stringify({ title: 'Pager breaks', body: 'b', stage: 'dev', auto: false, url: URL12, source: 'hive', workspace: 'site' }),
  })));
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/fields'))).toBe(false); // in no source: #757's rows only
  expect(panel().getByText('ana')).toBeInTheDocument();
});
