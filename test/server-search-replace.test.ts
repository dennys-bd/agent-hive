import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Machine } from '../src/machine.js';
import { localActivityId } from '../src/activities.js';
import { sha256 } from '../src/server-editor.js';
import { MATCH_END, MATCH_START, type GrepLine } from '../src/server-search.js';
import { replaceFiles, replaceInBytes, replaceLine, replaceRequestOf } from '../src/server-search-replace.js';
import { EDITOR_FILE_MAX, type ReplaceAnswer, type ReplaceRequest, SEARCH_CAP } from '../src/types.js';
import { fakeFiles, fakeMachine, statsOf } from './fake-machine.js';
import { grepMachine } from './fixtures/grep-machine.js';
import { postJson, startTree } from './fixtures/tree-server.js';
import { hiveFetch } from './secret-client.js';

const Q = { q: 'port', isCaseSensitive: false, isWholeWord: false, isRegex: false };
const mark = (text: string): string => `${MATCH_START.toString('latin1')}${text}${MATCH_END.toString('latin1')}`;
const hit = (file: string, line: number, text: string): Buffer => Buffer.from(`${file}\0${line}\0${text}\n`, 'utf8');
const ROOT = '/wt';
const buf = (text: string): Buffer => Buffer.from(text, 'utf8');
const row = (line: number, raw: string, spans: [number, number][]): GrepLine => ({ file: 'f', line, raw: buf(raw), spans });

test('replaceLine: the replacement is literal, so $1 stays $1 (#868)', () => {
  assert.equal(replaceLine(buf('a port b port'), [[2, 6], [9, 13]], buf('$1')).toString(), 'a $1 b $1');
});

test('replaceInBytes: only the reported spans change, CRLF and other lines are kept, a moved line answers undefined, multibyte stays UTF-8 (#868)', () => {
  const file = buf('one\r\nport and port\r\nthree\r\n');
  const lines = [row(2, 'port and port\r', [[0, 4], [9, 13]])];
  assert.equal(replaceInBytes(file, lines, buf('X'))?.toString(), 'one\r\nX and X\r\nthree\r\n');
  assert.equal(replaceInBytes(file, [row(2, 'port and other\r', [[0, 4]])], buf('X')), undefined);
  assert.equal(replaceInBytes(buf('only\n'), [row(3, 'port', [[0, 4]])], buf('X')), undefined, 'a reported line the file no longer has');
  const accented = 'ação pôrt';
  const spans: [number, number][] = [[buf('ação ').length, buf('ação pôrt').length]];
  const out = replaceInBytes(buf(`${accented}\n`), [row(1, accented, spans)], buf('é'));
  assert.equal(out?.toString('utf8'), 'ação é\n');
});

const request = (files: string[]): ReplaceRequest => ({ query: Q, replacement: 'NEW', files });

test('replaceFiles on a fake machine: each refusal named, the ok file written once with its previous text, version and count (#868)', async () => {
  const text = (name: string): Buffer => hit(name, 1, `a ${mark('port')} b ${mark('port')}`);
  const names = ['big.ts', 'bin.dat', 'ro.ts', 'link.ts', 'moved.ts', 'ok.ts'];
  const { machine } = grepMachine({ [ROOT]: { out: names.map(text) } }, fakeMachine({ exec: async () => ({ stdout: '' }) }));
  const written: [string, string][] = [];
  const disk: Record<string, Buffer> = { 'ro.ts': buf('a port b port'), 'moved.ts': buf('changed port'), 'ok.ts': buf('a port b port'), 'bin.dat': Buffer.from([0xff, 0xfe]) };
  const fs = {
    lstat: async (path: string) => (path.endsWith('link.ts') ? { isFile: () => false } : statsOf('file')),
    stat: async (path: string) => ({ size: path.endsWith('big.ts') ? EDITOR_FILE_MAX + 1 : 20, mode: path.endsWith('ro.ts') ? 0o444 : 0o644 }),
    readFile: async (path: string) => disk[path.slice(ROOT.length + 1)] ?? Buffer.alloc(0),
    writeAtomic: async (path: string, content: string) => {
      written.push([path, content]);
      return buf(content);
    },
  };
  const wired = { ...machine, fs: { ...machine.fs, ...fs } } as unknown as Machine;
  const answer = await replaceFiles(wired, ROOT, request(names));
  assert.deepEqual(answer, {
    changed: [{ path: 'ok.ts', previous: 'a port b port', version: sha256(buf('a NEW b NEW')), count: 2 }],
    skipped: [
      { path: 'big.ts', reason: 'too_large' }, { path: 'bin.dat', reason: 'not_text' }, { path: 'link.ts', reason: 'not_text' },
      { path: 'moved.ts', reason: 'changed' }, { path: 'ro.ts', reason: 'read_only' },
    ],
  } satisfies ReplaceAnswer);
  assert.deepEqual(written.map(([path]) => path.slice(ROOT.length + 1)), ['ok.ts']);
});

test('replaceFiles: a file that throws is named failed and the files already written are still answered, so the undo exists (#868)', async () => {
  const names = ['a.ts', 'boom.ts', 'denied.ts', 'z.ts'];
  const { machine } = grepMachine({ [ROOT]: { out: names.map((name) => hit(name, 1, `a ${mark('port')}`)) } }, fakeMachine({ exec: async () => ({ stdout: '' }) }));
  const fs = {
    lstat: async () => statsOf('file'),
    stat: async () => ({ size: 5, mode: 0o644 }),
    readFile: async (path: string) => {
      if (path.endsWith('denied.ts')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return buf('a port');
    },
    writeAtomic: async (path: string, content: string) => {
      if (path.endsWith('boom.ts')) throw new Error('ENOSPC');
      return buf(content);
    },
  };
  const wired = { ...machine, fs: { ...machine.fs, ...fs } } as unknown as Machine;
  const answer = await replaceFiles(wired, ROOT, request(names));
  assert.ok(!('error' in answer));
  assert.deepEqual(answer.changed.map((c) => c.path), ['a.ts', 'z.ts']);
  assert.deepEqual(answer.skipped, [{ path: 'boom.ts', reason: 'failed' }, { path: 'denied.ts', reason: 'failed' }]);
});

test('replaceFiles: more than SEARCH_CAP matches kills the grep, writes nothing and refuses with too_many_matches (#868)', async () => {
  const many = Buffer.concat(Array.from({ length: SEARCH_CAP + 1 }, (_, i) => hit(`f${i}.ts`, 1, mark('port'))));
  const { machine, killed } = grepMachine({ [ROOT]: { out: [many], isHeld: true } }, fakeMachine({ exec: async () => ({ stdout: '' }) }));
  let writes = 0;
  const wired = { ...machine, fs: { ...machine.fs, writeAtomic: async () => { writes += 1; return Buffer.alloc(0); } } } as unknown as Machine;
  const answer = await replaceFiles(wired, ROOT, request(['a.ts']));
  assert.ok('error' in answer);
  assert.equal(answer.code, 'too_many_matches');
  assert.deepEqual(killed, [ROOT]);
  assert.equal(writes, 0);
});

test('replaceFiles: an aborted signal kills the grep and writes nothing (#868)', async () => {
  const { machine, killed } = grepMachine({ [ROOT]: { out: [hit('a.ts', 1, mark('port'))], isHeld: true } }, fakeMachine({ exec: async () => ({ stdout: '' }) }));
  let writes = 0;
  const wired = { ...machine, fs: { ...machine.fs, writeAtomic: async () => { writes += 1; return Buffer.alloc(0); } } } as unknown as Machine;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const answer = await replaceFiles(wired, ROOT, request(['a.ts']), controller.signal);
  assert.ok('error' in answer);
  assert.deepEqual(killed, [ROOT]);
  assert.equal(writes, 0);
});

test('replaceFiles: a failing grep answers { error } and writes nothing (#868)', async () => {
  const { machine } = grepMachine({ [ROOT]: { err: 'fatal: bad pattern\n', code: 128 } }, fakeMachine({ fs: fakeFiles() }));
  let writes = 0;
  const wired = { ...machine, fs: { ...machine.fs, writeAtomic: async () => { writes += 1; return Buffer.alloc(0); } } } as unknown as Machine;
  assert.deepEqual(await replaceFiles(wired, ROOT, request(['a.ts'])), { error: 'bad pattern' });
  assert.equal(writes, 0);
});

test('replaceRequestOf: a query with q, a string replacement and 1 to SEARCH_CAP files; anything else is refused (#868)', () => {
  const good = { query: Q, replacement: '', files: ['a.ts'] };
  assert.deepEqual(replaceRequestOf(good), good);
  const bad = [{ ...good, query: { ...Q, q: '' } }, { query: Q, files: ['a'] }, { ...good, files: [] }, { ...good, files: [1] }, { ...good, files: Array.from({ length: SEARCH_CAP + 1 }, () => 'a.ts') }, null];
  for (const raw of bad) assert.equal(replaceRequestOf(raw), undefined);
});

const LOCAL = `/activities/${encodeURIComponent(localActivityId('hive'))}`;

test('POST /activities/local:hive/search/replace on a real repository: the root and the nested docs written, the version the editor reads, a second run finds nothing (#868)', async (t) => {
  const f = await startTree(t, () => [], { exec: promisify(execFile) });
  await writeFile(join(f.repo, '.gitignore'), '/docs/\n');
  await writeFile(join(f.repo, 'a.ts'), 'const daemonPort = 1;\r\nlog(daemonPort, daemonPort);\r\n');
  await mkdir(join(f.repo, 'docs', 'agent'), { recursive: true });
  await promisify(execFile)('git', ['init', '--quiet', join(f.repo, 'docs')]);
  await writeFile(join(f.repo, 'docs', 'agent', 'x.md'), 'the daemonPort\n');
  const body = { query: { q: 'daemonPort', isCaseSensitive: true, isWholeWord: false, isRegex: false }, replacement: 'daemonAddress', files: ['a.ts', 'docs/agent/x.md'] };
  const res = await postJson(`${f.base}${LOCAL}/search/replace`, body);
  assert.equal(res.status, 200);
  const answer = (await res.json()) as ReplaceAnswer;
  assert.equal(await readFile(join(f.repo, 'a.ts'), 'utf8'), 'const daemonAddress = 1;\r\nlog(daemonAddress, daemonAddress);\r\n');
  assert.equal(await readFile(join(f.repo, 'docs', 'agent', 'x.md'), 'utf8'), 'the daemonAddress\n');
  assert.deepEqual(answer.skipped, []);
  assert.deepEqual(answer.changed.map(({ path, count }) => [path, count]), [['a.ts', 3], ['docs/agent/x.md', 1]]);
  const version = (await (await hiveFetch(`${f.base}${LOCAL}/file-version?path=a.ts`)).json()) as { version: string };
  assert.equal(answer.changed[0].version, version.version);
  const again = await postJson(`${f.base}${LOCAL}/search/replace`, body);
  assert.deepEqual(await again.json(), { changed: [], skipped: [] });
  assert.equal((await postJson(`${f.base}${LOCAL}/search/replace`, { ...body, files: [] })).status, 400);
});
