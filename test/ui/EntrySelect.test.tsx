import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { EntrySelect } from '@/components/settings/EntrySelect';
import { setLanguage, t } from '@/i18n';
import { emptyStage, type FlowDraft, type StageDraft } from '@/lib/settings-form';

beforeEach(() => setLanguage('pt'));

const stage = (id: string, name: string, flow: string): StageDraft => ({ ...emptyStage(flow, 'claude'), id, name });
const FLOWS: FlowDraft[] = [{ id: 'd', name: 'entrega' }, { id: 'x', name: 'descoberta' }];
const SCOPE = { flows: FLOWS, stages: [stage('s1', 'Spec', 'd'), stage('s2', 'Build', 'd'), stage('s3', 'Pesquisa', 'x')] };

test('the menu: sem fluxo, then one group per flow: the flow with its first stage noted, then its other stages; the footer note (#670)', async () => {
  render(<EntrySelect value={{ flowId: 'd' }} scope={SCOPE} label="entra em" onChange={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('entra em')); // a plain click opens Radix reliably here, as in TaskDefaults' tests
  const options = await screen.findAllByRole('option');
  expect(options).toHaveLength(4);
  expect(options[0]).toHaveTextContent('sem fluxo');
  expect(options[1]).toHaveTextContent('na primeira etapa, Spec');
  expect(options[2]).toHaveTextContent('Build');
  expect(options[3]).toHaveTextContent('na primeira etapa, Pesquisa');
  expect(screen.getAllByRole('group').map((g) => within(g).getAllByRole('option').length)).toEqual([2, 1]);
  expect(screen.getByText(t('settings.taskProps.entry.footer'))).toBeInTheDocument();
});

test('the trigger shows the flow, flow · stage or sem fluxo; a pick reaches onChange by draft id (#670)', async () => {
  const onChange = vi.fn();
  const { rerender } = render(<EntrySelect value={{ flowId: 'd' }} scope={SCOPE} label="entra em" onChange={onChange} />);
  expect(screen.getByLabelText('entra em')).toHaveTextContent('entrega');
  rerender(<EntrySelect value={{ flowId: 'd', stageId: 's2' }} scope={SCOPE} label="entra em" onChange={onChange} />);
  expect(screen.getByLabelText('entra em')).toHaveTextContent('entrega · Build');
  rerender(<EntrySelect value={null} scope={SCOPE} label="entra em" onChange={onChange} />);
  expect(screen.getByLabelText('entra em')).toHaveTextContent('sem fluxo');
  fireEvent.click(screen.getByLabelText('entra em'));
  fireEvent.click(await screen.findByRole('option', { name: 'Build' }));
  expect(onChange).toHaveBeenLastCalledWith({ flowId: 'd', stageId: 's2' });
});

test('a value whose flow or stage is gone marks the trigger invalid (#670)', () => {
  render(<EntrySelect value={{ flowId: 'gone' }} scope={SCOPE} label="entra em" onChange={vi.fn()} />);
  expect(screen.getByLabelText('entra em')).toHaveAttribute('aria-invalid', 'true');
});
