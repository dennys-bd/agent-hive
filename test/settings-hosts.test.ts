import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGitlabHost, withHost } from '../src/ui/lib/settings-hosts.js';

test('withHost adds one trimmed, lowercased host, ignores a repeat and refuses what is not a bare host (#513)', () => {
  assert.deepEqual(withHost(['github.com'], ' Docs.Example.com '), ['github.com', 'docs.example.com']);
  assert.deepEqual(withHost(['github.com'], 'GITHUB.com'), ['github.com'], 'a repeat is no change');
  for (const bad of ['https://github.com', 'github.com:443', 'github.com/x', '*.github.com', '']) assert.equal(withHost([], bad), undefined, bad);
  assert.deepEqual(withHost(['a.example.com'], 'B.example.com', ['b.example.com']), ['a.example.com'], 'a dropped name is no change (#1044)');
});

test('withGitlabHost adds a bare host as withHost does, leaves gitlab.com out like a repeat and refuses github.com (#1044, decisions 8, 9)', () => {
  assert.deepEqual(withGitlabHost([], ' Git.Example.com '), ['git.example.com']);
  assert.deepEqual(withGitlabHost(['git.example.com'], 'GITLAB.com'), ['git.example.com'], 'gitlab.com is GitLab already');
  for (const bad of ['github.com', ' GitHub.com ', 'https://git.example.com', 'git.example.com:8443', '']) assert.equal(withGitlabHost([], bad), undefined, bad);
});
