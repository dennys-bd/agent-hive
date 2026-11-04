import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { windowTitle } from '@/components/ActivityBar';
import { DetachedStrip } from '@/components/DetachedStrip';
import { setLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';

beforeEach(() => setLanguage('pt'));

test('the strip drags the window, names the activity, and its back button, out of the drag region, docks only while a tab shows (#553)', async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  const { rerender } = render(<DetachedStrip title="#1 Task 1" canGoBack onBack={onBack} />);
  const strip = screen.getByRole('banner');
  expect(strip).toHaveTextContent('#1 Task 1');
  expect(strip.className).toContain('[-webkit-app-region:drag]');
  const back = screen.getByRole('button', { name: 'Voltar para a janela principal' });
  expect([back.className.includes('[-webkit-app-region:no-drag]'), back.getAttribute('title')]).toEqual([true, 'Voltar para a janela principal']);
  await user.click(back);
  expect(onBack).toHaveBeenCalledTimes(1);
  rerender(<DetachedStrip title="#1 Task 1" canGoBack={false} onBack={onBack} />);
  expect(screen.getByRole('button', { name: 'Voltar para a janela principal' })).toBeDisabled();
});

test('windowTitle reads local · <workspace> for a local activity and the bar title for a task (#553)', () => {
  const local = { kind: 'local', workspace: 'hive' } as unknown as Activity;
  const task = { kind: 'task', task: { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' } } } as unknown as Activity;
  expect(windowTitle(local)).toBe('local · hive');
  expect(windowTitle(task)).toBe('#1 Task 1');
});
