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
const save = (user: User) => user.click(screen.getByRole('button', { name: /^salvar/ }));
const open = (experiment: Experiment = ARMS, armId?: string) => {
  const onClose = vi.fn();
  render(<AgentsContext.Provider value={AGENTS}><ArmSettings experiment={experiment} armId={armId} onClose={onClose} onShowConfig={vi.fn()} /></AgentsContext.Provider>);
  return onClose;
};

test("editing build's agent raises the count, voltar à base lowers it, and salvar posts the arm's overrides once (#462)", async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open(ARMS, 'a2');
  const dialog = screen.getByRole('alertdialog', { name: 'B Skills do plugin' });
  expect(within(dialog).getByText('nenhuma sobreposição · este braço é a própria base')).toBeInTheDocument();
  await pickAgent(user, 'build', /codex/i);
  expect(within(dialog).getByText('1 sobreposição · o resto segue a base')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'voltar à base: build' }));
  expect(within(dialog).getByText('nenhuma sobreposição · este braço é a própria base')).toBeInTheDocument();
  await pickAgent(user, 'build', /codex/i);
  await save(user);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  // another agent drops the base's sonnet: codex runs its own default model
  expect(posts(calls)).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a2`, body: { overrides: { stages: { build: { agent: 'codex', model: null } } } } }]);
});

test("the model menu offers the agent's default (model null over the base's) and the base's model, which resets the field (#462)", async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open(ARMS, 'a2');
  await pickModel(user, 'build', /^o padrão do agente/);
  expect(screen.getByText('1 sobreposição · o resto segue a base')).toBeInTheDocument();
  await pickModel(user, 'build', /^o da base: sonnet/);
  expect(screen.getByText('nenhuma sobreposição · este braço é a própria base')).toBeInTheDocument();
  await pickModel(user, 'build', /^o padrão do agente/);
  await save(user);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a2`, body: { overrides: { stages: { build: { model: null } } } } }]);
});

test('salvar posts the overrides once; cancelar, Esc and × post nothing (#536)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open(ARMS, 'a3');
  await save(user);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([]);
});

test('cancelar, Esc and × drop an edited draft and post nothing (#536)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open(ARMS, 'a2');
  await pickAgent(user, 'build', /codex/i);
  await user.click(within(screen.getByRole('alertdialog')).getAllByRole('button', { name: 'cancelar' }).at(-1) as HTMLElement);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  await user.click(within(screen.getByRole('alertdialog')).getAllByRole('button', { name: 'cancelar' })[0]);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(3));
  expect(posts(calls)).toEqual([]);
});

test('só sobreposições hides the rows equal to the base; with none overridden it says so (#536)', async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch();
  open(ARMS, 'a3');
  expect(screen.getByRole('region', { name: 'plugins' })).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'só sobreposições' }));
  expect(screen.queryByRole('region', { name: 'plugins' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'build' })).toBeInTheDocument();
});

test('só sobreposições on an arm with no override reads nenhuma sobreposição (#536)', async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch();
  open(ARMS, 'a2');
  await user.click(screen.getByRole('switch', { name: 'só sobreposições' }));
  expect(screen.getByText('nenhuma sobreposição: este braço é a própria base.')).toBeInTheDocument();
});

test('locked: the lock note, no salvar, no voltar à base, and ver em config still works (#536)', async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch();
  const onShowConfig = vi.fn();
  render(<AgentsContext.Provider value={AGENTS}><ArmSettings experiment={{ ...ARMS, status: 'running' }} onClose={vi.fn()} onShowConfig={onShowConfig} /></AgentsContext.Provider>);
  expect(screen.getByRole('status')).toHaveTextContent('só leitura');
  expect(screen.queryByRole('button', { name: /^salvar/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /voltar à base/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'fechar' })).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'ver em config' })); // base-only row: the arm has none
  expect(onShowConfig).toHaveBeenCalled();
});

test('base mode: each row names the arms that override it, and the footer names them all (#536)', () => {
  stubBenchmarkFetch();
  open(ARMS);
  expect(within(screen.getByRole('region', { name: 'build' })).getByText('C sobrepõe')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'plugins' })).getByText('A sobrepõe')).toBeInTheDocument();
  expect(screen.getByText('salvar muda a base de A, B, C e D nas linhas que eles não sobrepõem.')).toBeInTheDocument();
});

test('a refused save keeps the dialog open (#462)', async () => {
  const user = userEvent.setup();
  stubBenchmarkFetch(409);
  const onClose = open(ARMS, 'a2');
  await user.type(screen.getByRole('textbox', { name: 'skill de spec' }), 'x');
  await save(user);
  await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
  expect(onClose).not.toHaveBeenCalled();
});

test('a running experiment opens read only: fechar posts nothing (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = open({ ...ARMS, status: 'running' }, 'a3');
  expect(screen.getByRole('combobox', { name: 'agente de build' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'modelo de build' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'skill de spec' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'voltar à base: build' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^salvar/ })).not.toBeInTheDocument();
  await user.click(within(screen.getByRole('alertdialog')).getAllByRole('button', { name: 'fechar' }).at(-1) as HTMLElement);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([]);
});

test('base mode: every field plain, no igual à base, salvar posts the whole base (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  open(ARMS);
  expect(screen.getByRole('alertdialog', { name: 'Base' })).toBeInTheDocument();
  expect(screen.queryByText('igual à base')).not.toBeInTheDocument();
  const skill = screen.getByRole('textbox', { name: 'skill de spec' });
  await user.clear(skill);
  await user.type(skill, '/x');
  await save(user);
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
  expect(screen.getByText('1 sobreposição · o resto segue a base')).toBeInTheDocument();
  await save(user);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a2`, body: { overrides: { items: { 'hive:new-build': 'terse' } } } }]);
  expect(calls).toContainEqual({ method: 'GET', path: `${ARMS_PATH}/items` });
});

test('an arm removed elsewhere while open closes the dialog without posting, never editing the base (#462)', async () => {
  const calls = stubBenchmarkFetch();
  const onClose = vi.fn();
  const view = render(<AgentsContext.Provider value={AGENTS}><ArmSettings experiment={ARMS} armId="a2" onClose={onClose} onShowConfig={vi.fn()} /></AgentsContext.Provider>);
  const without = { ...ARMS, arms: ARMS.arms.filter((a) => a.id !== 'a2') };
  view.rerender(<AgentsContext.Provider value={AGENTS}><ArmSettings experiment={without} armId="a2" onClose={onClose} onShowConfig={vi.fn()} /></AgentsContext.Provider>);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([]);
});

test('a base edited elsewhere while open does not turn the fields the arm left alone into overrides (#462)', async () => {
  const user = userEvent.setup();
  const calls = stubBenchmarkFetch();
  const onClose = vi.fn();
  const view = render(<AgentsContext.Provider value={AGENTS}><ArmSettings experiment={ARMS} armId="a2" onClose={onClose} onShowConfig={vi.fn()} /></AgentsContext.Provider>);
  const edited = { ...ARMS, base: { ...ARMS.base, plugins: [...ARMS.base.plugins, 'elsewhere'] } };
  view.rerender(<AgentsContext.Provider value={AGENTS}><ArmSettings experiment={edited} armId="a2" onClose={onClose} onShowConfig={vi.fn()} /></AgentsContext.Provider>);
  await pickAgent(user, 'build', /codex/i);
  await save(user);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts(calls)).toEqual([{ method: 'PATCH', path: `${ARMS_PATH}/arms/a2`, body: { overrides: { stages: { build: { agent: 'codex', model: null } } } } }]);
});
