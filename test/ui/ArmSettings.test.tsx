import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ArmSettings } from '@/components/benchmark/arms/ArmSettings';
import { AgentsContext } from '@/components/NewRunButton';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { ARMS, ARMS_PATH, type Call, stubBenchmarkFetch } from './benchmark-fixtures';

const AGENTS = [{ agent: 'claude' as const, available: true }, { agent: 'codex' as const, available: true }];
type User = ReturnType<typeof userEvent.setup>;
beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());
const posts = (calls: Call[]): Call[] => calls.filter((c) => c.method !== 'GET'); // launch options and items load on open
const pickAgent = async (user: User, role: string, agent: RegExp): Promise<void> => {
  // Radix Select in jsdom ignores a second pointer open after a pick; the keyboard opens it every time
  screen.getByRole('combobox', { name: `agente de ${role}` }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: agent }));
};
const pickModel = async (user: User, role: string, name: RegExp): Promise<void> => {
  await user.click(screen.getByRole('combobox', { name: `modelo de ${role}` }));
  await user.click(await screen.findByRole('option', { name }));
};
// a bare undefined would take a default, so base mode passes its armId explicitly
const open = (experiment: Experiment = ARMS, armId?: string) => {
  const onClose = vi.fn();
  render(<AgentsContext.Provider value={AGENTS}><ArmSettings experiment={experiment} armId={armId} onClose={onClose} /></AgentsContext.Provider>);
  return onClose;
};

test("editing build's agent raises the count, voltar à base lowers it, and closing posts the arm's overrides once (#462)", async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open(ARMS, 'a2');
  const dialog = screen.getByRole('dialog', { name: 'braço B · skills do plugin' });
  expect(within(dialog).getByText('0 sobreposições')).toBeInTheDocument();
  await pickAgent(user, 'build', /codex/i);
  expect(within(dialog).getByText('1 sobreposição')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'voltar à base: build' }));
  expect(within(dialog).getByText('0 sobreposições')).toBeInTheDocument();
  await pickAgent(user, 'build', /codex/i);
  await user.click(within(dialog).getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  // another agent drops the base's sonnet: codex runs its own default model
  expect(posts(calls)).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a2`, body: { overrides: { stages: { build: { agent: 'codex', model: null } } } } }]);
});

test("the model menu offers the agent's default (model null over the base's) and the base's model, which resets the field (#462)", async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open(ARMS, 'a2');
  await pickModel(user, 'build', /^o padrão do agente/);
  expect(screen.getByText('1 sobreposição')).toBeInTheDocument();
  await pickModel(user, 'build', /^o da base: sonnet/);
  expect(screen.getByText('0 sobreposições')).toBeInTheDocument();
  await pickModel(user, 'build', /^o padrão do agente/);
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a2`, body: { overrides: { stages: { build: { model: null } } } } }]);
});

test('closing untouched posts nothing; Esc closes too (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open(ARMS, 'a3');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([]);
});

test('a refused save keeps the dialog open (#462)', async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch(409);
  const onClose = open(ARMS, 'a2');
  await user.type(screen.getByRole('textbox', { name: 'skill de spec' }), 'x');
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  expect(onClose).not.toHaveBeenCalled();
});

test('a running experiment opens read only and closing posts nothing (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open({ ...ARMS, status: 'running' }, 'a3');
  expect(screen.getByRole('combobox', { name: 'agente de build' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'modelo de build' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'skill de spec' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'voltar à base: build' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([]);
});

test('base mode: every field plain, no igual à base, closing posts the whole base (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  open(ARMS);
  expect(screen.getByRole('dialog', { name: 'base · todos os braços' })).toBeInTheDocument();
  expect(screen.queryByText('igual à base')).not.toBeInTheDocument();
  const skill = screen.getByRole('textbox', { name: 'skill de spec' });
  await user.clear(skill);
  await user.type(skill, '/x');
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  const base = { ...ARMS.base, stages: { ...ARMS.base.stages, spec: { ...ARMS.base.stages.spec, skill: '/x' } } };
  await waitFor(() => expect(posts(calls)).toEqual([{ method: 'PATCH', path: ARMS_PATH, body: { base } }]));
});

const PINNED = [{ id: 'hive:new-build', name: 'new-build', kind: 'skill', versions: ['tdd', 'terse'] }, { id: 'hive:new-spec', name: 'new-spec', kind: 'skill', versions: [] }];

test('items lists the pinned items, each original or a pinned version; a pick is an items override (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch(undefined, PINNED);
  const onClose = open(ARMS, 'a2');
  const build = await screen.findByRole('combobox', { name: 'versão de hive:new-build' });
  expect(build).toHaveTextContent('original');
  await user.click(build);
  await user.click(await screen.findByRole('option', { name: 'terse' }));
  expect(screen.getByText('1 sobreposição')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a2`, body: { overrides: { items: { 'hive:new-build': 'terse' } } } }]);
  expect(calls).toContainEqual({ method: 'GET', path: `${ARMS_PATH}/items` });
});
