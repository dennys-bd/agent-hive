import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkdownBoard, createMarkdownFileIfMissing, newBoardText } from '../../src/boards/markdown.js';
import type { StatusKey } from '../../src/types.js';

const STATUS: Record<StatusKey, string> = { queue: 'Ready', working: 'In progress', review: 'In review' };
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

test('listQueue finds the table amid other content, with extra columns and a Portuguese header, in file order', async () => {
  const path = await boardFile();
  const board = createMarkdownBoard(path, STATUS);
  await board.resolveFields();
  assert.deepEqual(await board.listQueue(), [
    { itemId: 'T-2', id: 'T-2', title: 'Segunda tarefa', body: '', url: path },
    { itemId: 'T-3', id: 'T-3', title: 'Terceira', body: '', url: path },
  ]);
});

test('setStatus rewrites only the status cell of that row; the rest of the file is byte for byte the same', async () => {
  const path = await boardFile();
  await createMarkdownBoard(path, STATUS).setStatus('T-2', 'working');
  const before = '| média      | T-2  | Segunda tarefa  | Ready       |      |';
  const after = '| média      | T-2  | Segunda tarefa  | In progress       |      |'; // cell padding kept
  assert.ok(BOARD.includes(before), 'fixture row present');
  assert.equal(await readFile(path, 'utf8'), BOARD.replace(before, after));
  assert.deepEqual((await createMarkdownBoard(path, STATUS).listQueue()).map((t) => t.id), ['T-3']);
});

test('setStatus rejects an id that is not in the table', async () => {
  const path = await boardFile();
  await assert.rejects(createMarkdownBoard(path, STATUS).setStatus('T-9', 'queue'), { message: `task T-9 não encontrada em ${path}` });
});

test('duplicate ids are rejected by resolveFields and listQueue, naming them', async () => {
  const path = await boardFile(BOARD.replace('| baixa      | T-3  |', '| baixa      | T-2  |'));
  const board = createMarkdownBoard(path, STATUS);
  await assert.rejects(board.resolveFields(), /ids duplicados.*T-2/);
  await assert.rejects(board.listQueue(), /ids duplicados.*T-2/);
});

test('resolveFields fails naming the path and the expected header when the table or the file is missing', async () => {
  const path = await boardFile('# só texto\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  await assert.rejects(createMarkdownBoard(path, STATUS).resolveFields(), (err: Error) => {
    assert.ok(err.message.includes(path) && err.message.includes(HEADER), err.message);
    return true;
  });
  const missing = join(path, '..', 'nope.md');
  await assert.rejects(createMarkdownBoard(missing, STATUS).resolveFields(), (err: Error) => {
    assert.ok(err.message.includes(missing) && err.message.includes(HEADER), err.message);
    return true;
  });
});

test('setupOptions lists the statuses in the file first, then the defaults not yet present', async () => {
  const path = await boardFile();
  assert.deepEqual(await createMarkdownBoard(path, STATUS).setupOptions(), ['In progress', 'Ready', 'In review', 'Done']);
});

test('createMarkdownFileIfMissing writes the header and a Done example row once and never overwrites', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-md-')), 'docs', 'board.md');
  assert.equal(await createMarkdownFileIfMissing(path), true);
  assert.equal(await readFile(path, 'utf8'), `${HEADER}\n|---|---|---|\n| T-1 | Exemplo | Done |\n`);
  await writeFile(path, BOARD);
  assert.equal(await createMarkdownFileIfMissing(path), false);
  assert.equal(await readFile(path, 'utf8'), BOARD);
  await writeFile(path, newBoardText());
  const board = createMarkdownBoard(path, STATUS);
  await board.resolveFields();
  assert.deepEqual(await board.listQueue(), [], 'the example row is not queued, so a fresh setup spawns nothing');
  assert.deepEqual(await board.setupOptions(), ['Done', 'Ready', 'In progress', 'In review']);
});

test('overlapping setStatus calls are serialized: both resolve and both changes land in the file', async () => {
  const path = await boardFile();
  const board = createMarkdownBoard(path, STATUS);
  await Promise.all([board.setStatus('T-1', 'review'), board.setStatus('T-2', 'working')]);
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('| alta       | T-1  | Primeira tarefa | In review |'), text);
  assert.ok(text.includes('| média      | T-2  | Segunda tarefa  | In progress       |'), text);
});

test('an escaped pipe inside a cell is not a column boundary, and setStatus keeps that cell byte-identical', async () => {
  const row = '| T-1 | a \\| b | Ready |';
  const path = await boardFile(`${HEADER}\n|---|---|---|\n${row}\n`);
  const board = createMarkdownBoard(path, STATUS);
  assert.deepEqual(await board.listQueue(), [{ itemId: 'T-1', id: 'T-1', title: 'a \\| b', body: '', url: path }]);
  await board.setStatus('T-1', 'working');
  assert.equal(await readFile(path, 'utf8'), `${HEADER}\n|---|---|---|\n| T-1 | a \\| b | In progress |\n`);
});

test('setStatus throws when the row has no status cell instead of rewriting nothing', async () => {
  const path = await boardFile(`${HEADER}\n|---|---|---|\n| T-1 | só título |\n`);
  await assert.rejects(createMarkdownBoard(path, STATUS).setStatus('T-1', 'working'), { message: `task T-1 sem célula de status em ${path}` });
});

test('two board instances writing the same file at once never corrupt it', async () => {
  const path = await boardFile();
  const a = createMarkdownBoard(path, STATUS);
  const b = createMarkdownBoard(path, STATUS);
  const results = await Promise.allSettled([a.setStatus('T-1', 'review'), b.setStatus('T-2', 'working')]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
  const text = await readFile(path, 'utf8');
  assert.equal(text.split('\n').length, BOARD.split('\n').length, text);
  const landed = [text.includes('| T-1  | Primeira tarefa | In review |'), text.includes('| T-2  | Segunda tarefa  | In progress       |')];
  assert.ok(landed.includes(true), text);
  assert.equal((await createMarkdownBoard(path, STATUS).listQueue()).length, landed[1] ? 1 : 2);
});

test('setStatus through a symlink writes the real file and keeps the link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-md-'));
  const real = join(dir, 'real.md');
  const link = join(dir, 'link.md');
  await writeFile(real, BOARD);
  await symlink(real, link);
  await createMarkdownBoard(link, STATUS).setStatus('T-2', 'working');
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.ok((await readFile(real, 'utf8')).includes('| T-2  | Segunda tarefa  | In progress       |'));
});

test('setStatus keeps CRLF line endings byte for byte', async () => {
  const crlf = BOARD.replaceAll('\n', '\r\n');
  const path = await boardFile(crlf);
  await createMarkdownBoard(path, STATUS).setStatus('T-2', 'working');
  const expected = crlf.replace('| Segunda tarefa  | Ready       |', '| Segunda tarefa  | In progress       |');
  assert.notEqual(expected, crlf);
  assert.equal(await readFile(path, 'utf8'), expected);
});

test('setStatus does not add a trailing newline to a file without one', async () => {
  const text = `${HEADER}\n|---|---|---|\n| T-1 | Sem newline | Ready |`;
  const path = await boardFile(text);
  await createMarkdownBoard(path, STATUS).setStatus('T-1', 'review');
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

test('listQueue lists open dependencies from the depende de column (comma and/or space), ignoring Done ones', async () => {
  const path = await boardFile(DEPENDS_BOARD);
  const queue = await createMarkdownBoard(path, STATUS).listQueue();
  assert.deepEqual(queue.map((t) => [t.id, t.blockedBy]), [
    ['T-1', undefined],
    ['T-2', ['T-1', 'T-3']],
    ['T-5', ['T-1']],
    ['T-6', undefined],
  ]);
  assert.deepEqual(queue[0], { itemId: 'T-1', id: 'T-1', title: 'Primeira', body: '', url: path }, 'no blockedBy key when free');
});

test('an unknown dependency id blocks the task', async () => {
  const path = await boardFile('| id | título | status | depende de |\n|---|---|---|---|\n| T-1 | Só | Ready | T-99 |\n');
  assert.deepEqual((await createMarkdownBoard(path, STATUS).listQueue()).map((t) => t.blockedBy), [['T-99']]);
});

test('a table without a dependency column yields tasks without blockedBy, even if another column mentions ids', async () => {
  const path = await boardFile('| id | título | status | notas |\n|---|---|---|---|\n| T-1 | A | Ready | ver T-2 |\n| T-2 | B | Ready | |\n');
  const queue = await createMarkdownBoard(path, STATUS).listQueue();
  assert.deepEqual(queue.map((t) => t.blockedBy), [undefined, undefined]);
});

test('the blocked by header is recognized too, normalized like the other headers', async () => {
  const path = await boardFile('| id | título | status | Blocked By |\n|---|---|---|---|\n| T-1 | A | Ready | |\n| T-2 | B | Ready | T-1 |\n');
  const queue = await createMarkdownBoard(path, STATUS).listQueue();
  assert.deepEqual(queue.map((t) => t.blockedBy), [undefined, ['T-1']]);
});
