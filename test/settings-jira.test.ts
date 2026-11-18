import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson } from '../src/ui/lib/api.js';
import { EMPTY_JIRA, isJiraChosen, jiraColumnsUrl, jiraDraft, jiraFilterOptionsUrl, jiraIssueTypesUrl, jiraLinkTypesUrl, jiraProjectsUrl, jiraReadError, withCurrent } from '../src/ui/lib/settings-jira.js';
import { JIRA_ENTRY } from './fakes.js';

const SITE = 'acme.atlassian.net';
// A real refusal, as getJson rejects it: the error parseJson throws for that status and body
const refusal = (status: number, body: unknown): Promise<unknown> =>
  parseJson(new Response(JSON.stringify(body), { status })).then(() => assert.fail('no refusal'), (err: unknown) => err);

test('jiraReadError reads a route\'s refusal: 409 not-connected, 429 with its resetsAt, anything else failed (#822)', async () => {
  assert.deepEqual(jiraReadError(await refusal(409, { error: 'not-connected' })), { kind: 'not-connected' });
  const resetsAt = '2026-11-17T14:05:00.000Z';
  assert.deepEqual(jiraReadError(await refusal(429, { error: `rate limited until ${resetsAt}`, resetsAt })), { kind: 'rate-limited', resetsAt });
  assert.deepEqual(jiraReadError(await refusal(429, { error: 'x' })), { kind: 'rate-limited', resetsAt: '' });
  const others = [await refusal(409, { error: 'other' }), await refusal(502, { error: 'jira api: HTTP 500' }), await refusal(400, { error: 'invalid-site' }), new Error('offline'), 'nope', null];
  for (const err of others) assert.deepEqual(jiraReadError(err), { kind: 'failed' }, String(err));
});

test('the read urls carry the site, the project where the route needs it, and type=jira on the two shared routes (#822)', () => {
  const jira = { ...EMPTY_JIRA, site: SITE, project: 'ABC' };
  assert.equal(jiraProjectsUrl(SITE), '/settings/jira/projects?site=acme.atlassian.net');
  assert.equal(jiraLinkTypesUrl(SITE), '/settings/jira/link-types?site=acme.atlassian.net');
  assert.equal(jiraIssueTypesUrl(jira), '/settings/jira/issue-types?site=acme.atlassian.net&project=ABC');
  assert.equal(jiraColumnsUrl(jira), '/settings/source-columns?type=jira&site=acme.atlassian.net&project=ABC');
  assert.equal(jiraFilterOptionsUrl(jira), '/settings/filter-options?type=jira&site=acme.atlassian.net&project=ABC');
  assert.deepEqual([isJiraChosen(jira), isJiraChosen({ ...jira, project: '' }), isJiraChosen({ ...jira, site: '' })], [true, false, false]);
});

test('jiraDraft keeps the jira member\'s own keys and nothing else; a new row has both tree levels on (#822)', () => {
  assert.deepEqual(jiraDraft(JIRA_ENTRY), {
    site: 'acme.example', project: 'ABC', tree: { epics: false, subtasks: false }, blockingLinkTypes: ['Blocks'], issueType: 'Story', subtaskType: 'Sub-task', doneStatus: 'Done',
  });
  assert.deepEqual(EMPTY_JIRA, { site: '', project: '', tree: { epics: true, subtasks: true }, blockingLinkTypes: [], issueType: '', subtaskType: '', doneStatus: '' });
});

test('withCurrent lists the saved value first, once, while the options load (#822)', () => {
  assert.deepEqual(withCurrent('Done', []), ['Done']);
  assert.deepEqual(withCurrent('Done', ['To Do', 'Done']), ['Done', 'To Do']);
  assert.deepEqual(withCurrent('', ['To Do']), ['To Do']);
});
