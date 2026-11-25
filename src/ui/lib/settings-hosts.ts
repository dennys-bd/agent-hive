// The Settings host chips' rules (#513, #1044), shared by the trusted domains and the GitLab hosts cards: the config parser's own, so a chip
// the form adds is one the save keeps. Pure, so node:test checks it.
import { GITLAB_HOST, hostKind } from '../../repo-host.js';
import { isTrustedHost } from '../../trusted-hosts.js';

/** The chips with `text` added (#513): trimmed and lowercased like the parser, a repeat or a name of `drop` (#1044) left out; undefined when
 * it is not a bare host. */
export function withHost(hosts: readonly string[], text: string, drop: readonly string[] = []): string[] | undefined {
  const host = text.trim().toLowerCase();
  if (!isTrustedHost(host)) return undefined;
  return hosts.includes(host) || drop.includes(host) ? [...hosts] : [...hosts, host];
}

/** The GitLab host chips with `text` added (#1044, decisions 8, 9): withHost's rule with gitlab.com left out like a repeat, since it always is
 * one; github.com is refused, since it is GitHub. */
export const withGitlabHost = (hosts: readonly string[], text: string): string[] | undefined =>
  (hostKind(text.trim(), []) === 'github' ? undefined : withHost(hosts, text, [GITLAB_HOST]));
