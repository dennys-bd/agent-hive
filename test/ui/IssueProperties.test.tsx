import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IssueProperties, type IssuePropertiesProps } from '@/components/IssueProperties';
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
const renderProps = (props: Partial<IssuePropertiesProps> = {}) => {
  const onChanged = vi.fn(async () => {});
  render(<IssueProperties issue={ISSUE} state={STATE} workspace="site" meta="acme/site" onGoTo={vi.fn()} onChanged={onChanged} {...props} />);
  return onChanged;
};

test('a task of a source with its fields read: the "esta issue" box with its fields as field cells, the stage beside Status and the note; no stage select, no source or workspace rows, which the panel\'s header shows (#65)', async () => {
  fetchMock.mockImplementation(withFields(() => jsonRes({ ok: true })));
  renderProps({ task: TASK });
  const box = within(await panel().findByRole('region', { name: 'esta issue' }));
  expect(fetchMock).toHaveBeenCalledWith(FIELDS_PATH);
  expect(box.getByText('campos de roadmap')).toBeInTheDocument();
  expect(terms()).toEqual(['Status', 'Labels', 'responsável', 'Priority', 'Repository']);
  expect(box.getByRole('button', { name: 'editar Status' })).toHaveTextContent('In review· etapa dev');
  expect(box.getByRole('button', { name: 'editar Labels' })).toHaveTextContent('bug');
  expect(box.getByText('mudar o status move a tarefa para a etapa ligada a ele.')).toBeInTheDocument();
  expect(panel().queryByRole('button', { name: 'etapa' })).not.toBeInTheDocument();
  expect(panel().queryByRole('button', { name: 'fluxo…' })).not.toBeInTheDocument();
  expect(panel().queryByRole('button', { name: 'remover bug' })).not.toBeInTheDocument(); // the labels are the field's cell, not #757's chips
  expect(panel().queryByText('github project')).not.toBeInTheDocument();
  expect(panel().queryByText('hive/12-pager')).not.toBeInTheDocument(); // the branch is the panel's properties grid
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

test('a field written from the sidebar shows the value the source answered (#686)', async () => {
  const user = userEvent.setup();
  const row: ProjectItem = { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: 'b', url: URL12, labels: ['bug'], assignees: ['ana'], fields: { Priority: 'P0' }, pullRequests: [] };
  const written = FIELDS.map((f) => (f.name === 'Priority' ? { ...f, value: 'P0' } : f));
  fetchMock.mockImplementation(withFields(() => jsonRes({ fields: written, row })));
  const onChanged = renderProps({ task: TASK });
  (await panel().findByRole('button', { name: 'editar Priority' })).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'P0' }));
  await waitFor(() => expect(panel().getByRole('button', { name: 'editar Priority' })).toHaveTextContent('P0'));
  expect(fetchMock).toHaveBeenCalledWith(FIELDS_PATH, expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'Priority', value: 'P0' }) }));
  expect(onChanged).toHaveBeenCalled(); // the page reads the issue again: the center's labels and assignees follow (#65)
});

test('an issue in a source\'s Project with no task: the "fluxo" row with fluxo… above the box; no stage beside Status, no note (#65, #757, #686)', async () => {
  const user = userEvent.setup();
  const onGoTo = vi.fn();
  fetchMock.mockImplementation(withFields(() => jsonRes({ id: 'HIVE-1', itemId: 'local:1' }, 201)));
  renderProps({ state: { ...STATE, tasks: [] }, itemId: 'roadmap:PVTI_12', meta: 'roadmap', onGoTo });
  const box = await panel().findByRole('region', { name: 'esta issue' });
  const create = panel().getByRole('button', { name: 'fluxo…' });
  expect(create.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(terms()).toEqual(['fluxo', 'Status', 'Labels', 'responsável', 'Priority', 'Repository']);
  expect(within(box).getByRole('button', { name: 'editar Status' })).toHaveTextContent(/^In review$/);
  expect(panel().queryByText(/mudar o status/)).not.toBeInTheDocument();
  await user.click(create);
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(onGoTo).toHaveBeenCalledWith('local:1'));
  expect(fetchMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({
    body: JSON.stringify({ title: 'Pager breaks', body: 'b', stage: 'dev', auto: false, url: URL12, source: 'hive', origin: 'roadmap:PVTI_12', workspace: 'site' }),
  }));
});

test('a repository\'s issue out of the flow creates its task with no origin: it came from no source item (#757)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => jsonRes({ id: 'HIVE-1', itemId: 'local:1' }, 201));
  renderProps({ state: { ...STATE, tasks: [] } });
  expect(terms()).toEqual(['fluxo', 'labels', 'responsável', 'workspace']);
  expect(panel().queryByRole('button', { name: 'etapa' })).not.toBeInTheDocument();
  await user.click(panel().getByRole('button', { name: 'fluxo…' }));
  await user.click(screen.getByRole('button', { name: 'criar tarefa' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({
    body: JSON.stringify({ title: 'Pager breaks', body: 'b', stage: 'dev', auto: false, url: URL12, source: 'hive', workspace: 'site' }),
  })));
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/fields'))).toBe(false); // in no source: #757's rows only
  expect(panel().getByText('ana')).toBeInTheDocument();
});

test('a task whose fields do not answer keeps today\'s rows: labels, the assignees read only, its source and workspace; no stage select, no box (#65, #757)', async () => {
  renderProps({ task: TASK }); // the fields route answers { ok: true }: no fields
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(FIELDS_PATH));
  expect(terms()).toEqual(['labels', 'responsável', 'source', 'workspace']);
  expect(panel().getByText('ana')).toBeInTheDocument();
  expect(panel().getByText('github project')).toBeInTheDocument();
  expect(panel().getByRole('button', { name: 'remover bug' })).toBeInTheDocument();
  expect(panel().queryByRole('button', { name: 'etapa' })).not.toBeInTheDocument();
  expect(panel().queryByRole('region', { name: 'esta issue' })).not.toBeInTheDocument();
});
