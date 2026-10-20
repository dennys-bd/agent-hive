import { useEffect, useRef, useState } from 'react';
import type { Activity, OpenResult, SetupRow, SetupRowStatus, SetupRows } from '../../types';

/** How a start or an open's request ended (#390): its answer, or its refusal. */
export type Answer = { ok: true; opened?: OpenResult } | { ok: false; error: Error & { code?: string } };
type Verdict = 'end' | 'failed';

/** What the dialog does with an answer (#390). With no preparing view, the answer alone decides, as before. With it, a refusal fails at once,
 * and an ok waits for the setup to leave the state, whose lastSetup then says it failed: the answer and the state broadcast are not ordered. */
export function verdictOf(isOn: boolean, answer: Answer | undefined, live: Activity | undefined): Verdict | undefined {
  if (answer === undefined) return undefined;
  if (!isOn) return 'end';
  if (!answer.ok) return 'failed';
  if (live?.setup !== undefined) return undefined;
  return live?.lastSetup === undefined ? 'end' : 'failed';
}

/** The session row (#390): queued while a server row is not done, running once they all are, done once the request answered. */
export const sessionStatus = (rows: readonly SetupRow[], isAnswered: boolean): SetupRowStatus => {
  if (!rows.every((row) => row.status === 'done')) return 'queued';
  return isAnswered ? 'done' : 'running';
};

// A failure with no lastSetup (#390: a spawn refused after the setup passed, a git refusal): the last rows seen, the running one failed
const failedRows = (seen: SetupRows): SetupRows => ({ ...seen, rows: seen.rows.map((row) => (row.status === 'running' ? { ...row, status: 'failed' } : row)) });

// A lastSetup as its content: the state is broadcast whole, so the same failure comes back as a new object
const keyOf = (rows: SetupRows | undefined): string | undefined => (rows === undefined ? undefined : JSON.stringify(rows));

interface Request { id: number; answer?: Answer; onEnd(answer: Answer): void; onFailed(answer: Answer): void }

/** The Start dialog's preparing view (#390). */
export interface SetupView {
  progress?: SetupRows; // the rows the view shows: the live setup's, else the last failed one's, else the last seen; undefined: the form
  isLive: boolean; // the activity holds its live setup
  isFailed: boolean; // only once the setup left the state: until then a submit would be refused, so tentar de novo keeps the wait
  isAnswered: boolean;
  begin(onEnd: (answer: Answer) => void, onFailed: (answer: Answer) => void): (answer: Answer) => void; // a submit or tentar de novo: answers the request's settle
}

/** The switch of the Start dialog (#390): a setup that marks the activity while the dialog's request is on its way turns the view on, for the
 * rest of the dialog. The request then ends through onEnd (the dialog closes, or its error shows), or onFailed (the view stays, failed). */
export function useSetupView(live: Activity | undefined): SetupView {
  const [request, setRequest] = useState<Request>();
  const [seen, setSeen] = useState<SetupRows>();
  const [hasFailed, setFailed] = useState(false);
  const [stale, setStale] = useState<string>(); // the lastSetup present at begin: a retry's ok answer can beat its setupStarted to the state
  const ids = useRef(0);
  const setup = live?.setup;
  useEffect(() => {
    if (request !== undefined && setup !== undefined) setSeen(setup);
  }, [request, setup]);
  const lastSetup = keyOf(live?.lastSetup) === stale ? undefined : live?.lastSetup;
  const verdict = verdictOf(seen !== undefined, request?.answer, live && { ...live, lastSetup });
  useEffect(() => {
    const answer = request?.answer;
    if (request === undefined || answer === undefined || verdict === undefined) return;
    setRequest(undefined);
    if (verdict === 'end') {
      request.onEnd(answer);
      return;
    }
    setFailed(true);
    request.onFailed(answer);
  }, [request, verdict]);
  const begin = (onEnd: (answer: Answer) => void, onFailed: (answer: Answer) => void): ((answer: Answer) => void) => {
    ids.current += 1;
    const id = ids.current;
    setRequest({ id, onEnd, onFailed });
    setFailed(false);
    setStale(keyOf(live?.lastSetup));
    return (answer) => setRequest((r) => (r?.id === id ? { ...r, answer } : r)); // a stale request's answer never lands on the next
  };
  const isFailed = hasFailed && setup === undefined;
  const progress = seen === undefined ? undefined : setup ?? live?.lastSetup ?? (isFailed ? failedRows(seen) : seen);
  return { progress, isLive: setup !== undefined, isFailed, isAnswered: request?.answer !== undefined, begin };
}
