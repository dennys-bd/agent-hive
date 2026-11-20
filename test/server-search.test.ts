import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localActivityId } from '../src/activities.js';
import type { Machine } from '../src/machine.js';
import { createGrepParser, grepArgs, grepError, type GrepLine, MATCH_END, MATCH_START, searchQueryOf, searchTree, stripMatches, toWireMatch } from '../src/server-search.js';
import { type SearchLine, SEARCH_CAP } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { fakeFiles, fakeMachine } from './fake-machine.js';
import { grepMachine } from './fixtures/grep-machine.js';
import { workPath } from './fixtures/work.js';
import { startTree, task } from './fixtures/tree-server.js';
import { hiveFetch } from './secret-client.js';

const Q = { q: 'port', isCaseSensitive: false, isWholeWord: false, isRegex: false };
const mark = (text: string): string => `${MATCH_START.toString('latin1')}${text}${MATCH_END.toString('latin1')}`;
const record = (file: string, line: number, text: string): Buffer => Buffer.from(`${file}\0${line}\0${text}\n`, 'utf8');
const lines = (...chunks: Buffer[]): GrepLine[] => {
  const seen: GrepLine[] = [];
  const parser = createGrepParser((line) => seen.push(line));
  for (const chunk of chunks) parser.push(chunk);
  return seen;
};

test('grepArgs: the pinned colours, -z -n -I --untracked --exclude-standard, -F or -E, -i while match case is off, -w for whole word, the query after -e; paths literal after -- (#868)', () => {
  const head = (args: string[]) => args.slice(0, args.indexOf('grep') + 1);
  const tail = (args: string[]) => args.slice(args.indexOf('grep') + 1);
  const args = grepArgs('/wt', Q);
  assert.deepEqual(head(args).slice(0, 3), ['--no-optional-locks', '-C', '/wt']);
  for (const pin of ['color.grep.matchSelected=#010203', 'color.grep.filename=normal', 'color.grep.lineNumber=normal', 'color.grep.separator=normal', 'color.grep.selected=normal', 'grep.column=false', 'core.fsmonitor=false']) assert.ok(args.includes(pin), pin);
  assert.deepEqual(tail(args), ['--color=always', '-z', '-n', '-I', '--untracked', '--exclude-standard', '-F', '-i', '-e', 'port']);
  assert.deepEqual(tail(grepArgs('/wt', { ...Q, isCaseSensitive: true, isWholeWord: true, isRegex: true })), ['--color=always', '-z', '-n', '-I', '--untracked', '--exclude-standard', '-E', '-w', '-e', 'port']);
  assert.deepEqual(tail(grepArgs('/wt', { ...Q, q: '-v' })).slice(-2), ['-e', '-v'], 'a query starting with - is never an option');
  const scoped = grepArgs('/wt', Q, ['src/a.ts', ':(top)x']);
  assert.ok(scoped.indexOf('--literal-pathspecs') < scoped.indexOf('grep'), 'git\'s own option, before the subcommand');
  assert.deepEqual(scoped.slice(-3), ['--', 'src/a.ts', ':(top)x']);
});

test('stripMatches: every match a byte span of the text without markers; an unclosed marker, a stray ESC and a lone reset are the line\'s own text (#868)', () => {
  const two = stripMatches(Buffer.from(`a ${mark('port')} b ${mark('port')}`, 'latin1'));
  assert.deepEqual([two.raw.toString(), two.spans], ['a port b port', [[2, 6], [9, 13]]]);
  const stray = stripMatches(Buffer.from(`\x1b[1mx\x1b[m ${mark('port')} ${MATCH_START.toString('latin1')}open`, 'latin1'));
  assert.deepEqual([stray.raw.toString('latin1'), stray.spans], [`\x1b[1mx\x1b[m port ${MATCH_START.toString('latin1')}open`, [[9, 13]]]);
});

test('createGrepParser: name, number and text in order, a record split across chunks, a name holding a newline (#868)', () => {
  const whole = record('src/a.ts', 12, `const ${mark('port')} = 1;`);
  const seen = lines(whole.subarray(0, 5), whole.subarray(5, 20), Buffer.concat([whole.subarray(20), record('odd\nname.md', 3, mark('port'))]));
  assert.deepEqual(seen.map((l) => [l.file, l.line, l.raw.toString(), l.spans]), [['src/a.ts', 12, 'const port = 1;', [[6, 10]]], ['odd\nname.md', 3, 'port', [[0, 4]]]]);
  assert.deepEqual(lines(Buffer.from('src/a.ts\x0012\x00no end yet')), [], 'a record waits for its newline');
});

test('toWireMatch: byte columns to UTF-16 on a multibyte line, a CR dropped, a line-1 BOM dropped with the spans shifted (#868)', () => {
  const [accented] = lines(record('a.md', 4, `ação ${mark('pôrt')} 😀 ${mark('pôrt')}`));
  assert.deepEqual(toWireMatch(accented), { line: 4, text: 'ação pôrt 😀 pôrt', spans: [[5, 9], [13, 17]] }); // 😀 is two UTF-16 units
  const [crlf] = lines(record('b.ts', 2, `${mark('port')}\r`));
  assert.deepEqual(toWireMatch(crlf), { line: 2, text: 'port', spans: [[0, 4]] });
  const [bom] = lines(record('c.ts', 1, `\uFEFFx ${mark('port')}`));
  assert.deepEqual(toWireMatch(bom), { line: 1, text: 'x port', spans: [[2, 6]] });
});

test('grepError: git\'s fatal reason without its prefix, else what stderr says (#868)', () => {
  assert.equal(grepError("fatal: command line, 'daemon(Port': Unmatched ( or \\(\n"), "command line, 'daemon(Port': Unmatched ( or \\(");
  assert.equal(grepError('warning: x\nfatal: not a git repository\n'), 'not a git repository');
  assert.equal(grepError(''), 'git grep failed');
});

// nestedRepos and the searched count run on this exec: docs/ is the one nested repository, and each repository lists two files
const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => ({ stdout: args.includes('--directory') ? 'docs/\0' : args.includes('--cached') ? 'a.ts\0b.ts\0' : '' });
const withDocs = (): Machine => fakeMachine({ exec, fs: fakeFiles(join('/wt', 'docs', '.git')) });
const collect = async (run: (send: (l: SearchLine) => void) => Promise<void>): Promise<SearchLine[]> => {
  const sent: SearchLine[] = [];
  await run((l) => sent.push(l));
  return sent;
};
const hit = (file: string, line: number, text: string, count = 1): Buffer => record(file, line, Array.from({ length: count }, () => mark(text)).join(' '));
const ROOT = '/wt';
const DOCS = join('/wt', 'docs');

test('searchTree: one result per file as the next file starts, the root then the nested repository with its prefix, then the closing line (#868)', async () => {
  const { machine, ran } = grepMachine({
    [ROOT]: { out: [Buffer.concat([hit('src/a.ts', 1, 'port', 2), hit('src/a.ts', 2, 'port'), hit('src/b.ts', 4, 'port')])] },
    [DOCS]: { out: [hit('agent/x.md', 3, 'port')] },
  }, withDocs());
  const sent = await collect((send) => searchTree(machine, ROOT, Q, send, new AbortController().signal, () => undefined));
  assert.deepEqual(sent.map((l) => ('file' in l ? [l.file, l.repo, l.matches.length] : l)), [
    ['src/a.ts', '', 2], ['src/b.ts', '', 1], ['docs/agent/x.md', 'docs', 1], { done: true, total: 5, files: 3, capped: false, repos: ['docs'] },
  ]);
  assert.deepEqual(ran, [ROOT, DOCS]);
});

test('searchTree: the cap kills the process at SEARCH_CAP matches, skips the other repositories and closes capped (#868)', async () => {
  const many = Buffer.concat(Array.from({ length: SEARCH_CAP - 1 }, (_, i) => hit('a.ts', i + 1, 'x')));
  const { machine, killed, ran } = grepMachine({ [ROOT]: { out: [many, Buffer.concat([hit('b.ts', 1, 'x'), hit('b.ts', 2, 'x'), hit('b.ts', 3, 'x')])], isHeld: true } }, withDocs());
  const sent = await collect((send) => searchTree(machine, ROOT, Q, send, new AbortController().signal, () => undefined));
  const last = sent.at(-2);
  assert.equal(last !== undefined && 'matches' in last ? last.matches.length : -1, 1);
  assert.deepEqual(sent.at(-1), { done: true, total: SEARCH_CAP, files: 2, capped: true, repos: ['docs'] });
  assert.deepEqual([killed, ran], [[ROOT], [ROOT]]);
});

test('searchTree: exactly SEARCH_CAP matches is not capped, and the nested repository is still searched (#868)', async () => {
  const exact = Buffer.concat(Array.from({ length: SEARCH_CAP }, (_, i) => hit('a.ts', i + 1, 'x')));
  const { machine, killed, ran } = grepMachine({ [ROOT]: { out: [exact] }, [DOCS]: { out: [] } }, withDocs());
  const sent = await collect((send) => searchTree(machine, ROOT, Q, send, new AbortController().signal, () => undefined));
  assert.deepEqual(sent.at(-1), { done: true, total: SEARCH_CAP, files: 1, capped: false, repos: ['docs'] });
  assert.deepEqual([killed, ran], [[], [ROOT, DOCS]]);
});

test('searchTree: a match in the nested repository beyond a full root is what caps (#868)', async () => {
  const exact = Buffer.concat(Array.from({ length: SEARCH_CAP }, (_, i) => hit('a.ts', i + 1, 'x')));
  const { machine, ran } = grepMachine({ [ROOT]: { out: [exact] }, [DOCS]: { out: [hit('x.md', 1, 'x')], isHeld: true } }, withDocs());
  const sent = await collect((send) => searchTree(machine, ROOT, Q, send, new AbortController().signal, () => undefined));
  assert.deepEqual(sent.at(-1), { done: true, total: SEARCH_CAP, files: 1, capped: true, repos: ['docs'] });
  assert.deepEqual(ran, [ROOT, DOCS]);
});

test('createGrepParser: a long line fed in small chunks is read once, not re-joined per chunk (#868)', () => {
  const body = Buffer.alloc(8 * 1024 * 1024, 'a');
  const record = Buffer.concat([Buffer.from('f.ts\x001\x00'), body, Buffer.from('\n')]);
  const got: GrepLine[] = [];
  const parser = createGrepParser((l) => got.push(l));
  const started = performance.now();
  for (let at = 0; at < record.length; at += 1024) parser.push(record.subarray(at, at + 1024));
  assert.ok(performance.now() - started < 1500, 'quadratic on a long line');
  assert.equal(got.length, 1);
  assert.equal(got[0].raw.length, body.length);
  assert.equal(got[0].file, 'f.ts');
});

test('toWireMatch: many spans on a long multibyte line map to UTF-16 in order (#868)', () => {
  const unit = 'ação ';
  const raw = Buffer.from(unit.repeat(1000) + 'x');
  const spans: [number, number][] = Array.from({ length: 1000 }, (_, i) => [i * Buffer.byteLength(unit), i * Buffer.byteLength(unit) + 3]);
  const match = toWireMatch({ file: 'f', line: 2, raw, spans });
  assert.deepEqual(match.spans[999], [999 * unit.length, 999 * unit.length + 2]);
  assert.deepEqual(match.spans[1], [unit.length, unit.length + 2]);
});

test('searchTree: git\'s fatal becomes the only line, { error }, and no other repository runs (#868)', async () => {
  const { machine, ran } = grepMachine({ [ROOT]: { err: "fatal: command line, 'a(': Unmatched ( or \\(\n", code: 128 } }, withDocs());
  const sent = await collect((send) => searchTree(machine, ROOT, Q, send, new AbortController().signal, () => undefined));
  assert.deepEqual(sent, [{ error: "command line, 'a(': Unmatched ( or \\(" }]);
  assert.deepEqual(ran, [ROOT]);
});

test('searchTree: a nested repository that fails is skipped and warned by its path, never with the query (#868)', async () => {
  const { machine } = grepMachine({ [ROOT]: { out: [hit('a.ts', 1, 'port')] }, [DOCS]: { err: 'fatal: not a git repository\n', code: 128 } }, withDocs());
  const warned: string[] = [];
  const sent = await collect((send) => searchTree(machine, ROOT, Q, send, new AbortController().signal, (line) => warned.push(line)));
  assert.deepEqual(sent.map((l) => ('file' in l ? l.file : l)), ['a.ts', { done: true, total: 1, files: 1, capped: false, repos: ['docs'] }]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /docs/);
  assert.equal(warned[0].includes(Q.q), false);
});

test('searchTree: an abort kills the child and ends without a closing line (#868)', async () => {
  const { machine, killed } = grepMachine({ [ROOT]: { out: [Buffer.concat([hit('a.ts', 1, 'port'), hit('b.ts', 1, 'port')])], isHeld: true } }, withDocs());
  const controller = new AbortController();
  const sent = await collect((send) => searchTree(machine, ROOT, Q, (l) => { send(l); controller.abort(); }, controller.signal, () => undefined));
  assert.deepEqual(sent.map((l) => ('file' in l ? l.file : l)), ['a.ts']);
  assert.deepEqual(killed, [ROOT]);
});

test('searchTree: an empty query runs no git grep and reports the repositories searched (#868)', async () => {
  const { machine, ran } = grepMachine({}, withDocs());
  const sent = await collect((send) => searchTree(machine, ROOT, { ...Q, q: '' }, send, new AbortController().signal, () => undefined));
  assert.deepEqual(sent, [{ done: true, total: 0, files: 0, capped: false, repos: ['docs'] }]);
  assert.deepEqual(ran, []);
});

test('searchTree: no match reports how many files were searched across the repositories (#868)', async () => {
  const { machine } = grepMachine({}, withDocs());
  const sent = await collect((send) => searchTree(machine, ROOT, Q, send, new AbortController().signal, () => undefined));
  assert.deepEqual(sent, [{ done: true, total: 0, files: 0, capped: false, repos: ['docs'], searched: 4 }]);
});

test('searchQueryOf: a single string q and 0/1 toggles; anything else is refused (#868)', () => {
  assert.deepEqual(searchQueryOf({ q: 'x', case: '1' }), { q: 'x', isCaseSensitive: true, isWholeWord: false, isRegex: false });
  assert.deepEqual(searchQueryOf({ q: 'x', word: '1', regex: '0' }), { q: 'x', isCaseSensitive: false, isWholeWord: true, isRegex: false });
  for (const bad of [{ q: ['a', 'b'] }, {}, { q: 'x', regex: 'yes' }]) assert.equal(searchQueryOf(bad), undefined);
});

const LOCAL = `/activities/${encodeURIComponent(localActivityId('hive'))}`;

test('GET /activities/local:hive/search on a real repository: the root, then docs (ignored, holding its own repository), NDJSON per file, a 409 for a task with no worktree (#868)', async (t) => {
  const f = await startTree(t, (repo) => [task(2, { worktree: worktreePath(repo, 'hive-2-task'), worktreeGone: true })], { exec: promisify(execFile) });
  await writeFile(join(f.repo, '.gitignore'), '/docs/\n');
  await writeFile(join(f.repo, 'a.ts'), 'const daemonPort = 1;\nlog(daemonPort, daemonPort);\n');
  await mkdir(join(f.repo, 'docs', 'agent'), { recursive: true });
  await promisify(execFile)('git', ['init', '--quiet', join(f.repo, 'docs')]);
  await writeFile(join(f.repo, 'docs', 'agent', 'x.md'), 'the daemonPort\n');
  const res = await hiveFetch(`${f.base}${LOCAL}/search?${new URLSearchParams({ q: 'daemonPort' })}`);
  assert.equal(res.headers.get('content-type')?.startsWith('application/x-ndjson'), true);
  const sent = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as SearchLine);
  const repos = sent.at(-1) as { repos: string[] };
  assert.equal(repos.repos.includes('docs'), true);
  assert.deepEqual(sent.filter((l) => 'file' in l), [
    { file: 'a.ts', repo: '', matches: [{ line: 1, text: 'const daemonPort = 1;', spans: [[6, 16]] }, { line: 2, text: 'log(daemonPort, daemonPort);', spans: [[4, 14], [16, 26]] }] },
    { file: 'docs/agent/x.md', repo: 'docs', matches: [{ line: 1, text: 'the daemonPort', spans: [[4, 14]] }] },
  ]);
  assert.equal(sent.at(-1) !== undefined && 'total' in sent.at(-1)!, true);
  assert.equal((sent.at(-1) as { total: number }).total, 4);
  assert.equal((await hiveFetch(`${f.base}${workPath(f.server, 'local:2')}/search?q=x`)).status, 409);
  assert.equal((await hiveFetch(`${f.base}${LOCAL}/search`)).status, 400);
});
