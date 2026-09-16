import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

test('createMarkdownFileIfMissing writes the header and an example row once and never overwrites', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-md-')), 'docs', 'board.md');
  assert.equal(await createMarkdownFileIfMissing(path, 'Ready'), true);
  assert.equal(await readFile(path, 'utf8'), `${HEADER}\n|---|---|---|\n| T-1 | Exemplo | Ready |\n`);
  assert.equal(await createMarkdownFileIfMissing(path, 'Todo'), false);
  assert.equal(await readFile(path, 'utf8'), newBoardText('Ready'));
  const board = createMarkdownBoard(path, STATUS);
  await board.resolveFields();
  assert.deepEqual((await board.listQueue()).map((t) => t.id), ['T-1']);
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
