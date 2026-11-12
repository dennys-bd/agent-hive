import { expect, test } from 'vitest';
import { type CreateTargets, createTargetsOf, destinations, preselect, repositoryLabel } from '@/lib/create-targets';

test('createTargetsOf keeps every source with a repository, with its type; destinations puts the default first and lists hive only while it is on (#846, #893)', () => {
  const targets = createTargetsOf({ sources: [{ name: 'roadmap', type: 'github', repository: 'me/site' }, { name: 'bare', type: 'github' }], createIn: 'roadmap' });
  expect(targets).toEqual({ hiveSource: true, createIn: 'roadmap', sources: [{ name: 'roadmap', type: 'github', repository: 'me/site' }] });
  expect(destinations(targets)).toEqual([{ name: 'roadmap', type: 'github', repository: 'me/site' }, { name: 'hive' }]);
  expect(destinations({ ...targets, hiveSource: false })).toEqual([{ name: 'roadmap', type: 'github', repository: 'me/site' }]);
  expect(destinations({ hiveSource: true, createIn: 'hive', sources: [] })).toEqual([{ name: 'hive' }]);
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
