import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, expect, test, vi } from 'vitest';
import { BlockersSection } from '@/components/BlockersSection';
import { setLanguage } from '@/i18n';
import { editBlocker } from '@/lib/blockers-api';
import { initialState } from '../../src/orchestrator';
import type { ItemBlockers, State, Task } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/blockers-api', () => ({ editBlocker: vi.fn(), findBlockerCandidates: vi.fn(async () => []) }));
const edit = vi.mocked(editBlocker);

const NONE: ItemBlockers = { blockedBy: [], blocking: [] };
const RELATIONS: ItemBlockers = {
  blockedBy: [{ id: '451', title: 'Dock layout primitives', state: 'closed' }, { id: '503', title: 'Search across tasks', state: 'open' }],
  blocking: [{ id: 'other/lib#98', title: 'Distribution', state: 'open' }],
};
const gh = (id: string, stage: string, blockers?: ItemBlockers): Task => ({
  item: { itemId: `work:PVTI_${id}`, id, title: `T${id}`, body: '', url: '', source: 'work', ...(blockers ? { blockers } : {}) },
  stage, boardColumn: '', auto: false,
});
const HIVE_TASK: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Local', body: '', url: '' }, stage: 'dev', boardColumn: '', created: true, auto: false };
const TASK = gh('12', 'dev', RELATIONS);
const stateOf = (...tasks: Task[]): State => ({ ...initialState(0), tasks });
const section = (): HTMLElement => screen.getByRole('region', { name: 'bloqueios' });
const cells = (): string[][] =>
  [...section().querySelectorAll('[data-slot="blocker-row"]')].map((row) => [...row.querySelectorAll('span')].map((s) => s.textContent ?? ''));
const NOTE = 'são as dependências da issue no GitHub. a tarefa bloqueada não inicia até o bloqueio fechar.';

beforeEach(() => {
  setLanguage('pt');
  edit.mockReset();
  edit.mockResolvedValue(NONE);
  vi.mocked(toast.error).mockClear();
});

test('one row per relation, blocked-by first: the kind, the id, the title and fechada, the flow stage of the task it names, or aberta (#57)', () => {
  // #98 of this repository is in the flow, but the ref names other/lib#98: no task, so aberta
  render(<BlockersSection task={TASK} state={stateOf(TASK, gh('503', 'spec'), gh('98', 'plan'))} />);
  expect(cells()).toEqual([
    ['bloqueada por', '#451', 'Dock layout primitives', 'fechada'],
    ['bloqueada por', '#503', 'Search across tasks', 'spec'],
    ['bloqueia', 'other/lib#98', 'Distribution', 'aberta'],
  ]);
  expect(screen.getByTitle('Dock layout primitives')).toHaveClass('truncate');
  expect(within(section()).getByText(NOTE)).toBeInTheDocument();
});

test('× removes the relation through the API with its row\'s kind and id (#57)', async () => {
  const user = userEvent.setup();
  render(<BlockersSection task={TASK} state={stateOf(TASK)} />);
  await user.click(screen.getByRole('button', { name: 'remover #451' }));
  await user.click(screen.getByRole('button', { name: 'remover other/lib#98' }));
  expect(edit.mock.calls).toEqual([
    ['work', 'work:PVTI_12', { action: 'remove', kind: 'blockedBy', ref: '451' }],
    ['work', 'work:PVTI_12', { action: 'remove', kind: 'blocking', ref: 'other/lib#98' }],
  ]);
});

test('no relations: only the header, + adicionar and the note (#57)', () => {
  render(<BlockersSection task={gh('12', 'dev', NONE)} state={stateOf()} />);
  expect(cells()).toEqual([]);
  expect(within(section()).getByRole('heading', { name: 'bloqueios' })).toBeInTheDocument();
  expect(within(section()).getAllByRole('button').map((b) => b.textContent)).toEqual(['+ adicionar']);
  expect(within(section()).getByText(NOTE)).toBeInTheDocument();
});

test('a GitHub item and a hive task show the section; a source item with no relations read does not (#57)', () => {
  const hive = render(<BlockersSection task={HIVE_TASK} state={stateOf(HIVE_TASK)} />);
  expect(section()).toBeInTheDocument();
  hive.unmount();
  const bare = gh('12', 'dev');
  render(<BlockersSection task={bare} state={stateOf(bare)} />);
  expect(screen.queryByRole('region', { name: 'bloqueios' })).not.toBeInTheDocument();
});

test('a refusal shows the code\'s copy inline and no toast; any other failure reads Erro inesperado; the next edit clears it (#57)', async () => {
  const user = userEvent.setup();
  edit.mockRejectedValueOnce(Object.assign(new Error('the other item is already blocked by this one'), { status: 409, code: 'blockers.cycle' }));
  edit.mockRejectedValueOnce(new Error('Failed to fetch'));
  render(<BlockersSection task={TASK} state={stateOf(TASK)} />);
  await user.click(screen.getByRole('button', { name: 'remover #451' }));
  expect(await within(section()).findByRole('alert')).toHaveTextContent('a outra tarefa já está bloqueada por esta');
  await user.click(screen.getByRole('button', { name: 'remover #503' }));
  expect(await within(section()).findByText('Erro inesperado')).toHaveClass('text-destructive');
  await user.click(screen.getByRole('button', { name: 'remover #451' }));
  await waitFor(() => expect(within(section()).queryByRole('alert')).not.toBeInTheDocument());
  expect(toast.error).not.toHaveBeenCalled();
});

test('+ adicionar opens the add row with the field focused; a refused add keeps it open with the error, one that lands closes it (#57)', async () => {
  const user = userEvent.setup();
  edit.mockRejectedValueOnce(Object.assign(new Error('no such issue or task to relate'), { status: 404, code: 'blockers.unknownRef' }));
  render(<BlockersSection task={TASK} state={stateOf(TASK)} />);
  await user.click(screen.getByRole('button', { name: '+ adicionar' }));
  expect(screen.getByRole('combobox', { name: '#número ou título…' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: '+ adicionar' })).not.toBeInTheDocument();
  await user.keyboard('#99{Enter}');
  expect(await within(section()).findByRole('alert')).toHaveTextContent('nenhuma issue ou tarefa com esse id');
  expect(screen.getByRole('combobox', { name: '#número ou título…' })).toHaveFocus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('combobox', { name: '#número ou título…' })).not.toBeInTheDocument());
  expect(edit.mock.calls.map(([, , change]) => change)).toEqual([
    { action: 'add', kind: 'blockedBy', ref: '99' }, { action: 'add', kind: 'blockedBy', ref: '99' },
  ]);
  expect(screen.getByRole('button', { name: '+ adicionar' })).toBeInTheDocument();
});

test('an inherited blocker reads as one line under the task\'s own rows, with its ancestor and no remove button (#424)', () => {
  const held: Task = { ...TASK, item: { ...TASK.item, inheritedBlockedBy: [{ id: '40', via: '7' }] } };
  render(<BlockersSection task={held} state={stateOf(held)} />);
  expect(cells()).toHaveLength(3); // the editable rows stay the task's own relations
  expect(within(section()).getByText('bloqueada por #40 (via #7)')).toHaveClass('text-muted-foreground');
  expect(screen.queryByRole('button', { name: /#40/ })).not.toBeInTheDocument();
});
