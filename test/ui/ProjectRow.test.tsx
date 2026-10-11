import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ItemField, ProjectItem } from '../../src/types';
import { fetchMock, jsonRes, renderTable, resetProjectTest, rowOf, VIEW } from './project-harness';

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
