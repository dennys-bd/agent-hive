import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RulesButton } from '@/components/footer/RulesButton';
import { setLanguage } from '@/i18n';
import type { EffectiveLimits, State, UsageRule } from '../../src/types';
import { DAY_STAGE, FIRED, NONE, SESSION_FORCE, STATE, WEEK_CAP } from './rules-fixtures';

const RULES: State = { ...STATE, usageRules: [DAY_STAGE, WEEK_CAP, SESSION_FORCE] };
const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const posted = (path: string, body: unknown) => waitFor(() => expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ body: JSON.stringify(body) })));
const button = (props: Partial<{ state: State; effective: EffectiveLimits; onEditRules(): void }> = {}) =>
  <RulesButton state={props.state ?? RULES} effective={props.effective ?? FIRED} locale="pt-BR" form="full" onEditRules={props.onEditRules} />;
const PANEL = { name: 'regras de uso' } as const;
const PAUSE = { name: 'pausar regra' } as const;

// Opens the panel, then the pause popover of the row the pattern names; returns the pause popover.
async function openRow(user: ReturnType<typeof userEvent.setup>, row: RegExp): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: /^regras/ }));
  await user.click(within(await screen.findByRole('dialog', PANEL)).getByRole('button', { name: row }));
  return screen.findByRole('dialog', PAUSE);
}

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the button names the effects in force with a valendo title; short keeps the first and +n; nothing fired reads nenhuma ativa in muted, no title', () => {
  const { rerender } = render(button());
  expect(screen.getByRole('button', { name: 'regras máx 2 workers · review 1 · sinal yellow' })).toHaveAttribute('title', 'valendo: máx 2 workers · review 1 · sinal yellow');
  rerender(<RulesButton state={RULES} effective={FIRED} locale="pt-BR" form="short" />);
  expect(screen.getByRole('button', { name: 'regras máx 2 workers +2' })).toBeInTheDocument();
  rerender(button({ state: STATE, effective: NONE }));
  expect(screen.getByRole('button', { name: 'regras nenhuma ativa' })).not.toHaveAttribute('title');
  expect(screen.getByText('nenhuma ativa')).toHaveClass('text-muted-foreground');
});

test('a click opens the panel; Escape closes it', async () => {
  const user = userEvent.setup();
  render(button());
  await user.click(screen.getByRole('button', { name: /^regras/ }));
  expect(await screen.findByRole('dialog', PANEL)).toHaveTextContent('3 regras · 3 dispararam');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', PANEL)).not.toBeInTheDocument());
});

test('a row opens pausar regra: até resetar shows the window countdown, até amanhã the next 07:00; 1 h posts a pause an hour ahead and the panel stays open', async () => {
  const user = userEvent.setup();
  const before = Date.now(); // the popover reads the clock when it renders
  render(button());
  const pause = await openRow(user, /90% → limitar workers a 2/);
  expect(within(pause).getByRole('button', { name: /até resetar/ })).toHaveTextContent('4d10h');
  expect(within(pause).getByRole('button', { name: /até amanhã/ })).toHaveTextContent('07:00');
  expect(within(pause).queryByRole('button', { name: 'retomar agora' })).not.toBeInTheDocument();
  await user.click(within(pause).getByRole('button', { name: '1 h' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [path, init] = fetchMock.mock.lastCall ?? [];
  const body = JSON.parse(String(init?.body));
  expect(path).toBe('/rules/disable');
  expect(body).toMatchObject({ source: 'week', percent: 90, until: { kind: 'at' } });
  expect(Date.parse(body.until.at) - before).toBeGreaterThanOrEqual(3_600_000);
  await waitFor(() => expect(screen.queryByRole('dialog', PAUSE)).not.toBeInTheDocument());
  expect(screen.getByRole('dialog', PANEL)).toBeInTheDocument();
});

test('até resetar posts a reset pause; personalizado… posts the picked time', async () => {
  const user = userEvent.setup();
  render(button());
  await user.click(within(await openRow(user, /90% → limitar workers a 2/)).getByRole('button', { name: /até resetar/ }));
  await posted('/rules/disable', { source: 'week', percent: 90, until: { kind: 'reset' } });
  const panel = screen.getByRole('dialog', PANEL);
  await user.click(within(panel).getByRole('button', { name: /90% → limitar workers a 2/ }));
  await user.click(within(await screen.findByRole('dialog', PAUSE)).getByRole('button', { name: 'personalizado…' }));
  const apply = screen.getByRole('button', { name: 'pausar' });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText('pausar até'), { target: { value: '2999-01-02T09:30' } });
  await user.click(apply);
  await posted('/rules/disable', { source: 'week', percent: 90, until: { kind: 'at', at: new Date(2999, 0, 2, 9, 30).toISOString() } });
});

test('editar… and a row\'s editar regras both close the panel, then open the rules', async () => {
  const user = userEvent.setup();
  const onEditRules = vi.fn();
  render(button({ onEditRules }));
  await user.click(screen.getByRole('button', { name: /^regras/ }));
  await user.click(within(await screen.findByRole('dialog', PANEL)).getByRole('button', { name: 'editar…' }));
  expect(onEditRules).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole('dialog', PANEL)).not.toBeInTheDocument());
  await user.click(within(await openRow(user, /90% → limitar workers a 2/)).getByRole('button', { name: 'editar regras em configurar' }));
  expect(onEditRules).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('a paused rule\'s popover offers retomar agora, which re-enables it', async () => {
  const user = userEvent.setup();
  render(button({ effective: { ...NONE, disabledRules: [{ rule: WEEK_CAP, until: 'manual', estimate: false }] } }));
  await user.click(within(await openRow(user, /90% → limitar workers a 2/)).getByRole('button', { name: 'retomar agora' }));
  await posted('/rules/enable', { source: 'week', percent: 90 });
});

test('a non-default agent\'s rule posts its agent with its pause and its resume (#929)', async () => {
  const user = userEvent.setup();
  const codexWeek: UsageRule = { ...WEEK_CAP, agent: 'codex' };
  const state: State = { ...STATE, usageRules: [codexWeek] };
  const { unmount } = render(button({ state, effective: { ...NONE, floor: { signal: 'green', maxWorkers: 2 }, capRules: [codexWeek] } }));
  await user.click(within(await openRow(user, /90% → limitar workers a 2/)).getByRole('button', { name: /até resetar/ }));
  await posted('/rules/disable', { source: 'week', percent: 90, agent: 'codex', until: { kind: 'reset' } });
  unmount();
  render(button({ state, effective: { ...NONE, disabledRules: [{ rule: codexWeek, until: 'manual', estimate: false }] } }));
  await user.click(within(await openRow(user, /90% → limitar workers a 2/)).getByRole('button', { name: 'retomar agora' }));
  await posted('/rules/enable', { source: 'week', percent: 90, agent: 'codex' });
});
