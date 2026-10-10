import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiGql, cliGql, cliGqlJson, githubLoginName, loggedGql, NO_TOKEN_MESSAGE } from '../../src/sources/github-gql.js';
import { PROJECT_FIELDS, VIEWER } from '../../src/sources/github-queries.js';
import { writeCredentials } from '../../src/credentials.js';
import { fakeLog } from '../fakes.js';
import { tempDir } from '../temp-dir.js';

const TOKEN = 'gho_thisMustNeverBeLogged';
const OK_BODY = { data: { viewer: { login: 'ana' } } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every call; answers `answers` in order (the last one repeats). */
function fakeFetch(...answers: Response[]): { doFetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return answers[Math.min(calls.length - 1, answers.length - 1)].clone();
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

const bound = (doFetch: typeof fetch) => apiGql({ fetch: doFetch, readToken: async () => TOKEN });

test('cliGql sends the query as -f query= and one flag per variable: -f for strings, -F for numbers, and unwraps data', async () => {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: { repositoryOwner: null } });
  };
  assert.deepEqual(await cliGql(exec)(PROJECT_FIELDS, { login: 'acme', number: 6 }), { repositoryOwner: null });
  assert.deepEqual(calls[0].slice(0, 3), ['api', 'graphql', '-f']);
  assert.equal(calls[0][3], `query=${PROJECT_FIELDS}`);
  assert.deepEqual(calls[0].slice(4), ['-f', 'login=acme', '-F', 'number=6'], '-F is what makes gh send a JSON number');
  assert.deepEqual(await cliGql(exec)(VIEWER), { repositoryOwner: null });
  assert.equal(calls[1].length, 4, 'no variables, no flags');
});

test('apiGql posts to api.github.com with the bearer, the fixed host and no redirect, and unwraps data', async () => {
  const { doFetch, calls } = fakeFetch(json(OK_BODY));
  assert.deepEqual(await bound(doFetch)(VIEWER, { login: 'acme' }), { viewer: { login: 'ana' } });
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual', 'the bearer never follows a redirect off the fixed host');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { query: VIEWER, variables: { login: 'acme' } });
  assert.ok(calls[0].init.signal, 'a timeout, not an open-ended call');
});

test('both transports treat a non-empty errors array as a failure, even with partial data beside it', async () => {
  const body = { data: { viewer: null }, errors: [{ message: 'Could not resolve to a User' }, { message: 'second' }] };
  await assert.rejects(bound(fakeFetch(json(body)).doFetch)(VIEWER), { message: 'Could not resolve to a User' });
  await assert.rejects(cliGql(async () => JSON.stringify(body))(VIEWER), { message: 'Could not resolve to a User' });
  // a poll must never silently degrade into "no blockers": partial data is not a result
  await assert.rejects(bound(fakeFetch(json({ data: { a: 1 }, errors: [{ message: 'partial' }] })).doFetch)(VIEWER), { message: 'partial' });
});

test('githubLoginName answers only the login, never the token, and undefined when nobody is stored', async (t) => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'gql-') };
  assert.equal(await githubLoginName(env), undefined);
  await writeCredentials({ github: { token: TOKEN, login: 'ana' } }, env);
  assert.equal(await githubLoginName(env), 'ana');
});

test('apiGql without a stored token rejects with the instruction, and a non-2xx rejects with the status alone', async (t) => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'gql-') };
  const { doFetch, calls } = fakeFetch(json(OK_BODY));
  await assert.rejects(apiGql({ fetch: doFetch, env })(VIEWER), { message: NO_TOKEN_MESSAGE });
  assert.equal(calls.length, 0, 'no call without a token');
  await writeCredentials({ github: { token: TOKEN, login: 'ana' } }, env);
  assert.deepEqual(await apiGql({ fetch: doFetch, env })(VIEWER), { viewer: { login: 'ana' } });
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`, 'read per call from the store');
  await assert.rejects(bound(fakeFetch(json({ message: TOKEN }, 401)).doFetch)(VIEWER), { message: 'github api: HTTP 401' });
  await assert.rejects(bound(fakeFetch(new Response('<html>', { status: 502 })).doFetch)(VIEWER), { message: 'github api: HTTP 502' });
});

test('the token reaches no rejection, no log line and no error message, on every failure path', async () => {
  const { log, lines } = fakeLog();
  const failures: Promise<unknown>[] = [
    bound(fakeFetch(json({ message: TOKEN }, 401)).doFetch)(VIEWER),
    bound(fakeFetch(json({ errors: [{ message: `bad credentials for ${TOKEN}` }] })).doFetch)(VIEWER),
    bound(fakeFetch(new Response('not json', { status: 200 })).doFetch)(VIEWER),
    loggedGql(bound(fakeFetch(json({ message: TOKEN }, 403)).doFetch), log)(PROJECT_FIELDS, { login: 'acme', number: 6 }),
  ];
  for (const [i, failure] of failures.entries()) {
    const err = await failure.then(() => undefined, (e: Error) => e);
    assert.ok(err, `call ${i} should reject`);
    // the GraphQL message is GitHub's own text: the only path where a token could travel is a body we echo, and we never echo one
    if (i !== 1) assert.ok(!err.message.includes(TOKEN), `call ${i}: ${err.message}`);
  }
  const ok = loggedGql(bound(fakeFetch(json(OK_BODY)).doFetch), log);
  assert.deepEqual(await ok(PROJECT_FIELDS, { login: 'acme', number: 6 }), { viewer: { login: 'ana' } });
  assert.ok(lines.every((l) => !l.includes(TOKEN)), lines.join('\n'));
  assert.ok(lines.every((l) => l.startsWith('DEBUG graphql ')), 'graphql calls are debug only');
  assert.match(lines.at(-1) as string, /^DEBUG graphql \{"login":"acme","number":6\} query.* \d+ms ok$/);
  assert.ok(!(lines.at(-1) as string).includes('ana'), 'the response is never logged');
  assert.ok((lines.at(-2) as string).includes('ms error: github api: HTTP 403'));
});

test('cliGqlJson writes { query, variables } to gh\'s stdin behind --input -, and unwraps data and errors as cliGql does (#592)', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const exec = async (args: string[], input?: string) => {
    calls.push({ args, input });
    return JSON.stringify({ data: { ok: true } });
  };
  const variables = { threads: [{ path: 'a.ts', line: 2, body: 'why -f x=1?' }] };
  assert.deepEqual(await cliGqlJson(exec)('mutation($threads: [T]) { x }', variables), { ok: true });
  assert.deepEqual(calls[0].args, ['api', 'graphql', '--input', '-'], 'no value in the argv');
  assert.deepEqual(JSON.parse(calls[0].input ?? ''), { query: 'mutation($threads: [T]) { x }', variables });
  const refused = { data: null, errors: [{ message: 'Head sha can\'t be blank' }] };
  await assert.rejects(cliGqlJson(async () => JSON.stringify(refused))('mutation { x }', {}), { message: 'Head sha can\'t be blank' });
});

test('cliGql sends a boolean with -F, so gh sends JSON false and not the string "false"; a string "true" stays -f (#849)', async () => {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: {} });
  };
  await cliGql(exec)(VIEWER, { open: false, head: 'true' });
  assert.deepEqual(calls[0].slice(4), ['-F', 'open=false', '-f', 'head=true']);
});
