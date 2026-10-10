import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { SourceDetail } from '@/components/settings/SourceDetail';
import { setLanguage, t } from '@/i18n';
import { type SourceDraft, emptySource } from '@/lib/settings-form';
import type { EpicsMode, FilterOptions, GithubAuth } from '../../src/types';

beforeEach(() => setLanguage('pt'));

interface HarnessProps {
  source: SourceDraft; epics?: EpicsMode; auth?: GithubAuth; filterOptions?: FilterOptions; onDraft(source: SourceDraft): void; onRemove(): void;
  onEpicsChange?(epics: EpicsMode): void; onOpenList?(): void;
}

// SourceDetail is controlled: the harness holds the draft as FlowSection does and reports every patched row (was BoardDetail's harness).
function Harness({ source: initial, epics = 'ignore', auth = 'cli', filterOptions, onDraft, onRemove, onEpicsChange = vi.fn(), onOpenList = vi.fn() }: HarnessProps) {
  const [source, setSource] = useState<SourceDraft>(initial);
  const change = (patch: Partial<SourceDraft>): void => {
    const next = { ...source, ...patch };
    setSource(next);
    onDraft(next);
  };
  return (
    <SourceDetail
      source={source} workspaces={['hive', 'site']} githubProjects={[]} needsToken={false} epics={epics} auth={auth} filterOptions={filterOptions}
      onChange={change} onRemove={onRemove} onLoadProjects={vi.fn()} onLoadColumns={vi.fn()} onEpicsChange={onEpicsChange} onOpenList={onOpenList}
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

test('a GitHub source shows the epics select and its hint under the filter, and the connection line; mudar calls onOpenList, escolher enfileirar calls onEpicsChange (#524)', () => {
  const onEpicsChange = vi.fn();
  const onOpenList = vi.fn();
  render(
    <Harness
      source={{ ...emptySource('hive'), name: 'work', number: '1' }} epics="ignore" auth="cli"
      onDraft={vi.fn()} onRemove={vi.fn()} onEpicsChange={onEpicsChange} onOpenList={onOpenList}
    />,
  );

  expect(screen.getByLabelText(t('settings.epics'))).toHaveTextContent(t('settings.epics.ignore'));
  expect(screen.getByText(t('settings.source.epicsHint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.source.connection', { auth: t('settings.auth.cli') }), { exact: false })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: t('settings.source.connection.change') }));
  expect(onOpenList).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByLabelText(t('settings.epics')));
  fireEvent.click(screen.getByRole('option', { name: t('settings.epics.queue') }));
  expect(onEpicsChange).toHaveBeenLastCalledWith('queue');
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
