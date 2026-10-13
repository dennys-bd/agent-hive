import { useState } from 'react';
import { Confirm } from '@/components/Confirm';
import { t } from '@/i18n';
import { trustHost, webHost } from '@/lib/trusted-links';
import { isTrustedHost } from '../../trusted-hosts';

interface LinkConfirmProps { url: string | undefined; onClose(): void }

// The URL as the terminal printed it, with its host in bold. A host the URL writes differently from URL's hostname (an IDN, which URL turns
// into punycode) is not found, and the URL shows plain.
function UrlText({ url, host }: { url: string; host: string }) {
  const at = host === '' ? -1 : url.toLowerCase().indexOf(host);
  if (at < 0) return <>{url}</>;
  return <>{url.slice(0, at)}<strong className="text-foreground">{url.slice(at, at + host.length)}</strong>{url.slice(at + host.length)}</>;
}

/** The Hive's own prompt for a terminal link to an untrusted host (#404), in place of the browser's confirm(), on Confirm (#75): open it once
 * (Enter), trust its host for good (⌘/Ctrl+Enter: POST /trusted-domains, then open), or cancel. Open while `url` is set; every way out calls
 * onClose. A failed trust rejects, so the dialog stays open with the route's error and opens nothing. Always trust is offered only for a host
 * the route accepts (not an IPv6 literal). */
export function LinkConfirm({ url, onClose }: LinkConfirmProps) {
  const [error, setError] = useState<string>();
  const host = url === undefined ? '' : (webHost(url) ?? '');
  const close = (): void => {
    setError(undefined);
    onClose();
  };
  async function trust(): Promise<void> {
    try {
      await trustHost(host);
      window.open(url);
    } catch (err) {
      setError((err as Error).message);
      throw err; // keeps the dialog open (DialogBase)
    }
  }
  return (
    <Confirm
      open={url !== undefined} onOpenChange={(isOpen) => { if (!isOpen) close(); }}
      title={t('link.confirm.title')} message={<span className="break-all">{url !== undefined && <UrlText url={url} host={host} />}</span>}
      confirmLabel={t('link.confirm.open')} onConfirm={() => { window.open(url); }}
      secondary={isTrustedHost(host) ? { label: t('link.confirm.trust', { host }), onConfirm: trust } : undefined}
      error={error}
    />
  );
}
