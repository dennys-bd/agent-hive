import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// The fake reviewer and judge of test/server-evaluate.test.ts, in node so the same file runs on every OS (#655). The prompt arrives on stdin and
// the branch is its focus line. Claude prints its result object; Codex gets `-o <file>` and writes the answer there.

const POLL_MS = 100;
const POLL_MAX = 600;
const HANG_MS = 120_000;
const STARTS = 2; // both reviewers of a "slow" pair must be running before either answers: they run at once

const log = process.env.LOG ?? '';
const argv = process.argv.slice(2);
const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : '';

function answer(text: string): void {
  if (out === '') process.stdout.write(`{"type":"result","is_error":false,"result":"","structured_output":${text}}`);
  else writeFileSync(out, text);
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const starts = (): number => readdirSync(log).filter((name) => name.endsWith('.start')).length;

async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; !done(); i += 1) {
    if (i >= POLL_MAX) process.exit(1);
    await sleep(POLL_MS);
  }
}

async function main(): Promise<void> {
  const prompt = await stdin();
  const focus = /^Your focus: (.*)$/m.exec(prompt)?.[1] ?? '';
  if (focus.startsWith('slow')) {
    writeFileSync(join(log, `${focus}.start.pwd`), process.cwd());
    writeFileSync(join(log, `${focus}.start`), '');
    await waitUntil(() => starts() >= STARTS);
    answer(JSON.stringify({ findings: [{ file: 'a.ts', line: 3, finding: focus }] }));
  } else if (focus === 'broken') {
    await waitUntil(() => readdirSync(log).includes('hang.start'));
    answer('not json');
  } else if (focus.startsWith('hang')) {
    writeFileSync(join(log, `${focus}.pid`), String(process.pid));
    writeFileSync(join(log, `${focus}.start`), '');
    await sleep(HANG_MS);
  } else if (focus === '') {
    writeFileSync(join(log, 'judge.args'), argv.join(' '));
    writeFileSync(join(log, 'judge.prompt'), prompt);
    answer(process.env.SCORES ?? '');
  }
}

await main();
