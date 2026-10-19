import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import type { UpdateChoice, UpdatePreview } from '../../types';
import type { MessageKey } from '@/i18n';
import { getJson, postJson } from '@/lib/api';

export interface Update {
  preview?: UpdatePreview; // undefined until a read answers
  notice?: MessageKey; // a failed read or apply, or a stale apply, shown inline (decisions 13, 15)
  choices: Readonly<Record<string, UpdateChoice>>; // by conflict id
  choose(conflictId: string, choice: UpdateChoice): void;
  isApplying: boolean;
  apply(): Promise<void>;
}

const GONE = 'gone'; // the version has no update any more (no_update): nothing to show
type Read = UpdatePreview | MessageKey | typeof GONE;
const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);
const pathOf = (id: string, version: string): string => `/api/items/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/update`;

// The preview, or why there is none; the server's own words stay in hive.log (decision 15)
async function readPreview(path: string): Promise<Read> {
  try {
    return await getJson<UpdatePreview>(path);
  } catch (err) {
    return codeOf(err) === 'no_update' ? GONE : 'plugins.update.readFailed';
  }
}

/** One version's update (#325): the preview, read on opening, nothing written until apply (decision 4); the conflicts' choices; apply and its
 * refusals (decisions 12–15). `leave` reads the catalogue again and opens the item: after an apply, and when the update is gone. */
export function useUpdate(id: string, version: string, leave: () => Promise<void>): Update {
  const path = pathOf(id, version);
  const [preview, setPreview] = useState<UpdatePreview>();
  const [notice, setNotice] = useState<MessageKey>();
  const [choices, setChoices] = useState<Readonly<Record<string, UpdateChoice>>>({});
  const [isApplying, setApplying] = useState(false);
  // true when a preview landed
  const land = useCallback(async (read: Read): Promise<boolean> => {
    if (read === GONE) {
      await leave();
      return false;
    }
    if (typeof read === 'string') {
      setNotice(read);
      return false;
    }
    setPreview(read);
    return true;
  }, [leave]);
  const landOpening = useEffectEvent((read: Read): void => void land(read));
  useEffect(() => {
    let isLive = true; // a read that answers after the screen left lands nowhere
    void readPreview(path).then((read) => { if (isLive) landOpening(read); });
    return () => { isLive = false; };
  }, [path]);
  // decision 13: a stale token reads the update again with no choice made, since the conflicts may differ (a failed re-read keeps the
  // preview and the choices made on it); 14: a gone update leaves; 15: anything else says so and keeps the choices
  const refused = useCallback(async (code: unknown): Promise<void> => {
    if (code === 'no_update') return leave();
    if (code !== 'stale') return setNotice('plugins.update.applyFailed');
    if (!(await land(await readPreview(path)))) return;
    setChoices({});
    setNotice('plugins.update.stale');
  }, [leave, land, path]);
  const apply = useCallback(async (): Promise<void> => {
    if (preview === undefined) return;
    setApplying(true);
    setNotice(undefined);
    try {
      await postJson(path, { token: preview.token, choices });
      await leave();
    } catch (err) {
      await refused(codeOf(err));
    } finally {
      setApplying(false);
    }
  }, [preview, path, choices, leave, refused]);
  const choose = useCallback((conflictId: string, choice: UpdateChoice): void => setChoices((now) => ({ ...now, [conflictId]: choice })), []);
  return { preview, notice, choices, choose, isApplying, apply };
}
