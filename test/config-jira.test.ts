import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { combConfig, FIXED, STAGES } from './fakes.js';

// combConfig adds the epics keys to a github entry only: a jira entry carries its own, switchAt on STAGES' one stage
const JIRA_SOURCE = {
  type: 'jira', site: 'acme.atlassian.net', project: 'ABC', filter: [], epics: 'ignore', epicFollows: 'behind', switchAt: 'fila',
  tree: { epics: false, subtasks: true }, blockingLinkTypes: ['Blocks'], issueType: 'Story', subtaskType: 'Sub-task', doneStatus: 'Done',
};
const jira = (patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => combConfig({ source: { ...JIRA_SOURCE, ...patch }, ...extra });
const field = (key: string): RegExp => new RegExp(`"comb\\.sources\\[0\\]\\.${key.replace(/[.[\]]/g, '\\$&')}"`);

test('a jira source with every key parses as written, qualifyId included (#820)', () => {
  assert.deepEqual(parseConfig(jira()).comb.sources[0], { ...JIRA_SOURCE, name: 'board', qualifyId: false, taskProps: FIXED });
  const [qualified] = parseConfig(combConfig({ sources: [{ ...JIRA_SOURCE, name: 'board', qualifyId: true, prefix: 'TIX', taskProps: FIXED }] })).comb.sources;
  assert.deepEqual([qualified.qualifyId, qualified.prefix], [true, 'TIX']);
});

test('each missing key of a jira source is refused, naming it (#820)', () => {
  for (const key of ['site', 'project', 'filter', 'taskProps', 'epics', 'epicFollows', 'switchAt', 'tree', 'blockingLinkTypes', 'issueType', 'subtaskType', 'doneStatus']) {
    assert.throws(() => parseConfig(jira({ [key]: undefined })), field(key), key);
  }
});

test('a site with a scheme, a path, a port or capitals, and a project that is no key, are refused naming the key (#820)', () => {
  for (const site of ['https://acme.atlassian.net', 'acme.atlassian.net/jira', 'acme.atlassian.net:443', 'ACME.atlassian.net', 'acme']) {
    assert.throws(() => parseConfig(jira({ site })), field('site'), site);
  }
  for (const project of ['abc', 'AB-1', '1AB', '']) assert.throws(() => parseConfig(jira({ project })), field('project'), project);
});

test('tree needs two booleans, blockingLinkTypes non-empty strings, the three type and status names non-empty strings (#820)', () => {
  const refused: [Record<string, unknown>, string][] = [
    [{ tree: { epics: true } }, 'tree'], [{ tree: 'yes' }, 'tree'],
    [{ blockingLinkTypes: ['Blocks', ' '] }, 'blockingLinkTypes'], [{ blockingLinkTypes: 'Blocks' }, 'blockingLinkTypes'],
    [{ issueType: '' }, 'issueType'], [{ subtaskType: 3 }, 'subtaskType'], [{ doneStatus: ' ' }, 'doneStatus'],
  ];
  for (const [patch, key] of refused) assert.throws(() => parseConfig(jira(patch)), field(key), JSON.stringify(patch));
});

test('a milestone or repository rule is refused naming the rule and the type; the other criteria parse (#820)', () => {
  for (const criterion of ['milestone', 'repository']) {
    assert.throws(() => parseConfig(jira({ filter: [{ field: criterion, op: 'any', values: ['x'] }] })),
      { message: `hive.config.json: "comb.sources[0].filter[0].field" "${criterion}" is not a criterion of a jira source` });
  }
  const filter = [
    { field: 'assignee', op: 'any', values: ['@me'] }, { field: 'label', op: 'none', values: ['wip'] },
    { field: 'projectField', name: 'Team', op: 'any', values: ['Core'] }, { field: 'blocked', op: 'none' },
  ];
  assert.deepEqual(parseConfig(jira({ filter })).comb.sources[0].filter, filter);
});

test('a jira source\'s onFinish takes close, delete and archive, and refuses remove naming it and the type (#823)', () => {
  const finishing = (type: string) => [{ ...STAGES[0], onFinish: { board: [{ type }] } }];
  for (const type of ['close', 'delete', 'archive']) assert.doesNotThrow(() => parseConfig(jira({}, { stages: finishing(type) })), type);
  assert.throws(() => parseConfig(jira({}, { stages: finishing('remove') })), /"remove" is not supported by source board \(jira\): move, close, delete, archive/);
});
