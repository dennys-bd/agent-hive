import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Terminal } from './types.js';

// A kept terminal's files under <home>/terminals (#696): its scrollback ring, written as its pty exits, and its shell's history.
export const TERMINALS_DIR = 'terminals';

export const terminalsDir = (home: string): string => join(home, TERMINALS_DIR);
export const scrollbackPath = (home: string, terminalId: string): string => join(terminalsDir(home), `${terminalId}.log`);
export const historyPath = (home: string, terminalId: string): string => join(terminalsDir(home), `${terminalId}.history`);

/** Forget (#696): both files go; one never written is no error. */
export async function removeTerminalFiles(home: string, terminalId: string): Promise<void> {
  await Promise.all([rm(scrollbackPath(home, terminalId), { force: true }), rm(historyPath(home, terminalId), { force: true })]);
}

const DIR_MODE = 0o700; // the home's own: a terminal's output and history hold whatever the user typed

/** The dir a terminal's shell writes its history in and its ring goes to, made before its pty spawns: zsh and bash never make it. */
export async function ensureTerminalsDir(home: string): Promise<void> {
  await mkdir(terminalsDir(home), { recursive: true, mode: DIR_MODE });
}

/** The ring a woken terminal replays first; undefined for one that never slept. */
export const readScrollback = (home: string, terminalId: string): Promise<string | undefined> =>
  readFile(scrollbackPath(home, terminalId), 'utf8').catch(() => undefined);

/** After a boot (#696): every sleeping terminal's saved ring back in the pty host, so its sleeping tab replays it; one never written is none. */
export async function restoreScrollbacks(home: string, terminals: readonly Terminal[], restore: (ptyId: string, text: string) => void): Promise<void> {
  for (const terminal of terminals) {
    if (terminal.asleep !== true) continue;
    const text = await readScrollback(home, terminal.terminalId);
    if (text !== undefined) restore(terminal.terminalId, text);
  }
}
