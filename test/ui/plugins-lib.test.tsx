import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { basedOnTitle, countOf, groupsOf, itemIdOf, markOf, sectionOfScreen, usageText } from '@/lib/plugins';
import { CATALOGUE, WORKSPACES } from './plugins-fixtures';

beforeEach(() => setLanguage('en'));
const ids = (groups: ReturnType<typeof groupsOf>) => groups.map((g) => [g.origin, g.items.map((i) => i.name)]);

test("groupsOf: hive first, then each workspace in config order, a kind's items only, an empty group left out; a workspace filter keeps hive and that workspace (#313)", () => {
  expect(ids(groupsOf(CATALOGUE, 'skill', WORKSPACES))).toEqual([['hive', ['new-spec', 'new-build', 'new-plan']], ['agent-hive', ['release']], ['hive-site', ['deploy']]]);
  expect(ids(groupsOf(CATALOGUE, 'specialist', WORKSPACES))).toEqual([['hive', ['architect']]]);
  expect(ids(groupsOf(CATALOGUE, 'skill', WORKSPACES, '', 'hive-site'))).toEqual([['hive', ['new-spec', 'new-build', 'new-plan']], ['hive-site', ['deploy']]]);
});

test('the search matches a name or a description, case-insensitive; a blank one keeps every item (#313)', () => {
  const names = (query: string) => groupsOf(CATALOGUE, 'skill', WORKSPACES, query).flatMap((g) => g.items.map((i) => i.name));
  expect(names('BUILD')).toEqual(['new-build']);
  expect(names('preview')).toEqual(['deploy']);
  expect(names('  ')).toHaveLength(5);
});

test('markOf counts two versions or more and adds ↗ for an external origin; countOf counts a kind; basedOnTitle names the origin (#313)', () => {
  expect(CATALOGUE.map(markOf)).toEqual(['', '2 ↗', '', '', '', '']);
  expect([countOf(CATALOGUE, 'skill'), countOf(CATALOGUE, 'specialist')]).toEqual([5, 1]);
  expect(basedOnTitle(CATALOGUE[1] ?? CATALOGUE[0])).toBe('based on superpowers:executing-plans · obra/superpowers · MIT');
  expect(basedOnTitle(CATALOGUE[0] ?? CATALOGUE[1])).toBeUndefined();
});

test('usageText: the stages first, then each caller by name, comma-joined; — with none; in both languages (#313)', () => {
  const build = CATALOGUE[1] ?? CATALOGUE[0];
  expect(usageText(build, CATALOGUE)).toBe('build stage, called by new-spec');
  expect(usageText(CATALOGUE[3] ?? build, CATALOGUE)).toBe('—');
  setLanguage('pt');
  expect(usageText(build, CATALOGUE)).toBe('etapa build, chamada por new-spec');
});

test("sectionOfScreen: a list's section, an item's kind, and mcp and protocol as themselves (#313)", () => {
  expect(sectionOfScreen({ kind: 'list', section: 'specialists' }, CATALOGUE)).toBe('specialists');
  expect(sectionOfScreen({ kind: 'item', id: 'hive:architect' }, CATALOGUE)).toBe('specialists');
  expect(sectionOfScreen({ kind: 'protocol' }, CATALOGUE)).toBe('protocol');
  expect(sectionOfScreen({ kind: 'item', id: 'hive:gone' }, CATALOGUE)).toBeUndefined();
});

test("an update screen belongs to its item: its section is the item kind's, and itemIdOf names the item for it as for the item screen (#325)", () => {
  expect(sectionOfScreen({ kind: 'update', id: 'hive:architect', version: 'mine' }, CATALOGUE)).toBe('specialists');
  expect([itemIdOf({ kind: 'update', id: 'hive:new-plan', version: 'mine' }), itemIdOf({ kind: 'item', id: 'hive:new-plan' }), itemIdOf({ kind: 'mcp' })]).toEqual(['hive:new-plan', 'hive:new-plan', undefined]);
});
