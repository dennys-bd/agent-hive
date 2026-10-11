import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IssueFieldsBox } from '@/components/IssueFieldsBox';
import { setLanguage } from '@/i18n';
import type { ItemField, ProjectItem, Task } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const URL12 = 'https://github.com/acme/site/issues/12';
const ITEM = 'roadmap:PVTI_12';
const FIELDS_PATH = '/sources/roadmap/items/roadmap%3APVTI_12/fields';
const TASK: Task = { item: { itemId: ITEM, id: '12', title: 'Pager breaks', body: '', url: URL12, source: 'roadmap' }, stage: 'dev', boardColumn: 'In review', auto: true };
// In the project's order: the box pulls Status, the labels and the assignees up
const FIELDS: ItemField[] = [
  { name: 'Priority', type: 'singleSelect', value: 'P2', options: ['P0', 'P1', 'P2'] },
  { name: 'Assignees', type: 'assignees', value: ['ana'], options: ['ana', 'bia'] },
  { name: 'Estimate', type: 'number', value: 3 },
  { name: 'Labels', type: 'labels', value: ['bug'], options: ['bug', 'docs'] },
  { name: 'Status', type: 'singleSelect', value: 'In review', options: ['Ready', 'In review', 'Done'] },
  { name: 'Repository', type: 'repository', value: 'acme/site', readOnly: true },
];
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonRes({ ok: true }));
beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderBox = (task?: Task) => {
  const onWritten = vi.fn();
  const view = render(<IssueFieldsBox itemId={ITEM} source="roadmap" fields={FIELDS} task={task} onWritten={onWritten} />);
  return { ...view, onWritten };
};
const region = (): HTMLElement => screen.getByRole('region', { name: 'esta issue' });
const box = () => within(region());
const terms = (): (string | null)[] => [...region().querySelectorAll('dt')].map((d) => d.textContent);

test('the box: "esta issue" and "campos de roadmap", then Status, the labels and the assignee, then the other fields in the project\'s order; every editable value a field cell, a read-only one text (#65)', () => {
  renderBox(TASK);
  expect(box().getByText('esta issue')).toHaveClass('font-medium');
  expect(box().getByText('campos de roadmap')).toHaveClass('text-muted-foreground');
  expect(region()).toHaveClass('rounded-lg', 'border', 'p-3');
  expect(terms()).toEqual(['Status', 'Labels', 'responsável', 'Priority', 'Estimate', 'Repository']);
  for (const name of ['Status', 'Labels', 'Assignees', 'Priority', 'Estimate']) expect(box().getByRole('button', { name: `editar ${name}` })).toHaveAttribute('data-slot', 'field-cell');
  expect(box().queryByRole('button', { name: 'editar Repository' })).not.toBeInTheDocument();
  expect(box().getByText('acme/site').closest('[title]')).toHaveAttribute('title', 'somente leitura');
  expect(within(box().getByRole('button', { name: 'editar Labels' })).getByText('bug')).toHaveClass('rounded-[4px]', 'border');
});

test('with a task the Status cell reads "· etapa {stage}" after the value and the note says a status change moves it; with no task, neither (#65)', () => {
  const { unmount } = renderBox(TASK);
  expect(box().getByRole('button', { name: 'editar Status' })).toHaveTextContent('In review· etapa dev');
  expect(box().getByText('· etapa dev')).toHaveClass('text-muted-foreground');
  expect(box().getByText('mudar o status move a tarefa para a etapa ligada a ele.')).toBeInTheDocument();
  unmount();
  renderBox();
  expect(box().getByRole('button', { name: 'editar Status' })).toHaveTextContent(/^In review$/);
  expect(box().queryByText(/mudar o status/)).not.toBeInTheDocument();
});

test('choosing another Status option posts it to the item\'s fields route and hands the answer to onWritten (#65)', async () => {
  const user = userEvent.setup();
  const row: ProjectItem = { itemId: ITEM, id: '12', title: 'Pager breaks', body: 'b', url: URL12, labels: ['bug'], assignees: ['ana'], fields: {}, pullRequests: [] };
  const answer = { fields: FIELDS.map((f) => (f.name === 'Status' ? { ...f, value: 'Done' } : f)), row };
  fetchMock.mockImplementation(async () => jsonRes(answer));
  const { onWritten } = renderBox(TASK);
  box().getByRole('button', { name: 'editar Status' }).focus(); // Radix's menu opens on a key under jsdom
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'Done' }));
  await waitFor(() => expect(onWritten).toHaveBeenCalledWith(answer));
  expect(fetchMock).toHaveBeenCalledWith(FIELDS_PATH, expect.objectContaining({ method: 'POST', body: JSON.stringify({ field: 'Status', value: 'Done' }) }));
});
