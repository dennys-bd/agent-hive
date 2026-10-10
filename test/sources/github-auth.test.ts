import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginToGithub, requestDeviceCode, type GithubLoginDeps } from '../../src/sources/github-auth.js';
import { readCredentials } from '../../src/credentials.js';
import { tempDir, type AfterHost } from '../temp-dir.js';

const TOKEN = 'gho_thisMustNeverBeLogged';
const CLIENT_ID = 'Ov23liTEST';
const DEVICE = { device_code: 'DC1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { url: string; body: Record<string, string> }

/** Answers the device-code request with DEVICE, then `tokenAnswers` in order, then the viewer query. */
function fakeGithub(tokenAnswers: unknown[], viewer: Response = json({ data: { viewer: { login: 'ana' } } })) {
  const calls: Call[] = [];
  const slept: number[] = [];
  const doFetch = (async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    const body = target.includes('api.github.com') ? {} : Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({ url: target, body });
    if (target.endsWith('/login/device/code')) return json(DEVICE);
    if (target.endsWith('/login/oauth/access_token')) return json(tokenAnswers.shift() ?? { error: 'authorization_pending' });
    return viewer.clone();
  }) as unknown as typeof fetch;
  return { calls, slept, doFetch };
}

async function deps(t: AfterHost, fake: ReturnType<typeof fakeGithub>): Promise<GithubLoginDeps> {
  return {
    fetch: fake.doFetch,
    sleep: async (ms) => { fake.slept.push(ms); },
    now: () => 0, // the deadline never bites in these tests; the expiry case overrides it
    env: { XDG_CONFIG_HOME: await tempDir(t, 'login-'), HIVE_GITHUB_CLIENT_ID: CLIENT_ID },
  };
}

test('the device code request asks for project and repo on the Hive\'s client id and answers what the user has to type', async (t) => {
  const fake = fakeGithub([]);
  const d = await deps(t, fake);
  const device = await requestDeviceCode(d);
  assert.deepEqual(
    { userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn, interval: device.interval, deviceCode: device.deviceCode },
    { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5, deviceCode: 'DC1' },
  );
  assert.equal(fake.calls[0].url, 'https://github.com/login/device/code');
  assert.deepEqual(fake.calls[0].body, { client_id: CLIENT_ID, scope: 'project repo' });
  await assert.rejects(requestDeviceCode({ ...d, fetch: (async () => json({ error: 'device_flow_disabled' }, 400)) as unknown as typeof fetch }), /device_flow_disabled/);
});

test('deps.signal cancels the request itself, not just the polling loop around it', async (t) => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const doFetch = (async (_url: string | URL, init: RequestInit = {}) => {
    capturedSignal = init.signal as AbortSignal;
    return json(DEVICE);
  }) as unknown as typeof fetch;
  const d = { ...(await deps(t, fakeGithub([]))), fetch: doFetch, signal: controller.signal };
  await requestDeviceCode(d);
  assert.ok(capturedSignal, 'the fetch call must receive a signal');
  assert.equal(capturedSignal?.aborted, false);
  controller.abort(); // simulates the server aborting a flow it is replacing while this request is still in flight
  assert.equal(capturedSignal?.aborted, true, 'the request\'s own signal must reflect an external abort, not only the timeout');
});

test('authorization_pending waits the interval and retries; the access token is checked with viewer and stored with the login', async (t) => {
  const fake = fakeGithub([{ error: 'authorization_pending' }, { error: 'authorization_pending' }, { access_token: TOKEN }]);
  const d = await deps(t, fake);
  assert.equal(await loginToGithub(() => {}, d), 'ana');
  assert.deepEqual(fake.slept, [5000, 5000, 5000]);
  const token = fake.calls.filter((c) => c.url.endsWith('/access_token'));
  assert.equal(token.length, 3);
  assert.deepEqual(token[0].body, { client_id: CLIENT_ID, device_code: 'DC1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  assert.equal(fake.calls.at(-1)?.url, 'https://api.github.com/graphql', 'the login comes from viewer, not from the token response');
  assert.deepEqual(await readCredentials(d.env), { github: { token: TOKEN, login: 'ana' } });
});

test('slow_down widens the interval by 5 s, and the code expiring rejects saying so', async (t) => {
  const fake = fakeGithub([{ error: 'slow_down' }, { error: 'slow_down' }, { access_token: TOKEN }]);
  await loginToGithub(() => {}, await deps(t, fake));
  assert.deepEqual(fake.slept, [5000, 10_000, 15_000]);
  const expiring = fakeGithub([{ error: 'authorization_pending' }]);
  let clock = 0;
  const d = { ...(await deps(t, expiring)), now: () => (clock += 600_000) }; // two ticks and the 900 s window is gone
  await assert.rejects(loginToGithub(() => {}, d), /expired/);
});

test('an authorization that fails rejects with GitHub\'s reason, and no path lets the token into a message', async (t) => {
  const denied = fakeGithub([{ error: 'access_denied', error_description: 'the user cancelled the authorization' }]);
  await assert.rejects(loginToGithub(() => {}, await deps(t, denied)), { message: 'github login: the user cancelled the authorization' });
  const expired = fakeGithub([{ error: 'expired_token', error_description: 'this code has expired' }]);
  await assert.rejects(loginToGithub(() => {}, await deps(t, expired)), /this code has expired/);
  // a token GitHub refuses must not be stored, and its value must not reach the rejection
  const refused = fakeGithub([{ access_token: TOKEN }], json({ message: TOKEN }, 401));
  const d = await deps(t, refused);
  const err = await loginToGithub(() => {}, d).then(() => undefined, (e: Error) => e);
  assert.ok(err && !err.message.includes(TOKEN), err?.message);
  assert.equal(err?.message, 'github api: HTTP 401');
  assert.deepEqual(await readCredentials(d.env), {}, 'nothing stored for a token the API refuses');
  const seen: string[] = [];
  await loginToGithub((code) => seen.push(code.userCode), await deps(t, fakeGithub([{ access_token: TOKEN }])));
  assert.deepEqual(seen, ['ABCD-1234'], 'onCode fires once, before the wait');
});

test('valid JSON that is not an object (null, an array) is a clean "github login:" error, not a raw TypeError', async (t) => {
  const d = await deps(t, fakeGithub([]));
  await assert.rejects(requestDeviceCode({ ...d, fetch: (async () => json(null)) as unknown as typeof fetch }), /github login: HTTP 200$/);
  await assert.rejects(requestDeviceCode({ ...d, fetch: (async () => json([])) as unknown as typeof fetch }), /github login: HTTP 200$/);
});
