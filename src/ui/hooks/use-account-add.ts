import { useCallback, useEffect, useRef, useState } from 'react';
import { ADD_POLL_MS, type AddStatus, addRoute, addStatusFrom, addedName, failedStatus, IDLE, type NameRefusal, shownStatus, startFailure } from '@/lib/account-add';
import { getJson, sendJson } from '@/lib/api';
import type { AccountList } from '@/lib/settings-accounts';
import type { ClaudeAddStatus, GithubAddStatus } from '../../types';

export type StartOutcome = 'started' | 'refused' | 'failed';
/** One provider's add (#965): the status its group shows (connected and cancelled read as idle), the name the last add stored, for the screen
 * reader, and Claude's refusal at the field. */
export interface AccountAdd<S extends AddStatus> {
  status: S;
  added?: string;
  refusal?: NameRefusal;
  start(name?: string): Promise<StartOutcome>;
  cancel(): void;
  dismiss(): void; // a failed add's close: back to rest without a call
}

// A read that fails or answers no status is logged and changes nothing: the next tick reads again
async function readStatus(list: AccountList): Promise<AddStatus | undefined> {
  try {
    const status = addStatusFrom(list, await getJson<unknown>(addRoute(list)));
    if (status === undefined) console.error(`accounts: the ${list} add answered no status`);
    return status;
  } catch (err) {
    console.error(`accounts: the ${list} add was not read`, err);
    return undefined;
  }
}

// The POST and what it means: a status to land, Claude's name refusal, or undefined for a failure the group words. A 409 add-pending is the
// daemon's one add per provider, this same flow: it resumes from the status
async function postStart(list: AccountList, name: string | undefined): Promise<AddStatus | NameRefusal | undefined> {
  try {
    const status = addStatusFrom(list, await sendJson<unknown>('POST', addRoute(list), name === undefined ? undefined : { name }));
    if (status === undefined) console.error(`accounts: the ${list} add answered no status`);
    return status;
  } catch (err) {
    const failure = startFailure(err);
    if (failure.kind === 'pending') return readStatus(list);
    console.error(`accounts: the ${list} add did not start`, err);
    return failure.kind === 'refused' ? failure.refusal : undefined;
  }
}

/** The add flow of one provider (#965): reads its status once on mount, where only a pending add resumes; polls once a second while pending;
 * stops on a terminal state and on unmount. connected re-reads the list through onConnected; nothing here touches the form's draft. */
export function useAccountAdd(list: 'claude', onConnected: () => void): AccountAdd<ClaudeAddStatus>;
export function useAccountAdd(list: 'github', onConnected: () => void): AccountAdd<GithubAddStatus>;
export function useAccountAdd(list: AccountList, onConnected: () => void): AccountAdd<AddStatus> {
  const [status, setStatus] = useState<AddStatus>(IDLE);
  const [added, setAdded] = useState<string>();
  const [refusal, setRefusal] = useState<NameRefusal>();
  const connected = useRef(onConnected);
  useEffect(() => { connected.current = onConnected; }); // the card's refetch is a new function each render
  const land = useCallback((next: AddStatus): void => {
    const name = addedName(next);
    if (name !== undefined) { setAdded(name); connected.current(); }
    setStatus(shownStatus(next));
  }, []);
  useEffect(() => {
    let live = true;
    void readStatus(list).then((next) => { if (live && next?.state === 'pending') setStatus(next); }); // a connected or failed one is old news
    return () => { live = false; };
  }, [list]);
  const isPending = status.state === 'pending';
  useEffect(() => {
    if (!isPending) return;
    let live = true;
    const timer = setInterval(() => { void readStatus(list).then((next) => { if (live && next !== undefined) land(next); }); }, ADD_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [isPending, list, land]);
  const start = async (name?: string): Promise<StartOutcome> => {
    setRefusal(undefined);
    setAdded(undefined);
    const answer = await postStart(list, name);
    if (typeof answer === 'string') { setRefusal(answer); setStatus(IDLE); return 'refused'; }
    if (answer === undefined) { setStatus(failedStatus(list, name ?? '')); return 'failed'; }
    land(answer);
    return 'started';
  };
  const cancel = (): void => {
    setStatus(IDLE);
    sendJson<unknown>('DELETE', addRoute(list)).catch((err: unknown) => console.error(`accounts: the ${list} add was not cancelled`, err));
  };
  const dismiss = (): void => { setRefusal(undefined); setStatus(IDLE); };
  return { status, added, refusal, start, cancel, dismiss };
}
