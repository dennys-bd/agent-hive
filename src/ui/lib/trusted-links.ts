// The terminals' links (#404), shared by the main window's panel tabs (PtyTab.tsx) and the terminal window (terminal.ts): the page's trusted
// domains and the xterm link handler built on them. A trusted http(s) link opens at once, another http(s) link asks through LinkConfirm, and
// any other scheme never opens: xterm's allowNonHttpProtocols stays false, and activate checks the scheme itself too.
import type { ILinkHandler } from '@xterm/xterm';
import { hostIsTrusted } from '../../trusted-hosts.js';
import { postJson } from './api.js';

const WEB_PROTOCOLS: readonly string[] = ['http:', 'https:'];

let trusted: readonly string[] = []; // empty until the page reads GET /settings: every link asks meanwhile
const trustListeners = new Set<() => void>();

/** The saved list, as GET /settings answered it. */
export function setTrustedDomains(list: readonly string[]): void {
  trusted = list;
}

/** An http(s) URL's host, lowercased by URL and without its port; undefined for another scheme or a text that is no URL. */
export function webHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return WEB_PROTOCOLS.includes(parsed.protocol) ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `url` opens without asking: http(s), and its host is an entry or a subdomain of one. */
export function isTrustedUrl(url: string): boolean {
  const host = webHost(url);
  return host !== undefined && hostIsTrusted(host, trusted);
}

/** The dialog's "always trust": POST /trusted-domains, then the host joins this page's list and the listeners hear it. Rejects with the
 * route's error, the list unchanged. */
export async function trustHost(host: string): Promise<void> {
  await postJson<{ ok: true }>('/trusted-domains', { host });
  if (!trusted.includes(host)) trusted = [...trusted, host];
  for (const listener of trustListeners) listener();
}

/** Called after every trust this page makes: App reloads GET /settings, so the next Settings form drafts the list with the new host. Returns
 * the unsubscribe. */
export function onTrust(listener: () => void): () => void {
  trustListeners.add(listener);
  return () => {
    trustListeners.delete(listener);
  };
}

/** Opens `url` the way a terminal's link does (#404): a trusted http(s) host at once, another http(s) one through `ask` (LinkConfirm), any
 * other scheme never. A task reference's GitHub issue takes the same path (#588). */
export function openLink(url: string, ask: (url: string) => void): void {
  if (webHost(url) === undefined) return;
  if (isTrustedUrl(url)) window.open(url);
  else ask(url);
}

/** The xterm link handler: `ask` gets an untrusted http(s) URL, for the page to show LinkConfirm. The OSC 8 links claude prints reach it;
 * the Hive loads no WebLinksAddon, so a bare URL in the output is no link. */
export function linkHandler(ask: (url: string) => void): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate(_event, url) {
      openLink(url, ask);
    },
  };
}
