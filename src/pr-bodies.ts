import { withoutControls } from './pty-paste.js';
import { textOf } from './review-bodies.js';
import { PR_BODY_MAX } from './types.js';

// What the PR routes take from a request (#592): checked here, and sent to GitHub only as GraphQL variables.

const OID = /^[0-9a-f]{40}$/;
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/; // a GitHub node id (PRRT_…); anything else is no thread of GitHub's

/** The head the page showed (#592): a full commit sha. */
export const isOid = (value: unknown): value is string => typeof value === 'string' && OID.test(value);
export const isNodeId = (value: unknown): value is string => typeof value === 'string' && NODE_ID.test(value);

/** A comment, a reply or a draft (#592): control characters out, trimmed, 1 to REVIEW_TEXT_MAX characters. */
export const prTextOf = (raw: unknown): string | undefined => (typeof raw === 'string' ? textOf(withoutControls(raw)) : undefined);

/** The general comment (#592): control characters out, trimmed, 0 to PR_BODY_MAX characters. */
export function prBodyOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const body = withoutControls(raw).trim();
  return body.length > PR_BODY_MAX ? undefined : body;
}
