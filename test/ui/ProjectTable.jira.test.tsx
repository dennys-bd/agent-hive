import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetViewState } from '@/lib/view-state';
import type { ProjectItem, ProjectView } from '../../src/types';
import { fetchMock, jsonRes, openMenu, renderTable, resetProjectTest, rowOf } from './project-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// #827: a Jira source's rows: the key as id, the browse url, no repository
const jiraRow = (n: number, title: string, extra: Partial<ProjectItem> = {}): ProjectItem => ({
  itemId: `roadmap:${10000 + n}`, id: `PROJ-${n}`, title, body: '', url: `https://acme.example/browse/PROJ-${n}`,
  labels: [], assignees: [], fields: {}, pullRequests: [], ...extra,
});
const JIRA_VIEW: ProjectView = {
  statuses: [{ name: 'To Do' }, { name: 'In Progress', stage: 'dev' }, { name: 'Done' }],
  fields: [{ name: 'Team', type: 'singleSelect', options: ['Platform', 'Web'] }],
  builtins: { status: 0, labels: 0, assignees: 0 },
  items: [
    jiraRow(12, 'Login', { status: 'To Do', fields: { Team: 'Web' } }),
    jiraRow(2, 'Logout', { status: 'In Progress', fields: { Team: 'Platform' } }),
    jiraRow(9, 'Signup', { status: 'To Do', fields: { Team: 'Web' } }),
  ],
  truncated: false,
};
const keys = (): (string | null)[] => screen.getAllByRole('row').slice(1).flatMap((r) => within(r).queryAllByText(/^PROJ-\d+$/).slice(0, 1)).map((n) => n.textContent);
const groups = (): (string | null)[] => screen.getAllByRole('row').filter((r) => r.closest('tbody') && r.children.length === 1).map((r) => r.textContent);

beforeEach(() => {
  resetProjectTest();
  resetViewState({ projectViews: { roadmap: { groupBy: null, collapsed: [], columns: ['status', 'labels', 'assignee', 'pr'], blockedByShown: true } } });
  fetchMock.mockImplementation(async () => jsonRes(JIRA_VIEW));
});
afterEach(() => vi.unstubAllGlobals());

test('a Jira row shows its key with no #, the issue header sorts the keys by their number, and ⇧↵ opens its Jira page (#827)', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  renderTable({ tasks: [] });
  await screen.findByText('3 de 3');
  expect(keys()).toEqual(['PROJ-12', 'PROJ-2', 'PROJ-9']);
  expect(screen.queryByText('#PROJ-12')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  expect(keys()).toEqual(['PROJ-2', 'PROJ-9', 'PROJ-12']);
  await user.click(screen.getByRole('button', { name: /^issue/ }));
  expect(keys()).toEqual(['PROJ-12', 'PROJ-9', 'PROJ-2']);
  rowOf('PROJ-9').focus();
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(open).toHaveBeenCalledWith('https://acme.example/browse/PROJ-9', '_blank', 'noreferrer');
  open.mockRestore();
});

test('the search finds a key in any case and by its number alone (#827)', async () => {
  const user = userEvent.setup();
  renderTable({ tasks: [] });
  await screen.findByText('3 de 3');
  const search = screen.getByRole('textbox', { name: 'buscar tarefas' });
  await user.type(search, 'proj-9');
  expect(keys()).toEqual(['PROJ-9']);
  await user.clear(search);
  await user.type(search, '12');
  expect(keys()).toEqual(['PROJ-12']);
});

test('the rows group by a Jira select field in its options\' order (#827)', async () => {
  const user = userEvent.setup();
  renderTable({ tasks: [] });
  await screen.findByText('3 de 3');
  await openMenu(user, /^agrupar/);
  await user.click(screen.getByRole('menuitemradio', { name: 'Team' }));
  expect(groups()).toEqual(['Platform1', 'Web2']);
});

test('a Status change on a Jira row posts the transition\'s status and the answered row replaces the row (#827)', async () => {
  const user = userEvent.setup();
  const moved: ProjectItem = { ...JIRA_VIEW.items[0], status: 'In Progress' };
  fetchMock.mockImplementation(async (_input, init) => (init?.method === 'POST' ? jsonRes({ fields: [], row: moved }) : jsonRes(JIRA_VIEW)));
  renderTable({ tasks: [] });
  await screen.findByText('3 de 3');
  within(rowOf('PROJ-12')).getByRole('button', { name: 'To Do' }).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: /^In Progress/ }));
  await waitFor(() => expect(within(rowOf('PROJ-12')).getByRole('button', { name: 'In Progress' })).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith('/sources/roadmap/project/status', expect.objectContaining({ method: 'POST', body: JSON.stringify({ itemId: 'roadmap:10012', status: 'In Progress' }) }));
});
