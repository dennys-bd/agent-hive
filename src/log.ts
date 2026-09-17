import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'info' | 'debug';
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'debug'];
export const LOG_FILE = 'hive.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const TAG_WIDTH = 5; // ERROR / INFO  / DEBUG

export interface Logger {
  error(message: string): void; // file + stderr
  info(message: string): void; // what the Hive did
  debug(message: string): void; // what it received; written only at level debug
  setLevel(level: LogLevel): void;
}

export interface LoggerOptions {
  maxBytes?: number; // rotation threshold; tests use a small one
  stderr?: (line: string) => void; // default console.error; tests inject a spy
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** One file per repo, `<ISO> <LEVEL> <message>` per line, rotated once at `maxBytes`. Never throws: a broken disk disables the file, not the Hive. */
export function createLogger(dir: string, level: LogLevel = 'info', options: LoggerOptions = {}): Logger {
  const { maxBytes = LOG_MAX_BYTES, stderr = console.error } = options;
  const path = join(dir, LOG_FILE);
  let current = level;
  let disabled = false;
  let size = 0;

  function disable(err: unknown): void {
    disabled = true;
    stderr(`${LOG_FILE}: ${errorMessage(err)}`);
  }

  try {
    mkdirSync(dir, { recursive: true }); // setup mode has no prepareHiveDir yet
    size = fileSize(path);
  } catch (err) {
    disable(err);
  }

  // ponytail: sync appends and no queue; a few short lines per second keep order for free. Move to a write stream if the volume ever matters.
  function write(tag: string, message: string): void {
    if (disabled) return;
    const line = `${new Date().toISOString()} ${tag.padEnd(TAG_WIDTH)} ${message}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(path, `${path}.1`); // one rotation: the previous .1 is gone
        size = 0;
      }
      appendFileSync(path, line);
      size += bytes;
    } catch (err) {
      disable(err);
    }
  }

  return {
    error: (message) => {
      stderr(message); // keeps today's console.error behaviour in headless / terminal runs
      write('ERROR', message);
    },
    info: (message) => write('INFO', message),
    debug: (message) => {
      if (current === 'debug') write('DEBUG', message);
    },
    setLevel: (next) => {
      current = next;
    },
  };
}
