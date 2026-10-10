import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { Settings } from '@/components/settings/Settings';
import { ShortcutsTab } from '@/components/settings/ShortcutsTab';
import { type MessageKey, setLanguage, t } from '@/i18n';
import type { SettingsSection } from '@/lib/settings-sections';
import { SHORTCUT_MAP, SHORTCUT_SCOPES } from '../../src/shortcut-registry';
import type { SettingsInfo } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, EDITOR_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const open = (user: UserEvent, s: SettingsSection) => user.click(screen.getByRole('button', { name: t(`settings.section.${s}`) }));
const h1 = () => screen.getByRole('heading', { level: 1 });

// Settings › atalhos (#513). jsdom's platform is not macOS: CmdOrCtrl reads and records as Ctrl.
const TOGGLE = 'abrir ou fechar o painel da direita';
const LEFT = 'abrir ou fechar o painel da esquerda';
const CLEAR = 'limpar o terminal';
const CONFIRM = 'confirmar: executar etapas, abrir sessão, enviar e começar agora';
const WARNING = 'aviso: o programa do terminal não recebe esta tecla';
const row = (name: string) => within(screen.getByRole('group', { name }));
const chip = (name: string): HTMLElement => screen.getByRole('button', { name: t('shortcuts.record', { name }) });

// A configured Hive with no board, so nothing but a save would reach fetch
const info: SettingsInfo = {
  configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }],
  config: {
    auth: { github: 'cli' },
    comb: { prefix: 'HIVE', hiveSource: true, createIn: 'hive', workspaces: [{ name: 'hive', path: '/repo', env: {}, fork: null }], sources: [], transitions: [], stages: [{ name: 'fila', from: {} }], commands: [] },
    epics: 'ignore', logLevel: 'info', claudeArgs: [], budget: {}, usageRules: [],
    onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: EDITOR_DEFAULTS,
  },
};
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('clicking a chip starts recording: a lone modifier waits, an invalid combination says so and keeps recording (#513)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ShortcutsTab shortcuts={{ clear: null }} onChange={onChange} />);
  expect(chip(TOGGLE)).toHaveTextContent('Ctrl+Alt+Shift+B');
  expect(chip(CLEAR)).toHaveTextContent('desligado');
  await user.click(chip(TOGGLE));
  expect(chip(TOGGLE)).toHaveTextContent(t('shortcuts.recording'));
  await user.keyboard('{Shift}');
  expect(screen.queryByText(t('shortcuts.invalid'))).not.toBeInTheDocument();
  await user.keyboard('j');
  expect(screen.getByText(t('shortcuts.invalid'))).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  await user.keyboard('{Control>}{Shift>}t{/Shift}{/Control}');
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ clear: null, toggleRight: 'CmdOrCtrl+Shift+T' });
  expect(screen.queryByText(t('shortcuts.invalid'))).not.toBeInTheDocument();
  await user.keyboard('{Control>}k{/Control}');
  expect(onChange).toHaveBeenCalledOnce(); // the first binding ended the recording
});

test('Tab moves the focus off a chip without recording, and focus alone never starts one (#513)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ShortcutsTab shortcuts={{}} onChange={onChange} />);
  await user.click(chip(TOGGLE));
  await user.tab();
  expect(chip(TOGGLE)).not.toHaveFocus();
  expect(chip(TOGGLE)).toHaveTextContent('Ctrl+Alt+Shift+B'); // no longer recording
  expect(onChange).not.toHaveBeenCalled();

  await user.tab({ shift: true }); // focus lands back on the chip, without a click
  await user.keyboard('{Control>}k{/Control}');
  expect(onChange).not.toHaveBeenCalled();
});

test('restaurar drops the id, × sets null and restaurar todos empties the map; each row shows only the buttons that change something (#513)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ShortcutsTab shortcuts={{ toggleRight: 'CmdOrCtrl+Shift+T', clear: null }} onChange={onChange} />);
  expect(row(LEFT).queryByRole('button', { name: t('shortcuts.reset') })).not.toBeInTheDocument(); // on its default
  expect(row(CLEAR).queryByRole('button', { name: t('shortcuts.off') })).not.toBeInTheDocument(); // already off
  await user.click(row(TOGGLE).getByRole('button', { name: t('shortcuts.reset') }));
  expect(onChange).toHaveBeenLastCalledWith({ clear: null });
  await user.click(row(LEFT).getByRole('button', { name: t('shortcuts.off') }));
  expect(onChange).toHaveBeenLastCalledWith({ toggleRight: 'CmdOrCtrl+Shift+T', clear: null, toggleLeft: null });
  const resetAll = screen.getByRole('button', { name: t('shortcuts.resetAll') });
  await user.click(resetAll);
  expect(onChange).toHaveBeenLastCalledWith({});
});

test('restaurar todos is disabled with no change (#513)', () => {
  render(<ShortcutsTab shortcuts={{}} onChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: t('shortcuts.resetAll') })).toBeDisabled();
});

test('an in-terminal shortcut on a key the terminal\'s program reads shows the muted warning under its row; one outside the terminal does not; off macOS the defaults on an F key and the shortcut map\'s Ctrl+/ warn (#513, #585, #639)', () => {
  const { unmount } = render(<ShortcutsTab shortcuts={{ toggleRight: 'Ctrl+W', confirm: 'Shift+Tab' }} onChange={vi.fn()} />);
  expect(row(TOGGLE).getByText(WARNING)).toHaveClass('text-muted-foreground');
  expect(row(CONFIRM).queryByText(WARNING)).not.toBeInTheDocument(); // the feedback box is never a terminal
  unmount();
  render(<ShortcutsTab shortcuts={{}} onChange={vi.fn()} />);
  const warned = screen.getAllByText(WARNING).map((w) => w.closest('fieldset')?.getAttribute('aria-label'));
  // F1 and F11 are keys a terminal program reads, and Ctrl+/ is one too (Ctrl+punctuation): kept, with the warning (#585, #639)
  expect(warned).toEqual([t('shortcuts.searchOperations'), t('shortcuts.shortcutMap'), t('shortcuts.fullScreen')]);
});

test('rows sit under the four scopes in the map\'s order (#585)', () => {
  render(<ShortcutsTab shortcuts={{}} onChange={vi.fn()} />);
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings).toEqual(SHORTCUT_SCOPES.map((scope) => t(`shortcuts.scope.${scope}`)));
  const rows = (group: MessageKey) => within(screen.getByRole('region', { name: t(group) })).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
  for (const scope of SHORTCUT_SCOPES) {
    expect(rows(`shortcuts.scope.${scope}`)).toEqual(SHORTCUT_MAP.filter((row) => row.scope === scope).map((row) => t(row.label)));
  }
  expect(chip(CONFIRM)).toHaveTextContent('Ctrl+Enter');
});

test('inside Settings, a key two shortcuts share stops the save on the atalhos tab (#513)', async () => {
  const user = userEvent.setup();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await open(user, 'shortcuts');
  await user.click(chip(LEFT));
  await user.keyboard('{Control>}{Alt>}{Shift>}b{/Shift}{/Alt}{/Control}'); // toggleRight's default off macOS
  expect(chip(LEFT)).toHaveTextContent('Ctrl+Alt+Shift+B');
  await user.click(screen.getByRole('button', { name: t('settings.save') }));
  // toggleLeft sits before toggleRight in the registry, so the pair names it first.
  expect(await screen.findByText(t('settings.error.shortcutCollision', { a: LEFT, b: TOGGLE }))).toBeInTheDocument();
  expect(h1()).toHaveTextContent('atalhos');
  expect(fetchMock).not.toHaveBeenCalledWith('/settings', expect.anything());
});

test('Escape while recording cancels it, with or without modifiers: the chip shows its binding again and keeps the focus, nothing changes, and the key goes no further (#481)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const bubbled = vi.fn();
  document.addEventListener('keydown', bubbled);
  onTestFinished(() => document.removeEventListener('keydown', bubbled));
  render(<ShortcutsTab shortcuts={{}} onChange={onChange} />);
  await user.click(chip(TOGGLE));
  expect(chip(TOGGLE)).toHaveTextContent('pressione as teclas… (Esc cancela)');
  await user.keyboard('j');
  expect(screen.getByText(t('shortcuts.invalid'))).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(chip(TOGGLE)).toHaveTextContent('Ctrl+Alt+Shift+B');
  expect(chip(TOGGLE)).toHaveFocus();
  expect(screen.queryByText(t('shortcuts.invalid'))).not.toBeInTheDocument();
  await user.click(chip(TOGGLE));
  await user.keyboard('{Shift>}{Escape}{/Shift}');
  expect(chip(TOGGLE)).toHaveTextContent('Ctrl+Alt+Shift+B');
  await user.keyboard('{Control>}k{/Control}'); // no longer recording: nothing is taken
  expect(onChange).not.toHaveBeenCalled();
  expect(bubbled.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')).toHaveLength(0);
});

test('inside Settings, Escape while recording only cancels the recording; the next Escape leaves Settings as before (#481)', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(<Settings info={info} onSaved={vi.fn()} onCancel={onCancel} />);
  await open(user, 'shortcuts');
  await user.click(chip(TOGGLE));
  await user.keyboard('{Escape}');
  expect(chip(TOGGLE)).toHaveTextContent('Ctrl+Alt+Shift+B');
  expect(onCancel).not.toHaveBeenCalled();
  expect(h1()).toHaveTextContent('atalhos');
  await user.keyboard('{Escape}'); // the chip is not recording and nothing changed: Settings' own Escape applies
  expect(onCancel).toHaveBeenCalledOnce();
});

test('a soon row is greyed with its planned key and (em breve): no record, no reset, no off (#585)', () => {
  render(<ShortcutsTab shortcuts={{}} onChange={vi.fn()} />);
  const soon = screen.getByRole('group', { name: t('shortcuts.nextTab') });
  expect(soon).toHaveClass('text-muted-foreground');
  expect(soon).toHaveTextContent(`${t('shortcuts.nextTab')} (em breve)`);
  expect(soon).toHaveTextContent('Ctrl+Tab');
  expect(within(soon).queryAllByRole('button')).toHaveLength(0);
});

test('a fixed row lists its keys read only, a digit range as one key; a fixed soon row says so (#585)', () => {
  render(<ShortcutsTab shortcuts={{}} onChange={vi.fn()} />);
  const signal = screen.getByRole('group', { name: t('shortcuts.fixed.signal') });
  expect(signal).toHaveTextContent('Ctrl+Shift+1–3');
  expect(within(signal).queryAllByRole('button')).toHaveLength(0);
  const tabs = screen.getByRole('group', { name: t('shortcuts.fixed.goToTab') });
  expect(tabs).toHaveTextContent('(em breve)');
  expect(tabs).toHaveTextContent('Alt+1–9');
});

test('recording this platform\'s default drops the change: reset compares to the Linux / Windows table here (#585)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ShortcutsTab shortcuts={{ toggleRight: 'CmdOrCtrl+Shift+T' }} onChange={onChange} />);
  await user.click(chip(TOGGLE));
  await user.keyboard('{Control>}{Alt>}{Shift>}b{/Shift}{/Alt}{/Control}');
  expect(onChange).toHaveBeenLastCalledWith({});
});
