import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { LspPeer } from '../src/lsp-process.js';

/** The stub server, read from the repo: .mjs files are not copied to dist/ (#780). */
export const LSP_STUB = fileURLToPath(new URL('../../test/fixtures/lsp-stub.mjs', import.meta.url));

/** A client of a process that records what it was sent and how it was closed. */
export interface FakePeer extends LspPeer { sent: Record<string, unknown>[]; closed?: { code: number; reason: string } }
export const fakePeer = (): FakePeer => {
  const peer: FakePeer = { sent: [], send: (m) => { peer.sent.push(m as Record<string, unknown>); }, close: (code, reason) => { peer.closed = { code, reason }; } };
  return peer;
};

// Generous: a loaded machine starts a node stub slowly
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 4000 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'condition not met in time');
}
