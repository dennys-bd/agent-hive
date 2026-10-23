import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { TABS } from '@/components/benchmark/tabs';
import { setLanguage } from '@/i18n';
import { RESULT_EXP, RUN_B1 } from './benchmark-result-fixtures';

const execution = TABS.find((tab) => tab.id === 'execution');

beforeEach(() => setLanguage('pt'));

test("the execution tab's result slot renders the picked run's result (#466)", () => {
  render(<>{execution?.result?.(RESULT_EXP, RUN_B1.token)}</>);
  expect(screen.getByRole('region', { name: 'resultado do run' })).toBeInTheDocument();
});

test('a token no run of the experiment holds leaves the slot to its placeholder (#466)', () => {
  expect(execution?.result?.(RESULT_EXP, 'zzzz9999')).toBeUndefined();
});
