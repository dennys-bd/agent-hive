import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SourceDetail, sourceEntries } from '@/components/settings/SourceDetail';
import type { JiraLoad, JiraRowOptions } from '@/hooks/use-jira-source-options';
import { type MessageKey, setLanguage, t } from '@/i18n';
import type { JiraDraft } from '@/lib/settings-jira';
import { settingAnchor } from '@/lib/settings-search';
import { type SourceDraft, type StageDraft, emptySource, emptyStage } from '@/lib/settings-form';
import type { FilterOptions, GithubAuth } from '../../src/types';
const FLOW = 'f';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

// The flow the block's switchAt picks from (#30): Build is the default, review the last stage
const STAGES: StageDraft[] = [{ ...emptyStage(FLOW), name: 'fila' }, { ...emptyStage(FLOW), name: 'Build' }, { ...emptyStage(FLOW), name: 'review' }];
const work = (): SourceDraft => ({ ...emptySource('hive'), name: 'work', number: '1' });

interface HarnessProps {
  source: SourceDraft; auth?: GithubAuth; filterOptions?: FilterOptions; stages?: StageDraft[]; onDraft(source: SourceDraft): void; onRemove(): void; onOpenList?(): void;
  jira?: JiraRowOptions; columns?: string[]; onLoadJira?(jira: JiraDraft, load: JiraLoad): void;
}

// SourceDetail is controlled: the harness holds the draft as FlowSection does and reports every patched row (was BoardDetail's harness).
function Harness({ source: initial, auth = 'cli', filterOptions, stages = STAGES, onDraft, onRemove, onOpenList = vi.fn(), jira, columns, onLoadJira = vi.fn() }: HarnessProps) {
  const [source, setSource] = useState<SourceDraft>(initial);
  const change = (patch: Partial<SourceDraft>): void => {
    const next = { ...source, ...patch };
    setSource(next);
    onDraft(next);
  };
  return (
    <SourceDetail
      source={source} flows={[{ id: FLOW, name: 'main' }]} stages={stages} workspaces={['hive', 'site']} githubProjects={[]} needsToken={false} auth={auth} filterOptions={filterOptions}
      onChange={change} onRemove={onRemove} onLoadProjects={vi.fn()} onLoadColumns={vi.fn()} jira={jira} columns={columns} onLoadJira={onLoadJira} onOpenList={onOpenList}
    />
  );
}

test('propriedades da tarefa replaces the fixo / dinâmico toggle: the defaults, then + regra, whose rule makes workspace dynamic (#688)', () => {
  const onDraft = vi.fn();
  render(<Harness source={{ ...emptySource('hive'), name: 'work', number: '1' }} onDraft={onDraft} onRemove={vi.fn()} />);

  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.getByText(t('settings.taskProps.hint'))).toBeInTheDocument();
  const [workspace] = screen.getAllByTestId('task-default-row');
  expect(within(workspace).getByText(t('settings.taskProps.mode.fixed'))).toBeInTheDocument();
  expect(screen.queryAllByTestId('task-rule')).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: t('settings.workspaceRules.add') }));

  expect(screen.getAllByTestId('task-rule')).toHaveLength(1);
  expect(within(workspace).getByText(t('settings.taskProps.mode.one'))).toBeInTheDocument();
  expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({
    taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flowId: '' } }, rules: [expect.objectContaining({ set: { workspace: 'hive' } })] },
  }));
});

test('the groups and their headings; the type is read-only; the filter caption shows only once, as the group heading (#514)', () => {
  render(<Harness source={{ ...emptySource('hive'), name: 'work', number: '1' }} onDraft={vi.fn()} onRemove={vi.fn()} />);

  for (const name of [t('settings.source.fields'), t('settings.source.filter'), t('settings.taskProps.title')]) {
    expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
  }
  expect(screen.getAllByText(t('settings.source.filter'))).toHaveLength(1);
  expect(screen.getByLabelText(t('settings.sourceType'))).toBeDisabled();
  expect(screen.getByLabelText(t('settings.sourceType'))).toHaveValue('GitHub Project');
  expect(screen.getByLabelText(t('settings.owner'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('settings.load') })).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.project'))).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: t('settings.sources.qualifyId') })).toBeInTheDocument();
  expect(screen.getByText(t('settings.sources.qualifyId.hint'))).toBeInTheDocument();
});

test('a GitHub source shows its own epics select and the note under the filter, and the connection line; mudar calls onOpenList, não mostrar patches the source (#524, #30)', () => {
  const onDraft = vi.fn();
  const onOpenList = vi.fn();
  render(<Harness source={{ ...emptySource('hive'), name: 'work', number: '1' }} auth="cli" onDraft={onDraft} onRemove={vi.fn()} onOpenList={onOpenList} />);

  expect(screen.getByLabelText(t('settings.epics'))).toHaveTextContent(t('settings.epics.show'));
  expect(screen.getByText(t('settings.source.epicsHint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.source.connection', { auth: t('settings.auth.cli') }), { exact: false })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: t('settings.source.connection.change') }));
  expect(onOpenList).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByLabelText(t('settings.epics')));
  for (const key of ['settings.epics.ignore', 'settings.epics.show', 'settings.epics.hide'] as const) {
    expect(screen.getByRole('option', { name: t(key) })).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole('option', { name: t('settings.epics.hide') }));
  expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ epics: 'hide' }));
});

test('remover source calls onRemove (#514)', () => {
  const onRemove = vi.fn();
  render(<Harness source={{ ...emptySource('hive'), name: 'work', number: '1' }} onDraft={vi.fn()} onRemove={onRemove} />);

  fireEvent.click(screen.getByRole('button', { name: t('settings.sources.remove') }));

  expect(onRemove).toHaveBeenCalledTimes(1);
});

test('a GitHub source picks its repository for new issues among the Project\'s linked ones, or none (#846)', async () => {
  const user = userEvent.setup();
  const onDraft = vi.fn();
  const filterOptions: FilterOptions = { assignees: [], labels: [], milestones: [], repositories: [], projectFields: [], linkedRepositories: ['acme/app', 'acme/site'] };
  render(<Harness source={{ ...emptySource('hive'), name: 'work', number: '1' }} filterOptions={filterOptions} onDraft={onDraft} onRemove={vi.fn()} />);
  const select = screen.getByRole('combobox', { name: t('settings.source.repository') });
  expect(select).toHaveTextContent(t('settings.source.repository.none'));
  select.focus(); // a pointer click can leave a Radix Select closed in jsdom
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: 'acme/site' }));
  expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ repository: 'acme/site' }));
});

test('the epics block: the mode with its hint, then the epic follows and switches at, both on the default, and the note at the end (#30)', () => {
  render(<Harness source={work()} onDraft={vi.fn()} onRemove={vi.fn()} />);

  expect(screen.getByText(t('settings.epics.hint'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('settings.epicFollows'))).toHaveTextContent(t('settings.epicFollows.aheadThenBehind'));
  expect(screen.getByLabelText(t('settings.switchAt'))).toHaveTextContent('Build');
  expect(screen.getByText(t('settings.source.epicsHint'))).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(t('settings.epicFollows')));
  for (const key of ['settings.epicFollows.behind', 'settings.epicFollows.ahead', 'settings.epicFollows.aheadThenBehind'] as const) {
    expect(screen.getByRole('option', { name: t(key) })).toBeInTheDocument();
  }
});

test('switches at shows only with furthest ahead, then furthest behind; with another choice the hint takes its column (#30)', () => {
  const onDraft = vi.fn();
  render(<Harness source={work()} onDraft={onDraft} onRemove={vi.fn()} />);

  fireEvent.click(screen.getByLabelText(t('settings.epicFollows')));
  fireEvent.click(screen.getByRole('option', { name: t('settings.epicFollows.behind') }));

  expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ epicFollows: 'behind' }));
  expect(screen.queryByLabelText(t('settings.switchAt'))).not.toBeInTheDocument();
  expect(screen.getByText(t('settings.switchAt.hint', { stage: 'Build', last: 'review' }))).toBeInTheDocument();
});

test('under ignore both fields are disabled and the hint says why; hide leaves them on (#30)', () => {
  const { unmount } = render(<Harness source={{ ...work(), epics: 'ignore' }} onDraft={vi.fn()} onRemove={vi.fn()} />);

  expect(screen.getByLabelText(t('settings.epicFollows'))).toBeDisabled();
  expect(screen.getByLabelText(t('settings.switchAt'))).toBeDisabled();
  expect(screen.getByText(t('settings.epicFollows.ignored'))).toBeInTheDocument();
  expect(screen.queryByText(t('settings.switchAt.hint', { stage: 'Build', last: 'review' }))).not.toBeInTheDocument();
  unmount();

  render(<Harness source={{ ...work(), epics: 'hide' }} onDraft={vi.fn()} onRemove={vi.fn()} />);
  expect(screen.getByLabelText(t('settings.epicFollows'))).toBeEnabled();
  expect(screen.getByLabelText(t('settings.switchAt'))).toBeEnabled();
});

test('the hint names the switch stage and the last stage; a pick stores the stage draft id; a gone id shows the fallback (#30)', () => {
  const onDraft = vi.fn();
  const { unmount } = render(<Harness source={work()} onDraft={onDraft} onRemove={vi.fn()} />);

  expect(screen.getByText(t('settings.switchAt.hint', { stage: 'Build', last: 'review' }))).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(t('settings.switchAt')));
  fireEvent.click(screen.getByRole('option', { name: 'fila' }));
  expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ switchAt: STAGES[0].id }));
  expect(screen.getByText(t('settings.switchAt.hint', { stage: 'fila', last: 'review' }))).toBeInTheDocument();
  unmount();

  render(<Harness source={{ ...work(), switchAt: 'gone' }} stages={[STAGES[0], STAGES[2]]} onDraft={vi.fn()} onRemove={vi.fn()} />);
  expect(screen.getByLabelText(t('settings.switchAt'))).toHaveTextContent('fila');
});

test('the epic delete-activity switch: off on a new source, a click patches the draft, labelled in both languages, disabled under ignore (#856)', () => {
  for (const language of ['en', 'pt'] as const) {
    setLanguage(language);
    const onDraft = vi.fn();
    const { unmount } = render(<Harness source={work()} onDraft={onDraft} onRemove={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: t('settings.epicDeleteActivity') });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onDraft).toHaveBeenLastCalledWith(expect.objectContaining({ epicDeleteActivity: true }));
    unmount();
  }
  setLanguage('en');
  expect(t('settings.epicDeleteActivity')).toBe("delete an epic's activity in its last stage");
  setLanguage('pt');
  expect(t('settings.epicDeleteActivity')).toBe('excluir a atividade do épico na última etapa'); // lowercase, as every label (design system); the glossary's PT names: atividade, etapa
  render(<Harness source={{ ...work(), epics: 'ignore' }} onDraft={vi.fn()} onRemove={vi.fn()} />);
  expect(screen.getByRole('switch', { name: t('settings.epicDeleteActivity') })).toBeDisabled();
});

const SITE = 'acme.atlassian.net';
// JiraFields lists the connected sites from GET /settings/jira/sites
const stubSites = (): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ site: SITE, state: 'connected' }, { site: 'beta.atlassian.net', state: 'connected' }]), { status: 200 })));
};
const JIRA_ROW: SourceDraft = {
  ...emptySource('hive'), name: 'tickets', type: 'jira', epics: 'show',
  jira: { site: SITE, project: 'ABC', tree: { epics: true, subtasks: false }, blockingLinkTypes: ['Blocks'], issueType: 'Task', subtaskType: 'Subtask', doneStatus: 'Done' },
};
const JIRA_OPTIONS: JiraRowOptions = {
  projects: [{ key: 'ABC', name: 'Alpha' }, { key: 'XYZ', name: 'Zed' }],
  issueTypes: [{ id: '1', name: 'Task', subtask: false }, { id: '2', name: 'Story', subtask: false }, { id: '3', name: 'Subtask', subtask: true }],
  linkTypes: [{ name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, { name: 'Relates', inward: 'relates to', outward: 'relates to' }],
  errors: {},
};
const choose = async (user: ReturnType<typeof userEvent.setup>, label: MessageKey, option: string): Promise<void> => {
  screen.getByLabelText(t(label)).focus(); // a pointer click can leave a Radix Select closed in jsdom
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: option }));
};

test('a saved Jira source shows every key filled, and no GitHub field (#822)', () => {
  stubSites();
  render(<Harness source={JIRA_ROW} jira={JIRA_OPTIONS} columns={['To Do', 'Done']} onDraft={vi.fn()} onRemove={vi.fn()} />);
  expect(screen.getByLabelText(t('settings.sources.name'))).toBeEnabled();
  expect(screen.getByLabelText(t('settings.sourceType'))).toHaveValue('Jira');
  expect(screen.getByLabelText(t('settings.source.jira.site'))).toHaveTextContent(SITE);
  expect(screen.getByLabelText(t('settings.source.jira.project'))).toHaveTextContent('ABC · Alpha');
  expect(screen.getByRole('switch', { name: t('settings.source.jira.tree.epics') })).toBeChecked();
  expect(screen.getByRole('switch', { name: t('settings.source.jira.tree.subtasks') })).not.toBeChecked();
  expect(screen.getByRole('combobox', { name: t('settings.source.jira.blockingLinkTypes') })).toHaveTextContent('Blocks');
  for (const [label, value] of [['settings.source.jira.issueType', 'Task'], ['settings.source.jira.subtaskType', 'Subtask'], ['settings.source.jira.doneStatus', 'Done']] as const) {
    expect(screen.getByLabelText(t(label))).toHaveTextContent(value);
  }
  expect(screen.getByRole('switch', { name: t('settings.sources.qualifyId') })).toBeInTheDocument();
  for (const label of ['settings.owner', 'settings.project', 'settings.source.repository'] as const) expect(screen.queryByLabelText(t(label))).not.toBeInTheDocument();
  expect(screen.queryByText(t('settings.source.connection', { auth: t('settings.auth.cli') }), { exact: false })).not.toBeInTheDocument();
});

test('each Jira edit reaches onChange; a project pick asks for its reads, a site pick clears the project and asks for the projects (#822)', async () => {
  stubSites();
  const user = userEvent.setup();
  const onDraft = vi.fn();
  const onLoadJira = vi.fn();
  render(<Harness source={JIRA_ROW} jira={JIRA_OPTIONS} columns={['To Do', 'Done']} onDraft={onDraft} onLoadJira={onLoadJira} onRemove={vi.fn()} />);
  const lastJira = (): JiraDraft => onDraft.mock.lastCall?.[0].jira;

  await choose(user, 'settings.source.jira.project', 'XYZ · Zed');
  expect(lastJira()).toEqual({ ...JIRA_ROW.jira, project: 'XYZ' });
  expect(onLoadJira).toHaveBeenLastCalledWith({ ...JIRA_ROW.jira, project: 'XYZ' }, 'project');
  await choose(user, 'settings.source.jira.issueType', 'Story');
  expect(lastJira().issueType).toBe('Story');
  await choose(user, 'settings.source.jira.doneStatus', 'To Do');
  expect(lastJira().doneStatus).toBe('To Do');
  await user.click(screen.getByRole('switch', { name: t('settings.source.jira.tree.subtasks') }));
  expect(lastJira().tree).toEqual({ epics: true, subtasks: true });
  fireEvent.click(screen.getByRole('combobox', { name: t('settings.source.jira.blockingLinkTypes') }));
  fireEvent.click(await screen.findByRole('option', { name: /Relates/ }));
  expect(lastJira().blockingLinkTypes).toEqual(['Blocks', 'Relates']);
  await choose(user, 'settings.source.jira.site', 'beta.atlassian.net');
  expect(lastJira()).toEqual(expect.objectContaining({ site: 'beta.atlassian.net', project: '' }));
  expect(onLoadJira).toHaveBeenLastCalledWith(expect.objectContaining({ site: 'beta.atlassian.net', project: '' }), 'site');
});

test('a Jira source has the filter, epics and task properties groups; the filter offers no milestone or repository, the epics block no delete activity row (#822)', async () => {
  stubSites();
  render(<Harness source={JIRA_ROW} jira={JIRA_OPTIONS} onDraft={vi.fn()} onRemove={vi.fn()} />);
  for (const name of [t('settings.source.filter'), t('settings.taskProps.title'), t('settings.source.jira.keys')]) {
    expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
  }
  expect(screen.getByLabelText(t('settings.epics'))).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: t('settings.epicDeleteActivity') })).not.toBeInTheDocument();
  expect(screen.getByText(t('settings.source.jira.epicsHint'))).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: t('settings.filter.add') }));
  fireEvent.click(screen.getByRole('combobox', { name: t('settings.filter.field') }));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent))
    .toEqual([t('settings.filter.field.assignee'), t('settings.filter.field.label'), t('settings.filter.field.blocked')]);
});

test('a Jira read failure shows inline: not connected with its link to connections, a rate limit with its time, else the generic copy (#822)', () => {
  stubSites();
  const onOpenList = vi.fn();
  const resetsAt = new Date(2026, 10, 17, 14, 5).toISOString(); // local 14:05, as clock reads it
  const cases: [JiraRowOptions['errors'], string][] = [
    [{ site: { kind: 'not-connected' } }, t('settings.source.jira.error.notConnected')],
    [{ project: { kind: 'rate-limited', resetsAt } }, t('settings.source.jira.error.rateLimited', { time: '14:05' })],
    [{ project: { kind: 'failed' } }, t('settings.source.jira.error.failed')],
  ];
  for (const [errors, text] of cases) {
    const { unmount } = render(<Harness source={JIRA_ROW} jira={{ ...JIRA_OPTIONS, errors }} onDraft={vi.fn()} onRemove={vi.fn()} onOpenList={onOpenList} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    if (errors.site !== undefined) {
      fireEvent.click(screen.getByRole('button', { name: t('settings.source.jira.openConnections') }));
      expect(onOpenList).toHaveBeenCalledTimes(1);
    }
    unmount();
  }
});

test('a project with no sub-task type says so under its select (#822)', () => {
  stubSites();
  const options = { ...JIRA_OPTIONS, issueTypes: JIRA_OPTIONS.issueTypes.filter((type) => !type.subtask) };
  render(<Harness source={{ ...JIRA_ROW, jira: { ...JIRA_ROW.jira, subtaskType: '' } }} jira={options} onDraft={vi.fn()} onRemove={vi.fn()} />);
  expect(screen.getByText(t('settings.source.jira.noSubtaskTypeHint'))).toBeInTheDocument();
});

test("a Jira source's search entries name its site, project and keys, and no GitHub field (#822)", () => {
  const anchors = sourceEntries(JIRA_ROW).map((e) => e.anchor);
  for (const label of ['settings.source.jira.site', 'settings.source.jira.project', 'settings.source.jira.doneStatus', 'settings.source.filter'] as const) {
    expect(anchors).toContain(settingAnchor(label, JIRA_ROW.id));
  }
  for (const label of ['settings.owner', 'settings.epicDeleteActivity'] as const) expect(anchors).not.toContain(settingAnchor(label, JIRA_ROW.id));
});
