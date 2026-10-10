import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SessionsTable } from '@/components/settings/SessionsTable';
import { type MessageKey, setLanguage, t } from '@/i18n';
import { draftFrom, type SettingsDraft } from '@/lib/settings-form';
import { setShortcuts } from '@/lib/shortcut-bindings';
import { APPROVAL_HOLD_MAX_MIN, RATE_LIMIT_WAIT_MAX, SHUTDOWN_IDLE_MAX } from '../../src/types';

beforeEach(() => setLanguage('pt'));
afterEach(() => { setShortcuts({}); vi.restoreAllMocks(); });

// The spec's row order (#778): what you do first, then what the Hive does on its own.
const ROWS = ['closeSession', 'closeStage', 'closeTerminal', 'sleep', 'sleepAll', 'auto', 'idle', 'approval', 'rateLimit'] as const;
type Row = (typeof ROWS)[number];
const situation = (row: Row): string => t(`settings.sessions.${row}`);
const warnName = (row: Row): string => `${situation(row)} ${t('settings.sessions.col.warn')}`;
const rowOf = (row: Row): HTMLElement => within(screen.getByRole('table')).getAllByRole('row')[ROWS.indexOf(row) + 1]; // 0 is the header

function renderTable(patch: Partial<SettingsDraft> = {}) {
  const onChange = vi.fn();
  render(<SessionsTable draft={{ ...draftFrom(undefined), ...patch }} onChange={onChange} />);
  return onChange;
}

function openSelect(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
}

test('a header and nine rows, what you do before what the Hive does on its own, each with its situation, and the note, in both languages (#778)', () => {
  for (const language of ['pt', 'en'] as const) {
    setLanguage(language);
    const { unmount } = render(<SessionsTable draft={draftFrom(undefined)} onChange={vi.fn()} />);
    const [header, ...rows] = within(screen.getByRole('table')).getAllByRole('row');
    expect(within(header).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([t('settings.sessions.col.when'), t('settings.sessions.col.what'), t('settings.sessions.col.warn')]);
    expect(rows).toHaveLength(ROWS.length);
    rows.forEach((row, i) => {
      expect(within(row).getAllByRole('cell')[0]).toHaveTextContent(situation(ROWS[i]));
    });
    if (language === 'pt') expect(rows[0]).toHaveTextContent('você fecha a aba de uma sessão livre');
    expect(screen.getByText(t('settings.sessions.note'))).toBeInTheDocument();
    unmount();
  }
});

const SELECTS = [
  { row: 'closeSession', id: 'settings-close-session-tab', key: 'closeSessionTab', options: ['settings.closeTab.keep', 'settings.closeTab.sleep'] },
  { row: 'closeStage', id: 'settings-close-stage-tab', key: 'closeStageTab', options: ['settings.closeTab.keep', 'settings.closeTab.sleep'] },
  { row: 'closeTerminal', id: 'settings-close-terminal-tab', key: 'closeTerminalTab', options: ['settings.closeTab.terminal.keep', 'settings.closeTab.terminal.sleep'] },
] as const;

test.each(SELECTS)('the $row select, named by its situation, reads and writes $key under #$id with its own options (#614, #696, #778)', async ({ row, id, key, options }) => {
  const onChange = renderTable({ closeSessionTab: 'sleep', closeStageTab: 'sleep', closeTerminalTab: 'sleep' });
  const select = within(rowOf(row)).getByRole('combobox', { name: situation(row) });
  expect(select).toHaveAttribute('id', id);
  expect(select).toHaveTextContent(t(options[1]));
  openSelect(select);
  const items = await screen.findAllByRole('option');
  expect(items.map((item) => item.textContent)).toEqual(options.map((option) => t(option)));
  fireEvent.click(screen.getByRole('option', { name: t(options[0]) }));
  expect(onChange).toHaveBeenLastCalledWith({ [key]: 'keep' });
});

const SWITCHES = [
  ['closeSession', 'settings-close-session-tab-notice', 'closeSessionTabNotice'],
  ['closeStage', 'settings-close-stage-tab-notice', 'closeStageTabNotice'],
  ['closeTerminal', 'settings-close-terminal-tab-notice', 'closeTerminalTabNotice'],
  ['sleep', 'settings-sleep-notice', 'sleepNotice'],
  ['sleepAll', 'settings-sleep-all-notice', 'sleepAllNotice'],
  ['auto', 'settings-sleep-auto-notice', 'sleepAutoNotice'],
  ['idle', 'settings-sleep-idle-notice', 'sleepIdleNotice'],
] as const;
const ALL_OFF = { closeSessionTabNotice: false, closeStageTabNotice: false, closeTerminalTabNotice: false, sleepNotice: false, sleepAllNotice: false, sleepAutoNotice: false, sleepIdleNotice: false };

test('the seven notice switches sit in their row, each named by its situation and the avisar header, reading and writing its own key (#614, #672, #696, #778)', () => {
  const onChange = renderTable(ALL_OFF);
  for (const [row, id, key] of SWITCHES) {
    const notice = within(rowOf(row)).getByRole('switch', { name: warnName(row) });
    expect(notice).toHaveAttribute('id', id);
    expect(notice).not.toBeChecked();
    fireEvent.click(notice);
    expect(onChange).toHaveBeenLastCalledWith({ [key]: true });
  }
});

const FIELDS = [
  { row: 'idle', id: 'settings-shutdown-idle', key: 'shutdownIdleMinutes', label: 'settings.shutdownIdle', max: SHUTDOWN_IDLE_MAX },
  { row: 'approval', id: 'settings-approval-minutes', key: 'approvalMinutes', label: 'settings.approvalMinutes', max: APPROVAL_HOLD_MAX_MIN },
  { row: 'rateLimit', id: 'settings-rate-limit-wait', key: 'rateLimitWaitMinutes', label: 'settings.rateLimitWait', max: RATE_LIMIT_WAIT_MAX },
] as const;

test('the three minute fields sit inside their row\'s sentence with no visible label, named by their old label, reading and writing their own key (#233, #268, #805, #778)', () => {
  const onChange = renderTable({ shutdownIdleMinutes: '7', approvalMinutes: '8', rateLimitWaitMinutes: '9' });
  FIELDS.forEach(({ row, id, key, label, max }, i) => {
    const field = within(rowOf(row)).getByRole('spinbutton', { name: t(label) });
    expect(field).toHaveAttribute('id', id);
    expect(field).toHaveAttribute('max', String(max));
    expect(field).toHaveValue(7 + i);
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(t(label))).not.toBeInTheDocument();
    expect(within(rowOf(row)).getByText(t(`settings.sessions.${row}.before`))).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith({ [key]: '30' });
  });
});

const INVALID: readonly [string, Partial<SettingsDraft>, MessageKey][] = [
  ['0 minutes of idle', { shutdownIdleMinutes: '0' }, 'settings.shutdownIdle'],
  ['a plan-limit wait one minute over the max', { rateLimitWaitMinutes: String(RATE_LIMIT_WAIT_MAX + 1) }, 'settings.rateLimitWait'],
  ['letters for the approval window', { approvalMinutes: 'abc' }, 'settings.approvalMinutes'],
];

test.each(INVALID)('%s marks only that row\'s field invalid (#778)', (_case, patch, label) => {
  renderTable(patch);
  for (const field of FIELDS) {
    const input = screen.getByRole('spinbutton', { name: t(field.label) });
    if (field.label === label) expect(input).toHaveAttribute('aria-invalid', 'true');
    else expect(input).not.toHaveAttribute('aria-invalid');
  }
});

const HELP = [
  { row: 'idle', hint: 'settings.shutdownIdle.hint' },
  { row: 'approval', hint: 'settings.approvalMinutes.hint' },
  { row: 'rateLimit', hint: 'settings.rateLimitWait.hint' },
] as const;

// Radix draws the content twice (visible, and a visually hidden role="tooltip" copy): read the role, not the text.
test.each(HELP)('row $row\'s ? shows $hint in a tooltip on keyboard focus; the hint is not on the page before (#778)', async ({ row, hint }) => {
  renderTable();
  expect(screen.queryByText(t(hint))).not.toBeInTheDocument();
  fireEvent.focus(within(rowOf(row)).getByRole('button', { name: situation(row) }));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(t(hint));
});

test('rows 1 to 6 have no ?: the only buttons in the table are the three hints of rows 7 to 9 (#778)', () => {
  renderTable();
  const buttons = within(screen.getByRole('table')).getAllByRole('button');
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(HELP.map(({ row }) => situation(row)));
});

test('the approval and plan-limit rows have no notice: a dash in the avisar column and no switch (#778)', () => {
  renderTable();
  for (const row of ['approval', 'rateLimit'] as const) {
    expect(within(rowOf(row)).getAllByRole('cell')[2]).toHaveTextContent(/^—$/);
    expect(within(rowOf(row)).queryByRole('switch')).not.toBeInTheDocument();
  }
  expect(screen.getAllByRole('switch')).toHaveLength(SWITCHES.length);
});

test('row 4 names the sleepSession key as bound on this platform, and drops it while the shortcut is off (#778)', () => {
  renderTable(); // jsdom's platform is not macOS: CmdOrCtrl+Shift+. reads Ctrl+Shift+.
  expect(within(rowOf('sleep')).getByText('pelo menu, pela barra da atividade ou Ctrl+Shift+.')).toBeInTheDocument();
  cleanup();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  renderTable();
  expect(within(rowOf('sleep')).getByText('pelo menu, pela barra da atividade ou ⌘.')).toBeInTheDocument();
  cleanup();
  setShortcuts({ sleepSession: null });
  renderTable();
  expect(within(rowOf('sleep')).getByText('pelo menu ou pela barra da atividade')).toBeInTheDocument();
});
