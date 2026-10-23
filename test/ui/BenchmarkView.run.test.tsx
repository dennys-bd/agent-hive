import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';
import { useBenchmark } from '@/components/benchmark/benchmark-dock';
import { BenchmarkView } from '@/components/benchmark/BenchmarkView';
import { setLanguage } from '@/i18n';
import { RESULT_EXP, RUN_B1 } from './benchmark-result-fixtures';

// The shell's state with two doors in: 2.5's resultado button (not merged) only calls openRun
function Window({ token }: { token: string }) {
  const benchmark = useBenchmark([RESULT_EXP]);
  return (
    <>
      <button type="button" onClick={() => benchmark.openRun(token)}>abrir resultado</button>
      <BenchmarkView benchmark={benchmark} workspaces={['hive']} />
    </>
  );
}
const tabs = () => within(screen.getByRole('navigation', { name: 'experimento' }));
const current = () => tabs().getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.textContent;
const result = () => screen.queryByRole('region', { name: 'resultado do run' });

beforeEach(() => setLanguage('pt'));

test('a named run shows its result in place of the tab\'s body and marks execução; ← execução goes back to execução (#466)', async () => {
  const user = userEvent.setup();
  render(<Window token={RUN_B1.token} />);
  expect([current(), result()]).toEqual(['braços', null]);
  await user.click(screen.getByRole('button', { name: 'abrir resultado' }));
  expect(result()).toBeInTheDocument();
  expect(current()).toBe('execução');
  await user.click(within(result() as HTMLElement).getByRole('button', { name: 'execução' }));
  expect(result()).not.toBeInTheDocument();
  expect(current()).toBe('execução');
  expect(screen.getByText('em breve')).toBeInTheDocument();
});

test('a tab change clears the run (#466)', async () => {
  const user = userEvent.setup();
  render(<Window token={RUN_B1.token} />);
  await user.click(screen.getByRole('button', { name: 'abrir resultado' }));
  await user.click(tabs().getByRole('button', { name: 'relatório' }));
  expect([current(), result()]).toEqual(['relatório', null]);
});

test('a token no run of the selected experiment holds falls back to the tab (#466)', async () => {
  const user = userEvent.setup();
  render(<Window token="zzzz9999" />);
  await user.click(screen.getByRole('button', { name: 'abrir resultado' }));
  expect([current(), result()]).toEqual(['braços', null]);
});
