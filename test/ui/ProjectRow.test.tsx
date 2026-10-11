import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetViewState } from '@/lib/view-state';
import type { BlockerRef, ItemField, ProjectItem, ProjectView } from '../../src/types';
import { ALL, fetchMock, jsonRes, numbers, renderTable, resetProjectTest, rowOf, VIEW } from './project-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

beforeEach(resetProjectTest);
afterEach(() => vi.unstubAllGlobals());

// A row's cells in the harness's ALL order, then the action
const CELLS = ['issue', 'status', 'Priority', 'labels', 'resp.', 'Estimate', 'Target', 'Progress', 'Sprint', 'PR', 'action'];
const hasCaret = (id: string, column: string): boolean =>
  within(rowOf(id)).getAllByRole('cell')[CELLS.indexOf(column)].querySelector('[data-slot="field-cell"] svg') !== null;

test('every editable cell is a field cell with the ⌄: status, labels, resp. and the project fields; the PR cell and a read-only field have none (#60)', async () => {
  renderTable();
  await screen.findByText('3 de 3');
  for (const column of ['status', 'Priority', 'labels', 'resp.', 'Estimate', 'Target', 'Sprint']) expect(hasCaret('#12', column), column).toBe(true);
  for (const column of ['Progress', 'PR']) expect(hasCaret('#12', column), column).toBe(false);
});

test('a label toggled in the labels popover posts the whole new set to the fields route and the answer\'s row replaces the row (#60)', async () => {
  const user = userEvent.setup();
  const labels: ItemField = { name: 'Labels', type: 'labels', value: ['bug'], options: ['bug', 'docs'] };
  const written: ProjectItem = { ...VIEW.items[0], labels: ['bug', 'docs'] };
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === 'POST') return jsonRes({ fields: [], row: written });
    return jsonRes(String(input).endsWith('/fields') ? { fields: [labels] } : VIEW);
  });
  renderTable();
  await screen.findByText('3 de 3');
  await user.click(within(rowOf('#12')).getByRole('button', { name: 'editar Labels' }));
  await user.click(await screen.findByRole('checkbox', { name: 'docs' }));
  await waitFor(() => expect(within(rowOf('#12')).getByText('docs')).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith('/sources/roadmap/items/roadmap%3APVTI_12/fields', expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'Labels', value: ['bug', 'docs'] }) }));
});

const open = (id: string, title: string): BlockerRef => ({ id, title, state: 'open' });
const closed = (id: string, title: string): BlockerRef => ({ id, title, state: 'closed' });
// #12 is blocked by a closed #521 and an open #274, in GitHub's order; #3 by nothing; #40's relations were never read
const BLOCKED: ProjectView = {
  ...VIEW, items: [{ ...VIEW.items[0], blockedBy: [closed('521', 'Old pager'), open('274', 'Dock layout')] }, { ...VIEW.items[1], blockedBy: [] }, VIEW.items[2]],
};
const CELL = 'editar bloqueada por';
const cell12 = (): HTMLElement => within(rowOf('#12')).getByRole('button', { name: CELL });
// The blocked-by column shown; a blockers write answered by `write`, the add row's search by nothing, any other read by the view
function showBlockedBy(view: ProjectView, write: () => Response = () => jsonRes({ ok: true })): void {
  resetViewState({ projectViews: { roadmap: { groupBy: null, collapsed: [], columns: [...ALL, 'blockedBy'], blockedByShown: true } } });
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).includes('/blockers/candidates')) return jsonRes({ candidates: [] });
    return init?.method === 'POST' ? write() : jsonRes(view);
  });
}

test('the blocked-by cell shows the open refs first in foreground, the closed ones in muted with · fechada, the whole list as its title; — with none or never read; 112px with its own divider (#61)', async () => {
  showBlockedBy(BLOCKED);
  renderTable();
  await screen.findByText('3 de 3');
  expect(within(cell12()).getByText('#274')).toHaveClass('text-foreground');
  expect(within(cell12()).getByText('#521 · fechada')).toHaveClass('text-muted-foreground');
  expect(within(cell12()).getByTitle('#274, #521 · fechada')).toHaveTextContent('#274, #521 · fechada');
  expect(cell12().querySelector('svg')).not.toBeNull(); // the ⌄ of an editable cell
  for (const id of ['#3', '#40']) expect(within(rowOf(id)).getByRole('button', { name: CELL })).toHaveTextContent(/^—$/);
  expect(screen.getAllByRole('row')[0].style.gridTemplateColumns.split(' ').slice(-3)).toEqual(['112px', '104px', '76px']);
  expect(screen.getByRole('separator', { name: 'redimensionar bloqueada por' })).toBeInTheDocument();
});

test('the blocked-by header sorts by the first ref the cell shows; another repository\'s ref sorts last (#61)', async () => {
  const user = userEvent.setup();
  showBlockedBy({
    ...VIEW, items: [
      { ...VIEW.items[0], blockedBy: [closed('521', 'Old pager'), open('274', 'Dock layout')] },
      { ...VIEW.items[1], blockedBy: [open('other/lib#3', 'Lib')] },
      { ...VIEW.items[2], blockedBy: [open('7', 'Pager')] },
    ],
  });
  renderTable();
  await screen.findByText('3 de 3');
  await user.click(screen.getByRole('button', { name: /^bloqueada por/ }));
  expect(numbers()).toEqual(['#40', '#12', '#3']); // 7, 274 (the open one, shown first), then other/lib#3
});
