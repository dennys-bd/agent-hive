import type { GitlabAnswer, GitlabApi } from '../src/gitlab/api.js';

export interface GitlabCall { method: string; path: string; body?: unknown }

/** A GitlabApi holding no token (#1053): `${method} ${path}` answers its value as the body, an Error value is thrown, any other call throws;
 * every call is recorded. The callers' tests use it; test/gitlab/merge-requests.test.ts goes through the real client. */
export function fakeGitlabApi(answers: Record<string, unknown>): { api: GitlabApi; calls: GitlabCall[] } {
  const calls: GitlabCall[] = [];
  const answer = async (method: string, path: string, body?: unknown): Promise<GitlabAnswer> => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const key = `${method} ${path}`;
    if (!Object.hasOwn(answers, key)) throw new Error(`no answer for ${key}`);
    const value = answers[key];
    if (value instanceof Error) throw value;
    return { body: value };
  };
  const api: GitlabApi = {
    get: (path) => answer('GET', path),
    post: (path, body) => answer('POST', path, body),
    put: (path, body) => answer('PUT', path, body),
    delete: (path) => answer('DELETE', path),
    graphql: async () => { throw new Error('no graphql'); },
  };
  return { api, calls };
}
