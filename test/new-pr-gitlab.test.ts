import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';
import { NO_BUILT_INS, parseTemplate, renderTemplate } from '../src/template.js';
import type { BuiltIns } from '../src/template.js';

// #1051: /hive:new-pr opens a merge request with glab on a checkout whose origin is on GitLab
const skillText = (): Promise<string> => readFile(join(pluginSource(), 'skills', 'new-pr', 'SKILL.md.liquid'), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');
function rendered(text: string, builtIns: BuiltIns = NO_BUILT_INS): string {
  const result = renderTemplate(parseTemplate(text), { name: 'a', variables: {}, builtIns });
  if (!result.ok) return assert.fail(`${result.errors[0]?.line}: ${result.errors[0]?.message}`);
  return flat(result.text);
}
const LISTED: BuiltIns = { ...NO_BUILT_INS, gitlabHosts: ['gitlab.com', 'git.example.com'] };
const FORK: BuiltIns = { ...NO_BUILT_INS, fork: { remote: 'upstream', pr: 'original', baseRemote: 'upstream' } };
// The GitLab section's own text: what a GitHub step never reads
const gitlabSection = (text: string): string => text.slice(text.indexOf('## On GitLab'), text.indexOf('## Stops'));
const githubPart = (text: string): string => text.replace(gitlabSection(text), '');

test('each checkout tells its host from its own origin: gitlab.com alone without gitlabHosts, the listed hosts after it with them (#1051)', async () => {
  const text = await skillText();
  const plain = rendered(text);
  assert.ok(plain.includes('one of `gitlab.com`, its repository'), 'gitlab.com alone');
  assert.ok(!plain.includes('git.example.com'));
  assert.ok(rendered(text, LISTED).includes('one of `gitlab.com`, `git.example.com`, its repository'), 'the listed host after gitlab.com');
  assert.ok(plain.includes('Each checkout (this worktree and every nested repo) has its own host'), 'docs on GitHub and code on GitLab open a PR and an MR');
});

test('a GitLab checkout runs glab only: its checks first, the open MR looked up, the create from a body file, the refresh, the view (#1051)', async () => {
  const section = gitlabSection(rendered(await skillText()));
  for (const part of ['`glab --version`', '`glab auth status --hostname <host>`', '`--description-file`',
    'glab mr list -R <project URL> --source-branch <head> --output json',
    "glab mr create -R <project URL> --title '<title>' --target-branch <base> --source-branch <head> --description-file \"$body\" --yes",
    'glab mr view <iid> -R <project URL> --output json', 'glab mr update <iid> -R <project URL> --description-file "$body"', 'glab ci status -R <project URL> --branch <head>']) assert.ok(section.includes(part), part);
  assert.doesNotMatch(section, /\bgh (?:pr|auth|--version)/, 'no gh call for a GitLab checkout');
  assert.doesNotMatch(section, /--description [^f]|-d /, 'the body never rides argv');
});

test('the MR template, the link check, the walkthrough link and the body limit are GitLab\'s (#1051)', async () => {
  const section = gitlabSection(rendered(await skillText()));
  for (const part of ['the template CONTRIBUTING.md names or embeds', '`.gitlab/merge_request_templates/Default.md`', 'the first file of `.gitlab/merge_request_templates/` by name',
    '`https://<host>/<project>/-/merge_requests/<iid>`', 'before it is reported', '`https://<host>/<project>/-/blob/<head>/<path>`', '1,048,576']) assert.ok(section.includes(part), part);
});

test('a fork whose remotes are on GitLab stops before any gh, glab or push; a plain workspace renders no such stop (#1051)', async () => {
  const text = await skillText();
  const fork = rendered(text, FORK);
  assert.ok(fork.includes('a fork on GitLab is not supported'), 'the stop\'s message');
  assert.ok(fork.indexOf('a fork on GitLab is not supported') < fork.indexOf('## Phase 2'), 'before any command of Phase 2');
  assert.ok(!rendered(text).includes('a fork on GitLab is not supported'));
});

test('the GitHub path reads as before: its commands, link check and limit unchanged, gh checked only when a checkout is on GitHub (#1051)', async () => {
  const github = githubPart(rendered(await skillText()));
  for (const part of ['gh pr create --title \'<title>\' --base <base> --head <branch> --body-file "$body"', '^https://github\\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+$',
    'https://github.com/<owner/name>/blob/<head>/<path>', "GitHub's 65,536 characters", '.github/PULL_REQUEST_TEMPLATE/', '`gh --version` and `gh auth status` when a checkout is on GitHub']) assert.ok(github.includes(part), part);
  assert.doesNotMatch(github, /\bglab mr\b/, 'no glab command outside the GitLab section');
});
