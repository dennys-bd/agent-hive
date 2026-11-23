import { useCallback, useState } from 'react';

// Every key under `from` moved under `to`, or dropped without one: a renamed version's buffers follow it, a deleted one's go
const rekey = <T>(record: Readonly<Record<string, T>>, from: string, to?: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).flatMap(([key, value]): [string, T][] => {
    if (!key.startsWith(from)) return [[key, value]];
    return to === undefined ? [] : [[`${to}${key.slice(from.length)}`, value]];
  }));

/** The item editor's unsaved buffers by key (#319, #320); its own file keeps use-item-editor.ts under the size limit (#983). */
export function useBuffers() {
  const [buffers, setBuffers] = useState<Readonly<Record<string, string>>>({});
  const set = useCallback((key: string, text: string): void => setBuffers((prev) => ({ ...prev, [key]: text })), []);
  // A save's settling: the buffer sent goes back to the read; one typed in while the save flew stays dirty, under the file's new key
  const settle = useCallback((from: string, to: string, sent: string): void => setBuffers((prev) => {
    const { [from]: typed, ...rest } = prev;
    return typed === undefined || typed === sent ? rest : { ...rest, [to]: typed };
  }), []);
  const rekeyBuffers = useCallback((from: string, to?: string): void => setBuffers((prev) => rekey(prev, from, to)), []);
  return { buffers, set, settle, rekeyBuffers };
}
