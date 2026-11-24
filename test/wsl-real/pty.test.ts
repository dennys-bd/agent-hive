// The distro's ptys under ConPTY (#948 decision 12), through the machine's pty.spawn with a shell RunSpec. A run that prints first waits for
// a line on its stdin, so its output and its exit reach the subscriber, who is listening by then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { isRunning, openPty, realWsl, shellSpec, within } from './real-wsl.js';

const PTY_MS = 10_000;
const GO = 'go\r';
const WORD = 'ação 🐝';

test('the pty output holds ação 🐝 after an echo (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  // the word rides the run's env, not its command line: the line is printed before it runs, so only the echo can put the word in the output
  const run = await openPty(t, machine, shellSpec('wsl948echo', await freshDir(), 'read -r go; echo "$WORD"', { WORD }));
  machine.pty.write('wsl948echo', GO);
  // the output, not the exit: ConPTY may hand over a run's last bytes after its exit
  await within(PTY_MS, async () => run.output().includes(WORD), 'the echoed word', () => run.output());
});

test('after resize(cols, rows) the shell\'s stty size prints the new size (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  // the resize reaches the distro's tty a moment after the call, so the shell waits for it, five seconds at most; `tr` prints 40x132, which
  // the printed command line does not hold
  const command = 'read -r go; i=0; while [ "$(stty size)" != "40 132" ] && [ "$i" -lt 25 ]; do sleep 0.2; i=$((i+1)); done; stty size | tr " " x';
  const run = await openPty(t, machine, shellSpec('wsl948size', await freshDir(), command));
  machine.pty.resize('wsl948size', 132, 40);
  machine.pty.write('wsl948size', GO);
  await within(PTY_MS, async () => run.output().includes('40x132'), 'the new size', () => run.output());
});

test('exit 7 reports exit code 7 (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  const run = await openPty(t, machine, shellSpec('wsl948exit', await freshDir(), 'read -r go; exit 7'));
  machine.pty.write('wsl948exit', GO);
  await within(PTY_MS, async () => run.code() !== undefined, 'the exit');
  assert.equal(run.code(), 7);
});

test('after kill of a pty whose shell ran a marked sleep, pgrep -f of the marker inside the distro finds nothing within 10 s (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  // a duration no other process holds: the sleep's own argv and the shell's command line both carry it, so neither may outlive the kill.
  // The `:` after it keeps the shell from exec'ing the sleep, so the shell stays a process of its own
  const marker = `sleep ${randomInt(600_000, 700_000)}`;
  const run = await openPty(t, machine, shellSpec('wsl948kill', await freshDir(), `${marker}; :`));
  await within(PTY_MS, () => isRunning(machine, marker), 'the marked run inside the distro');
  await run.kill();
  await within(PTY_MS, async () => !(await isRunning(machine, marker)), 'no marked process left inside the distro');
});
