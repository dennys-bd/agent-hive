import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MetaGrid } from '@/components/DetailSections';
import { IssueOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task } from '../../src/types';

const ISSUE = 'https://github.com/acme/app/issues/12';
const task: Task = { item: { itemId: 'I1', id: '12', title: 'Task 1', body: '', url: ISSUE }, stage: 'dev', boardColumn: 'Ready', auto: true };
const state = { workers: [], activities: [], activityRecords: [] };
beforeEach(() => setLanguage('pt'));

test('the issue row opens the issue through the dock\'s opener, and its URL outside a Dashboard (#895)', () => {
  const openIssue = vi.fn();
  const { rerender } = render(<IssueOpenerContext.Provider value={openIssue}><MetaGrid task={task} state={state} isActivity /></IssueOpenerContext.Provider>);
  const link = screen.getByRole('link', { name: 'app#12' });
  expect(link).toHaveAttribute('href', ISSUE);
  expect(fireEvent.click(link)).toBe(false); // the default prevented: no browser
  expect(openIssue).toHaveBeenCalledWith(ISSUE);
  rerender(<MetaGrid task={task} state={state} isActivity />);
  expect(fireEvent.click(screen.getByRole('link', { name: 'app#12' }))).toBe(true);
});
