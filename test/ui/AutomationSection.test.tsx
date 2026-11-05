import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AutomationSection } from '@/components/tasks/AutomationSection';
import { SignalsContext, signalsSaver } from '@/hooks/use-signals';
import { setLanguage, t } from '@/i18n';
import type { RuleSignal, Signal, SignalSettings, State } from '../../src/types';
import { SIGNALS_DEFAULTS } from '../../src/types';
import { workerCount } from '../../src/worker-count';
import { SIDEBAR_STATE } from './sidebar-fixtures.js';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const PREFIX = 'HIVE';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let settingsAnswer = (): Response => json({ ok: true });
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (String(input) === '/settings' ? settingsAnswer() : json({ ok: true })));
const reload = vi.fn(async () => undefined);
const posted = (path: string): unknown[] => fetchMock.mock.calls.filter(([url]) => String(url) === path).map(([, init]) => JSON.parse(String(init?.body)));

const stateOf = (signal: Signal, signals: SignalSettings = SIGNALS_DEFAULTS): State => ({ ...SIDEBAR_STATE, signal, signals });
const section = (state: State) => (
  <SignalsContext.Provider value={{ save: signalsSaver(PREFIX, reload) }}><AutomationSection state={state} /></SignalsContext.Provider>
);
const newTasks = (signal: Signal): string => t('settings.signal.newTasks.control', { signal });
const started = (signal: RuleSignal): string => t('settings.signal.control', { row: t('settings.signal.started'), signal });
const workerless = (signal: RuleSignal): string => t('settings.signal.control', { row: t('settings.signal.workerless'), signal });
const controls = (): string[] => [...screen.queryAllByRole('combobox'), ...screen.queryAllByRole('switch')].map((c) => c.getAttribute('aria-label') ?? '');

beforeEach(() => {
  setLanguage('en');
  settingsAnswer = () => json({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  reload.mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test('only the active signal\'s three rows render, each with its tooltip; green shows started and workerless as fixed text (#573)', () => {
  const { rerender } = render(section(stateOf('green')));
  expect(controls()).toEqual([newTasks('green')]);
  expect(screen.getByTitle(`${t('settings.signal.newTasks.hint')} · ${t('settings.signal.newTasks.treeHint')}`)).toHaveTextContent(t('settings.signal.newTasks'));
  expect(screen.getByTitle(t('settings.signal.started.hint'))).toHaveTextContent(`${t('settings.signal.started')}${t('settings.signal.started.resumeAndContinue')}`);
  expect(screen.getByTitle(t('settings.signal.workerless.hint'))).toHaveTextContent(`${t('tasks.automation.workerless')}${t('settings.signal.always')}`);
  rerender(section(stateOf('yellow')));
  expect(controls()).toEqual([newTasks('yellow'), started('yellow'), workerless('yellow')]);
  expect(screen.getByRole('combobox', { name: newTasks('yellow') })).toHaveTextContent(t('settings.signal.newTasks.tree'));
  rerender(section(stateOf('red')));
  expect(controls()).toEqual([newTasks('red'), started('red'), workerless('red')]);
  expect(screen.getByRole('combobox', { name: started('red') })).toHaveTextContent(t('settings.signal.started.stay'));
});

test('changing yellow\'s started posts { prefix, signals } with yellow patched and red clamped, then reloads the settings info (#573)', async () => {
  const signals: SignalSettings = { ...SIGNALS_DEFAULTS, red: { ...SIGNALS_DEFAULTS.red, started: 'continueOnly' } };
  render(section(stateOf('yellow', signals)));
  fireEvent.click(screen.getByRole('combobox', { name: started('yellow') }));
  fireEvent.click(await screen.findByRole('option', { name: t('settings.signal.started.stay') }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(posted('/settings')).toEqual([{ prefix: PREFIX, signals: { ...signals, yellow: { ...signals.yellow, started: 'stay' }, red: { ...signals.red, started: 'stay' } } }]);
});

test('an option the order would refuse is disabled: red is not offered more than yellow (#573)', async () => {
  render(section(stateOf('red')));
  fireEvent.click(screen.getByRole('combobox', { name: newTasks('red') }));
  expect(await screen.findByRole('option', { name: t('settings.signal.newTasks.always') })).toHaveAttribute('aria-disabled', 'true');
  expect(await screen.findByRole('option', { name: t('settings.signal.newTasks.tree') })).not.toHaveAttribute('aria-disabled');
});

test('a refused save is the i18n toast, the raw error goes to the console, and the control keeps the state\'s value (#573)', async () => {
  settingsAnswer = () => json({ error: 'raw server text' }, 400);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(section(stateOf('yellow')));
  fireEvent.click(screen.getByRole('combobox', { name: started('yellow') }));
  fireEvent.click(await screen.findByRole('option', { name: t('settings.signal.started.continueOnly') }));
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('tasks.automation.notSaved')));
  expect(errorSpy).toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: started('yellow') })).toHaveTextContent(t('settings.signal.started.resumeAndContinue'));
  errorSpy.mockRestore();
});

test('clicking red in the toggle posts /signal (#573)', async () => {
  const user = userEvent.setup();
  render(section(stateOf('green')));
  await user.click(screen.getByRole('radio', { name: 'red' }));
  expect(fetchMock).toHaveBeenCalledWith('/signal', expect.objectContaining({ method: 'POST', body: JSON.stringify({ signal: 'red' }) }));
});

test('the foot reads workers {active}/{max}, then max. with the editable field (#573)', () => {
  render(section(stateOf('green')));
  expect(screen.getByText(t('header.workers', { active: workerCount(SIDEBAR_STATE.workers), max: SIDEBAR_STATE.maxConcurrent }))).toBeInTheDocument();
  expect(screen.getByLabelText(t('footer.max'))).toHaveValue(SIDEBAR_STATE.maxConcurrent);
});
