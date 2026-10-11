import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { SourceDetail } from '@/components/settings/SourceDetail';
import { setLanguage, t } from '@/i18n';
import { type SourceDraft, type StageDraft, emptySource, emptyStage } from '@/lib/settings-form';
import type { FilterOptions, GithubAuth } from '../../src/types';

beforeEach(() => setLanguage('pt'));

// The flow the block's switchAt picks from (#30): Build is the default, review the last stage
const STAGES: StageDraft[] = [{ ...emptyStage(), name: 'fila' }, { ...emptyStage(), name: 'Build' }, { ...emptyStage(), name: 'review' }];
const work = (): SourceDraft => ({ ...emptySource('hive'), name: 'work', number: '1' });

interface HarnessProps {
  source: SourceDraft; auth?: GithubAuth; filterOptions?: FilterOptions; stages?: StageDraft[]; onDraft(source: SourceDraft): void; onRemove(): void; onOpenList?(): void;
}

// SourceDetail is controlled: the harness holds the draft as FlowSection does and reports every patched row (was BoardDetail's harness).
function Harness({ source: initial, auth = 'cli', filterOptions, stages = STAGES, onDraft, onRemove, onOpenList = vi.fn() }: HarnessProps) {
  const [source, setSource] = useState<SourceDraft>(initial);
  const change = (patch: Partial<SourceDraft>): void => {
    const next = { ...source, ...patch };
    setSource(next);
    onDraft(next);
  };
  return (
    <SourceDetail
      source={source} stages={stages} workspaces={['hive', 'site']} githubProjects={[]} needsToken={false} auth={auth} filterOptions={filterOptions}
      onChange={change} onRemove={onRemove} onLoadProjects={vi.fn()} onLoadColumns={vi.fn()} onOpenList={onOpenList}
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
    taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [expect.objectContaining({ set: { workspace: 'hive' } })] },
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
