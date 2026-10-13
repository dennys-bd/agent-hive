import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS } from '../src/agents.js';
import { installShellInit, renderShellInit, SHELL_INIT_FILES } from '../src/shell-init.js';
import { shimPath } from '../src/shim.js';
import { AGENT_IDS } from '../src/types.js';
import { tempDir } from './temp-dir.js';

const FUNCTION_FILES = ['zsh/.zshrc', 'bash/rc', 'fish/init.fish'];

test('renderShellInit puts one function per shim in the placeholder, the path quoted for the file\'s shell: a quote, a space, $\' and $& stay literal (#259)', () => {
  const shims = [{ command: 'claude', path: `/h/it's $'x' $& "dir"/bin/claude` }, { command: 'codex', path: '/h/bin/codex' }];
  const template = 'before\n__HIVE_FUNCTIONS__\nafter\n';
  const sh = [String.raw`function claude { '/h/it'\''s $'\''x'\'' $& "dir"/bin/claude' "$@"; }`, `function codex { '/h/bin/codex' "$@"; }`];
  const fish = [String.raw`function claude; '/h/it\'s $\'x\' $& "dir"/bin/claude' $argv; end`, 'function codex; \'/h/bin/codex\' $argv; end'];
  for (const file of ['zsh/.zshrc', 'bash/rc']) assert.equal(renderShellInit(template, file, shims), `before\n${sh.join('\n')}\nafter\n`, file);
  assert.equal(renderShellInit(template, 'fish/init.fish', shims), `before\n${fish.join('\n')}\nafter\n`);
  assert.equal(renderShellInit('no placeholder\n', 'zsh/.zshenv', shims), 'no placeholder\n');
});

test('installShellInit writes every init file under <home>/shell/, its folders for this user only, a function per agent of AGENTS calling its shim, no placeholder left, and rewrites them on every boot (#259)', async (t) => {
  const home = await tempDir(t, 'home-');
  const dir = await installShellInit(home);
  assert.equal(dir, join(home, 'shell'));
  for (const file of SHELL_INIT_FILES) assert.doesNotMatch(await readFile(join(dir, file), 'utf8'), /__HIVE_[A-Z]+__/, file);
  for (const file of FUNCTION_FILES) {
    const text = await readFile(join(dir, file), 'utf8');
    for (const id of AGENT_IDS) assert.ok(text.includes(`function ${AGENTS[id].command}`) && text.includes(shimPath(home, AGENTS[id])), `${file}: ${id}`);
  }
  for (const folder of ['', 'zsh', 'bash', 'fish']) assert.equal((await stat(join(dir, folder))).mode & 0o777, 0o700, folder);
  await writeFile(join(dir, 'bash', 'rc'), 'from a previous version');
  await installShellInit(home);
  assert.match(await readFile(join(dir, 'bash', 'rc'), 'utf8'), /function claude \{/, 'upgrading the Hive changes every terminal');
});
