import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskDefaults } from '@/components/settings/TaskDefaults';
import { setLanguage, t } from '@/i18n';
import { emptyStage, type FlowDraft, type StageDraft } from '@/lib/settings-form';
import type { SourceTaskPropsDraft } from '@/lib/setup-source-task-props';

beforeEach(() => setLanguage('pt'));

const stage = (id: string, name: string, flow: string): StageDraft => ({ ...emptyStage(flow, 'claude'), id, name });
const FLOWS: FlowDraft[] = [{ id: 'd', name: 'entrega' }, { id: 'x', name: 'descoberta' }];
const SCOPE = { flows: FLOWS, stages: [stage('s1', 'Spec', 'd'), stage('s2', 'Build', 'd'), stage('s3', 'Pesquisa', 'x')] };

const DRAFT: SourceTaskPropsDraft = {
  defaults: { workspace: 'hive', auto: true, entry: { flowId: 'd' } },
  rules: [{ id: 'a', field: 'labels', op: 'icontains', value: 'core', set: { workspace: 'site' } }],
};

test('one row per property in registry order, with its note, its default and its derived mode (#688)', () => {
  render(<TaskDefaults scope={SCOPE} id="d" draft={DRAFT} workspaces={['hive', 'site']} onChange={vi.fn()} />);
  const [workspace, auto, entry] = screen.getAllByTestId('task-default-row');
  expect(within(workspace).getByText('obrigatório')).toBeInTheDocument();
  expect(within(workspace).getByLabelText('workspace')).toHaveTextContent('hive');
  expect(within(workspace).getByText('dinâmico · 1 regra define')).toBeInTheDocument();
  expect(within(auto).getByText('executa sozinha')).toBeInTheDocument();
  expect(within(auto).getByLabelText('auto')).toHaveTextContent('sim');
  expect(within(auto).getByText('fixo')).toBeInTheDocument();
  expect(within(entry).getByText('entra em')).toBeInTheDocument();
  expect(within(entry).getByText('fluxo e etapa')).toBeInTheDocument();
  expect(within(entry).getByLabelText('entra em')).toHaveTextContent('entrega');
  expect(within(entry).getByText('fixo')).toBeInTheDocument();
  expect(screen.getByText(t('settings.taskProps.defaults'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.taskProps.defaultsHint'))).toBeInTheDocument();
  expect(screen.getByText(t('settings.taskProps.entry.hint'))).toBeInTheDocument(); // #670
});

test('the workspace select offers sem workspace before the Comb\'s workspaces; it and auto não reach onChange as a new draft (#688)', async () => {
  const onChange = vi.fn();
  render(<TaskDefaults scope={SCOPE} id="d" draft={DRAFT} workspaces={['hive', 'site']} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText('workspace')); // a plain click opens Radix reliably here, as in TaskRules' tests
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['sem workspace', 'hive', 'site']);
  fireEvent.click(screen.getByRole('option', { name: 'sem workspace' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, defaults: { ...DRAFT.defaults, workspace: '' } });
  fireEvent.click(screen.getByLabelText('auto'));
  fireEvent.click(await screen.findByRole('option', { name: 'não' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, defaults: { ...DRAFT.defaults, auto: false } });
});

test('a pick of Build in the entry menu reaches onChange by draft id (#670)', async () => {
  const onChange = vi.fn();
  render(<TaskDefaults scope={SCOPE} id="d" draft={DRAFT} workspaces={['hive', 'site']} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText('entra em'));
  fireEvent.click(await screen.findByRole('option', { name: 'Build' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DRAFT, defaults: { ...DRAFT.defaults, entry: { flowId: 'd', stageId: 's2' } } });
});
