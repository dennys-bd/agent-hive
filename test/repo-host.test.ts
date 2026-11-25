import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrLink, hostKind, isPrUrl, type PrLink, parsePrLink, remoteRepository } from '../src/repo-host.js';
import { githubRepository } from '../src/task-refs.js';
import { isPrUrl as orchestratorIsPrUrl } from '../src/orchestrator.js';
import { prLink, prNumber, prRepo } from '../src/pull-requests.js';

const LISTED = ['git.example.com'];

test('hostKind: github.com is GitHub; gitlab.com and an exact listed host are GitLab, in any case; a subdomain, a look-alike or an unlisted host has none (#1044, decision 2)', () => {
  assert.equal(hostKind('github.com', LISTED), 'github');
  assert.equal(hostKind('GitHub.com', []), 'github');
  assert.equal(hostKind('gitlab.com', []), 'gitlab');
  assert.equal(hostKind('Git.Example.com', LISTED), 'gitlab');
  assert.equal(hostKind('git.example.com', []), undefined, 'unlisted');
  for (const host of ['ci.git.example.com', 'evilgitlab.com', 'gitlab.com.evil.io', 'evilgithub.com', 'api.github.com', 'example.com']) assert.equal(hostKind(host, LISTED), undefined, host);
});

test('remoteRepository on github.com answers what githubRepository does, in every remote form (#1044, decisions 3, 4)', () => {
  for (const remote of ['https://github.com/acme/app.git', 'https://github.com/acme/app', 'https://token@github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/app/']) {
    assert.deepEqual(remoteRepository(remote, LISTED), { kind: 'github', host: 'github.com', repository: 'acme/app' }, remote);
    assert.equal(githubRepository(remote), 'acme/app', remote);
  }
  for (const remote of ['https://github.com/acme', 'https://github.com/acme/app/tree/x', 'https://github.com/./app.git', 'https://github.com/acme/..', 'git@github.com:../app.git', 'https://github.com/a/b/c']) {
    assert.equal(remoteRepository(remote, LISTED), undefined, remote);
  }
});

test('remoteRepository on gitlab.com or a listed host answers GitLab and the full path, nested groups included; the host lowercased, the path as written (#1044, decision 3)', () => {
  const cases: [string, string, string][] = [
    ['https://gitlab.com/Acme/App.git', 'gitlab.com', 'Acme/App'],
    ['git@gitlab.com:acme/platform/app.git', 'gitlab.com', 'acme/platform/app'],
    ['ssh://git@Git.Example.com/acme/platform/tools/app.git', 'git.example.com', 'acme/platform/tools/app'],
    ['https://oauth2:placeholder@git.example.com/acme/app/', 'git.example.com', 'acme/app'],
    ['https://git.example.com/acme/app', 'git.example.com', 'acme/app'],
  ];
  for (const [remote, host, repository] of cases) assert.deepEqual(remoteRepository(remote, LISTED), { kind: 'gitlab', host, repository }, remote);
});

test('remoteRepository answers none off a known host, with a port, a query or a fragment, or for a path GitLab cannot hold (#1044, decisions 2, 3)', () => {
  for (const remote of [
    'https://evilgitlab.com/acme/app.git', 'https://gitlab.com.evil.io/acme/app.git', 'https://ci.git.example.com/acme/app.git', 'git@code.example.org:acme/app.git',
    'https://git.example.com:8443/acme/app.git', 'ssh://git@git.example.com:2222/acme/app.git', 'https://gitlab.com/acme/app.git?ref=main', 'https://gitlab.com/acme/app#readme',
    'https://gitlab.com/acme', 'https://gitlab.com/acme/../app', 'https://gitlab.com/acme//app', '', '/srv/git/app.git',
  ]) assert.equal(remoteRepository(remote, LISTED), undefined, remote);
});

test('parsePrLink reads a GitHub PR link and an MR link on any host name, and buildPrLink gives each back (#1044, decision 5)', () => {
  const cases: [string, PrLink][] = [
    ['https://github.com/acme/app/pull/12', { host: 'github.com', repository: 'acme/app', number: 12 }],
    ['https://gitlab.com/acme/platform/app/-/merge_requests/7', { host: 'gitlab.com', repository: 'acme/platform/app', number: 7 }],
    ['https://code.example.org/acme/app/-/merge_requests/301', { host: 'code.example.org', repository: 'acme/app', number: 301 }],
  ];
  for (const [url, parts] of cases) {
    assert.deepEqual(parsePrLink(url), parts, url);
    assert.equal(buildPrLink(parts), url, url);
  }
});

test('parsePrLink refuses a query, a fragment, a trailing slash or path, a port, userinfo, a one-segment path, an MR path on github.com and a leading zero (#1044, decision 5)', () => {
  for (const url of [
    'https://github.com/acme/app/pull/12?x=1', 'https://github.com/acme/app/pull/12#top', 'https://github.com/acme/app/pull/12/', 'https://github.com/acme/app/pull/12/files',
    'https://gitlab.com/acme/app/-/merge_requests/7?x=1', 'https://gitlab.com/acme/app/-/merge_requests/7#note_1', 'https://gitlab.com/acme/app/-/merge_requests/7/', 'https://gitlab.com/acme/app/-/merge_requests/7/diffs',
    'https://git.example.com:8443/acme/app/-/merge_requests/7', 'https://user@git.example.com/acme/app/-/merge_requests/7', 'http://gitlab.com/acme/app/-/merge_requests/7',
    'https://gitlab.com/app/-/merge_requests/7', 'https://github.com/acme/app/-/merge_requests/7', 'https://gitlab.com/acme/app/pull/7', 'https://github.com/acme/app/pull/007', '',
  ]) assert.equal(parsePrLink(url), undefined, url);
});

test('isPrUrl takes a GitHub PR link as before and an MR link on any host name, listed or not (#1044, decision 6)', () => {
  assert.equal(isPrUrl('https://github.com/acme/app/pull/12'), true);
  assert.equal(isPrUrl('https://code.example.org/acme/app/-/merge_requests/3'), true, "no list: the host check is the callers'");
  assert.equal(isPrUrl('https://github.com/acme/app/issues/12'), false);
});

test("the GitHub helpers read the module: githubRepository takes a host in any case, the orchestrator's isPrUrl is the module's, prNumber and prRepo read an MR link (#1044, decisions 4, 6, 7)", () => {
  assert.equal(githubRepository('git@GitHub.com:acme/app.git'), 'acme/app', 'the host lowercased (decision 3)');
  assert.equal(githubRepository('https://gitlab.com/acme/app.git'), undefined);
  assert.equal(orchestratorIsPrUrl, isPrUrl);
  const mr = 'https://git.example.com/acme/platform/app/-/merge_requests/7';
  assert.deepEqual([prNumber(mr), prRepo(mr)], ['7', 'acme/platform/app']);
  assert.deepEqual([prNumber('https://github.com/o/r/pull/42/files'), prRepo('https://github.com/o/r/pull/42')], ['42', 'o/r'], 'a GitHub link reads as before');
  assert.equal(prLink('o/r', 42), 'https://github.com/o/r/pull/42');
});
