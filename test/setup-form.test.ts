import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { columnsUrl, draftFrom, emptyColumn, emptyRule, toSetupBody, validateSetup } from '../src/ui/lib/setup-form.js';
import type { Config, SetupInfo } from '../src/types.js';

const CONFIG: Config = {
  board: { type: 'github', owner: 'acme', number: 6 }, workers: 'iterm', epics: 'queue', logLevel: 'info', language: 'pt',
  columns: [
    { name: 'spec', weight: 5, from: ['Backlog'], onFinish: 'Ready', prompt: '/hive-spec {url}', model: 'opus' },
    { name: 'dev', weight: 1, from: ['Ready'], onStart: 'In progress', onFinish: 'In review', prompt: '/hive-build {url}', session: 'continue' },
  ],
  maxConcurrent: 2, port: 47821, claudeArgs: [], budget: { maxTokensPerHour: 50_000 }, usageRules: [{ percent: 80, signal: 'yellow' }, { percent: 90, maxWorkers: 1, signal: 'red' }],
};
const info = (config?: Config, configured = true): SetupInfo => ({ configured, repo: '/repo', config, language: config?.language ?? 'en' });
// id is generated per row (React key material, never sent to the server): every literal comparison strips it out.
const withoutId = <T extends { id: string }>(draft: T): Omit<T, 'id'> => {
  const { id: _id, ...rest } = draft;
  return rest;
};

test('draftFrom fills every field as strings from a github config, keeps a markdown path, and defaults an empty setup', () => {
  const github = draftFrom(info(CONFIG));
  assert.equal(github.boardType, 'github');
  assert.deepEqual([github.owner, github.project, github.markdownPath], ['acme', '6', 'board.md']);
  assert.deepEqual(withoutId(github.columns[0]), { name: 'spec', weight: '5', session: 'new', model: 'opus', from: ['Backlog'], onStart: '', onFinish: 'Ready', prompt: '/hive-spec {url}' });
  assert.equal(github.columns[1].session, 'continue');
  assert.notEqual(github.columns[0].id, github.columns[1].id, 'each row gets its own id');
  assert.deepEqual([github.language, github.workers, github.epics, github.budgetHour, github.budgetDay], ['pt', 'iterm', 'queue', '50000', '']);
  assert.deepEqual(github.rules.map(withoutId), [{ percent: '80', maxWorkers: '', signal: 'yellow' }, { percent: '90', maxWorkers: '1', signal: 'red' }]);
  assert.notEqual(github.rules[0].id, github.rules[1].id, 'each row gets its own id');
  const markdown = draftFrom(info({ ...CONFIG, board: { type: 'markdown', path: 'docs/board.md' } }));
  assert.deepEqual([markdown.boardType, markdown.markdownPath, markdown.owner, markdown.project], ['markdown', 'docs/board.md', '@me', '']);
  const empty = draftFrom(info(undefined, false));
  assert.deepEqual(empty, {
    boardType: 'github', owner: '@me', project: '', markdownPath: 'board.md', columns: [], language: 'en', workers: 'embedded', epics: 'ignore',
    budgetHour: '', budgetDay: '', rules: [],
  });
  assert.equal(draftFrom(undefined).language, 'en');
});

test('validateSetup answers the tab and message of the first problem, in the order of today, and undefined for a valid draft', () => {
  setLanguage('pt');
  const valid = draftFrom(info(CONFIG));
  assert.equal(validateSetup(valid), undefined);
  assert.deepEqual(validateSetup({ ...valid, project: '' }), { tab: 'board', message: t('setup.error.project') });
  assert.deepEqual(validateSetup({ ...valid, boardType: 'markdown', markdownPath: '  ' }), { tab: 'board', message: t('setup.error.path') });
  assert.deepEqual(validateSetup({ ...valid, columns: [] }), { tab: 'board', message: t('setup.columns.none') });
  assert.deepEqual(validateSetup({ ...valid, columns: [valid.columns[0], { ...emptyColumn(), name: ' ' }] }), { tab: 'board', message: t('setup.columns.error', { n: 2 }) });
  assert.deepEqual(validateSetup({ ...valid, columns: [{ ...valid.columns[0], weight: '1.5' }] }), { tab: 'board', message: t('setup.columns.error', { n: 1 }) });
  assert.deepEqual(validateSetup({ ...valid, columns: [{ ...valid.columns[0], weight: '-1' }] }), { tab: 'board', message: t('setup.columns.error', { n: 1 }) });
  assert.deepEqual(validateSetup({ ...valid, rules: [{ ...emptyRule(), percent: '50' }] }), { tab: 'limits', message: t('setup.rules.error', { n: 1 }) });
  assert.deepEqual(validateSetup({ ...valid, rules: [valid.rules[0], { ...emptyRule(), percent: '101', maxWorkers: '1' }] }), { tab: 'limits', message: t('setup.rules.error', { n: 2 }) });
  assert.deepEqual(validateSetup({ ...valid, budgetHour: 'abc' }), { tab: 'limits', message: t('setup.budgetHint') });
  assert.deepEqual(validateSetup({ ...valid, budgetDay: '-5' }), { tab: 'limits', message: t('setup.budgetHint') });
  assert.equal(validateSetup({ ...valid, budgetHour: '0', budgetDay: '' }), undefined, '0 and empty mean no limit');
  assert.equal(validateSetup({ ...valid, columns: [{ ...valid.columns[0], weight: '0' }] }), undefined, 'weight 0 is allowed');
});

test('toSetupBody emits only filled keys, keeps column and rule order, and reads the board from the type', () => {
  const body = toSetupBody(draftFrom(info(CONFIG)));
  assert.deepEqual(body, {
    board: { type: 'github', owner: 'acme', number: 6 },
    columns: CONFIG.columns,
    workers: 'iterm', epics: 'queue', budget: { maxTokensPerHour: 50_000 }, usageRules: CONFIG.usageRules, language: 'pt',
  });
  assert.equal('maxConcurrent' in body, false, 'the header owns it after the first boot');
  assert.equal('id' in body.columns[0]!, false, 'id is a draft-only field, never sent to the server');
  assert.equal('id' in body.usageRules![0]!, false, 'id is a draft-only field, never sent to the server');
  const bare = toSetupBody({ ...draftFrom(undefined), boardType: 'markdown', markdownPath: ' docs/b.md ', columns: [{ ...emptyColumn(), name: 'fila', weight: '1', from: ['Ready'] }], rules: [{ ...emptyRule(), percent: '80', signal: 'red' }] });
  assert.deepEqual(bare.board, { type: 'markdown', path: 'docs/b.md' });
  assert.deepEqual(bare.columns, [{ name: 'fila', weight: 1, from: ['Ready'] }], 'session=new, empty model / onStart / onFinish / prompt stay absent');
  assert.deepEqual(bare.usageRules, [{ percent: 80, signal: 'red' }]);
  assert.deepEqual(bare.budget, {});
  assert.equal('id' in bare.columns[0]!, false);
  assert.equal('id' in bare.usageRules![0]!, false);
  assert.deepEqual(withoutId(emptyColumn()), { name: '', weight: '1', session: 'new', model: '', from: [], onStart: '', onFinish: '', prompt: '' });
  assert.deepEqual(withoutId(emptyRule()), { percent: '', maxWorkers: '', signal: '' });
  assert.notEqual(emptyColumn().id, emptyColumn().id, 'ids are unique per call');
});

test('columnsUrl builds the GET /setup/columns query for either board type and is undefined while the board is not chosen', () => {
  const draft = draftFrom(info(CONFIG));
  assert.equal(columnsUrl(draft), '/setup/columns?type=github&owner=acme&number=6');
  assert.equal(columnsUrl({ ...draft, project: '' }), undefined);
  assert.equal(columnsUrl({ ...draft, owner: ' ' }), undefined);
  assert.equal(columnsUrl({ ...draft, boardType: 'markdown', markdownPath: 'docs/board.md' }), '/setup/columns?type=markdown&path=docs%2Fboard.md');
  assert.equal(columnsUrl({ ...draft, boardType: 'markdown', markdownPath: '' }), undefined);
});
