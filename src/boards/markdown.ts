import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Board, BoardConfig, StatusKey, Task } from '../types.js';

export type MarkdownBoardConfig = Extract<BoardConfig, { type: 'markdown' }>;

export const EXPECTED_HEADER = '| id | título | status |';
/** Always offered in the setup form, after whatever the file already uses. */
export const DEFAULT_STATUS_OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];
const TITLE_HEADERS = ['titulo', 'title'];
const SEPARATOR_CELL = /^\s*:?-+:?\s*$/;
const CELL_BOUNDARY = /(?<!\\)\|/; // a `\|` inside a cell is content, not a column boundary
const COMBINING_MARKS = /[\u0300-\u036f]/g;

interface Columns { id: number; title: number; status: number }
interface Row { lineIndex: number; id: string; title: string; status: string }
interface Table { lines: string[]; columns: Columns; rows: Row[] }
interface SplitLine { head: string; cells: string[]; tail: string }

/** Relative paths are resolved against the repo; absolute paths are kept. */
export function markdownPath(repo: string, path: string): string {
  return resolve(repo, path);
}

/** Header, separator and one example row in the queue column. */
export function newBoardText(queueStatus: string): string {
  return `${EXPECTED_HEADER}\n|---|---|---|\n| T-1 | Exemplo | ${queueStatus} |\n`;
}

/** Creates the file when it does not exist (parents included); resolves true when created. Never touches an existing file. */
export async function createMarkdownFileIfMissing(path: string, queueStatus: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, newBoardText(queueStatus), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

const isTableLine = (line: string): boolean => line.trimStart().startsWith('|');

// Splits `| a | b |` into raw cells, keeping the text before the first pipe and from the closing pipe on,
// so the line can be rebuilt byte for byte after one cell changes.
function splitLine(line: string): SplitLine {
  const first = line.indexOf('|');
  const end = line.trimEnd();
  const last = end.endsWith('|') && end.length - 1 > first ? end.length - 1 : line.length;
  return { head: line.slice(0, first + 1), cells: line.slice(first + 1, last).split(CELL_BOUNDARY), tail: line.slice(last) };
}

const joinLine = ({ head, cells, tail }: SplitLine): string => head + cells.join('|') + tail;

const isSeparator = (line: string): boolean => isTableLine(line) && splitLine(line).cells.every((c) => SEPARATOR_CELL.test(c));

const normalizeHeader = (cell: string): string => cell.normalize('NFD').replace(COMBINING_MARKS, '').trim().toLowerCase();

function findColumns(headerCells: string[]): Columns | undefined {
  const names = headerCells.map(normalizeHeader);
  const columns = { id: names.indexOf('id'), title: names.findIndex((n) => TITLE_HEADERS.includes(n)), status: names.indexOf('status') };
  return columns.id >= 0 && columns.title >= 0 && columns.status >= 0 ? columns : undefined;
}

const cellText = (cells: string[], index: number): string => (cells[index] ?? '').trim();

function readRows(lines: string[], start: number, columns: Columns): Row[] {
  const rows: Row[] = [];
  for (let i = start; i < lines.length && isTableLine(lines[i]); i++) {
    const cells = splitLine(lines[i]).cells;
    const id = cellText(cells, columns.id);
    if (id === '') continue;
    rows.push({ lineIndex: i, id, title: cellText(cells, columns.title), status: cellText(cells, columns.status) });
  }
  return rows;
}

/** The first table whose header has id, título/title and status columns (any order, extra columns allowed). */
function parseTable(text: string): Table | undefined {
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableLine(lines[i]) || !isSeparator(lines[i + 1])) continue;
    const columns = findColumns(splitLine(lines[i]).cells);
    if (columns) return { lines, columns, rows: readRows(lines, i + 2, columns) };
  }
  return undefined;
}

function duplicateIds(rows: Row[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const { id } of rows) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

// Replaces the text of a cell keeping its padding; an all-blank cell gets one space each side.
function replaceCell(cell: string, value: string): string {
  const content = cell.trim();
  if (content === '') return ` ${value} `;
  const start = cell.indexOf(content);
  return cell.slice(0, start) + value + cell.slice(start + content.length);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export function createMarkdownBoard(path: string, status: Record<StatusKey, string>): Board {
  // Dispatches overlap in-process, and two read-modify-writes on the same file would lose one
  // update and race on the same .tmp. Chaining them makes each call re-read after the previous rename.
  let writeChain: Promise<unknown> = Promise.resolve();

  // Always re-reads: the file is edited by hand too. No cache, no file lock (single user, local).
  async function loadTable(): Promise<Table> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path} não existe (esperado um arquivo com a tabela ${EXPECTED_HEADER})`);
      throw err;
    }
    const table = parseTable(text);
    if (!table) throw new Error(`${path} não tem uma tabela com o cabeçalho ${EXPECTED_HEADER}`);
    const dupes = duplicateIds(table.rows);
    if (dupes.length > 0) throw new Error(`${path}: ids duplicados na tabela: ${dupes.join(', ')}`);
    return table;
  }

  async function resolveFields(): Promise<void> {
    await loadTable();
  }

  async function listQueue(): Promise<Task[]> {
    const { rows } = await loadTable();
    return rows.filter((r) => r.status === status.queue).map((r) => ({ itemId: r.id, id: r.id, title: r.title, body: '', url: path }));
  }

  async function rewriteStatus(itemId: string, key: StatusKey): Promise<void> {
    const { lines, columns, rows } = await loadTable();
    const row = rows.find((r) => r.id === itemId);
    if (!row) throw new Error(`task ${itemId} não encontrada em ${path}`);
    const split = splitLine(lines[row.lineIndex]);
    if (split.cells.length <= columns.status) throw new Error(`task ${itemId} sem célula de status em ${path}`);
    const cells = split.cells.map((cell, i) => (i === columns.status ? replaceCell(cell, status[key]) : cell));
    const updated = lines.map((line, i) => (i === row.lineIndex ? joinLine({ ...split, cells }) : line));
    await writeAtomic(path, updated.join('\n'));
  }

  function setStatus(itemId: string, key: StatusKey): Promise<void> {
    const run = () => rewriteStatus(itemId, key);
    const link = writeChain.then(run, run);
    writeChain = link.catch(() => undefined); // a failed write must not poison the chain
    return link;
  }

  async function setupOptions(): Promise<string[]> {
    const { rows } = await loadTable();
    return [...new Set([...rows.map((r) => r.status).filter((s) => s !== ''), ...DEFAULT_STATUS_OPTIONS])];
  }

  return { resolveFields, listQueue, setStatus, setupOptions };
}
