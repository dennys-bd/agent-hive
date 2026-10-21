import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { launchChromium } from './browser.js';
import { bootDaemon, type RunningDaemon, stopRunDaemon } from '../../src/benchmark/daemon.js';
import type { EvalDeps } from './evaluate-run.js';
import type { Run } from '../../src/benchmark/exec.js';

// Never the daemon's secret: addresses are passed on, never printed
export const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

// Every daemon this process started and has not stopped: two during a pair, one during an evaluation
const live = new Set<RunningDaemon>();

async function tracked(booting: Promise<RunningDaemon>): Promise<RunningDaemon> {
  const daemon = await booting;
  live.add(daemon);
  return daemon;
}

export const boot = (home: string, runJs: string): Promise<RunningDaemon> => tracked(bootDaemon(home, runJs));
/** The evaluation's daemon runs the run branch's own build: it gets the toolchain env only (src/benchmark/daemon.ts). */
export const bootEvaluated = (home: string, runJs: string): Promise<RunningDaemon> => tracked(bootDaemon(home, runJs, { isWorkerCode: true }));

export async function stop(daemon: RunningDaemon): Promise<void> {
  await stopRunDaemon(daemon);
  live.delete(daemon);
}

/** Ctrl-C, a kill or a closed terminal stops every running daemon, so no worker is left. Branches stay, and the next call marks the attempts interrupted and starts their slots over. */
export function stopOnInterrupt(): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      log('interrupted: the attempts going on are marked interrupted on the next call');
      void Promise.all([...live].map((daemon) => stopRunDaemon(daemon))).finally(() => process.exit(130));
    });
  }
}

export const evalDeps = (repoRoot: string, run: Run, docs: Run): EvalDeps => ({ run, docs, launch: launchChromium, log, boot: bootEvaluated, stop, repoRoot, chromiumPath: chromium.executablePath(), tmpRoot: tmpdir() });
