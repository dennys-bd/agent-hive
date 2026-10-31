import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { type EditorDraft, editorDraft, editorFrom, editorProblem } from '../src/ui/lib/settings-format.js';
import { draftFrom, emptyWorkspace, toSettingsBody } from '../src/ui/lib/settings-form.js';
import { setLanguage } from '../src/ui/i18n.js';
import { EDITOR_DEFAULTS, type EditorConfig } from '../src/types.js';
import { combConfig, LOCAL_STAGES } from './fakes.js';

const SAVED: EditorConfig = {
  formatOnSave: { enabled: true, workspaces: ['hive'] },
  languages: {
    python: { server: { workspaces: [] }, formatters: { ruff: { enabled: true, args: ['--line-length', '100'], workspaces: 'all' } }, checkers: { mypy: { enabled: true, args: ['--strict'], workspaces: ['hive'] } } },
    sql: { custom: [{ name: 'sqlfluff', command: 'sqlfluff format -', extensions: ['.sql', '.psql'], workspaces: 'all' }] },
  },
};

test('editorDraft and editorFrom round-trip the editor config: args space separated (#541), extensions comma separated (#780)', () => {
  const draft = editorDraft(SAVED);
  assert.equal(draft.languages.python?.formatters.ruff?.args, '--line-length 100');
  assert.equal(draft.languages.python?.checkers.mypy?.args, '--strict');
  assert.equal(draft.languages.sql?.custom[0].extensions, '.sql, .psql');
  assert.deepEqual(editorFrom(draft), SAVED);
  assert.deepEqual(editorFrom(editorDraft()), EDITOR_DEFAULTS);
});

test('editorFrom splits args on any whitespace, so a saved arg with a space comes back as several (#541)', () => {
  const draft = editorDraft(SAVED);
  const ruff = { enabled: true, args: '  --line-length\t100\n--fix ', workspaces: 'all' as const };
  const python = draft.languages.python;
  assert.ok(python);
  const edited = { ...draft, languages: { ...draft.languages, python: { ...python, formatters: { ruff } } } };
  assert.deepEqual(editorFrom(edited).languages.python?.formatters?.ruff?.args, ['--line-length', '100', '--fix']);
});

test('editorFrom leaves out what is back on its default: a language with nothing changed, a formatter on with no args in every workspace (#780)', () => {
  const draft: EditorDraft = {
    formatOnSave: { enabled: false, workspaces: 'all' },
    languages: {
      typescript: { server: 'all', formatters: { prettier: { enabled: true, args: ' \n', workspaces: 'all' }, biome: { enabled: true, args: '', workspaces: ['web'] } }, custom: [], checkers: { tsc: { enabled: true, args: '', workspaces: 'all' } } },
      markdown: { server: 'all', formatters: {}, custom: [], checkers: {} },
    },
  };
  assert.deepEqual(editorFrom(draft), { formatOnSave: { enabled: false, workspaces: 'all' }, languages: { typescript: { formatters: { biome: { enabled: true, args: [], workspaces: ['web'] } } } } });
});

test('editorProblem names a scope still naming a workspace no longer in the form, a bad custom name, a duplicate, no command, an extension without its dot (#780)', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('en');
  const rows = [{ ...emptyWorkspace(), name: 'hive' }];
  const custom = (patch: object) => ({ formatOnSave: { enabled: true, workspaces: 'all' as const }, languages: { sql: { server: 'all' as const, formatters: {}, checkers: {}, custom: [{ id: 'x', name: 'sqlfluff', command: 'x', extensions: '.sql', workspaces: 'all' as const, ...patch }] } } });
  const cases: [EditorDraft, RegExp][] = [
    [{ formatOnSave: { enabled: true, workspaces: ['web'] }, languages: {} }, /format on save: workspace web/],
    [custom({ name: 'my sql' }), /^SQL: custom formatter 1 needs a name/],
    [custom({ command: ' ' }), /^SQL: custom formatter 1 needs a command line/],
    [custom({ extensions: 'sql' }), /^SQL: custom formatter 1 needs one or more extensions/],
    [custom({ workspaces: ['web'] }), /^SQL · sqlfluff: workspace web/],
    [{ formatOnSave: { enabled: true, workspaces: 'all' }, languages: { python: { server: 'all', formatters: {}, custom: [], checkers: { mypy: { enabled: true, args: '', workspaces: ['web'] } } } } }, /^Python · mypy: workspace web/],
  ];
  for (const [editor, message] of cases) assert.match(editorProblem({ workspaces: rows, editor })?.message ?? '', message);
  assert.equal(editorProblem({ workspaces: rows, editor: editorDraft() }), undefined);
});

test('the settings draft keeps the editor config and sends it with the body (#780)', () => {
  const config = parseConfig(combConfig({ stages: LOCAL_STAGES, editor: SAVED }));
  const draft = draftFrom({ configured: true, home: '/home', language: 'pt', agents: [], config });
  assert.deepEqual(toSettingsBody(draft).editor, SAVED);
  assert.equal('format' in toSettingsBody(draft).workspaces[0], false);
});
