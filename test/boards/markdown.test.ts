import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkdownBoard, createMarkdownFileIfMissing, newBoardText } from '../../src/boards/markdown.js';
import type { Citation } from '../../src/cards.js';

const CITED: Citation[] = [{ column: 'Ready', by: 'fila.from' }, { column: 'In progress', by: 'fila.onStart' }, { column: 'In review', by: 'fila.onFinish' }];
const card = (id: string, title: string, column: string, url: string, blockedBy?: string[]) =>
  ({ task: { itemId: id, id, title, body: '', url, ...(blockedBy ? { blockedBy } : {}) }, column });
const HEADER = '| id | título | status |';

const BOARD = `# Board do projeto

Uma tabela que não é o board:

| coluna | valor |
|--------|-------|
| x      | 1     |

| prioridade | id   | Título          | status      | dono |
|------------|------|-----------------|-------------|------|
| alta       | T-1  | Primeira tarefa | In progress | ana  |
| média      | T-2  | Segunda tarefa  | Ready       |      |
|            |      | linha sem id    | Ready       |      |
| baixa      | T-3  | Terceira        | Ready       | bia  |

## T-2 Segunda tarefa

Descrição da T-2, com \`| pipes |\` no meio e   espaços   preservados.
`;

async function boardFile(text = BOARD): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-md-')), 'board.md');
  await writeFile(path, text);
  return path;
}

test('listCards finds the table amid other content, with extra columns and a Portuguese header, in file order', async () => {
  const path = await boardFile();
  const board = createMarkdownBoard(path, CITED);
  await board.resolveFields();
  assert.deepEqual(await board.listCards(), [
    card('T-1', 'Primeira tarefa', 'In progress', path),
    card('T-2', 'Segunda tarefa', 'Ready', path),
    card('T-3', 'Terceira', 'Ready', path),
  ]);
});

test('setColumn rewrites only the status cell of that row; the rest of the file is byte for byte the same', async () => {
  const path = await boardFile();
  await createMarkdownBoard(path, CITED).setColumn('T-2', 'In progress');
  const before = '| média      | T-2  | Segunda tarefa  | Ready       |      |';
  const after = '| média      | T-2  | Segunda tarefa  | In progress       |      |'; // cell padding kept
  assert.ok(BOARD.includes(before), 'fixture row present');
  assert.equal(await readFile(path, 'utf8'), BOARD.replace(before, after));
  assert.deepEqual((await createMarkdownBoard(path, CITED).listCards()).map((c) => c.task.id), ['T-1', 'T-2', 'T-3']);
  assert.equal((await createMarkdownBoard(path, CITED).listCards()).find((c) => c.task.id === 'T-2')?.column, 'In progress');
});

test('setColumn rejects an id that is not in the table', async () => {
  const path = await boardFile();
  await assert.rejects(createMarkdownBoard(path, CITED).setColumn('T-9', 'Ready'), { message: `task T-9 não encontrada em ${path}` });
});

test('duplicate ids are rejected by resolveFields and listCards, naming them', async () => {
  const path = await boardFile(BOARD.replace('| baixa      | T-3  |', '| baixa      | T-2  |'));
  const board = createMarkdownBoard(path, CITED);
  await assert.rejects(board.resolveFields(), /ids duplicados.*T-2/);
  await assert.rejects(board.listCards(), /ids duplicados.*T-2/);
});

test('resolveFields fails naming the path and the expected header when the table or the file is missing', async () => {
  const path = await boardFile('# só texto\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  await assert.rejects(createMarkdownBoard(path, CITED).resolveFields(), (err: Error) => {
    assert.ok(err.message.includes(path) && err.message.includes(HEADER), err.message);
    return true;
  });
  const missing = join(path, '..', 'nope.md');
  await assert.rejects(createMarkdownBoard(missing, CITED).resolveFields(), (err: Error) => {
    assert.ok(err.message.includes(missing) && err.message.includes(HEADER), err.message);
    return true;
  });
});

test('setupOptions pads a default-worded file with the defaults, but a file with its own vocabulary lists only its statuses', async () => {
  const path = await boardFile();
  assert.deepEqual(await createMarkdownBoard(path, CITED).setupOptions(), ['In progress', 'Ready', 'In review', 'Done']);
  const own = await boardFile('| id | título | status |\n|---|---|---|\n| 1 | a | feito |\n| 2 | b | a fazer |\n');
  assert.deepEqual(await createMarkdownBoard(own, CITED).setupOptions(), ['feito', 'a fazer']);
});

test('createMarkdownFileIfMissing writes the header and a Done example row once and never overwrites', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-md-')), 'docs', 'board.md');
  assert.equal(await createMarkdownFileIfMissing(path), true);
  assert.equal(await readFile(path, 'utf8'), `${HEADER}\n|---|---|---|\n| T-1 | Exemplo | Done |\n`);
  await writeFile(path, BOARD);
  assert.equal(await createMarkdownFileIfMissing(path), false);
  assert.equal(await readFile(path, 'utf8'), BOARD);
  await writeFile(path, newBoardText());
  const board = createMarkdownBoard(path, CITED);
  await board.resolveFields();
  assert.deepEqual(await board.listCards(), [], 'the example row is not queued, so a fresh setup spawns nothing');
  assert.deepEqual(await board.setupOptions(), ['Done', 'Ready', 'In progress', 'In review']);
});

test('overlapping setColumn calls are serialized: both resolve and both changes land in the file', async () => {
  const path = await boardFile();
  const board = createMarkdownBoard(path, CITED);
  await Promise.all([board.setColumn('T-1', 'In review'), board.setColumn('T-2', 'In progress')]);
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('| alta       | T-1  | Primeira tarefa | In review |'), text);
  assert.ok(text.includes('| média      | T-2  | Segunda tarefa  | In progress       |'), text);
});

test('an escaped pipe inside a cell is not a column boundary, and setColumn keeps that cell byte-identical', async () => {
  const row = '| T-1 | a \\| b | Ready |';
  const path = await boardFile(`${HEADER}\n|---|---|---|\n${row}\n`);
  const board = createMarkdownBoard(path, CITED);
  assert.deepEqual(await board.listCards(), [card('T-1', 'a \\| b', 'Ready', path)]);
  await board.setColumn('T-1', 'In progress');
  assert.equal(await readFile(path, 'utf8'), `${HEADER}\n|---|---|---|\n| T-1 | a \\| b | In progress |\n`);
});

test('setColumn throws when the row has no status cell instead of rewriting nothing', async () => {
  const path = await boardFile(`${HEADER}\n|---|---|---|\n| T-1 | só título |\n`);
  await assert.rejects(createMarkdownBoard(path, CITED).setColumn('T-1', 'In progress'), { message: `task T-1 sem célula de status em ${path}` });
});

test('two board instances writing the same file at once never corrupt it', async () => {
  const path = await boardFile();
  const a = createMarkdownBoard(path, CITED);
  const b = createMarkdownBoard(path, CITED);
  const results = await Promise.allSettled([a.setColumn('T-1', 'In review'), b.setColumn('T-2', 'In progress')]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
  const text = await readFile(path, 'utf8');
  assert.equal(text.split('\n').length, BOARD.split('\n').length, text);
  const landed = [text.includes('| T-1  | Primeira tarefa | In review |'), text.includes('| T-2  | Segunda tarefa  | In progress       |')];
  assert.ok(landed.includes(true), text);
  assert.equal((await createMarkdownBoard(path, CITED).listCards()).length, 3);
});

test('setColumn through a symlink writes the real file and keeps the link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-md-'));
  const real = join(dir, 'real.md');
  const link = join(dir, 'link.md');
  await writeFile(real, BOARD);
  await symlink(real, link);
  await createMarkdownBoard(link, CITED).setColumn('T-2', 'In progress');
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.ok((await readFile(real, 'utf8')).includes('| T-2  | Segunda tarefa  | In progress       |'));
});

test('setColumn keeps CRLF line endings byte for byte', async () => {
  const crlf = BOARD.replaceAll('\n', '\r\n');
  const path = await boardFile(crlf);
  await createMarkdownBoard(path, CITED).setColumn('T-2', 'In progress');
  const expected = crlf.replace('| Segunda tarefa  | Ready       |', '| Segunda tarefa  | In progress       |');
  assert.notEqual(expected, crlf);
  assert.equal(await readFile(path, 'utf8'), expected);
});

test('setColumn does not add a trailing newline to a file without one', async () => {
  const text = `${HEADER}\n|---|---|---|\n| T-1 | Sem newline | Ready |`;
  const path = await boardFile(text);
  await createMarkdownBoard(path, CITED).setColumn('T-1', 'In review');
  assert.equal(await readFile(path, 'utf8'), `${HEADER}\n|---|---|---|\n| T-1 | Sem newline | In review |`);
});

const DEPENDS_BOARD = `| id  | título   | status      | depende de |
|-----|----------|-------------|------------|
| T-1 | Primeira | Ready       |            |
| T-2 | Segunda  | Ready       | T-1, T-3   |
| T-3 | Terceira | In progress |            |
| T-4 | Quarta   | Done        |            |
| T-5 | Quinta   | Ready       | T-4 T-1    |
| T-6 | Sexta    | Ready       | T-4        |
`;

test('listCards lists open dependencies from the depende de column (comma and/or space), ignoring Done ones', async () => {
  const path = await boardFile(DEPENDS_BOARD);
  const cards = await createMarkdownBoard(path, CITED).listCards();
  assert.deepEqual(cards.map((c) => [c.task.id, c.task.blockedBy]), [
    ['T-1', undefined],
    ['T-2', ['T-1', 'T-3']],
    ['T-3', undefined],
    ['T-5', ['T-1']],
    ['T-6', undefined],
  ]);
  assert.deepEqual(cards[0], card('T-1', 'Primeira', 'Ready', path), 'no blockedBy key when free');
});

test('an unknown dependency id blocks the task', async () => {
  const path = await boardFile('| id | título | status | depende de |\n|---|---|---|---|\n| T-1 | Só | Ready | T-99 |\n');
  assert.deepEqual((await createMarkdownBoard(path, CITED).listCards()).map((c) => c.task.blockedBy), [['T-99']]);
});

test('a table without a dependency column yields tasks without blockedBy, even if another column mentions ids', async () => {
  const path = await boardFile('| id | título | status | notas |\n|---|---|---|---|\n| T-1 | A | Ready | ver T-2 |\n| T-2 | B | Ready | |\n');
  const cards = await createMarkdownBoard(path, CITED).listCards();
  assert.deepEqual(cards.map((c) => c.task.blockedBy), [undefined, undefined]);
});

test('the blocked by header is recognized too, normalized like the other headers', async () => {
  const path = await boardFile('| id | título | status | Blocked By |\n|---|---|---|---|\n| T-1 | A | Ready | |\n| T-2 | B | Ready | T-1 |\n');
  const cards = await createMarkdownBoard(path, CITED).listCards();
  assert.deepEqual(cards.map((c) => c.task.blockedBy), [undefined, ['T-1']]);
});

test('resolveFields rejects a cited column the file does not offer, naming the Hive column; a default-worded file accepts the defaults', async () => {
  const own = await boardFile('| id | título | status |\n|---|---|---|\n| 1 | a | feito |\n');
  await assert.rejects(createMarkdownBoard(own, CITED).resolveFields(), /"Ready" \(fila\.from\).*feito/s);
  await assert.doesNotReject(createMarkdownBoard(await boardFile(newBoardText()), CITED).resolveFields());
});
