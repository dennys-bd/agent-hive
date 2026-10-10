import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { RulesEditor } from '@/components/settings/RulesEditor';
import { setLanguage, t } from '@/i18n';
import { emptyRule, type RuleDraft } from '@/lib/settings-rules';

beforeEach(() => setLanguage('pt'));

const row = (patch: Partial<RuleDraft>): RuleDraft => ({ ...emptyRule('session'), ...patch });
const session40cap4 = row({ percent: '40', kind: 'maxWorkers', value: '4' });
const week70cap1 = row({ source: 'week', percent: '70', kind: 'maxWorkers', value: '1' });
const session60yellow = row({ percent: '60', kind: 'signal', value: 'yellow' });

const openOptions = async (label: string): Promise<(string | null)[]> => {
  fireEvent.click(screen.getByLabelText(label));
  return (await screen.findAllByRole('option')).map((o) => o.textContent);
};

const NOW = {};

test('every rule shows in one table under medida, a partir de, consequência, valor and agora (#526)', () => {
  render(<RulesEditor rules={[session40cap4, week70cap1, session60yellow]} stages={[]} now={{ session: 11 }} onChange={vi.fn()} />);
  const rows = screen.getAllByTestId('rule-row');
  expect(rows).toHaveLength(3);
  for (const heading of ['medida', 'a partir de', 'consequência', 'valor', 'agora']) expect(screen.getByText(heading)).toBeInTheDocument();
  expect(within(rows[0]).getByLabelText('medida')).toHaveTextContent('janela da sessão (5h)');
  expect(within(rows[0]).getByLabelText('a partir de')).toHaveValue(40);
  expect(within(rows[0]).getByText('%')).toBeInTheDocument();
  expect(within(rows[0]).getByText('11%')).toBeInTheDocument();
  expect(within(rows[1]).getByText('—')).toBeInTheDocument();
  expect(within(rows[2]).getByText('11%')).toBeInTheDocument();
});

test('a row\'s medida lists the four measures, and a pick changes only that row\'s source (#526)', async () => {
  const onChange = vi.fn();
  render(<RulesEditor rules={[session40cap4, week70cap1]} stages={[]} now={NOW} onChange={onChange} />);
  const [first] = screen.getAllByTestId('rule-row');
  fireEvent.click(within(first).getByLabelText('medida'));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(
    ['janela da sessão (5h)', 'janela da semana', 'orçamento por hora', 'orçamento por dia'],
  );
  fireEvent.click(screen.getByRole('option', { name: 'janela da semana' }));
  expect(onChange).toHaveBeenLastCalledWith([{ ...session40cap4, source: 'week' }, week70cap1]);
});

test('a signal value shows its dot and the word (#512)', () => {
  render(<RulesEditor rules={[session40cap4, session60yellow]} stages={[]} now={NOW} onChange={vi.fn()} />);
  const [, yellowRow] = screen.getAllByTestId('rule-row');
  const trigger = within(yellowRow).getByLabelText('valor');
  expect(trigger).toHaveTextContent('yellow');
  expect(trigger.querySelector('[data-signal="yellow"]')).toBeInTheDocument();
});

test('the consequence options include each stage, and a pick reaches onChange with the stage and the kept value (#512, #475)', async () => {
  const onChange = vi.fn();
  const { unmount } = render(<RulesEditor rules={[session40cap4]} stages={['spec', 'build']} now={NOW} onChange={onChange} />);
  expect(await openOptions('consequência')).toEqual(['—', 'limitar workers a', 'limitar workers de spec a', 'limitar workers de build a', 'mudar o sinal para']);
  fireEvent.click(screen.getByRole('option', { name: 'limitar workers de build a' }));
  expect(onChange).toHaveBeenLastCalledWith([{ ...session40cap4, kind: 'maxWorkers', stage: 'build', value: '4' }]);
  unmount();

  const onChange2 = vi.fn();
  render(<RulesEditor rules={[session40cap4]} stages={['spec', 'build']} now={NOW} onChange={onChange2} />);
  fireEvent.click(screen.getByLabelText('consequência'));
  fireEvent.click(await screen.findByRole('option', { name: 'mudar o sinal para' }));
  expect(onChange2).toHaveBeenLastCalledWith([{ ...session40cap4, kind: 'signal', stage: '', value: '' }]);
});

test('+ regra appends an empty session rule, and × removes only its row (#526)', () => {
  const rules = [session40cap4, week70cap1, session60yellow];
  const onChange = vi.fn();
  const { unmount } = render(<RulesEditor rules={rules} stages={[]} now={NOW} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: t('settings.rules.add') }));
  const added = onChange.mock.calls[0][0] as RuleDraft[];
  expect(added.slice(0, 3)).toEqual(rules);
  expect(added[3]).toMatchObject({ source: 'session', percent: '', stage: '', kind: '', value: '' });
  unmount();

  const onRemove = vi.fn();
  render(<RulesEditor rules={rules} stages={[]} now={NOW} onChange={onRemove} />);
  fireEvent.click(within(screen.getAllByTestId('rule-row')[1]).getByRole('button', { name: 'remover regra' }));
  expect(onRemove).toHaveBeenCalledWith([session40cap4, session60yellow]);
});

test('typing in a row\'s "a partir de" updates only that row, by id (#512)', () => {
  const rules = [session40cap4, session60yellow];
  const onChange = vi.fn();
  render(<RulesEditor rules={rules} stages={[]} now={NOW} onChange={onChange} />);
  const [first] = screen.getAllByTestId('rule-row');
  fireEvent.change(within(first).getByLabelText('a partir de'), { target: { value: '5' } });
  expect(onChange).toHaveBeenCalledWith([{ ...session40cap4, percent: '5' }, session60yellow]);
});
