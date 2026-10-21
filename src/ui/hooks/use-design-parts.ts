import { type RefObject, useEffect, useRef, useState } from 'react';
import { bridgeData } from '@/hooks/use-design-pins';
import { type DiskVersion, readVersion, VERSION_POLL_MS } from '@/hooks/use-file-version';

// The parts a screen's assembly asked for (#421): the bridge reports them after a load, and the pane polls each beside the screen, so a
// change to a part, or a missing one appearing, reloads the frame. The list is the frame's, so untrusted: only relative paths with no .., dot
// or empty segment, and a bounded count, all polled through the file-version route, which stays inside the activity's folder.

/** The most parts the pane polls for one screen. */
export const PARTS_MAX = 32;
const PART_PATH_MAX = 1000;

const isPartPath = (value: unknown): value is string => typeof value === 'string' && value.length <= PART_PATH_MAX
  && !value.includes('\\') && value.split('/').every((segment) => segment !== '' && !segment.startsWith('.'));

/** The bridge's parts list as the pane keeps it: the paths it may poll, each once, at most PARTS_MAX. */
export const partsOf = (raw: unknown): string[] => (Array.isArray(raw) ? [...new Set(raw.filter(isPartPath))].slice(0, PARTS_MAX) : []);

/** A path from the screen's folder, made relative to the activity as the screen's own path is. */
export const inScreenFolder = (screen: string, path: string): string => `${screen.slice(0, screen.lastIndexOf('/') + 1)}${path}`;

/** The last parts list this pane's frame reported. A screen with no include reports none, and the last list stands.
 *  ponytail: a screen that drops every include keeps its old parts polled until the pane remounts; at most a needless reload */
export function useFrameParts(frame: RefObject<HTMLIFrameElement | null>): string[] {
  const [parts, setParts] = useState<string[]>([]);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = bridgeData(event, frame.current);
      if (data?.type !== 'parts') return;
      const next = partsOf(data.parts);
      // every reload reports the same list: keeping the one held keeps its poll running
      setParts((now) => (now.join('\n') === next.join('\n') ? now : next));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
  return parts;
}

/** Asks each part's version at once, every VERSION_POLL_MS while shown and on each window focus, and calls `onChange` when one differs
 *  from its last answer, a part gone or appearing included. Baselines outlive a new list, so a change met across a reload is never lost. */
export function usePartVersions(activityId: string, screen: string, parts: readonly string[], isShown: boolean, onChange: () => void): void {
  const seen = useRef(new Map<string, DiskVersion>());
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const key = parts.join('\n');
  useEffect(() => {
    if (!isShown || key === '') return undefined;
    let live = true;
    let isAsking = false; // a slow daemon must not stack requests
    const paths = key.split('\n').map((part) => inScreenFolder(screen, part));
    const read = (): void => {
      if (isAsking) return;
      isAsking = true;
      Promise.all(paths.map(async (path) => [path, await readVersion(activityId, path).catch(() => undefined)] as const)).then((answers) => {
        if (!live) return;
        const known = seen.current;
        const isChanged = answers.some(([path, version]) => version !== undefined && known.has(path) && known.get(path) !== version);
        for (const [path, version] of answers) if (version !== undefined) known.set(path, version);
        if (isChanged) latest.current();
      }).finally(() => { isAsking = false; });
    };
    read(); // the baselines at once: a change before the first tick would otherwise become one
    const timer = setInterval(read, VERSION_POLL_MS);
    window.addEventListener('focus', read);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [activityId, screen, key, isShown]);
}
