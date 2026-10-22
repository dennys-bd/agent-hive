import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { prNumber, prRepo } from '../../pull-requests';
import type { PrChanges, PrChecksRead, PrData, PrReviewFile } from '../../types';
import { useReadModelReload } from '@/hooks/use-repo-issues';
import { repoPath } from '@/hooks/use-repositories';
import { type MessageKey, t } from '@/i18n';
import { getJson } from '../lib/api.js';
import { onPrReviewEvent } from '@/lib/review-events';

/** What a PR view shows (#592): its first read, the route's error, or the PR. */
export type PrLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; pr: PrData };
/** GitHub computes mergeability lazily (#592): an UNKNOWN answer is read once more after this. */
export const UNKNOWN_RETRY_MS = 3000;

/** A PR's routes (#758): under its repository, by the number its link holds. */
export const prPath = (url: string, rest = ''): string => `${repoPath(prRepo(url))}/pulls/${prNumber(url)}${rest}`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
// Checked at the boundary (#592): anything else never reaches the view
const isPrData = (value: unknown): value is PrData =>
  isObject(value) && typeof value.url === 'string' && typeof value.head === 'string' && typeof value.body === 'string' && typeof value.approvals === 'number'
  && Array.isArray(value.files) && Array.isArray(value.threads) && Array.isArray(value.methods) && Array.isArray(value.reviews) && Array.isArray(value.comments);
// The status tells a read's failures apart (#849); the server's text, GitHub's own, never reaches the page
const READ_ERRORS: Record<number, MessageKey> = { 404: 'pr.error.notFound', 409: 'pr.error.moved', 413: 'pr.error.tooLarge', 502: 'pr.error.github' };

/** A failed read's copy (#849), by the status src/ui/lib/api.ts puts on the error: anything unforeseen, a network failure included, is
 * unexpected, so the user always learns an error happened. */
export function prReadError(err: unknown): string {
  const status = isObject(err) ? err.status : undefined;
  return t(typeof status === 'number' && Object.hasOwn(READ_ERRORS, status) ? READ_ERRORS[status] : 'pr.error.unexpected');
}

const isPrReviewFile = (value: unknown): value is PrReviewFile => isObject(value) && Array.isArray(value.reviewed) && Array.isArray(value.drafts);
export const isChecksRead = (value: unknown): value is PrChecksRead => isObject(value) && typeof value.mergeState === 'string' && typeof value.updatedAt === 'string';

/** A PR's changes (#497): their first read, the route's error, or the diff and the threads. */
export type ChangesLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; changes: PrChanges };
const isPrChanges = (value: unknown): value is PrChanges =>
  isObject(value) && typeof value.head === 'string' && Array.isArray(value.files) && Array.isArray(value.threads)
  && typeof value.truncated === 'boolean' && Array.isArray(value.reviewRequests);
const CHANGES_KINDS: readonly string[] = ['pullChanges'];

const PAGE_KINDS: readonly string[] = ['issues', 'pulls']; // the PR's issues row and its own fields (#187)

// The round is the poll now (#187): a readModel event of the PR's repository reads …/checks, which the server answers from the model. Never
// while hidden. A failed read waits for the next event: a toast per round would only nag
function useChecksReload(url: string, active: boolean, apply: (read: PrChecksRead) => void): void {
  const reload = useCallback(async (): Promise<void> => {
    if (!active) return;
    try {
      const read = await getJson<unknown>(prPath(url, '/checks'));
      if (isChecksRead(read)) apply(read);
    } catch {
      // the next round's event reads again
    }
  }, [url, active, apply]);
  useReadModelReload(prRepo(url), PAGE_KINDS, reload);
}

// The diff and the threads (#497). They are read when the page turns active, on fresh() (the page's refresh, after every write: the server
// revalidates past its cooldown and a change comes back as the event), on a pullChanges event of the repository, and once more when the fields
// name another head. Only the latest answer lands. A failure is the files tab's message, never a toast: the tab shows it
function usePrChanges(url: string, active: boolean, head: string | undefined): { changes: ChangesLoad; readChanges(fresh?: boolean): Promise<void> } {
  const [changes, setChanges] = useState<ChangesLoad>({ status: 'loading' });
  const latest = useRef(0);
  const readChanges = useCallback((fresh = false): Promise<void> => {
    latest.current += 1;
    const mine = latest.current;
    return getJson<unknown>(prPath(url, fresh ? '/changes?fresh=1' : '/changes')).then(
      (read) => { if (latest.current === mine) setChanges(isPrChanges(read) ? { status: 'ready', changes: read } : { status: 'error', message: t('pr.badAnswer') }); },
      (err: unknown) => { if (latest.current === mine) setChanges({ status: 'error', message: prReadError(err) }); },
    );
  }, [url]);
  useEffect(() => { if (active) void readChanges(); }, [active, readChanges]);
  const onEvent = useCallback(async (): Promise<void> => { if (active) await readChanges(); }, [active, readChanges]);
  useReadModelReload(prRepo(url), CHANGES_KINDS, onEvent);
  // Once per head the fields name: a server answering at another head (its refetch failed) never loops the page
  const askedFor = useRef<string | undefined>(undefined);
  const changesHead = changes.status === 'ready' ? changes.changes.head : undefined;
  useEffect(() => {
    if (!active || !head || changesHead === undefined || head === changesHead || askedFor.current === head) return;
    askedFor.current = head;
    void readChanges();
  }, [active, head, changesHead, readChanges]);
  return { changes, readChanges };
}

/** The PR (#592, #758): read each time `active` turns on and on refresh(), never while hidden. A refresh keeps the PR on screen until its
 * answer lands, and a failed one after a first success is a toast. Only the latest answer lands; refresh never rejects. An UNKNOWN
 * mergeability is read once more. While `active`, a readModel event of its repository reads its checks again (#187). The changes (#497) are a
 * second load beside it; refresh reads both. */
export function usePrData(url: string, active: boolean): { load: PrLoad; changes: ChangesLoad; refresh(): Promise<void> } {
  const [load, setLoad] = useState<PrLoad>({ status: 'loading' });
  const shown = useRef(load);
  shown.current = load;
  const latest = useRef(0);
  const readFields = useCallback((): Promise<void> => {
    latest.current += 1;
    const mine = latest.current;
    return getJson<unknown>(prPath(url)).then(
      (pr) => {
        if (latest.current !== mine) return;
        setLoad(isPrData(pr) ? { status: 'ready', pr } : { status: 'error', message: t('pr.badAnswer') });
      },
      (err: unknown) => {
        if (latest.current !== mine) return;
        const message = prReadError(err);
        if (shown.current.status === 'ready') toast.error(message);
        else setLoad({ status: 'error', message });
      },
    );
  }, [url]);
  useEffect(() => { if (active) void readFields(); }, [active, readFields]);
  const retried = useRef<string | undefined>(undefined);
  const pr = load.status === 'ready' ? load.pr : undefined;
  const updatedAt = pr?.updatedAt;
  const { changes, readChanges } = usePrChanges(url, active, pr?.head);
  // A reload's checks and merge state go into the PR shown; a newer updatedAt means the PR itself changed, so it is read whole: an edit then
  // goes with the updatedAt of the text the page shows
  const apply = useCallback((read: PrChecksRead): void => {
    setLoad((current) => (current.status === 'ready' ? { status: 'ready', pr: { ...current.pr, checks: read.checks, mergeState: read.mergeState } } : current));
    if (read.updatedAt !== updatedAt) void readFields();
  }, [updatedAt, readFields]);
  useChecksReload(url, active, apply);
  useEffect(() => {
    // The retry is once per PR: the url it was armed for, and only on an answer that is that PR's, not the previous one still on screen
    if (pr?.mergeState !== 'unknown' || pr.url !== url || retried.current === url) return undefined;
    retried.current = url;
    const timer = setTimeout(() => void readFields(), UNKNOWN_RETRY_MS);
    return () => clearTimeout(timer);
  }, [pr, url, readFields]);
  const refresh = useCallback(async (): Promise<void> => { await Promise.all([readFields(), readChanges(true)]); }, [readFields, readChanges]);
  return { load, changes, refresh };
}

/** The PR's review file (#592): read on mount, on every prReview event of the link, and on reread(). Only the latest read lands. */
export function usePrReviewFile(url: string): { review?: PrReviewFile; reread(): void } {
  const [review, setReview] = useState<PrReviewFile>();
  const latest = useRef(0);
  const reread = useCallback(() => {
    latest.current += 1;
    const mine = latest.current;
    getJson<unknown>(prPath(url, '/review')).then(
      (file) => { if (latest.current === mine && isPrReviewFile(file)) setReview(file); },
      (err: unknown) => toast.error(prReadError(err)),
    );
  }, [url]);
  useEffect(() => {
    reread();
    return onPrReviewEvent((changed) => { if (changed === url) reread(); });
  }, [url, reread]);
  return { review, reread };
}

/** A PR's data (#592, #758): the PR, its changes (#497) and its review file. */
export function usePr(url: string, active: boolean): { load: PrLoad; changes: ChangesLoad; refresh(): Promise<void>; review?: PrReviewFile; reread(): void } {
  return { ...usePrData(url, active), ...usePrReviewFile(url) };
}
