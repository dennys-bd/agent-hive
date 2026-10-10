// The trusted link domains' two rules (#404), shared by the config parser, POST /trusted-domains, the settings form and the terminals' link
// handler. No Node import: the UI bundles it.

const HOST_MAX = 253; // a DNS name's own limit; it also bounds the regex on a request body
// Labels of letters, digits and '-', never starting or ending with '-', joined by dots. No scheme, port, path or wildcard, since the match
// below works on a link's host alone, and a subdomain is already covered by it.
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Whether `host`, already trimmed and lowercased by the caller, is one host name a trusted list may hold. */
export function isTrustedHost(host: string): boolean {
  return host.length <= HOST_MAX && HOST.test(host);
}

/** Whether a link's host (port already dropped) is trusted by `list`: an entry itself, or a subdomain of one. The leading dot keeps
 * evilgithub.com from matching github.com. */
export function hostIsTrusted(host: string, list: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return list.some((entry) => lower === entry || lower.endsWith(`.${entry}`));
}
