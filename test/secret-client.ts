import { newSecret, SECRET_HEADER } from '../src/secret.js';

/** This test process's daemon secret (#467): every createServer of a test gets it and every client call carries it. Made at runtime, so
 *  no secret is ever a literal in a fixture. */
export const SECRET = newSecret();

/** fetch as a client of the daemon (#467): the secret header on top of the call's own headers. A bare fetch in a test is the stranger the
 *  gate refuses. */
export function hiveFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(SECRET_HEADER, SECRET);
  return fetch(input, { ...init, headers });
}

/** A CSP directive's sources, split on spaces; undefined when the policy has no such directive. */
export function directive(policy: string, name: string): string[] | undefined {
  const found = policy.split(';').map((part) => part.trim().split(/\s+/)).find(([key]) => key === name);
  return found?.slice(1);
}
