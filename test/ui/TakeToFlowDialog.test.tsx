import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TakeToFlowDialog } from '@/components/tasks/TakeToFlowDialog';
import { setLanguage } from '@/i18n';
import type { Flow, Stage, Task } from '../../src/types';
import { jsonResponse } from '../fakes';

const stage = (name: string, extra: Partial<Stage> = {}): Stage => ({ name, from: {}, ...extra });
const FLOWS: Flow[] = [
  { name: 'feature', transitions: [], stages: [stage('spec'), stage('design'), stage('build'), stage('checks', { action: 'commands' }), stage('avaliação', { action: 'evaluate' }), stage('PR', { action: 'waitForCi' })] },
  { name: 'bug', transitions: [], stages: [stage('triagem'), stage('fix')] },
];
const TASK: Task = { item: { itemId: 'I/14', id: 'HIVE-14', title: 'Flaky e2e on CI', body: '', url: '' }, stage: '', boardColumn: 'Ready', auto: true };
let answer = (): Response => jsonResponse({ ok: true });
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
const posts = () => fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))]);

beforeEach(() => { setLanguage('pt'); answer = () => jsonResponse({ ok: true }); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const open = (flows = FLOWS) => {
  const onOpenChange = vi.fn();
  render(<TakeToFlowDialog task={TASK} flows={flows} open onOpenChange={onOpenChange} />);
  return { onOpenChange, dialog: within(screen.getByRole('alertdialog', { name: 'Levar ao fluxo' })) };
};
const checked = (dialog: ReturnType<typeof open>['dialog'], group: string) => dialog.getAllByRole('radio', { checked: true }).filter((r) => r.getAttribute('name') === group).map((r) => r.getAttribute('value'));

test('names the task and lists every flow, even a single one, the first picked', () => {
  const { dialog } = open();
  expect(dialog.getByText('#HIVE-14 Flaky e2e on CI')).toBeInTheDocument();
  expect(dialog.getAllByRole('radio', { name: /^(feature|bug)$/ }).map((r) => r.getAttribute('value'))).toEqual(['feature', 'bug']);
  expect(checked(dialog, 'take-flow')).toEqual(['feature']);
});

test('lists one flow when there is only one', () => {
  const { dialog } = open([FLOWS[1]]);
  expect(dialog.getAllByRole('radio', { name: /^bug$/ })).toHaveLength(1);
});

test('preselects the entry stage, marked, and folds the trailing action stages into one unselectable muted row', () => {
  const { dialog } = open();
  expect(dialog.getAllByRole('radio', { name: /spec|design|build/ }).map((r) => r.getAttribute('value'))).toEqual(['spec', 'design', 'build']);
  expect(checked(dialog, 'take-stage')).toEqual(['spec']);
  expect(dialog.getByRole('radio', { name: /spec/ })).toHaveAccessibleName(/entrada/);
  const folded = dialog.getByText('checks · avaliação · PR');
  expect(folded).toHaveClass('text-muted-foreground');
  expect(folded.closest('label')).toBeNull();
  expect(dialog.queryByRole('radio', { name: /checks/ })).toBeNull();
});

test('switching flow resets the stage to that flow entry', async () => {
  const user = userEvent.setup();
  const { dialog } = open();
  await user.click(dialog.getByRole('radio', { name: 'build' }));
  expect(checked(dialog, 'take-stage')).toEqual(['build']);
  await user.click(dialog.getByRole('radio', { name: 'bug' }));
  expect(checked(dialog, 'take-stage')).toEqual(['triagem']);
  expect(dialog.getAllByRole('radio', { name: /triagem|fix/ })).toHaveLength(2);
});

test('the primary posts move-to with the chosen stage and closes', async () => {
  const user = userEvent.setup();
  const { dialog, onOpenChange } = open();
  await user.click(dialog.getByRole('radio', { name: 'design' }));
  await user.click(dialog.getByRole('button', { name: /levar ao fluxo/ }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(posts()).toEqual([['/tasks/I%2F14/move-to', { stage: 'design' }]]);
});

test('Enter posts the entry stage', async () => {
  const user = userEvent.setup();
  const { onOpenChange } = open();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(posts()).toEqual([['/tasks/I%2F14/move-to', { stage: 'spec' }]]);
});

test('a refusal shows inline as is and keeps the dialog open', async () => {
  answer = () => jsonResponse({ error: 'um worker ou sessão está executando nessa tarefa' }, 409);
  const user = userEvent.setup();
  const { dialog, onOpenChange } = open();
  await user.click(dialog.getByRole('button', { name: /levar ao fluxo/ }));
  expect(await dialog.findByRole('alert')).toHaveTextContent('um worker ou sessão está executando nessa tarefa');
  expect(onOpenChange).not.toHaveBeenCalled();
});
