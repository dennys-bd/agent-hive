import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel, READ_MODEL_FILE, type ReadModel, type SyncKind } from '../../src/read-model/db.js';
import { groupsOf, jiraRoundSources, syncJira, type JiraRoundDeps, type JiraRoundSource } from '../../src/read-model/jira-round.js';
import { RECONCILE_EVERY_MS } from '../../src/read-model/reconcile.js';
import type { JiraCall } from '../../src/sources/jira-queries.js';
import { SourceNotConnectedError, SourceRateLimitError } from '../../src/source-errors.js';
import { tempDir } from '../temp-dir.js';
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

const INCREMENTAL = ['*navigable', 'description'];

test('a first sync stamps the reconcile and runs no reconcile pass (#824)', async (t) => {
  const db = await tempModel(t);
  const jira = fakeJira({ [ABC]: [jiraPage([jiraIssue('ABC', 1)])] });
  await syncJira(roundOn(db, jira.call).deps, [BOARD]);
  assert.equal(db.scope(JIRA_ROWS, 'ABC', 'reconcile')?.syncedAt, new Date(AT).toISOString());
  assert.deepEqual(jira.searches().map((s) => s.fields), [INCREMENTAL], 'no id-only search');
});

test('the reconcile runs only past 24 h, re-stamps, and its stamp holds across a reopen of the model (#824)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  const first = (await openReadModel(path)).db;
  const page = jiraPage([jiraIssue('ABC', 1)]);
  const jira = fakeJira({ [ABC]: [page, page, page, page, page] }); // the fourth answers the reconcile's id search
  const round = roundOn(first, jira.call);
  await syncJira(round.deps, [BOARD]); // at AT: the first sync stamps
  round.at(AT + RECONCILE_EVERY_MS);
  await syncJira(round.deps, [BOARD]);
  assert.equal(jira.searches().length, 2, 'exactly 24 h is not past 24 h');
  round.at(AT + RECONCILE_EVERY_MS + 1);
  await syncJira(round.deps, [BOARD]);
  assert.deepEqual(jira.searches().slice(2).map((s) => s.fields), [INCREMENTAL, ['id']]);
  const stamped = new Date(AT + RECONCILE_EVERY_MS + 1).toISOString();
  assert.equal(first.scope(JIRA_ROWS, 'ABC', 'reconcile')?.syncedAt, stamped);
  first.close();
  const reopened = (await openReadModel(path)).db;
  t.after(() => reopened.close());
  assert.equal(reopened.scope(JIRA_ROWS, 'ABC', 'reconcile')?.syncedAt, stamped);
  const again = roundOn(reopened, jira.call);
  again.at(AT + RECONCILE_EVERY_MS + 2);
  await syncJira(again.deps, [BOARD]);
  assert.deepEqual(jira.searches().slice(4).map((s) => s.fields), [INCREMENTAL], 'no reconcile right after a restart');
});

const RETRY_AT = '2026-10-12T12:05:00.000Z';
const JIRA_T2 = '2026-10-13T10:00:00.000+0000'; // after the first sync, before AT + 24 h + 1

test('a 429 reports the retry for every source of the group, stores nothing, and the next group still syncs in the round (#824)', async (t) => {
  const db = await tempModel(t);
  const jira = fakeJira({ [ABC]: [new SourceRateLimitError(RETRY_AT)], [OPS_KEY]: [jiraPage([jiraIssue('OPS', 2)])] });
  const round = roundOn(db, jira.call);
  await syncJira(round.deps, [BOARD, BUGS, OPS]);
  assert.deepEqual(round.reported, [['board', RETRY_AT], ['bugs', RETRY_AT]]);
  assert.equal(db.items.cursor(JIRA_ROWS, 'ABC'), null, 'the limited sync stored nothing');
  assert.deepEqual(db.items.listing(JIRA_ROWS, 'OPS'), ['10002']);
  assert.deepEqual(round.errors, []);
});

test('a retry report that fails is logged, never thrown, and the group\'s other sources are still reported (#824)', async (t) => {
  const db = await tempModel(t);
  const reported: string[] = [];
  const round = roundOn(db, fakeJira({ [ABC]: [new SourceRateLimitError(RETRY_AT)] }).call, {
    reportRetry: async (source) => {
      if (source === 'board') throw new Error('dispatch failed');
      reported.push(source);
    },
  });
  await assert.doesNotReject(syncJira(round.deps, [BOARD, BUGS]));
  assert.deepEqual(reported, ['bugs']);
  assert.deepEqual(round.errors, ['read model: the retry of board was not reported: dispatch failed']);
});

test('a group with one source in its retry wait makes no call, and syncs once that time has passed (#824)', async (t) => {
  const db = await tempModel(t);
  const waiting = { ...BOARD, backoffUntil: new Date(AT + 60_000).toISOString() };
  const jira = fakeJira({ [ABC]: [jiraPage([jiraIssue('ABC', 1)])] });
  const round = roundOn(db, jira.call);
  await syncJira(round.deps, [waiting, BUGS]);
  assert.deepEqual(jira.sent, []);
  round.at(AT + 60_001);
  await syncJira(round.deps, [waiting, BUGS]);
  assert.equal(jira.searches().length, 1);
  assert.deepEqual(db.items.listing(JIRA_ROWS, 'ABC'), ['10001']);
});

test('a 401 mid-round ends the group as a missing login does: no report, no error log, one debug line, no rejection (#824)', async (t) => {
  const db = await tempModel(t);
  const jira = fakeJira({ [ABC]: [new SourceNotConnectedError(`jira:${JIRA_SITE}`)], [OPS_KEY]: [jiraPage([jiraIssue('OPS', 2)])] });
  const round = roundOn(db, jira.call);
  await assert.doesNotReject(syncJira(round.deps, [BOARD, OPS]));
  assert.deepEqual([round.reported, round.errors], [[], []]);
  assert.equal(round.debugs.length, 1);
  assert.deepEqual(db.items.listing(JIRA_ROWS, 'OPS'), ['10002']);
});

test('a 5xx is one error log naming the site and project, and the next group still runs (#824)', async (t) => {
  const db = await tempModel(t);
  const jira = fakeJira({ [ABC]: [new Error('jira api: HTTP 502')], [OPS_KEY]: [jiraPage([jiraIssue('OPS', 2)])] });
  const round = roundOn(db, jira.call);
  await syncJira(round.deps, [BOARD, OPS]);
  assert.deepEqual(round.errors, ['read model: the sync of acme.example/ABC failed: jira api: HTTP 502']);
  assert.deepEqual(db.items.listing(JIRA_ROWS, 'OPS'), ['10002']);
});

test('a reconcile that fails after the sync changed rows still notifies once, logs once, and stays due (#824)', async (t) => {
  const db = await tempModel(t);
  const jira = fakeJira({ [ABC]: [jiraPage([jiraIssue('ABC', 1)]), jiraPage([jiraIssue('ABC', 1, JIRA_T2, 'Renamed')]), new Error('jira api: HTTP 502')] });
  const round = roundOn(db, jira.call);
  await syncJira(round.deps, [BOARD]);
  round.at(AT + RECONCILE_EVERY_MS + 1);
  await syncJira(round.deps, [BOARD]);
  assert.deepEqual(round.notified, [[ABC, ['items']], [ABC, ['items']]]);
  assert.equal(round.errors.length, 1);
  assert.equal(db.scope(JIRA_ROWS, 'ABC', 'reconcile')?.syncedAt, new Date(AT).toISOString(), 'no stamp: the reconcile is still due');
});
