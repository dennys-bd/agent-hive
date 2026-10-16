import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AGENTS } from '../src/agents.js';
import { type HeadlessInput, runHeadless } from '../src/headless-run.js';
import { type AgentId, EDITOR_FILE_MAX } from '../src/types.js';
import { tempDir } from './temp-dir.js';

interface Cli { bin: string; tmpRoot: string; env: NodeJS.ProcessEnv }

// A fake agent CLI first on the run's PATH: runHeadless spawns AGENTS[agent].command, so no test needs claude or codex installed.
// CLAUDECODE is in Claude's hostEnv: the run must not see it
async function fakeCli(t: TestContext, agent: AgentId, body: string): Promise<Cli> {
  const bin = await tempDir(t, 'headless-bin-');
  const file = join(bin, AGENTS[agent].command);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return { bin, tmpRoot: await tempDir(t, 'headless-tmp-'), env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDECODE: '1' } };
}
const input = (agent: AgentId, signal = new AbortController().signal): HeadlessInput => ({ agent, prompt: 'the prompt', schema: { type: 'object' }, signal });

async function pidIn(file: string): Promise<number> {
  for (;;) {
    const pid = Number(await readFile(file, 'utf8').catch(() => ''));
    if (pid > 0) return pid;
    await sleep(10);
  }
}
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(20);
  }
  return false;
}

test("Claude's answer is its structured_output: the prompt on stdin, its own temp folder, no hostEnv, nothing left behind (#330)", async (t) => {
  const cli = await fakeCli(t, 'claude',
    `prompt="$(cat)"; printf '{"type":"result","is_error":false,"result":"","structured_output":{"from":1,"to":1,"text":"%s|%s|%s"}}' "$prompt" "\${CLAUDECODE:-unset}" "$(basename "$PWD")"`);
  const result = await runHeadless(input('claude'), { env: cli.env, tmpRoot: cli.tmpRoot });
  assert.ok('answer' in result, JSON.stringify(result));
  assert.match((JSON.parse(result.answer) as { text: string }).text, /^the prompt\|unset\|hive-headless-/);
  assert.deepEqual(await readdir(cli.tmpRoot), []);
});

test("Codex's answer is the file it wrote to -o, inside the run's folder, which is gone afterwards (#330)", async (t) => {
  const cli = await fakeCli(t, 'codex',
    `while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; cat > /dev/null; printf '{"from":1,"to":1,"text":"x"}' > "$out"`);
  assert.deepEqual(await runHeadless(input('codex'), { env: cli.env, tmpRoot: cli.tmpRoot }), { answer: '{"from":1,"to":1,"text":"x"}' });
  assert.deepEqual(await readdir(cli.tmpRoot), []);
});

test('a non-zero exit, an output over the cap, the timeout and no answer each fail with the reason, and remove the folder (#330)', async (t) => {
  const cases: [string, string, number?][] = [
    ['cat > /dev/null; echo boom >&2; exit 3', 'exit code 3'],
    [`cat > /dev/null; head -c ${EDITOR_FILE_MAX + 1} /dev/zero | tr '\\0' a`, `output over ${EDITOR_FILE_MAX} bytes`],
    ['cat > /dev/null; exec sleep 5', 'timed out after 500 ms', 500], // exec: the killed process is the one holding the pipe
    [`cat > /dev/null; echo '{"type":"result","is_error":true,"result":"rate limited"}'`, 'no answer'],
  ];
  for (const [body, reason, timeoutMs] of cases) {
    const cli = await fakeCli(t, 'claude', body);
    const result = await runHeadless(input('claude'), { env: cli.env, tmpRoot: cli.tmpRoot, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    assert.ok('failure' in result, body);
    assert.equal(result.failure, reason, body);
    if (reason === 'exit code 3') assert.match(result.detail, /boom/);
    if (reason === 'no answer') assert.match(result.detail, /rate limited/);
    assert.deepEqual(await readdir(cli.tmpRoot), [], body);
  }
});

test('an abort kills the whole group, a grandchild too, and fails the run as cancelled (#330)', async (t) => {
  const cli = await fakeCli(t, 'claude', 'cat > /dev/null; sleep 30 & echo $! > "$PID_FILE"; wait');
  const pidFile = join(cli.bin, 'pid');
  const controller = new AbortController();
  const running = runHeadless(input('claude', controller.signal), { env: { ...cli.env, PID_FILE: pidFile }, tmpRoot: cli.tmpRoot });
  const pid = await pidIn(pidFile);
  controller.abort();
  const result = await running;
  assert.ok('failure' in result);
  assert.equal(result.failure, 'cancelled');
  assert.ok(await gone(pid), 'the sleep died with its group');
  assert.deepEqual(await readdir(cli.tmpRoot), []);
});
