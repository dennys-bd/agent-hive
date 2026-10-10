import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelativePath, describeStep, parseSetup } from '../src/setup-script.js';

const refused = (text: string, allowLoad = true): string => {
  try {
    parseSetup(text, { allowLoad });
  } catch (err) {
    return (err as Error).message;
  }
  return 'accepted';
};

test('parseSetup reads one COPY, RUN or LOAD per line with the rest of the line as its argument and its own line number; blank lines and # comments are skipped (#299)', () => {
  const text = '# the worktree\n\nCOPY .env\n  RUN   pnpm install && pnpm build  \r\nLOAD setup/worktree.hive\nCOPY config/local.json\n';
  assert.deepEqual(parseSetup(text, { allowLoad: true }), [
    { line: 3, kind: 'copy', arg: '.env' },
    { line: 4, kind: 'run', arg: 'pnpm install && pnpm build' },
    { line: 5, kind: 'load', arg: 'setup/worktree.hive' },
    { line: 6, kind: 'copy', arg: 'config/local.json' },
  ]);
  assert.deepEqual(parseSetup('', { allowLoad: true }), [], 'an empty setup has no steps');
  assert.deepEqual(parseSetup('# only\n   # comments\n', { allowLoad: false }), [], 'nor does one of comments only');
});

test('parseSetup refuses, with the line number, an unknown or lowercase instruction, a missing argument, a COPY / LOAD path that is absolute, climbs out, names nothing or starts at .git / .hive, and LOAD when not allowed (#299)', () => {
  assert.equal(refused('RUN a\nFROM node'), 'line 2: unknown instruction FROM (COPY, RUN, LOAD or DEL)');
  assert.equal(refused('copy .env'), 'line 1: unknown instruction copy (COPY, RUN, LOAD or DEL)', 'uppercase only, as in a Dockerfile');
  assert.equal(refused('\nRUN   '), 'line 2: RUN needs an argument');
  assert.equal(refused('COPY /etc/hosts'), 'line 1: COPY /etc/hosts: the path must be relative to the workspace');
  assert.equal(refused('COPY ../other/.env'), 'line 1: COPY ../other/.env: the path cannot contain ".."');
  assert.equal(refused('LOAD a/../../b'), 'line 1: LOAD a/../../b: the path cannot contain ".."');
  assert.equal(refused('COPY ./'), 'line 1: COPY ./: the path must name a file or folder in the workspace');
  assert.equal(refused('COPY .git/config'), 'line 1: COPY .git/config: the path cannot be inside .git');
  assert.equal(refused('COPY ./.hive/state.json'), 'line 1: COPY ./.hive/state.json: the path cannot be inside .hive');
  assert.equal(refused('LOAD setup.hive', false), 'line 1: LOAD cannot be used inside a loaded file');
  assert.equal(refused('RUN cat ../x /etc/hosts'), 'accepted', 'a RUN is a command, not a path');
});

test('checkRelativePath passes a path inside the workspace, .gitignore and a nested .git included; describeStep writes the instruction and its argument (#299)', () => {
  for (const path of ['.env', 'config/local.json', './.env', '.gitignore', 'vendor/lib/.git', 'node_modules']) assert.equal(checkRelativePath(path), undefined, path);
  assert.equal(describeStep({ line: 4, kind: 'run', arg: 'pnpm install' }), 'RUN pnpm install');
  assert.equal(describeStep({ line: 1, kind: 'copy', arg: '.env' }), 'COPY .env');
  assert.equal(describeStep({ line: 2, kind: 'load', arg: 'setup.hive' }), 'LOAD setup.hive');
});

test('inside a loaded file a bad COPY / LOAD path is refused without echoing the path, which is the file\'s text (#299)', () => {
  assert.throws(() => parseSetup('COPY ../shared/secret-name\n', { allowLoad: false }), (err: Error) => err.message === 'line 1: COPY: the path cannot contain ".."');
  assert.throws(() => parseSetup('COPY ../x\n', { allowLoad: true }), { message: 'line 1: COPY ../x: the path cannot contain ".."' }, 'the Settings text is the user\'s own: named');
});

test('parseSetup reads DEL with its path and COPY with an optional destination, relative, absolute, ~ or ~/…; describeStep writes the destination (#654)', () => {
  assert.deepEqual(parseSetup('DEL tmp/\nCOPY docs/xpto\nCOPY docs/superpowers/ docs/\nCOPY .env /srv/x.env\nCOPY a ~\nCOPY b ~/notes/', { allowLoad: true }), [
    { line: 1, kind: 'del', arg: 'tmp/' },
    { line: 2, kind: 'copy', arg: 'docs/xpto' },
    { line: 3, kind: 'copy', arg: 'docs/superpowers/', dest: 'docs/' },
    { line: 4, kind: 'copy', arg: '.env', dest: '/srv/x.env' },
    { line: 5, kind: 'copy', arg: 'a', dest: '~' },
    { line: 6, kind: 'copy', arg: 'b', dest: '~/notes/' },
  ]);
  assert.equal(describeStep({ line: 1, kind: 'copy', arg: 'docs/superpowers/', dest: '~/x/' }), 'COPY docs/superpowers/ ~/x/');
  assert.equal(describeStep({ line: 1, kind: 'del', arg: 'tmp/' }), 'DEL tmp/');
});

test('parseSetup refuses a third COPY word, a ~user destination, a relative destination that climbs out or names .git, a source or DEL path that is absolute or starts with ~; an absolute destination is not checked (#654)', () => {
  assert.equal(refused('COPY a b c'), 'line 1: COPY takes a source and at most one destination');
  assert.equal(refused('COPY a ~bob/x'), 'line 1: COPY ~bob/x: only ~ and ~/ expand to the home folder');
  assert.equal(refused('COPY a ../x'), 'line 1: COPY ../x: the path cannot contain ".."');
  assert.equal(refused('COPY a .git/hooks'), 'line 1: COPY .git/hooks: the path cannot be inside .git');
  assert.equal(refused('COPY a /x/../y'), 'accepted', 'an absolute destination is written exactly there');
  assert.equal(refused('COPY a ~/../x'), 'line 1: COPY ~/../x: the path cannot contain ".."');
  assert.equal(refused('COPY a ~/notes/../../x/'), 'line 1: COPY ~/notes/../../x/: the path cannot contain ".."');
  assert.equal(refused('COPY ~/x'), 'line 1: COPY ~/x: the path must be relative to the workspace');
  assert.equal(refused('COPY /etc/hosts docs/'), 'line 1: COPY /etc/hosts: the path must be relative to the workspace');
  assert.equal(refused('DEL /tmp'), 'line 1: DEL /tmp: the path must be relative to the workspace');
  assert.equal(refused('DEL ../x'), 'line 1: DEL ../x: the path cannot contain ".."');
  assert.equal(refused('DEL ~/x'), 'line 1: DEL ~/x: the path must be relative to the workspace');
  assert.equal(refused('RM x'), 'line 1: unknown instruction RM (COPY, RUN, LOAD or DEL)');
  assert.throws(() => parseSetup('COPY a ../secret\n', { allowLoad: false }), { message: 'line 1: COPY: the path cannot contain ".."' }, 'a loaded file\'s paths are never echoed');
});
