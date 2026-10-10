import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { prNumber, prRepo } from '../../pull-requests';
import type { PrChecksRead, PrData, PrReviewFile } from '../../types';
import { repoPath } from '@/hooks/use-repositories';
import { type MessageKey, t } from '@/i18n';
import { getJson } from '../lib/api.js';
import { onPrReviewEvent } from '@/lib/review-events';

/** What a PR view shows (#592): its first read, the route's error, or the PR. */
export type PrLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; pr: PrData };
/** GitHub computes mergeability lazily (#592): an UNKNOWN answer is read once more after this. */
export const UNKNOWN_RETRY_MS = 3000;
/** While a check of the PR shown runs and its page shows, its checks are read again this often (#758). */
export const CHECKS_POLL_MS = 30_000;

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
const isChecksRead = (value: unknown): value is PrChecksRead => isObject(value) && typeof value.mergeState === 'string' && typeof value.updatedAt === 'string';

// The checks' poll (#758): while a check of the PR shown is pending and its page shows, GET …/checks every CHECKS_POLL_MS. A failed read waits
// for the next one: a toast every 30 s would only nag
function useChecksPoll(url: string, isPending: boolean, active: boolean, apply: (read: PrChecksRead) => void): void {
  useEffect(() => {
    if (!active || !isPending) return undefined;
    const timer = setInterval(() => {
      getJson<unknown>(prPath(url, '/checks')).then((read) => { if (isChecksRead(read)) apply(read); }, () => undefined);
    }, CHECKS_POLL_MS);
    return () => clearInterval(timer);
  }, [url, isPending, active, apply]);
}

/** The PR (#592, #758): read each time `active` turns on and on refresh(), never while hidden. A refresh keeps the PR on screen until its
 * answer lands, and a failed one after a first success is a toast. Only the latest answer lands; refresh never rejects. An UNKNOWN
 * mergeability is read once more. While a check runs and `active`, the checks are polled (#758). */
export function usePrData(url: string, active: boolean): { load: PrLoad; refresh(): Promise<void> } {
  const [load, setLoad] = useState<PrLoad>({ status: 'loading' });
  const shown = useRef(load);
  shown.current = load;
  const latest = useRef(0);
  const refresh = useCallback((): Promise<void> => {
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
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  const retried = useRef<string | undefined>(undefined);
  const pr = load.status === 'ready' ? load.pr : undefined;
  const updatedAt = pr?.updatedAt;
  // A poll's checks and merge state go into the PR shown; a newer updatedAt means the PR itself changed, so it is read whole: an edit then
  // goes with the updatedAt of the text the page shows
  const apply = useCallback((read: PrChecksRead): void => {
    setLoad((current) => (current.status === 'ready' ? { status: 'ready', pr: { ...current.pr, checks: read.checks, mergeState: read.mergeState } } : current));
    if (read.updatedAt !== updatedAt) void refresh();
  }, [updatedAt, refresh]);
  useChecksPoll(url, pr?.checks?.state === 'pending', active, apply);
  useEffect(() => {
    // The retry is once per PR: the url it was armed for, and only on an answer that is that PR's, not the previous one still on screen
    if (pr?.mergeState !== 'unknown' || pr.url !== url || retried.current === url) return undefined;
    retried.current = url;
    const timer = setTimeout(() => void refresh(), UNKNOWN_RETRY_MS);
    return () => clearTimeout(timer);
  }, [pr, url, refresh]);
  return { load, refresh };
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

/** A PR's data (#592, #758): the PR and its review file. */
export function usePr(url: string, active: boolean): { load: PrLoad; refresh(): Promise<void>; review?: PrReviewFile; reread(): void } {
  return { ...usePrData(url, active), ...usePrReviewFile(url) };
}
