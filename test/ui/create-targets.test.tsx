import { expect, test } from 'vitest';
import type { SourceConfig } from '../../src/types';
import { type CreateTargets, createTargetsOf, destinations, placeOf, preselect, repositoryLabel } from '@/lib/create-targets';

const CONFIG: SourceConfig = { name: 'x', qualifyId: false, type: 'github', owner: 'me', number: 1, filter: [], taskProps: { defaults: { auto: true, entry: null }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', epicDeleteActivity: false, switchAt: 'fila' };

test('createTargetsOf keeps every source with a repository, with its type; destinations puts the default first and lists hive only while it is on (#846, #893)', () => {
  const configs: SourceConfig[] = [{ ...CONFIG, name: 'roadmap', repository: 'me/site' }, { ...CONFIG, name: 'bare' }];
  const targets = createTargetsOf({ sources: configs, createIn: 'roadmap' });
  expect(targets).toEqual({ hiveSource: true, createIn: 'roadmap', sources: [{ name: 'roadmap', type: 'github', repository: 'me/site' }], configs });
  expect(destinations(targets)).toEqual([{ name: 'roadmap', type: 'github', repository: 'me/site' }, { name: 'hive' }]);
  expect(destinations({ ...targets, hiveSource: false })).toEqual([{ name: 'roadmap', type: 'github', repository: 'me/site' }]);
  expect(destinations({ hiveSource: true, createIn: 'hive', sources: [] })).toEqual([{ name: 'hive' }]);
});

test('createTargetsOf offers every source the predicate accepts, a type with no repository included; the default still leaves a GitHub source with no repository out (#811)', () => {
  const tracker = { ...CONFIG, name: 'tracker', type: 'tracker' } as unknown as SourceConfig;
  const configs: SourceConfig[] = [tracker, { ...CONFIG, name: 'bare' }];
  const targets = createTargetsOf({ sources: configs, createIn: 'tracker' }, (s) => (s.type as string) === 'tracker');
  expect(targets.sources).toEqual([{ name: 'tracker', type: 'tracker' }]);
  expect(destinations(targets)).toEqual([{ name: 'tracker', type: 'tracker' }, { name: 'hive' }]);
  expect(repositoryLabel(targets.sources[0], targets.sources)).toBe('tracker');
  expect(createTargetsOf({ sources: [{ ...CONFIG, name: 'bare' }] }).sources).toEqual([]);
});

const SOURCES = [{ name: 'work', type: 'github' as const, repository: 'acme/app' }, { name: 'docs', type: 'github' as const, repository: 'acme/docs' }];
const TARGETS: CreateTargets = { hiveSource: true, createIn: 'hive', sources: SOURCES };
const DEFAULTS = { work: 'site', bare: 'hive' }; // bare has a default workspace but no repository, so it is no destination

test('preselect: an opening source wins, then the source whose default workspace is the opened one (the only hinted pick), then hive; with no workspace, or hive off, createIn (#772)', () => {
  const hive = { destination: 'hive', hinted: false };
  expect(preselect({ source: 'hive', workspace: 'site' }, TARGETS, DEFAULTS)).toEqual(hive);
  expect(preselect({ source: 'docs', workspace: 'site' }, TARGETS, DEFAULTS)).toEqual({ destination: 'github', source: 'docs', hinted: false });
  expect(preselect({ source: 'bare', workspace: 'site' }, TARGETS, DEFAULTS)).toEqual({ destination: 'github', source: 'work', hinted: true });
  expect(preselect({ workspace: 'site' }, TARGETS, DEFAULTS)).toEqual({ destination: 'github', source: 'work', hinted: true });
  expect(preselect({ workspace: 'hive' }, TARGETS, DEFAULTS)).toEqual(hive);
  expect(preselect({}, TARGETS, DEFAULTS)).toEqual(hive);
  expect(preselect({}, { ...TARGETS, createIn: 'docs' }, DEFAULTS)).toEqual({ destination: 'github', source: 'docs', hinted: false });
  const off = { ...TARGETS, hiveSource: false, createIn: 'docs' };
  expect(preselect({ workspace: 'hive' }, off, DEFAULTS)).toEqual({ destination: 'github', source: 'docs', hinted: false });
  expect(preselect({ source: 'hive' }, off, DEFAULTS)).toEqual({ destination: 'github', source: 'docs', hinted: false });
});

test('repositoryLabel names the repository, and the source too only where two sources share it (#772)', () => {
  const shared = [...SOURCES, { name: 'triage', type: 'github' as const, repository: 'acme/app' }];
  expect(repositoryLabel(SOURCES[0], SOURCES)).toBe('acme/app');
  expect(repositoryLabel(shared[0], shared)).toBe('acme/app · work');
  expect(repositoryLabel(shared[2], shared)).toBe('acme/app · triage');
  expect(repositoryLabel(shared[1], shared)).toBe('acme/docs');
});

const JIRA: SourceConfig = {
  name: 'tickets', qualifyId: false, type: 'jira', site: 'acme.example', project: 'ABC', filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: null }, rules: [] },
  epics: 'ignore', epicFollows: 'behind', switchAt: 'fila', tree: { epics: false, subtasks: false }, blockingLinkTypes: [], issueType: 'Story', subtaskType: 'Sub-task', doneStatus: 'Done',
};

test('a jira source a predicate accepts carries its project and default issue type, and placeOf names either kind (#831)', () => {
  const [tickets] = createTargetsOf({ sources: [JIRA] }, () => true).sources;
  expect(tickets).toEqual({ name: 'tickets', type: 'jira', project: 'ABC', issueType: 'Story' });
  expect([placeOf(tickets), placeOf(SOURCES[0]), placeOf(undefined)]).toEqual(['ABC', 'acme/app', undefined]);
});
