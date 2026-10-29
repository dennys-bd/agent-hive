import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ExecutionSection, searchEntries } from '@/components/settings/ExecutionSection';
import { setLanguage, t } from '@/i18n';
import { draftFrom } from '@/lib/settings-form';
import { agentName, ALL_AGENTS } from '../../src/agents';
import { AGENT_IDS, type AgentAvailability, DELETE_ACTIVITY_DEFAULTS } from '../../src/types';

beforeEach(() => setLanguage('pt'));

const FOUND: AgentAvailability[] = [{ agent: 'claude', available: true }];

test('the agents card hint ends in a link that opens the Flow tab (#527)', () => {
  const onOpenFlow = vi.fn();
  render(<ExecutionSection draft={draftFrom(undefined)} agents={FOUND} onChange={vi.fn()} onOpenFlow={onOpenFlow} />);
  fireEvent.click(within(screen.getByRole('region', { name: t('settings.agents') })).getByRole('button', { name: t('settings.section.flow') }));
  expect(onOpenFlow).toHaveBeenCalledTimes(1);
});

test('execução stacks its four cards full width, in order: agents, sessions and waiting, branches, delete activity (#778)', () => {
  render(<ExecutionSection draft={draftFrom(undefined)} agents={FOUND} onChange={vi.fn()} onOpenFlow={vi.fn()} />);
  const titles = [t('settings.agents'), t('settings.group.waiting'), t('settings.group.branches'), t('settings.deleteActivity')];
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(titles);
  const [agent, sessions, branches] = titles.slice(0, 3).map((name) => screen.getByRole('region', { name }));
  expect(agent.parentElement).toBe(branches.parentElement);
  expect(sessions.parentElement).toBe(branches.parentElement);
  expect(document.querySelector('.md\\:grid-cols-2')).toBeNull();
});

function renderSection(): void {
  render(<ExecutionSection draft={draftFrom(undefined)} agents={FOUND} onChange={vi.fn()} onOpenFlow={vi.fn()} />);
}

test('the branches card explains itself, lists the tokens as chips and shows the base branch hint (#527)', () => {
  renderSection();
  const card = screen.getByRole('region', { name: t('settings.group.branches') });
  expect(within(card).getByText(t('settings.group.branches.hint'))).toBeInTheDocument();
  expect(within(card).getByText(t('settings.branch.insert'))).toBeInTheDocument();
  for (const token of ['{id}', '{title}', '{slug}']) expect(within(card).getByText(token)).toBeInTheDocument();
  expect(within(card).getByText(t('settings.baseBranch.hint'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.baseBranch'))).toHaveAttribute('placeholder', t('settings.baseBranch.auto'));
});

test('the delete activity card carries its hint and three switches, sessions, transcripts and tasks without auto; none for the worktree or the branch, which always go (#527, #573)', () => {
  renderSection();
  const card = screen.getByRole('region', { name: t('settings.deleteActivity') });
  expect(within(card).getByText(t('settings.deleteActivity.hint'))).toBeInTheDocument();
  for (const key of ['session', 'transcripts', 'nonAutoTasks'] as const) expect(within(card).getByRole('switch', { name: t(`settings.deleteActivity.${key}`) })).toBeInTheDocument();
  expect(within(card).getAllByRole('switch')).toHaveLength(3);
});

test('with sessions off the transcripts switch shows the tip instead of its hint (#527)', () => {
  const base = draftFrom(undefined);
  render(<ExecutionSection draft={{ ...base, deleteActivity: { ...base.deleteActivity, session: false, transcripts: false } }} agents={FOUND} onChange={vi.fn()} onOpenFlow={vi.fn()} />);
  expect(screen.getByText(t('settings.deleteActivity.transcripts.off'))).toBeInTheDocument();
  expect(screen.queryByText(t('settings.deleteActivity.transcripts.hint'))).not.toBeInTheDocument();
});

test('the delete activity card ends with tasks without auto, off in a new form, with its hint in both languages; turning it on keeps the other two (#496)', () => {
  const copy = { pt: 'tarefas sem auto também', en: 'tasks without auto too' } as const;
  for (const language of ['pt', 'en'] as const) {
    setLanguage(language);
    const onChange = vi.fn();
    const { unmount } = render(<ExecutionSection draft={draftFrom(undefined)} agents={FOUND} onChange={onChange} onOpenFlow={vi.fn()} />);
    const card = screen.getByRole('region', { name: t('settings.deleteActivity') });
    const nonAuto = within(card).getByRole('switch', { name: copy[language] });
    expect(within(card).getAllByRole('switch').at(-1)).toBe(nonAuto);
    expect(nonAuto).not.toBeChecked();
    expect(nonAuto).toBeEnabled();
    expect(within(card).getByText(t('settings.deleteActivity.nonAutoTasks.hint'))).toBeInTheDocument();
    fireEvent.click(nonAuto);
    expect(onChange).toHaveBeenCalledWith({ deleteActivity: { ...DELETE_ACTIVITY_DEFAULTS, nonAutoTasks: true } });
    unmount();
  }
});

test('sessões e espera: its hint, the table of situations with every control under today\'s ids, and the note under it (#614, #778)', () => {
  renderSection();
  const card = screen.getByRole('region', { name: 'sessões e espera' });
  expect(within(card).getByText(t('settings.sessions.hint'))).toBeInTheDocument();
  expect(within(card).getByRole('table')).toBeInTheDocument();
  expect(within(card).getByText(t('settings.sessions.note'))).toBeInTheDocument();
  const ids = Array.from(card.querySelectorAll('[id^="settings-"]'), (el) => el.id);
  expect(ids).toEqual([
    'settings-close-session-tab', 'settings-close-session-tab-notice', 'settings-close-stage-tab', 'settings-close-stage-tab-notice', 'settings-close-terminal-tab', 'settings-close-terminal-tab-notice',
    'settings-sleep-notice', 'settings-sleep-all-notice', 'settings-sleep-auto-notice', 'settings-shutdown-idle', 'settings-sleep-idle-notice', 'settings-approval-minutes', 'settings-rate-limit-wait',
  ]);
});


test('the agents card holds one arguments field per agent, named after it, each with its hint, and editing one sends its text (#924)', () => {
  const onChange = vi.fn();
  render(<ExecutionSection draft={draftFrom(undefined)} agents={ALL_AGENTS} onChange={onChange} onOpenFlow={vi.fn()} />);
  const card = screen.getByRole('region', { name: t('settings.agents') });
  for (const agent of AGENT_IDS) expect(within(card).getByLabelText(t('settings.agentArgs', { agent: agentName(agent) }))).toBeInTheDocument();
  expect(within(card).getAllByRole('textbox')).toHaveLength(AGENT_IDS.length);
  expect(within(card).getAllByText(t('settings.agentArgs.hint'))).toHaveLength(AGENT_IDS.length);
  fireEvent.change(within(card).getByLabelText(t('settings.agentArgs', { agent: 'claude' })), { target: { value: '--verbose' } });
  expect(onChange).toHaveBeenCalledWith({ agentArgs: { claude: '--verbose', codex: '' } });
});

test('the search lists the agents card and, per agent, its model, its arguments and its switch (#482)', () => {
  const labels = searchEntries().map((e) => (typeof e.label === 'string' ? e.label : 'key' in e.label ? e.label.key : e.label.raw));
  expect(labels).toEqual(expect.arrayContaining(['settings.agents', 'settings.agents.model.of', 'settings.agentArgs', 'settings.agents.enabled.of']));
  expect(labels).not.toContain('settings.defaultAgent');
});
