import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESULTS, type SettingEntry, searchSettings, settingAnchor, settingEntry } from '../src/ui/lib/settings-search.js';
import type { Language } from '../src/types.js';

const labels = (query: string, entries: readonly SettingEntry[], language: Language = 'en'): string[] => searchSettings(query, entries, language).map((m) => m.label);
const raw = (name: string): SettingEntry => ({ label: { raw: name }, path: [], view: { section: 'editor' }, anchor: settingAnchor('settings.formatters', name) });
const BRANCH = settingEntry('settings.branch', 'execution', 'settings.group.branches');
const BASE = settingEntry('settings.baseBranch', 'execution', 'settings.group.branches');

test('a label that starts with the query ranks first, then one where a word does, then one that holds it; the shorter label breaks a tie, then the index order (#689)', () => {
  assert.deepEqual(labels('branch', [BASE, BRANCH]), ['branch name for each task', 'base branch']);
  assert.deepEqual(labels('ranch', [BRANCH, BASE]), ['base branch', 'branch name for each task'], 'both inside a word: the shorter first');
  assert.deepEqual(labels('ru', [raw('rufo'), raw('ruff')]), ['rufo', 'ruff'], 'same rank and length: index order');
  assert.deepEqual(labels('   ', [BASE]), [], 'a blank query lists nothing');
});

test('matching folds case and diacritics, and the run it highlights is in the shown text (#689)', () => {
  const execution: SettingEntry = { label: 'settings.section.execution', path: [], view: { section: 'execution' }, anchor: 'x' };
  const [hit] = searchSettings('EXECUCAO', [execution], 'pt');
  assert.deepEqual([hit.label, hit.range], ['execução', [0, 8]]);
});

test('a query matches the current language and English, never a third: an English-only match is found with nothing highlighted (#689)', () => {
  const [shown] = searchSettings('branch base', [BASE], 'pt');
  assert.deepEqual([shown.label, shown.range], ['branch base', [0, 11]]);
  const [english] = searchSettings('base branch', [BASE], 'pt');
  assert.deepEqual([english.label, english.range], ['branch base', undefined]);
  assert.deepEqual(labels('idioma', [settingEntry('settings.language', 'app')], 'en'), [], 'an English Hive never reads the Portuguese text');
});

test('a match only in the synonyms or only in the path ranks last, under any label match (#689)', () => {
  const idle = settingEntry('settings.sessions.idle', 'execution', 'settings.group.waiting', 'settings.shutdownIdle');
  assert.deepEqual(labels('idle worker', [idle, raw('idle worker pool')]), ['idle worker pool', 'a worker with "shut down" armed sits idle']);
  const theme = settingEntry('settings.theme', 'app');
  assert.deepEqual(labels('app', [theme, raw('zapp')]), ['zapp', 'theme']);
  assert.equal(searchSettings('app', [theme], 'pt')[0].path, 'app');
});

test('at most 8 results, the best first (#689)', () => {
  const many = Array.from({ length: 12 }, (_, i) => raw(`item ${i + 1}`));
  assert.equal(MAX_RESULTS, 8);
  assert.deepEqual(labels('item', many), ['item 1', 'item 2', 'item 3', 'item 4', 'item 5', 'item 6', 'item 7', 'item 8']);
});

test('settingAnchor is stable and unique per context; settingEntry names its section, its card and its anchor (#689)', () => {
  assert.equal(settingAnchor('settings.baseBranch'), 'setting-settings-baseBranch');
  assert.equal(settingAnchor('settings.workspaces.name', 'w1'), 'setting-settings-workspaces-name-w1');
  assert.notEqual(settingAnchor('settings.workspaces.name', 'w1'), settingAnchor('settings.workspaces.name', 'w2'));
  assert.deepEqual(BASE, { label: 'settings.baseBranch', path: ['settings.section.execution', 'settings.group.branches'], view: { section: 'execution' }, anchor: 'setting-settings-baseBranch' });
});
