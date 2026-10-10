import type { MemoryKind, MemoryStats, MemoryView } from '../../types.js';
import { getJson, sendJson } from './api.js'; // relative: the root tsc compiles this file too

// A workspace's memory (#797): the five routes the memory section and dialog call. Each write answers the new view.

const memoryPath = (workspace: string, rest = ''): string => `/workspaces/${encodeURIComponent(workspace)}/memory${rest}`;
const lessonPath = (workspace: string, id: string): string => memoryPath(workspace, `/${encodeURIComponent(id)}`);

const isMemoryView = (value: unknown): value is MemoryView => {
  const view = value as Partial<MemoryView> | null;
  return typeof view === 'object' && view !== null && Array.isArray(view.entries) && typeof view.used === 'number' && typeof view.cap === 'number' && typeof view.textMax === 'number';
};
const isMemoryStats = (value: unknown): value is MemoryStats => typeof (value as Partial<MemoryStats> | null)?.runs === 'number';

// An answer of another shape (another daemon, a page) fails like a refused call
async function shaped<T>(answer: Promise<unknown>, is: (value: unknown) => value is T): Promise<T> {
  const value = await answer;
  if (!is(value)) throw new Error('unexpected answer');
  return value;
}

export const readMemory = (workspace: string): Promise<MemoryView> => shaped(getJson<unknown>(memoryPath(workspace)), isMemoryView);
export const readStats = (workspace: string): Promise<MemoryStats> => shaped(getJson<unknown>(memoryPath(workspace, '/stats')), isMemoryStats);
export const addLesson = (workspace: string, kind: MemoryKind, text: string): Promise<MemoryView> =>
  shaped(sendJson<unknown>('POST', memoryPath(workspace), { kind, text }), isMemoryView);
export const editLesson = (workspace: string, id: string, kind: MemoryKind, text: string): Promise<MemoryView> =>
  shaped(sendJson<unknown>('PUT', lessonPath(workspace, id), { kind, text }), isMemoryView);
export const removeLesson = (workspace: string, id: string): Promise<MemoryView> => shaped(sendJson<unknown>('DELETE', lessonPath(workspace, id)), isMemoryView);

/** The HTTP status a failed call carried (parseJson's), if any (#797). */
export const statusOf = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};
