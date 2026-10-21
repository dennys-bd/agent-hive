import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AgentAvailability } from '../../src/types';
import { type StageSource, StageEditor, type TransitionFocus } from '@/components/settings/StageEditor';
import { setLanguage, t } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-form';
import { stageMeta } from '@/lib/settings-stages';
import { emptyTransition, type TransitionDraft } from '@/lib/settings-transitions';

beforeEach(() => setLanguage('pt'));

const SOURCES: StageSource[] = [
  { id: 'h', name: 'hive', type: 'github', options: ['Ready', 'In progress', 'Review'] },
  { id: 'c', name: 'core', type: 'github', options: ['todo', 'done'] },
];
const stage = (name: string, extra: Partial<StageDraft> = {}): StageDraft => ({ ...emptyStage(), name, ...extra });
const STAGES = [
  stage('spec', { prompt: '/hive-spec {url}', from: { h: ['Ready'] } }),
  stage('gate', { approval: true }),
  stage('clean', { action: 'deleteActivity' }),
];

const AGENTS: AgentAvailability[] = [{ agent: 'claude', available: true }];

// StageEditor over its own flow, as CombTab holds the draft: every onChange is seen and applied.
type Flow = { stages: StageDraft[]; transitions: TransitionDraft[] };
function Harness({ initial, transitions = [], sources = SOURCES, agents = AGENTS, focus, onChange }: { initial: StageDraft[]; transitions?: TransitionDraft[]; sources?: StageSource[]; agents?: AgentAvailability[]; focus?: TransitionFocus; onChange(next: Flow): void }) {
  const [flow, setFlow] = useState<Flow>({ stages: initial, transitions });
  return <StageEditor stages={flow.stages} transitions={flow.transitions} sources={sources} agents={agents} defaultAgent="claude" commands={[]} workspaces={['hive']} focus={focus} onChange={(next) => { onChange(next); setFlow(next); }} />;
}
const setup = (initial: StageDraft[] = STAGES, sources: StageSource[] = SOURCES, agents: AgentAvailability[] = AGENTS) => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness initial={initial} sources={sources} agents={agents} onChange={onChange} />);
  return { user, onChange, last: (): StageDraft[] => (onChange.mock.lastCall as [Flow])[0].stages };
};
const chip = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const nameField = (): HTMLInputElement => screen.getByLabelText(t('settings.stages.name')) as HTMLInputElement;

test('stages show as chips with their meta; the first is selected, a click selects another, + etapa adds and selects an empty one (#515)', async () => {
  const { user, last } = setup();
  for (const s of STAGES) expect(chip(s.name)).toHaveTextContent(`${s.name}${stageMeta(s, 'claude')}`);
  expect(chip('spec')).toHaveAttribute('aria-pressed', 'true');
  expect(chip('gate')).toHaveAttribute('aria-pressed', 'false');
  await user.click(chip('gate'));
  expect(chip('gate')).toHaveAttribute('aria-pressed', 'true');
  expect(nameField()).toHaveValue('gate');
  await user.click(screen.getByRole('button', { name: t('settings.stages.add') }));
  expect(last()).toHaveLength(4);
  expect(last()[3]).toEqual(expect.objectContaining({ name: '', from: {}, onStart: {}, prompt: '' }));
  expect(screen.getByRole('button', { name: new RegExp(`^${t('settings.stages.unnamed')}`) })).toHaveAttribute('aria-pressed', 'true');
  expect(nameField()).toHaveValue('');
});

test('the selected stage moves earlier or later and stays selected; remove selects its neighbour; there is no avançado (#515)', async () => {
  const { user, last } = setup();
  expect(screen.getByRole('button', { name: t('settings.stages.moveEarlier') })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: t('settings.stages.moveLater') }));
  expect(last().map((s) => s.name)).toEqual(['gate', 'spec', 'clean']);
  expect(chip('spec')).toHaveAttribute('aria-pressed', 'true');
  await user.click(screen.getByRole('button', { name: t('settings.stages.remove') }));
  expect(last().map((s) => s.name)).toEqual(['gate', 'clean']);
  expect(nameField()).toHaveValue('clean');
  await user.click(screen.getByRole('button', { name: t('settings.stages.remove') }));
  expect(last().map((s) => s.name)).toEqual(['gate']);
  expect(nameField()).toHaveValue('gate');
  expect(screen.queryByRole('button', { name: /avançado/ })).not.toBeInTheDocument();
});

test('entra: one entry select over every source, "source · column" chips, and the after / máx. de workers fields (#515)', async () => {
  const { user, last } = setup();
  expect(screen.getByRole('heading', { level: 3, name: `1 · ${t('settings.stages.enter')}` })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 3, name: `3 · ${t('settings.stages.run')}` })).toBeInTheDocument();
  const entry = screen.getByRole('combobox', { name: t('settings.stages.from') });
  expect(entry).toHaveTextContent('hive · Ready');
  await user.click(entry);
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['hive · Ready', 'hive · In progress', 'hive · Review', 'core · todo', 'core · done']);
  await user.click(screen.getByRole('option', { name: 'core · todo' }));
  expect(last()[0].from).toEqual({ h: ['Ready'], c: ['todo'] });
  await user.keyboard('{Escape}');
  await user.type(screen.getByLabelText(t('settings.stages.after')), '5d');
  expect(last()[0].after).toBe('5d');
  const cap = screen.getByLabelText(t('settings.stages.maxWorkers'));
  expect(cap).toHaveAttribute('placeholder', 'sem limite');
  await user.type(cap, '1');
  expect(last()[0].maxWorkers).toBe('1');
  await user.click(chip('clean'));
  expect(screen.getByLabelText(t('settings.stages.maxWorkers'))).toBeDisabled();
});

test('each field carries its own short hint; the help paragraph is gone (#524)', async () => {
  setup();
  expect(screen.getByText(t('settings.stages.maxWorkers.hint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.stages.after.hint'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.stages.after'))).toHaveAttribute('placeholder', 'iniciar ignora');
  expect(screen.getByText(t('settings.stages.prompt.hint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.stages.approval.hint'))).toBeInTheDocument();

  expect(screen.queryByText(t('settings.stages.action.deleteActivity.hint'))).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(t('settings.stages.action')));
  fireEvent.click(await screen.findByRole('option', { name: 'excluir atividade' }));
  expect(screen.getByText(t('settings.stages.action.deleteActivity.hint'))).toBeInTheDocument();
});

test('the entry select reads "adicionar coluna" when empty (#515)', () => {
  setup([stage('dev')]);
  expect(screen.getByRole('combobox', { name: t('settings.stages.from') })).toHaveTextContent(t('settings.stages.from.add'));
});

test('executa: action, agent, model, session, prompt and the approval switch on a prompt stage; delete activity keeps only the action (#515)', async () => {
  const { user, last } = setup();
  expect(screen.getByLabelText(t('settings.stages.action'))).toHaveTextContent('executar um prompt');
  expect(screen.getByLabelText(t('settings.stages.agent'))).toHaveTextContent(/^claude$/); // #710: no default row, the default agent shown picked
  expect(screen.getByLabelText(t('settings.stages.model'))).toHaveTextContent('padrão do claude'); // #710: ModelMenu, '' = the agent's default
  expect(screen.getByLabelText(t('settings.stages.session'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.stages.prompt'))).toHaveValue('/hive-spec {url}');
  expect(screen.getByText(t('settings.stages.prompt.hint'))).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: t('settings.stages.approval') }));
  expect(last()[0].approval).toBe(true);
  fireEvent.click(screen.getByLabelText(t('settings.stages.action')));
  fireEvent.click(await screen.findByRole('option', { name: 'excluir atividade' }));
  expect(last()[0].action).toBe('deleteActivity');
  for (const label of ['settings.stages.agent', 'settings.stages.model', 'settings.stages.session', 'settings.stages.prompt'] as const) {
    expect(screen.queryByLabelText(t(label))).not.toBeInTheDocument();
  }
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});

// A pointerdown + click sequence: jsdom has no layout, and a Radix Select trigger needs the pointer events to open.
function openSelect(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
}

test('an agent off PATH is disabled with the reason (#516)', async () => {
  setup(STAGES, SOURCES, [{ agent: 'claude', available: false }]);
  openSelect(screen.getByLabelText(t('settings.stages.agent')));
  expect(await screen.findByRole('option', { name: `claude · ${t('settings.agent.offPath')}` })).toHaveAttribute('aria-disabled', 'true');
});

test('saídas: one row per outgoing transition with its tags and + transição, the on-start actions in their own block; a row opens the transition editor (#134, #266)', async () => {
  const user = userEvent.setup();
  const stages = [stage('spec', { prompt: '/hive-spec {url}' }), stage('Checks', { action: 'commands', commands: ['lint'] })];
  const back: TransitionDraft = { ...emptyTransition(stages[1], stages), verdict: 'failed', to: stages[0].id, maxTries: '3', prompt: 'Fix', session: 'new' };
  render(<Harness initial={stages} transitions={[back]} onChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: /^Checks/ }));
  const exits = screen.getByRole('list', { name: 'saídas' });
  const row = within(exits).getByRole('button', { name: /falhou → spec/ });
  expect(row).toHaveTextContent('3x');
  expect(row).toHaveTextContent('prompt');
  expect(row).toHaveTextContent('nova sessão');
  expect(within(screen.getByRole('table', { name: t('settings.stages.onStart') })).getByText('hive')).toBeInTheDocument();
  await user.click(row);
  expect(screen.getByRole('region', { name: 'Checks → spec · falhou' })).toBeInTheDocument();
});

test('executa: só aprovação locks exige aprovação on and hides the prompt; vereditos are chips with + veredito, and none reads nenhum (#134)', async () => {
  const { user, last } = setup([stage('spec', { prompt: '/x' })]);
  fireEvent.click(screen.getByRole('combobox', { name: 'ação' })); // a plain click opens Radix reliably here
  fireEvent.click(await screen.findByRole('option', { name: 'só aprovação' }));
  expect(last()[0]).toMatchObject({ gate: true, approval: true });
  expect(screen.getByRole('switch', { name: 'exige aprovação' })).toBeDisabled();
  expect(screen.queryByLabelText('prompt')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', { name: 'ação' }));
  fireEvent.click(await screen.findByRole('option', { name: 'executar um prompt' }));
  await user.type(screen.getByLabelText('+ veredito'), 'redo{Enter}');
  expect(last()[0].verdicts).toEqual(['redo']);
  await user.click(screen.getByRole('button', { name: 'remover redo' }));
  expect(screen.getByText('nenhum: a etapa só termina')).toBeInTheDocument();
});

test('executa: the handoff switch on a prompt stage, disabled with its own hint while the session continues (#692)', async () => {
  const { user, last } = setup([stage('plan', { prompt: '/hive:new-plan {url}' }), stage('build', { prompt: '/hive:new-build {url}', session: 'continue', handoff: true })]);
  const handoff = (): HTMLElement => screen.getByRole('switch', { name: t('settings.stages.handoff') });
  expect(handoff()).toBeEnabled();
  expect(screen.getByText(t('settings.stages.handoff.hint'))).toBeInTheDocument();
  await user.click(handoff());
  expect(last()[0].handoff).toBe(true);
  await user.click(chip('build'));
  expect(handoff()).toBeDisabled();
  expect(handoff()).not.toBeChecked();
  expect(screen.getByText(t('settings.stages.handoff.continue'))).toBeInTheDocument();
});

test('executa: the handoff switch is disabled with its own hint on a stage without a prompt, a gate that never spawns (#692)', () => {
  setup([stage('gate', { prompt: '', handoff: true })]);
  const handoff = screen.getByRole('switch', { name: t('settings.stages.handoff') });
  expect(handoff).toBeDisabled();
  expect(handoff).not.toBeChecked();
  expect(screen.getByText(t('settings.stages.handoff.noPrompt'))).toBeInTheDocument();
});

test('executar comandos hides the agent, model, session, prompt and switches, disables the worker cap and shows the commands block with its switch on (#755)', async () => {
  const onChange = vi.fn();
  function Own() {
    const [flow, setFlow] = useState<Flow>({ stages: [stage('checks', { from: { h: ['Ready'] }, prompt: '/x' })], transitions: [] });
    return (
      <StageEditor
        stages={flow.stages} transitions={flow.transitions} sources={SOURCES} agents={AGENTS} defaultAgent="claude" commands={[{ name: 'build', impls: [{ workspace: null, command: 'pnpm build' }], menu: true, env: {} }]} workspaces={['hive']}
        onChange={(next) => { onChange(next); setFlow(next); }}
      />
    );
  }
  render(<Own />);
  fireEvent.click(screen.getByRole('combobox', { name: t('settings.stages.action') }));
  fireEvent.click(await screen.findByRole('option', { name: /executar comandos/ }));
  expect((onChange.mock.lastCall as [Flow])[0].stages[0].action).toBe('commands');
  expect(screen.getByRole('combobox', { name: t('settings.stages.action') })).toHaveTextContent(/^executar comandos$/);
  expect(screen.queryByLabelText(t('settings.stages.prompt'))).not.toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.stages.model'))).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: t('settings.stages.approval') })).not.toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.stages.maxWorkers'))).toBeDisabled();
  expect(screen.getByRole('switch', { name: t('settings.stages.commands.stopOnFailure') })).toBeChecked();
});

test('aguardar CI hides the agent, model, session, prompt and switches, disables the worker cap, shows its block and its chip reads the checks it counts (#834)', async () => {
  const onChange = vi.fn();
  render(<Harness initial={[stage('ci', { from: { h: ['Ready'] }, prompt: '/x' })]} onChange={onChange} />);
  fireEvent.click(screen.getByRole('combobox', { name: t('settings.stages.action') }));
  fireEvent.click(await screen.findByRole('option', { name: /aguardar CI/ }));
  expect((onChange.mock.lastCall as [Flow])[0].stages[0].action).toBe('waitForCi');
  expect(screen.getByRole('combobox', { name: t('settings.stages.action') })).toHaveTextContent(/^aguardar CI$/);
  expect(screen.queryByLabelText(t('settings.stages.prompt'))).not.toBeInTheDocument();
  expect(screen.queryByLabelText(t('settings.stages.model'))).not.toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.stages.maxWorkers'))).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'quais checks' })).toBeInTheDocument();
  expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('os obrigatórios da branch');
  expect(stageMeta({ ...stage('ci'), action: 'waitForCi', ciChecks: 'list', checks: ['build', 'e2e-*'] }, 'claude')).toBe('build, e2e-*');
});

const card = (): HTMLElement => screen.getByRole('region', { name: t('settings.stages') });
// SettingsGroup's first row is the card header: the h2, the hint and the action slot
const header = (): HTMLElement => card().firstElementChild as HTMLElement;
const checksFlow = (): Flow => {
  const stages = [stage('spec', { prompt: '/x' }), stage('Checks', { action: 'commands', commands: ['lint'] })];
  return { stages, transitions: [{ ...emptyTransition(stages[1], stages), verdict: 'failed', to: stages[0].id }] };
};
const failed = 'Checks → spec · falhou';

test('+ etapa and + transição sit in the etapas card header and still add a stage and a transition; the load hint leads the body when there are sources (#887)', async () => {
  const { user, onChange } = setup();
  expect(within(header()).getByRole('heading', { level: 2, name: t('settings.stages') })).toBeInTheDocument();
  expect(within(card()).getByText(t('settings.stages.loadHint'))).toBeInTheDocument();
  await user.click(within(header()).getByRole('button', { name: t('settings.transitions.add') }));
  expect((onChange.mock.lastCall as [Flow])[0].transitions).toEqual([expect.objectContaining({ from: STAGES[0].id })]);
  await user.click(within(header()).getByRole('button', { name: t('settings.stages.add') }));
  expect((onChange.mock.lastCall as [Flow])[0].stages).toHaveLength(4);
});

test('with no source there is no load hint (#887)', () => {
  setup(STAGES, []);
  expect(screen.queryByText(t('settings.stages.loadHint'))).not.toBeInTheDocument();
});

test('a transition opened from 3 · saídas leads with voltar para <stage>, which shows that stage again (#887)', async () => {
  const user = userEvent.setup();
  const { stages, transitions } = checksFlow();
  render(<Harness initial={stages} transitions={transitions} onChange={vi.fn()} />);
  await user.click(chip('Checks'));
  await user.click(within(screen.getByRole('list', { name: 'saídas' })).getByRole('button', { name: /falhou → spec/ }));
  expect(screen.getByRole('region', { name: failed })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'voltar para Checks' }));
  expect(screen.queryByRole('region', { name: failed })).not.toBeInTheDocument();
  expect(nameField()).toHaveValue('Checks');
  expect(chip('Checks')).toHaveAttribute('aria-pressed', 'true');
});

test('the same transition opened from its pill on the chart shows no way back (#887)', async () => {
  const user = userEvent.setup();
  const { stages, transitions } = checksFlow();
  render(<Harness initial={stages} transitions={transitions} onChange={vi.fn()} />);
  await user.click(chip('Checks'));
  await user.click(within(screen.getByRole('list', { name: 'saídas' })).getByRole('button', { name: /falhou → spec/ }));
  expect(screen.getByRole('button', { name: 'voltar para Checks' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'falhou' })); // the pill, the arrow's label
  expect(screen.getByRole('region', { name: failed })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^voltar para/ })).not.toBeInTheDocument();
});

const planFlow = (): Flow => {
  const stages = [stage('Plan', { prompt: '/p' }), stage('Review', { prompt: '/r' })];
  return { stages, transitions: [emptyTransition(stages[0], stages)] };
};
const exits = () => within(screen.getByRole('list', { name: 'saídas' }));

test('exige aprovação carries the stage\'s exits in the same change: terminou becomes aprovado when it turns on, terminou again when it turns off (#918)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { stages, transitions } = planFlow();
  render(<Harness initial={stages} transitions={transitions} onChange={onChange} />);
  const approval = screen.getByRole('switch', { name: t('settings.stages.approval') });
  expect(exits().getByRole('button', { name: /^terminou → Review/ })).toBeInTheDocument();
  await user.click(approval);
  expect(onChange).toHaveBeenCalledOnce();
  expect((onChange.mock.lastCall as [Flow])[0]).toMatchObject({ stages: [{ approval: true }, {}], transitions: [{ when: 'approved' }] });
  expect(exits().getByRole('button', { name: /^aprovado → Review/ })).toBeInTheDocument();
  await user.click(approval);
  expect(exits().getByRole('button', { name: /^terminou → Review/ })).toBeInTheDocument();
});

test('a focus selects the transition it names and opens its editor; one naming no transition leaves the stage selected (#918)', () => {
  const { stages, transitions } = planFlow();
  const { unmount } = render(<Harness initial={stages} transitions={transitions} focus={{ transition: transitions[0].id, n: 1 }} onChange={vi.fn()} />);
  expect(screen.getByRole('region', { name: 'Plan → Review · terminou' })).toBeInTheDocument();
  unmount();
  render(<Harness initial={stages} transitions={transitions} focus={{ transition: 'gone', n: 1 }} onChange={vi.fn()} />);
  expect(nameField()).toHaveValue('Plan');
});

test('ao começar is its own block between entra and executa: a row per source, the empty line until one has an action, and saídas moves to 4 (#266)', async () => {
  const { user, last } = setup();
  expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['1 · entra', '2 · ao começar', '3 · executa', '4 · saídas']);
  const table = within(screen.getByRole('table', { name: t('settings.stages.onStart') }));
  expect(table.getAllByRole('row').map((r) => r.firstElementChild?.textContent)).toEqual([t('settings.stages.exit.source'), 'hive', 'core']);
  expect(screen.getByText(t('settings.stages.onStart.empty'))).toBeInTheDocument();
  table.getByRole('button', { name: t('settings.stages.exit.addTo', { source: 'hive', when: t('settings.stages.exit.start') }) }).focus();
  await user.keyboard('{Enter}'); // as the Settings test opens it: a click does not open the Radix menu in jsdom
  await user.click(await screen.findByRole('menuitem', { name: 'mover para In progress' }));
  expect(last()[0].onStart).toEqual({ h: [{ type: 'move', column: 'In progress' }] });
  expect(screen.queryByText(t('settings.stages.onStart.empty'))).not.toBeInTheDocument();
});

test('with no source, ao começar keeps its heading and says there is none (#266)', () => {
  setup(STAGES, []);
  expect(screen.getByRole('heading', { level: 3, name: '2 · ao começar' })).toBeInTheDocument();
  expect(screen.queryByRole('table', { name: t('settings.stages.onStart') })).not.toBeInTheDocument();
  expect(screen.getByText(t('settings.sources.none'))).toBeInTheDocument();
});
