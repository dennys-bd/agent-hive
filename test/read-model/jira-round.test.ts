import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReadModel, SyncKind } from '../../src/read-model/db.js';
import { groupsOf, jiraRoundSources, syncJira, type JiraRoundDeps, type JiraRoundSource } from '../../src/read-model/jira-round.js';
import type { JiraCall } from '../../src/sources/jira-queries.js';
import { GITHUB_ENTRY, JIRA_ENTRY } from '../fakes.js';
import { fakeJira, JIRA_CRED, JIRA_ROWS, JIRA_SITE, jiraIssue, jiraPage, NOW, tempModel } from './fixtures.js';

const AT = NOW().getTime();
const BOARD: JiraRoundSource = { name: 'board', site: JIRA_SITE, project: 'ABC' };
const BUGS: JiraRoundSource = { name: 'bugs', site: JIRA_SITE, project: 'ABC' };
const OPS: JiraRoundSource = { name: 'ops', site: JIRA_SITE, project: 'OPS' };
const ABC = `${JIRA_SITE}/ABC`;
const OPS_KEY = `${JIRA_SITE}/OPS`;

interface Round { deps: JiraRoundDeps; notified: [string, SyncKind[]][]; reported: [string, string][]; errors: string[]; debugs: string[]; at(ms: number): void }

function roundOn(db: ReadModel, call: (site: string) => JiraCall, extra: Partial<JiraRoundDeps> = {}): Round {
  let clock = AT;
  const notified: [string, SyncKind[]][] = [];
  const reported: [string, string][] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  const deps: JiraRoundDeps = {
    db, call, credential: async (site) => (site === JIRA_SITE ? JIRA_CRED : undefined),
    reportRetry: async (source, until) => { reported.push([source, until]); },
    notify: (repository, kinds) => { notified.push([repository, kinds]); },
    log: { debug: (line: string): void => { debugs.push(line); }, error: (line: string): void => { errors.push(line); } },
    now: () => new Date(clock), isStopped: () => false, ...extra,
  };
  return { deps, notified, reported, errors, debugs, at: (ms) => { clock = ms; } };
}

test('the round reads each jira member of the config with its wait, and groups the sources by site and project in first-seen order (#824)', () => {
  const until = '2026-10-12T12:01:00.000Z';
  assert.deepEqual(jiraRoundSources([GITHUB_ENTRY, JIRA_ENTRY], { tickets: { backoffUntil: until } }), [{ name: 'tickets', site: 'acme.example', project: 'ABC', backoffUntil: until }]);
  assert.deepEqual(jiraRoundSources([JIRA_ENTRY], {}), [{ name: 'tickets', site: 'acme.example', project: 'ABC' }]);
  const far: JiraRoundSource = { name: 'far', site: 'beta.example', project: 'ABC' };
  assert.deepEqual(groupsOf([OPS, BOARD, far, BUGS]).map((g) => [g.site, g.project, g.sources.map((s) => s.name)]),
    [[JIRA_SITE, 'OPS', ['ops']], [JIRA_SITE, 'ABC', ['board', 'bugs']], ['beta.example', 'ABC', ['far']]]);
});

test('two sources over one site and project make one search a round; a source on another project gets its own sync (#824)', async (t) => {
  const db = await tempModel(t);
  const jira = fakeJira({ [ABC]: [jiraPage([jiraIssue('ABC', 1)])], [OPS_KEY]: [jiraPage([jiraIssue('OPS', 2)])] });
  const round = roundOn(db, jira.call);
  await syncJira(round.deps, [BOARD, BUGS, OPS]);
  assert.deepEqual(jira.searches().map((s) => [s.site, s.jql]), [[JIRA_SITE, 'project = "ABC" ORDER BY key ASC'], [JIRA_SITE, 'project = "OPS" ORDER BY key ASC']]);
  assert.deepEqual(db.items.listing(JIRA_ROWS, 'ABC'), ['10001']);
  assert.deepEqual(db.items.listing(JIRA_ROWS, 'OPS'), ['10002']);
  assert.deepEqual(round.errors, []);
});

test('a round that changed rows notifies once with the site and project and items; an identical second answer notifies nothing (#824)', async (t) => {
  const db = await tempModel(t);
  const same = jiraPage([jiraIssue('ABC', 1)]);
  const round = roundOn(db, fakeJira({ [ABC]: [same, same] }).call);
  await syncJira(round.deps, [BOARD, BUGS]);
  assert.deepEqual(round.notified, [[ABC, ['items']]]);
  round.at(AT + 60_000);
  await syncJira(round.deps, [BOARD, BUGS]);
  assert.deepEqual(round.notified, [[ABC, ['items']]], 'nothing changed: no second event');
});

test('with no login for the site the group makes no call, reports nothing, logs no error and does not reject (#824)', async (t) => {
  const db = await tempModel(t);
  const jira = fakeJira({});
  const round = roundOn(db, jira.call, { credential: async () => undefined });
  await assert.doesNotReject(syncJira(round.deps, [BOARD, BUGS]));
  assert.deepEqual([jira.sent, round.reported, round.errors, round.notified], [[], [], [], []]);
  assert.equal(round.debugs.length, 1);
  assert.match(round.debugs[0], /acme\.example\/ABC/);
});
