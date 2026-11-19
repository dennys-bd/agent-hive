import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { BlockersSection } from '@/components/BlockersSection';
import { setLanguage } from '@/i18n';
import { CreateTargetsContext, HIVE_ONLY } from '@/lib/create-targets';
import { editRelation, readRelationTypes } from '@/lib/relations-api';
import { initialState } from '../../src/orchestrator';
import type { LinkType, Relation, State, Task } from '../../src/types';
import { JIRA_ENTRY } from '../fakes';

vi.mock('@/lib/relations-api', () => ({ editRelation: vi.fn(), readRelationTypes: vi.fn() }));
vi.mock('@/lib/blockers-api', () => ({ editBlocker: vi.fn(), findBlockerCandidates: vi.fn(async () => []) }));
const edit = vi.mocked(editRelation);
const types = vi.mocked(readRelationTypes);

const TYPES: LinkType[] = [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }, { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }];
const rel = (id: string, phrase: string, type = 'Relates', direction: Relation['direction'] = 'outward', state: Relation['state'] = 'open'): Relation =>
  ({ id, title: `Issue ${id}`, state, type, direction, phrase });
const RELATIONS = [rel('ABC-2', 'relates to'), rel('ABC-3', 'is duplicated by', 'Duplicate', 'inward', 'closed'), rel('ABC-4', 'relates to', 'Relates', 'inward')];
const jira = (id: string, stage: string, relations?: Relation[]): Task => ({
  item: { itemId: `tickets:1000${id.slice(4)}`, id, title: `T ${id}`, body: '', url: '', source: 'tickets', ...(relations ? { relations } : {}) },
  stage, boardColumn: '', auto: false,
});
const TASK = jira('ABC-1', 'dev', RELATIONS);
const stateOf = (...tasks: Task[]): State => ({ ...initialState(0), tasks });
// The Dashboard's comb.sources (#810): the section reads its task's source type, and so its ref forms, from them
const show = (task: Task, state: State) =>
  render(<CreateTargetsContext.Provider value={{ ...HIVE_ONLY, configs: [JIRA_ENTRY] }}><BlockersSection task={task} state={state} /></CreateTargetsContext.Provider>);
const section = (): HTMLElement => screen.getByRole('group', { name: 'relacionamentos' });
const cells = (): string[][] =>
  [...section().querySelectorAll('[data-slot="blocker-row"]')].map((row) => [...row.querySelectorAll('span')].map((s) => s.textContent ?? ''));
const FIELD = '#número ou título…';

beforeEach(() => {
  setLanguage('pt');
  edit.mockReset();
  edit.mockResolvedValue([]);
  types.mockReset();
  types.mockResolvedValue(TYPES);
});

test('a Jira task\'s relations grouped by phrase in the order of each phrase\'s first relation: key, title and fechada, the flow stage of the task it names, or aberta (#829)', () => {
  show(TASK, stateOf(TASK, jira('ABC-4', 'spec')));
  expect(cells()).toEqual([
    ['relates to', 'ABC-2', 'Issue ABC-2', 'aberta'],
    ['relates to', 'ABC-4', 'Issue ABC-4', 'spec'],
    ['is duplicated by', 'ABC-3', 'Issue ABC-3', 'fechada'],
  ]);
});

test('× removes the relation with its own type and direction (#829)', async () => {
  const user = userEvent.setup();
  show(TASK, stateOf(TASK));
  await user.click(screen.getByRole('button', { name: 'remover ABC-3' }));
  expect(edit.mock.calls).toEqual([['tickets', 'tickets:10001', { action: 'remove', type: 'Duplicate', direction: 'inward', ref: 'ABC-3' }]]);
});

test('+ adicionar offers the site\'s types by phrase, a same-phrase type once; the chosen type and direction go with the typed key, and a landed add closes the row (#829)', async () => {
  const user = userEvent.setup();
  show(TASK, stateOf(TASK));
  await user.click(await screen.findByRole('button', { name: '+ relação' }));
  expect(types).toHaveBeenCalledWith('tickets');
  const picker = screen.getByRole('combobox', { name: 'tipo de relação' });
  expect(picker).toHaveTextContent('relates to');
  picker.focus();
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['relates to', 'duplicates', 'is duplicated by']);
  await user.click(screen.getByRole('option', { name: 'is duplicated by' }));
  await user.click(screen.getByRole('combobox', { name: FIELD }));
  await user.keyboard('ABC-9{Enter}');
  await waitFor(() => expect(screen.queryByRole('combobox', { name: FIELD })).not.toBeInTheDocument());
  expect(edit.mock.calls).toEqual([['tickets', 'tickets:10001', { action: 'add', type: 'Duplicate', direction: 'inward', ref: 'ABC-9' }]]);
});

test('a refusal shows the code\'s copy inline; any other failure reads Erro inesperado (#829)', async () => {
  const user = userEvent.setup();
  edit.mockRejectedValueOnce(Object.assign(new Error('no such item or task to relate'), { status: 404, code: 'blockers.unknownRef' }));
  edit.mockRejectedValueOnce(new Error('Failed to fetch'));
  show(TASK, stateOf(TASK));
  await user.click(screen.getByRole('button', { name: 'remover ABC-2' }));
  expect(await within(section()).findByRole('alert')).toHaveTextContent('nenhuma issue ou tarefa com esse id');
  await user.click(screen.getByRole('button', { name: 'remover ABC-2' }));
  expect(await within(section()).findByText('Erro inesperado')).toHaveClass('text-destructive');
});

test('no relations: the header and the empty line; no types offered: no + adicionar (#829)', async () => {
  types.mockResolvedValue([]);
  const empty = jira('ABC-1', 'dev', []);
  show(empty, stateOf(empty));
  expect(cells()).toEqual([]);
  expect(within(section()).getByText('nenhuma relação')).toBeInTheDocument();
  await waitFor(() => expect(types).toHaveBeenCalled());
  expect(within(section()).queryByRole('button', { name: '+ relação' })).not.toBeInTheDocument();
});

test('a GitHub item and a hive task show their blockers but no relation rows and read no types; a Jira item with neither shows no section (#829, #958)', () => {
  const github: Task = { item: { itemId: 'work:PVTI_12', id: '12', title: 'T12', body: '', url: '', source: 'work', blockers: { blockedBy: [], blocking: [] } }, stage: 'dev', boardColumn: '', auto: false };
  const local: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Local', body: '', url: '' }, stage: 'dev', boardColumn: '', created: true, auto: false };
  for (const task of [github, local]) {
    const view = show(task, stateOf(task));
    expect(section()).toBeInTheDocument();
    expect(screen.queryByText('nenhuma relação')).not.toBeInTheDocument();
    view.unmount();
  }
  expect(types).not.toHaveBeenCalled();
  const bare = jira('ABC-1', 'dev');
  show(bare, stateOf(bare));
  expect(screen.queryByRole('group', { name: 'relacionamentos' })).not.toBeInTheDocument();
});

test('a Jira task\'s relations sit inside relacionamentos after its blocker rows, with no heading of their own; the summary counts only blockers (#958)', async () => {
  const both: Task = { ...TASK, item: { ...TASK.item, blockers: { blockedBy: [{ id: 'ABC-7', title: 'Blocker', state: 'open' }], blocking: [] } } };
  show(both, stateOf(both));
  expect(cells()).toEqual([
    ['bloqueada por', 'ABC-7', 'Blocker', 'aberta'],
    ['relates to', 'ABC-2', 'Issue ABC-2', 'aberta'],
    ['relates to', 'ABC-4', 'Issue ABC-4', 'aberta'],
    ['is duplicated by', 'ABC-3', 'Issue ABC-3', 'fechada'],
  ]);
  expect(section().querySelector('summary')).toHaveTextContent('bloqueada por ABC-7');
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  // the blockers' + adicionar and, once the types are read, the relations' own + relação
  expect(within(section()).getByRole('button', { name: '+ adicionar' })).toBeInTheDocument();
  await waitFor(() => expect(within(section()).getByRole('button', { name: '+ relação' })).toBeInTheDocument());
});
