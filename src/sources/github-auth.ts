import { setTimeout as defaultSleep } from 'node:timers/promises';
import { readCredentials, writeCredentials } from '../credentials.js';
import { apiGql } from './github-gql.js';
import { VIEWER, type ViewerData } from './github-queries.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const SCOPES = 'project repo'; // project reads and writes the source's Status field; repo reads issue bodies in private repos
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SLOW_DOWN_STEP_S = 5;
const MS_PER_SECOND = 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Agent Hive's OAuth App. A device-flow client is a public client — there is no secret, and shipping the id in an
 * open-source build is the intended use. HIVE_GITHUB_CLIENT_ID overrides it for forks and tests.
 * ponytail: placeholder until the OAuth App is registered (plan Task 5, step 0, a human prerequisite) —
 * fill in the real client id (Ov23li…) from Settings -> Developer settings -> OAuth Apps once created.
 */
export const CLIENT_ID = 'Ov23liREPLACE_ME';

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

/** The code plus what only the poll needs. */
export interface Device extends DeviceCode {
  deviceCode: string;
  interval: number;
}

export interface GithubLoginDeps {
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  env?: NodeJS.ProcessEnv;
  /** Set by a caller that can replace this flow with another: an abandoned poll stops and never stores a late token. */
  signal?: AbortSignal;
}

interface DeviceBody { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string }
interface TokenBody { access_token?: string; error?: string; error_description?: string }

const clientId = (env: NodeJS.ProcessEnv): string => env.HIVE_GITHUB_CLIENT_ID || CLIENT_ID;

// Both login endpoints take a form body and answer JSON only when asked to; neither ever sees a token.
async function postForm<T>(url: string, fields: Record<string, string>, deps: GithubLoginDeps): Promise<T> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  // deps.signal aborts the request itself, not just the polling loop around it: without this, a poll already in
  // flight when the flow is cancelled would still run to completion (and could still see its response processed).
  const signal = deps.signal ? AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), deps.signal]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await doFetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal,
    redirect: 'manual',
  });
  const body: unknown = await res.json().catch(() => undefined);
  // Valid JSON that isn't an object (null, an array, a bare string) is still not a body callers can read fields off.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`github login: HTTP ${res.status}`);
  return body as T;
}

const reason = (body: { error?: string; error_description?: string }): string => body.error_description ?? body.error ?? 'unknown error';

/** Step one: the code the user types in the browser. */
export async function requestDeviceCode(deps: GithubLoginDeps = {}): Promise<Device> {
  const env = deps.env ?? process.env;
  const body = await postForm<DeviceBody>(DEVICE_CODE_URL, { client_id: clientId(env), scope: SCOPES }, deps);
  if (!body.device_code || !body.user_code || !body.verification_uri) throw new Error(`github login: ${reason(body)}`);
  return {
    deviceCode: body.device_code, userCode: body.user_code, verificationUri: body.verification_uri,
    expiresIn: body.expires_in ?? 0, interval: body.interval ?? SLOW_DOWN_STEP_S,
  };
}

// The token exists only here and as a header: the viewer call identifies the account, then both go to the store together.
async function store(token: string, deps: GithubLoginDeps): Promise<string> {
  const data = (await apiGql({ fetch: deps.fetch, readToken: async () => token })(VIEWER)) as ViewerData;
  const login = data.viewer?.login;
  if (!login) throw new Error('github login: the token has no viewer');
  await writeCredentials({ ...(await readCredentials(deps.env)), github: { token, login } }, deps.env);
  return login;
}

const CANCELLED_MESSAGE = 'github login: cancelled';

/**
 * Step two: poll until the user authorizes, then store the token and resolve with the account. No refresh: the token
 * does not expire. `deps.signal`, when a caller replaced this flow with another, is checked both before the next poll
 * (so an abandoned flow stops hitting GitHub) and again right after a response lands (so a token that arrives after
 * the abort is never stored).
 */
export async function awaitDeviceLogin(device: Device, deps: GithubLoginDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const sleep = deps.sleep ?? ((ms: number) => defaultSleep(ms));
  const now = deps.now ?? Date.now;
  const { signal } = deps;
  const deadline = now() + device.expiresIn * MS_PER_SECOND;
  let interval = device.interval;
  while (now() < deadline) {
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    await sleep(interval * MS_PER_SECOND);
    const body = await postForm<TokenBody>(ACCESS_TOKEN_URL, { client_id: clientId(env), device_code: device.deviceCode, grant_type: GRANT_TYPE }, deps);
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    if (body.access_token) return store(body.access_token, deps);
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += SLOW_DOWN_STEP_S; // GitHub asks for more room; anything else is the end of the flow
      continue;
    }
    throw new Error(`github login: ${reason(body)}`);
  }
  throw new Error('github login: the code expired before it was authorized');
}

/** The whole flow for a caller that can wait: the code goes to `onCode`, the account comes back. */
export async function loginToGithub(onCode: (code: DeviceCode) => void, deps: GithubLoginDeps = {}): Promise<string> {
  const device = await requestDeviceCode(deps);
  onCode({ userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn });
  return awaitDeviceLogin(device, deps);
}
