import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { JiraReadNotice } from '@/components/settings/JiraControls';
import { setLanguage, t } from '@/i18n';

beforeEach(() => setLanguage('en'));

test('a rate limit with a reset time names it (#822)', () => {
  render(<JiraReadNotice error={{ kind: 'rate-limited', resetsAt: '2026-11-17T10:30:00' }} onOpenConnections={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/try again at \d\d:\d\d/);
});

test('a rate limit without a reset time does not end on "at" (#822)', () => {
  render(<JiraReadNotice error={{ kind: 'rate-limited', resetsAt: '' }} onOpenConnections={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent(t('settings.source.jira.error.rateLimitedNoTime'));
  expect(screen.getByRole('alert').textContent).not.toMatch(/at\s*$/);
});
