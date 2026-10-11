import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FieldEditor } from '@/components/FieldEditor';
import { setLanguage } from '@/i18n';
import type { ItemField, ProjectItem } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const ITEM = 'roadmap:PVTI_12';
const PATH = '/sources/roadmap/items/roadmap%3APVTI_12/fields';
const ROW: ProjectItem = { itemId: ITEM, id: '12', title: 'Pager', body: '', url: 'https://github.com/acme/site/issues/12', labels: [], assignees: [], fields: {}, pullRequests: [] };
const ANSWER = { fields: [], row: ROW };
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonRes(ANSWER));
beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jsonRes(ANSWER));
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// Every write the editor sent: its path and its body
const posted = (): unknown[] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([input, init]) => [String(input), JSON.parse(String(init?.body))]);
function renderEditor(field: ItemField) {
  const onWritten = vi.fn();
  render(<FieldEditor itemId={ITEM} field={field} onWritten={onWritten} />);
  return onWritten;
}
const trigger = (name: string): HTMLElement => screen.getByRole('button', { name: `editar ${name}` });
// A write in flight disables its editor: the next edit waits for the answer
const settled = async (name: string): Promise<void> => {
  await waitFor(() => expect(trigger(name)).toBeEnabled());
};

test('a choice lists its options with the current one checked, writes the one picked, and limpar clears it (#686)', async () => {
  const user = userEvent.setup();
  const onWritten = renderEditor({ name: 'Priority', type: 'singleSelect', value: 'P1', options: ['P0', 'P1'] });
  expect(trigger('Priority')).toHaveTextContent('P1');
  trigger('Priority').focus(); // Radix's menu opens on a key under jsdom
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'P0' }));
  await waitFor(() => expect(onWritten).toHaveBeenCalledWith(ANSWER));
  await settled('Priority');
  trigger('Priority').focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'limpar' }));
  await waitFor(() => expect(posted()).toEqual([[PATH, { field: 'Priority', value: 'P0' }], [PATH, { field: 'Priority', value: null }]]));
});

test('a choice whose options the caller lacks reads them when its menu opens (#686)', async () => {
  const user = userEvent.setup();
  const milestone: ItemField = { name: 'Milestone', type: 'milestone', value: 'v1' };
  fetchMock.mockImplementation(async (_input, init) => (init?.method === 'POST' ? jsonRes(ANSWER) : jsonRes({ fields: [{ ...milestone, options: ['v1', 'v2'] }] })));
  renderEditor(milestone);
  trigger('Milestone').focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'v2' }));
  expect(fetchMock).toHaveBeenCalledWith(PATH);
  await waitFor(() => expect(posted()).toEqual([[PATH, { field: 'Milestone', value: 'v2' }]]));
});

test('a text saves on Enter, and Escape cancels with nothing sent (#686)', async () => {
  const user = userEvent.setup();
  renderEditor({ name: 'Notes', type: 'text', value: null });
  await user.click(trigger('Notes'));
  await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'hello{Enter}');
  await waitFor(() => expect(posted()).toEqual([[PATH, { field: 'Notes', value: 'hello' }]]));
  await settled('Notes');
  await user.click(trigger('Notes'));
  await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'draft{Escape}');
  expect(trigger('Notes')).toBeInTheDocument();
  expect(posted()).toHaveLength(1);
});

test('a number saves on blur as a number; an emptied one clears (#686)', async () => {
  const user = userEvent.setup();
  renderEditor({ name: 'Estimate', type: 'number', value: 5 });
  await user.click(trigger('Estimate'));
  const input = screen.getByRole('spinbutton', { name: 'Estimate' });
  await user.clear(input);
  await user.type(input, '8');
  await user.tab();
  await settled('Estimate');
  await user.click(trigger('Estimate'));
  await user.clear(screen.getByRole('spinbutton', { name: 'Estimate' }));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(posted()).toEqual([[PATH, { field: 'Estimate', value: 8 }], [PATH, { field: 'Estimate', value: null }]]));
});

test('a date saves the day picked on Enter (#686)', async () => {
  const user = userEvent.setup();
  renderEditor({ name: 'Due', type: 'date', value: null });
  await user.click(trigger('Due'));
  fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-10-20' } });
  await user.keyboard('{Enter}');
  await waitFor(() => expect(posted()).toEqual([[PATH, { field: 'Due', value: '2026-10-20' }]]));
});

test('a refused write toasts the field with the source\'s words and the editor shows the value it had (#686)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => jsonRes({ error: 'Resource not accessible by integration' }, 502));
  const onWritten = renderEditor({ name: 'Estimate', type: 'number', value: 5 });
  await user.click(trigger('Estimate'));
  await user.type(screen.getByRole('spinbutton', { name: 'Estimate' }), '1{Enter}');
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Estimate não salvo: Resource not accessible by integration'));
  expect(onWritten).not.toHaveBeenCalled();
  expect(trigger('Estimate')).toHaveTextContent('5');
});

test('the assignees are checkboxes: a toggle writes the whole new set (#686)', async () => {
  const user = userEvent.setup();
  renderEditor({ name: 'Assignees', type: 'assignees', value: ['ana'], options: ['ana', 'bia'] });
  await user.click(trigger('Assignees'));
  expect(screen.getByRole('checkbox', { name: 'ana' })).toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'bia' }));
  await waitFor(() => expect(posted()).toEqual([[PATH, { field: 'Assignees', value: ['ana', 'bia'] }]]));
});

test('a read-only field is its value as text, no editor; an empty value reads — (#686)', () => {
  renderEditor({ name: 'Repository', type: 'repository', value: 'acme/site', readOnly: true });
  expect(screen.getByText('acme/site').closest('[title]')).toHaveAttribute('title', 'somente leitura');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  renderEditor({ name: 'Notes', type: 'text', value: null });
  expect(trigger('Notes')).toHaveTextContent('—');
});

test('a write that failed midway toasts the error and still hands the caller the re-read fields and row, so it resyncs (#686)', async () => {
  const user = userEvent.setup();
  const resync = { fields: [{ name: 'Estimate', type: 'number', value: 7 }], row: ROW };
  fetchMock.mockImplementation(async () => jsonRes({ error: 'Resource not accessible by integration', ...resync }, 502));
  const onWritten = renderEditor({ name: 'Estimate', type: 'number', value: 5 });
  await user.click(trigger('Estimate'));
  await user.type(screen.getByRole('spinbutton', { name: 'Estimate' }), '1{Enter}');
  await waitFor(() => expect(onWritten).toHaveBeenCalledWith(resync));
  expect(toast.error).toHaveBeenCalledWith('Estimate não salvo: Resource not accessible by integration');
});

test('the Status choice offers no limpar: a task is always in a column (#686)', async () => {
  const user = userEvent.setup();
  renderEditor({ name: 'Status', type: 'singleSelect', value: 'Ready', options: ['Ready', 'Done'] });
  trigger('Status').focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('menuitem', { name: 'Done' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'limpar' })).not.toBeInTheDocument();
});

test('every editor\'s trigger is a field cell with the ⌄; a read-only field is none (#60)', () => {
  renderEditor({ name: 'Priority', type: 'singleSelect', value: 'P1', options: ['P0', 'P1'] });
  renderEditor({ name: 'Notes', type: 'text', value: 'x' });
  renderEditor({ name: 'Assignees', type: 'assignees', value: [], options: [] });
  renderEditor({ name: 'Repository', type: 'repository', value: 'acme/site', readOnly: true });
  for (const name of ['Priority', 'Notes', 'Assignees']) expect(trigger(name)).toHaveAttribute('data-slot', 'field-cell');
  expect(document.querySelectorAll('[data-slot="field-cell"]')).toHaveLength(3);
});

test('the labels are checkboxes like the assignees, the current ones first: a toggle writes the whole new set (#60)', async () => {
  const user = userEvent.setup();
  renderEditor({ name: 'Labels', type: 'labels', value: ['ui'], options: ['bug', 'ui'] });
  await user.click(trigger('Labels'));
  expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['ui', 'bug']);
  await user.click(screen.getByRole('checkbox', { name: 'bug' }));
  await waitFor(() => expect(posted()).toEqual([[PATH, { field: 'Labels', value: ['ui', 'bug'] }]]));
});
