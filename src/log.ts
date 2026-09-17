import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Effect, HiveEvent, Slot, State } from './types.js';

export type LogLevel = 'info' | 'debug';
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'debug'];
export const LOG_FILE = 'hive.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const TAG_WIDTH = 5; // ERROR / INFO  / DEBUG
const ID_WIDTH = 8; // enough of a uuid to grep for
const POLL_IDS_MAX = 20;

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

/** The first 8 characters of a uuid (worker or slot); `-` when the id is missing. */
export const shortId = (id?: string): string => id?.slice(0, ID_WIDTH) ?? '-';

/** A one-line summary of a reducer event: names, ids and counts, never a payload (tool_input, question, message). */
export function describeEvent(event: HiveEvent): string {
  switch (event.type) {
    case 'boot': return 'boot';
    case 'poll': return `poll tasks=${event.tasks.length} ids=${event.tasks.slice(0, POLL_IDS_MAX).map((t) => t.id).join(',')}`;
    case 'setMax': return `setMax ${event.max}`;
    case 'setSignal': return `setSignal ${event.signal}`;
    case 'setBudget': return `setBudget ${JSON.stringify(event.budget)}`;
    case 'setUsageRules': return `setUsageRules rules=${event.usageRules.length}`;
    case 'rateLimits': return `rateLimits worker=${shortId(event.workerId)}`;
    case 'boardQuota': return `boardQuota remaining=${event.quota.remaining}/${event.quota.limit} resetsAt=${event.quota.resetsAt}`;
    case 'hook': {
      const tool = event.payload.tool_name ? ` tool=${event.payload.tool_name}` : '';
      return `hook ${event.payload.hook_event_name} worker=${shortId(event.workerId)}${tool}`;
    }
    case 'exit': return `exit worker=${shortId(event.workerId)}`;
    case 'idle': return `idle worker=${shortId(event.workerId)}`;
    case 'kill': return `kill slot=${shortId(event.slotId)}`;
    case 'error': return event.message ? `error ${event.message}` : 'error';
  }
}

export function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case 'spawn': {
      const { slot } = effect;
      return `spawn slot=${shortId(slot.id)} #${slot.task?.id ?? '-'} slug=${slot.slug ?? '-'} worker=${shortId(slot.workerId)}`;
    }
    case 'setStatus': return `setStatus #${effect.itemId} → ${effect.key}`;
    case 'kill': return `kill slug=${effect.slug} worker=${shortId(effect.workerId)}`;
  }
}

const slotDetail = (slot: Slot): string =>
  `${slot.task ? ` #${slot.task.id}` : ''}${slot.workerId ? ` worker=${shortId(slot.workerId)}` : ''}`;

/** Slot and signal transitions between two states: one line per slot whose status changed, in grid order, matched by id; then the signal. */
export function describeChanges(prev: State, next: State): string[] {
  const slots = next.slots.flatMap((slot, i) => {
    const before = prev.slots.find((s) => s.id === slot.id);
    if (!before || before.status === slot.status) return [];
    const detail = slotDetail(slot.status === 'vazio' ? before : slot); // an emptied slot names what it held
    return [`slot ${i + 1}: ${before.status} → ${slot.status}${detail}`];
  });
  return prev.signal === next.signal ? slots : [...slots, `signal: ${prev.signal} → ${next.signal}`];
}
