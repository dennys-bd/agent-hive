import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/ui/i18n.js';
import { draftFrom } from '../src/ui/lib/settings-form.js';
import { editorEntries, matchingSections, SETTINGS_SECTIONS, unsavedKeys, unsavedSections } from '../src/ui/lib/settings-sections.js';

const saved = draftFrom({ configured: false, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }] });

test('unsavedKeys lists the draft keys that differ from the saved draft; a value typed back is no change (#510)', () => {
  assert.deepEqual(unsavedKeys(saved, saved), []);
  assert.deepEqual(unsavedKeys(saved, { ...saved, branch: 'x/{id}', theme: 'dark' }).sort(), ['branch', 'theme']);
  assert.deepEqual(unsavedKeys(saved, { ...saved, branch: saved.branch }), [], 'typed back');
  const workspaces = saved.workspaces.map((p) => ({ ...p, setup: 'RUN pnpm i' }));
  assert.deepEqual(unsavedKeys(saved, { ...saved, workspaces }), ['workspaces'], 'a row edit is one change of its key');
});

test('unsavedSections names each section with a change once, in the nav order (#510)', () => {
  assert.deepEqual(unsavedSections(['theme', 'branch', 'trustedDomains', 'consoleLines']), ['execution', 'app']);
  assert.deepEqual(unsavedSections(['workspaces']), ['workspaces']);
  assert.deepEqual(unsavedSections(['shortcuts', 'rules', 'stages', 'prefix']), ['flow', 'rules', 'shortcuts']);
  assert.deepEqual(unsavedSections(['onClose']), ['app']);
  assert.deepEqual(unsavedSections(['notifications']), ['app'], '#199');
  assert.deepEqual(unsavedSections(['defaultAgent']), ['execution'], '#516');
  assert.deepEqual(unsavedSections(['fileIcons']), ['app'], '#754');
  assert.deepEqual(unsavedSections(['sidebarsPerView']), ['app'], '#821');
  assert.deepEqual(unsavedSections(['signals']), ['rules'], '#727');
  assert.deepEqual(unsavedSections([]), []);
});

test('matchingSections filters by label, hint or field label, ignoring case and accents; empty shows all (#510)', () => {
  setLanguage('pt');
  assert.deepEqual(matchingSections('', SETTINGS_SECTIONS), [...SETTINGS_SECTIONS]);
  assert.deepEqual(matchingSections('idioma', SETTINGS_SECTIONS), ['app']);
  assert.deepEqual(matchingSections('notificações', SETTINGS_SECTIONS), ['app'], 'the notifications group (#199)');
  assert.deepEqual(matchingSections('EXECUCAO', SETTINGS_SECTIONS), ['execution']);
  assert.deepEqual(matchingSections('órfãs', SETTINGS_SECTIONS), ['maintenance']);
  assert.deepEqual(matchingSections('órfãs', SETTINGS_SECTIONS.filter((s) => s !== 'maintenance')), [], 'only the sections offered');
  assert.deepEqual(matchingSections('zzz', SETTINGS_SECTIONS), []);
  assert.deepEqual(matchingSections('comandos', SETTINGS_SECTIONS), ['workspaces', 'shortcuts'], 'the commands card (#511) and the buscar comandos key (#584)');
  assert.deepEqual(matchingSections('ambiente', SETTINGS_SECTIONS), ['workspaces'], 'a workspace env (#511)');
  assert.ok(matchingSections('agente padrão', SETTINGS_SECTIONS).includes('execution'), 'the default agent (#516)');
  assert.deepEqual(matchingSections('aprovação', SETTINGS_SECTIONS), ['execution'], 'approval left the nav hint but is still found (#516)');
  assert.deepEqual(matchingSections('prefixo', SETTINGS_SECTIONS), ['flow'], 'the local row, moved out of the removed Comb task (#524)');
  assert.deepEqual(matchingSections('conexões', SETTINGS_SECTIONS), ['flow'], 'the conexões task, replacing acesso ao GitHub (#524)');
  assert.deepEqual(matchingSections('regras de uso', SETTINGS_SECTIONS), ['rules'], 'the renamed task (#526)');
  assert.deepEqual(matchingSections('medida', SETTINGS_SECTIONS), ['rules'], 'the per-rule measure (#526)');
  assert.ok(matchingSections('GitHub', SETTINGS_SECTIONS).includes('rules'));
  assert.deepEqual(matchingSections('ícones de arquivo', SETTINGS_SECTIONS), ['app'], 'the files tree icons (#754)');
  assert.deepEqual(matchingSections('laterais por visão', SETTINGS_SECTIONS), ['app'], 'the sidebars per view card (#821)');
  setLanguage('en');
  assert.deepEqual(matchingSections('budget', SETTINGS_SECTIONS), ['rules']);
  setLanguage('pt');
});

test('the editor section (#749, #780) follows app in the nav, owns the editor draft key and is found by its field labels', () => {
  setLanguage('pt');
  assert.deepEqual(SETTINGS_SECTIONS.slice(4, 7), ['app', 'editor', 'shortcuts']);
  assert.deepEqual(unsavedSections(['editor', 'theme']), ['app', 'editor']);
  assert.deepEqual(matchingSections('formatar', SETTINGS_SECTIONS), ['editor']);
  assert.deepEqual(matchingSections('sintaxe', SETTINGS_SECTIONS), ['editor']);
});

test('the Settings search finds a language, its server and its formatters, prettier once per language it serves (#780)', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('pt');
  assert.deepEqual(editorEntries('pyright'), [{ language: 'python', text: 'pyright', path: 'editor › Python · language server' }]);
  assert.deepEqual(editorEntries('pytho').map((e) => e.path), ['editor › linguagens']);
  assert.deepEqual(editorEntries('prettier').map((e) => e.language), ['typescript', 'yaml', 'web', 'markdown', 'other']);
  assert.deepEqual(editorEntries(''), []);
});

test('the commands card\'s per-workspace column and its no menu switch are found under workspaces (#755)', () => {
  setLanguage('pt');
  for (const query of ['em cada workspace', 'no menu']) assert.ok(matchingSections(query, SETTINGS_SECTIONS).includes('workspaces'), query);
  setLanguage('en');
});

test('the signal card is found under rules, in both languages (#727)', () => {
  setLanguage('pt');
  assert.ok(matchingSections('sinal', SETTINGS_SECTIONS).includes('rules'));
  setLanguage('en');
});
