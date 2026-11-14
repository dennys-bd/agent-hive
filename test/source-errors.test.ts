import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { answeredRateLimit, isRateLimited, rateLimitAnswer, SourceRateLimitError } from '../src/source-errors.js';

const AT = '2026-11-14T13:00:00.000Z';

// A Response that keeps the one answer a route sends
function fakeRes(): { res: Response; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res: { status(code: number): unknown; json(body: unknown): unknown } = {
    status: (code) => { sent.status = code; return res; },
    json: (body) => { sent.body = body; return res; },
  };
  return { res: res as unknown as Response, sent };
}

test('SourceRateLimitError carries its absolute retry time and a message naming it; isRateLimited tells it from any other error (#812)', () => {
  const err = new SourceRateLimitError(AT);
  assert.ok(err instanceof Error);
  assert.deepEqual([err.name, err.retryAt, err.message], ['SourceRateLimitError', AT, `rate limited until ${AT}`]);
  assert.equal(new SourceRateLimitError(AT, 'Jira answered 429').message, 'Jira answered 429');
  assert.equal(isRateLimited(err), true);
  for (const other of [new Error('429'), { retryAt: AT }, undefined, 'rate limited']) assert.equal(isRateLimited(other), false, String(other));
});

test('rateLimitAnswer reports the retry for its source and answers 429 { error, resetsAt }; any other error reports and answers nothing (#812)', async () => {
  const reports: [string, string][] = [];
  const reportRetry = async (source: string, until: string): Promise<void> => { reports.push([source, until]); };
  assert.deepEqual(await rateLimitAnswer(new SourceRateLimitError(AT), 'notes', reportRetry), { status: 429, error: `rate limited until ${AT}`, resetsAt: AT });
  assert.equal(await rateLimitAnswer(new Error('502'), 'notes', reportRetry), undefined);
  assert.deepEqual(reports, [['notes', AT]]);
});

test('answeredRateLimit sends the 429 and answers true on the error, and sends nothing on any other (#812)', async () => {
  const reportRetry = async (): Promise<void> => {};
  const limited = fakeRes();
  assert.equal(await answeredRateLimit(new SourceRateLimitError(AT), 'work', reportRetry, limited.res), true);
  assert.deepEqual(limited.sent, { status: 429, body: { error: `rate limited until ${AT}`, resetsAt: AT } });
  const other = fakeRes();
  assert.equal(await answeredRateLimit(new Error('no access'), 'work', reportRetry, other.res), false);
  assert.deepEqual(other.sent, {});
});
