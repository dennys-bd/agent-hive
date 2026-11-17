import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunResult } from '../src/machine.js';
import { runDetached } from '../src/machine-run.js';
import { tempDir } from './temp-dir.js';

// scripts/test-node.mjs runs every file from the repo root, where biome.jsonc is
const ROOT = process.cwd();
// biome's own launcher is a node script: node runs it on every OS, so no .cmd and no shell line is involved
const BIOME = join(ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const PROBE = "import { readFile } from 'node:fs/promises';\n\nexport const probe = readFile;\n";
const RULE = /noRestrictedImports/;
const LINT_TIMEOUT_MS = 60_000;

// The probe linted as the file at `path` would be, in a temp dir holding a copy of the repo's own biome.jsonc: the tree is never written, so
// the whole-tree lint `pnpm test` runs beside the node tests never meets a stray file, and a failed or killed run leaves nothing behind.
// Biome's stdin mode prints no diagnostics (checked), and the vcs ignore file is off since the temp dir has no repository
async function lintAs(t: TestContext, path: string): Promise<{ ran: RunResult; output: string }> {
  const dir = await tempDir(t, 'lint-');
  await copyFile(join(ROOT, 'biome.jsonc'), join(dir, 'biome.jsonc'));
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), PROBE);
  const ran = await runDetached({ command: process.execPath, args: [BIOME, 'lint', '--vcs-enabled=false', path], cwd: dir, env: process.env, timeoutMs: LINT_TIMEOUT_MS });
  return { ran, output: `${ran.stdout.toString('utf8')}${ran.stderr}` };
}

test('a new node:fs/promises import in src/ outside both lists fails the lint (#158)', async (t) => {
  const { ran, output } = await lintAs(t, 'src/lint-probe.ts');
  assert.notEqual(ran.code, 0);
  assert.match(output, RULE);
});

test('the same import under a host-only pattern passes the lint (#158)', async (t) => {
  const { ran, output } = await lintAs(t, 'src/sources/lint-probe.ts');
  assert.deepEqual([ran.code, RULE.test(output)], [0, false]);
});

test('the page is outside the rule: src/ui never reaches a machine (#158)', async (t) => {
  const { ran, output } = await lintAs(t, 'src/ui/lint-probe.ts');
  assert.deepEqual([ran.code, RULE.test(output)], [0, false]);
});
