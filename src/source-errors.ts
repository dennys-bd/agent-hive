import type { Response } from 'express';

const HTTP_TOO_MANY_REQUESTS = 429;

/** A source call that was rate limited (#812 decision 1): retry at `retryAt`, an absolute ISO time the thrower turned Retry-After into once,
 * so every reader compares it to now the same way. */
export class SourceRateLimitError extends Error {
  readonly retryAt: string;
  constructor(retryAt: string, message = `rate limited until ${retryAt}`) {
    super(message);
    this.name = 'SourceRateLimitError';
    this.retryAt = retryAt;
  }
}

export const isRateLimited = (err: unknown): err is SourceRateLimitError => err instanceof SourceRateLimitError;

/** The one entry every caller of a source reports a rate limit through (#812 decision 4): the server's dispatch of sourceBackoff. */
export type ReportRetry = (source: string, until: string) => Promise<void>;

/** The 429 a write the source rate limited answers (#812 decision 7): resetsAt is the key #294's quota 429 already answers, so the UI reads one shape. */
export interface RateLimitAnswer { status: number; error: string; resetsAt: string }

/** Decision 7's rule for a caller with no Response, as backoffAnswer is for refusedInBackoff (#294): on a SourceRateLimitError the retry is
 * reported for `source` and the answer given; any other error is undefined, for the caller's own refusals. */
export async function rateLimitAnswer(err: unknown, source: string, reportRetry: ReportRetry): Promise<RateLimitAnswer | undefined> {
  if (!isRateLimited(err)) return undefined;
  await reportRetry(source, err.retryAt);
  return { status: HTTP_TOO_MANY_REQUESTS, error: err.message, resetsAt: err.retryAt };
}

/** The same rule for a route's catch: true when the 429 went out. */
export async function answeredRateLimit(err: unknown, source: string, reportRetry: ReportRetry, res: Response): Promise<boolean> {
  const answer = await rateLimitAnswer(err, source, reportRetry);
  if (answer === undefined) return false;
  const { status, ...body } = answer;
  res.status(status).json(body);
  return true;
}
