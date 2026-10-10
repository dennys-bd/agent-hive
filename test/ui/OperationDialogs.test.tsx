import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { OperationDialogs } from '@/components/OperationDialogs';
import { setLanguage } from '@/i18n';
import type { OperationDialog } from '@/lib/operations';
import type { Worker } from '../../src/types';
import { activityIdOf, bareTask } from '../fixtures/work';
import { stateOf, task } from './search-fixtures';

// Its own file: Radix shows a Dialog's content once per jsdom file, so the dialog opens once and the live session arrives through rerender.
// The task's and the activity's menus pass FeedbackDialog the same answerableActivity this one does.
beforeEach(() => { setLanguage('pt'); });

test('the feedback dialog renders nothing once a session of the task goes live, as it does once the task leaves approval (#829)', () => {
  const pending = task('11', 'Build', { approval: { since: '2026-09-28T10:00:00.000Z' } });
  const waiting: Worker = { id: 's1', activityId: activityIdOf('I11'), status: 'waiting', runId: 'W1', freeSession: true };
  const dialog: OperationDialog = { kind: 'feedback', task: bareTask(pending) };
  const onClose = vi.fn();
  const { rerender } = render(<OperationDialogs dialog={dialog} state={stateOf([pending])} onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: 'enviar feedback…' })).toBeInTheDocument();
  rerender(<OperationDialogs dialog={dialog} state={stateOf([pending], { workers: [waiting] })} onClose={onClose} />);
  expect(screen.queryByRole('dialog', { name: 'enviar feedback…' })).not.toBeInTheDocument();
});
