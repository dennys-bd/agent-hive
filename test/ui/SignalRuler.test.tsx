import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { SignalRuler } from '@/components/settings/SignalRuler';
import { setLanguage } from '@/i18n';
import { emptyRule, type RuleDraft } from '@/lib/settings-rules';

beforeEach(() => setLanguage('pt'));

const row = (percent: number, kind: 'maxWorkers' | 'signal', value: string, stage = ''): RuleDraft =>
  ({ ...emptyRule('session'), percent: String(percent), kind, value, stage });

// 40→4 workers, 60→yellow, 90→red: the png's session ruler.
const MOCK: RuleDraft[] = [row(40, 'maxWorkers', '4'), row(60, 'signal', 'yellow'), row(90, 'signal', 'red')];

const ruler = () => screen.getByRole('group', { name: 'janela da sessão (5h)' });

test('the ruler is named by its measure and reads agora N% beside the track (#526)', () => {
  const { rerender } = render(<SignalRuler source="session" rows={MOCK} current={11} />);
  expect(within(ruler()).getByText('agora 11%')).toBeInTheDocument();
  expect(screen.getByTestId('rules-now')).toHaveStyle({ left: '11%' });
  expect(screen.getByTestId('rules-now')).toHaveTextContent('');
  rerender(<SignalRuler source="session" rows={MOCK} current={130} />);
  expect(screen.getByTestId('rules-now')).toHaveStyle({ left: '100%' });
  rerender(<SignalRuler source="session" rows={MOCK} current={undefined} />);
  expect(screen.getByText('nada medido ainda')).toBeInTheDocument();
  expect(screen.queryByTestId('rules-now')).not.toBeInTheDocument();
});

test('only the yellow and red zones are drawn; the fill runs to now (#526)', () => {
  const { rerender } = render(<SignalRuler source="session" rows={MOCK} current={11} />);
  const zones = Array.from(ruler().querySelectorAll('[data-signal]')) as HTMLElement[];
  expect(zones.map((z) => z.getAttribute('data-signal'))).toEqual(['yellow', 'red']);
  expect(zones.map((z) => [z.style.left, z.style.width])).toEqual([['60%', '30%'], ['90%', '10%']]);
  expect(screen.getByTestId('rules-fill')).toHaveStyle({ width: '11%' });
  rerender(<SignalRuler source="session" rows={[]} current={11} />);
  expect(ruler().querySelector('[data-signal]')).toBeNull();
  expect(within(ruler()).queryAllByRole('listitem')).toHaveLength(0);
});

test('one tick per percent, reading the percent and its consequence on one line, labels joined with · (#526)', () => {
  const { rerender } = render(<SignalRuler source="session" rows={MOCK} />);
  const items = within(ruler()).getAllByRole('listitem');
  expect(items).toHaveLength(3);
  expect(items[0]).toHaveTextContent('40% 4 workers');
  const yellowItem = items.find((i) => i.textContent?.includes('sinal yellow')) as HTMLElement;
  expect(yellowItem).toHaveTextContent('60% sinal yellow');
  expect(yellowItem.style.left).toBe('60%');
  expect(ruler().textContent).not.toContain('amarelo');
  rerender(<SignalRuler source="session" rows={[row(60, 'signal', 'yellow'), row(60, 'maxWorkers', '2')]} />);
  expect(within(ruler()).getByRole('listitem')).toHaveTextContent('60% sinal yellow · 2 workers');
});

test('no 0% / 100% end labels', () => {
  render(<SignalRuler source="session" rows={MOCK} />);
  expect(screen.queryByText('100%')).toBeNull();
  expect(screen.queryByText('0%')).toBeNull();
});
