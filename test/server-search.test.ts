import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrepParser, grepArgs, grepError, type GrepLine, MATCH_END, MATCH_START, stripMatches, toWireMatch } from '../src/server-search.js';

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
