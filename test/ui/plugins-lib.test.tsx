import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { basedOnTitle, catalogueOf, countOf, groupsOf, itemIdOf, mainPathOf, markOf, openVersionOf, savedLabel, sectionOfScreen, usageText } from '@/lib/plugins';
import { CATALOGUE, itemOf, readOf, versionOf, WORKSPACES } from './plugins-fixtures';

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

const version = (name: string) => versionOf(name);

test('openVersionOf: mine when the item has it, else its first version, else the original (#319, decision 4)', () => {
  expect(openVersionOf(itemOf('hive:a', { versions: [version('tdd'), version('mine')] }))).toBe('mine');
  expect(openVersionOf(itemOf('hive:a', { versions: [version('tdd'), version('fast')] }))).toBe('tdd');
  expect(openVersionOf(itemOf('hive:a'))).toBeNull();
});

test("mainPathOf: a skill's SKILL.md or SKILL.md.liquid, a specialist's <name>.md, else the first file (#319)", () => {
  expect(mainPathOf(readOf('hive:new-build', 'mine', { 'scripts/x.py': '', 'SKILL.md.liquid': '' }))).toBe('SKILL.md.liquid');
  expect(mainPathOf(readOf('hive:architect', null, { 'architect.md': '' }))).toBe('architect.md');
  expect(mainPathOf(readOf('hive:new-build', 'mine', { 'notes.md': '' }))).toBe('notes.md');
});

test("catalogueOf names the Hive's items with the plugin's namespace and a workspace's bare, skills apart from specialists (#319)", () => {
  expect(catalogueOf([itemOf('hive:new-pr'), itemOf('hive:architect', { kind: 'specialist' }), itemOf('hive-site:deploy')])).toEqual({ skills: ['hive:new-pr', 'deploy'], agents: ['hive:architect'] });
});

test('savedLabel: the time today, the short date and the time on another day (#319, decision 10)', () => {
  const at = new Date(2026, 9, 16, 14, 31).toISOString();
  expect(savedLabel(at, new Date(2026, 9, 16, 18, 0))).toBe('14:31');
  expect(savedLabel(at, new Date(2026, 9, 17, 9, 0))).toMatch(/^\S+ 14:31$/);
});

test("an update screen belongs to its item: its section is the item kind's, and itemIdOf names the item for it as for the item screen (#325)", () => {
  expect(sectionOfScreen({ kind: 'update', id: 'hive:architect', version: 'mine' }, CATALOGUE)).toBe('specialists');
  expect([itemIdOf({ kind: 'update', id: 'hive:new-plan', version: 'mine' }), itemIdOf({ kind: 'item', id: 'hive:new-plan' }), itemIdOf({ kind: 'mcp' })]).toEqual(['hive:new-plan', 'hive:new-plan', undefined]);
});
