import { expect, test } from 'vitest';
import { type CreateDraft, withOptions } from '@/hooks/use-create-draft';

// #831: the issue types of a Jira project, by Jira's hierarchy level
const TYPES = [{ name: 'Epic', level: 1 }, { name: 'Bug', level: 0 }, { name: 'Story', level: 0 }, { name: 'Sub-task', level: -1 }];
const DRAFT: CreateDraft = { title: 'Fix', body: '', destination: 'github', workspace: undefined, stage: undefined, source: 'tickets', status: undefined, labels: [], issueType: undefined };

test('withOptions defaults the type to the source\'s, else to the first type that is no subtask, and never leaves a Jira status off the Project (#831)', () => {
  const jira = { statuses: ['To Do'], labels: [], issueTypes: TYPES };
  expect(withOptions(DRAFT, 'tickets', jira, 'Story')).toMatchObject({ status: 'To Do', issueType: 'Story' });
  expect(withOptions(DRAFT, 'tickets', jira, 'Task').issueType).toBe('Epic');
  expect(withOptions(DRAFT, 'tickets', { ...jira, issueTypes: [TYPES[3], TYPES[1]] }, 'Sub-task').issueType).toBe('Bug');
  expect(withOptions(DRAFT, 'tickets', { ...jira, statuses: [] }, 'Story').status).toBeUndefined();
  expect(withOptions({ ...DRAFT, source: 'work' }, 'work', { statuses: [], labels: [] })).toMatchObject({ status: null, issueType: undefined });
});
