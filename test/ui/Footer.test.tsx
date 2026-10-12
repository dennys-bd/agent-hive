import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Footer } from '@/components/Footer';
import { setLanguage, t } from '@/i18n';
import type { EffectiveLimits, State, UsageRule } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const WEEK_CAP: UsageRule = { source: 'week', percent: 90, maxWorkers: 2 };
const SESSION_FORCE: UsageRule = { source: 'session', percent: 60, signal: 'yellow' };
const DAY_STAGE: UsageRule = { source: 'day', percent: 80, maxWorkers: 1, stage: 'review' };

const NONE: EffectiveLimits = { signal: 'green', floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} };
const FIRED: EffectiveLimits = {
  signal: 'yellow', maxWorkers: 2, floor: { signal: 'yellow', maxWorkers: 2 }, signalRules: [SESSION_FORCE], capRules: [WEEK_CAP], disabledRules: [],
  stageCaps: { review: 1 }, stageCapRules: { review: [DAY_STAGE] },
};

const STATE = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 5, workers: [{ id: 's1', status: 'working' }, { id: 's2', status: 'working', freeSession: true }, { id: 's3', status: 'empty' }],
  tasks: [], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [], stages: [],
  rateLimits: { claude: { at: '2026-09-28T10:00:00Z', windows: { seven_day: { usedPercent: 91, resetsAt: new Date(Date.now() + (4 * 24 + 10) * 3_600_000 + 60_000).toISOString() } } } },
} as unknown as State;

const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const footer = (): HTMLElement => screen.getByRole('contentinfo');
const posted = (path: string, body: unknown) => waitFor(() => expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ body: JSON.stringify(body) })));

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('green with nothing fired: the pill, no effect, the workers (the own session not counted), no rules label, and the shut-down button', () => {
  render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  expect(within(footer()).getByRole('status')).toHaveAttribute('data-signal', 'green');
  expect(within(footer()).getByRole('status')).toHaveTextContent('green');
  expect(footer()).toHaveTextContent('workers 1/5');
  expect(footer()).not.toHaveTextContent(t('footer.rules'));
  expect(footer()).not.toHaveTextContent(t('signal.effect.noNewTasks'));
  expect(within(footer()).getAllByRole('button').map((b) => b.textContent)).toEqual(['desligar ao terminar']);
});

test('fired rules: the signal named in English with its effect in Portuguese, the effective cap, and one chip per rule naming what it does', () => {
  render(<Footer state={STATE} effective={FIRED} locale="pt-BR" />);
  expect(within(footer()).getByRole('status')).toHaveTextContent('yellow');
  expect(footer()).toHaveTextContent('tarefas novas só de árvore iniciada');
  expect(footer()).toHaveTextContent('workers 1/2');
  expect(footer()).toHaveTextContent('regras');
  const chips = within(footer()).getAllByRole('button').map((b) => b.textContent);
  expect(chips).toEqual(['sessão ≥ 60% → yellow', 'semana ≥ 90% → máx 2 workers', 'dia ≥ 80% → review máx 1', 'desligar ao terminar']);
});

test('a rule chip opens pausar regra: até resetar shows the window countdown, até amanhã the next 07:00, and 1 h posts a pause an hour ahead', async () => {
  const user = userEvent.setup();
  const before = Date.now(); // the popover reads the clock when it renders
  render(<Footer state={STATE} effective={FIRED} locale="pt-BR" onEditRules={() => {}} />);
  await user.click(screen.getByRole('button', { name: /semana ≥ 90%/ }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('pausar regra');
  expect(within(dialog).getByRole('button', { name: /até resetar/ })).toHaveTextContent('4d10h');
  expect(within(dialog).getByRole('button', { name: /até amanhã/ })).toHaveTextContent('07:00');
  expect(within(dialog).queryByRole('button', { name: 'retomar agora' })).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: '1 h' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [path, init] = fetchMock.mock.lastCall!;
  const body = JSON.parse(String(init?.body));
  expect(path).toBe('/rules/disable');
  expect(body).toMatchObject({ source: 'week', percent: 90, until: { kind: 'at' } });
  expect(Date.parse(body.until.at) - before).toBeGreaterThanOrEqual(3_600_000);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('até resetar posts a reset pause; personalizado… posts the picked time; editar regras calls back', async () => {
  const user = userEvent.setup();
  const onEditRules = vi.fn();
  render(<Footer state={STATE} effective={FIRED} locale="pt-BR" onEditRules={onEditRules} />);
  await user.click(screen.getByRole('button', { name: /semana ≥ 90%/ }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /até resetar/ }));
  await posted('/rules/disable', { source: 'week', percent: 90, until: { kind: 'reset' } });

  await user.click(screen.getByRole('button', { name: /semana ≥ 90%/ }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'personalizado…' }));
  const apply = screen.getByRole('button', { name: 'pausar' });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText('pausar até'), { target: { value: '2999-01-02T09:30' } });
  await user.click(apply);
  await posted('/rules/disable', { source: 'week', percent: 90, until: { kind: 'at', at: new Date(2999, 0, 2, 9, 30).toISOString() } });

  await user.click(screen.getByRole('button', { name: /semana ≥ 90%/ }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'editar regras em configurar' }));
  expect(onEditRules).toHaveBeenCalledOnce();
});

test('a paused rule: struck through, pausada with the time left, and its popover offers retomar agora, which re-enables it', async () => {
  const user = userEvent.setup();
  const backAt = new Date(Date.now() + 52 * 60_000 + 30_000).toISOString();
  render(<Footer state={STATE} effective={{ ...NONE, disabledRules: [{ rule: WEEK_CAP, until: 'at', backAt, estimate: false }] }} locale="pt-BR" />);
  const chip = screen.getByRole('button', { name: /semana ≥ 90%/ });
  expect(chip).toHaveClass('line-through');
  expect(footer()).toHaveTextContent('pausada · 52 min');
  await user.click(chip);
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'retomar agora' }));
  await posted('/rules/enable', { source: 'week', percent: 90 });
});

test('shut down when done asks first; armed, the footer says so in waiting and cancelar posts the release at once', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  await user.click(screen.getByRole('button', { name: 'desligar ao terminar' }));
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: t('shutdown.arm') }));
  await posted('/shutdown', { armed: true });
  rerender(<Footer state={{ ...STATE, shutdown: { armedAt: '2026-09-28T10:00:00Z' } }} effective={NONE} locale="pt-BR" />);
  expect(screen.getByText('desligando quando os workers terminarem')).toHaveClass('text-waiting');
  await user.click(screen.getByRole('button', { name: 'cancelar' }));
  await posted('/shutdown', { armed: false });
});

test('the effect is read from the signal\'s row: what it holds back, joined; a row that holds nothing back reads like green; green says nothing (#727)', () => {
  const { rerender } = render(<Footer state={STATE} effective={FIRED} locale="pt-BR" />);
  expect(footer()).toHaveTextContent('tarefas novas só de árvore iniciada');
  rerender(<Footer state={STATE} effective={{ ...FIRED, signal: 'red' }} locale="pt-BR" />);
  expect(footer()).toHaveTextContent('sem tarefas novas · nada segue');
  const open = { ...SIGNALS_DEFAULTS, yellow: { newTasks: 'always' as const, started: 'resumeAndContinue' as const, workerless: true } };
  rerender(<Footer state={{ ...STATE, signals: open }} effective={FIRED} locale="pt-BR" />);
  expect(footer()).toHaveTextContent('como green');
  rerender(<Footer state={STATE} effective={NONE} locale="pt-BR" />);
  expect(footer()).not.toHaveTextContent('como green');
  expect(within(footer()).queryByRole('button', { name: 'auto desligado' })).not.toBeInTheDocument();
});

test('an estimated end reads with ~, and a stage rule sharing a global rule source and floor keeps its own chip', () => {
  const backAt = new Date(Date.now() + 52 * 60_000 + 30_000).toISOString();
  const WEEK_STAGE: UsageRule = { ...WEEK_CAP, stage: 'review' };
  render(<Footer state={STATE} effective={{ ...FIRED, stageCapRules: { review: [WEEK_STAGE] }, disabledRules: [{ rule: DAY_STAGE, until: 'reset', backAt, estimate: true }] }} locale="pt-BR" />);
  expect(footer()).toHaveTextContent('pausada · ~52 min');
  expect(within(footer()).getByRole('button', { name: 'semana ≥ 90% → review máx 2' })).toBeInTheDocument();
  expect(within(footer()).getByRole('button', { name: 'semana ≥ 90% → máx 2 workers' })).toBeInTheDocument();
});
