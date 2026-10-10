import type { Response } from 'express';

/** What a continuing Stop hook is answered with: Claude Code goes on with `reason` as the next prompt. */
export interface HookReply {
  decision: 'block';
  reason: string;
}

/** The Stop answers the server owes (#268): the Stop's own continue, and a held Stop that waits for the user. */
export interface HeldStops {
  /** The Stop's handler, after its dispatch: an answer kept for the worker goes out now; else, with `until`, the Stop waits; else no decision. */
  settle(ptyId: string, res: Response, until?: string): void;
  /** The continue (reply) or release (none) effect: answers the waiting Stop, or keeps the answer for its settle. */
  answer(ptyId: string, reply?: HookReply): void;
  /** A later hold (Estender) moves the waiting Stop's timer. */
  extend(ptyId: string, until: string): void;
  /** close(): every waiting Stop gets no decision, and every timer goes. */
  releaseAll(): void;
}

const HTTP_NO_CONTENT = 204; // an empty body is "no decision" for Claude Code
const EXPIRY_SLACK_MS = 1_000; // the reducer checks until <= now: the timer fires just past it, never a hair early

export function createHeldStops(onExpire: (ptyId: string) => void, slackMs = EXPIRY_SLACK_MS): HeldStops {
  const waiting = new Map<string, { res: Response; timer: NodeJS.Timeout }>();
  // An answer that beat its Stop's handler: the Stop's own continue, or the user's answer while the Stop's dispatch still runs
  const early = new Map<string, HookReply | undefined>();
  const send = (res: Response, reply?: HookReply): void => {
    if (res.headersSent) return;
    if (reply) res.json(reply);
    else res.status(HTTP_NO_CONTENT).end();
  };
  // The timer only answers the entry it was armed for: a second Stop of the worker (Esc, then a new prompt) owns the key since
  const arm = (ptyId: string, res: Response, until: string): NodeJS.Timeout =>
    setTimeout(() => { if (waiting.get(ptyId)?.res === res && take(ptyId)) onExpire(ptyId); }, Math.max(0, Date.parse(until) - Date.now()) + slackMs);
  // A worker that dies with its Stop held closes the connection: nothing is left to answer
  const forgetOnClose = (ptyId: string, res: Response): void => {
    res.once('close', () => {
      const entry = waiting.get(ptyId);
      if (entry?.res !== res) return;
      clearTimeout(entry.timer);
      waiting.delete(ptyId);
    });
  };
  // the waiting Stop, answered with `reply`: false when none waits
  function take(ptyId: string, reply?: HookReply): boolean {
    const entry = waiting.get(ptyId);
    if (!entry) return false;
    waiting.delete(ptyId);
    clearTimeout(entry.timer);
    send(entry.res, reply);
    return true;
  }
  return {
    settle(ptyId, res, until) {
      if (early.has(ptyId)) {
        send(res, early.get(ptyId));
        early.delete(ptyId);
      } else if (until === undefined) send(res);
      else {
        take(ptyId); // a Stop still held for this worker is ended before the new one takes its place
        waiting.set(ptyId, { res, timer: arm(ptyId, res, until) });
        forgetOnClose(ptyId, res);
      }
    },
    answer(ptyId, reply) {
      // A release with no Stop waiting is not kept: the expiry timer already answered it (approvalExpired's release would otherwise
      // sit in `early` forever), and one that beats its Stop's settle only costs that Stop the wait until its timer, on a killed worker
      if (!take(ptyId, reply) && reply) early.set(ptyId, reply);
    },
    extend(ptyId, until) {
      const entry = waiting.get(ptyId);
      if (!entry) return;
      clearTimeout(entry.timer);
      waiting.set(ptyId, { res: entry.res, timer: arm(ptyId, entry.res, until) });
    },
    releaseAll() {
      for (const ptyId of [...waiting.keys()]) take(ptyId);
      early.clear();
    },
  };
}
