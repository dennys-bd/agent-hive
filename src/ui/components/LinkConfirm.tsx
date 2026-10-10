import { useState } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
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

/** The Hive's own prompt for a terminal link to an untrusted host (#404), in place of the browser's confirm(): open it once, trust its
 * host for good (POST /trusted-domains, then open), or cancel. Open while `url` is set; every way out calls onClose. A failed trust keeps
 * the dialog open with the route's error and opens nothing. Always trust is offered only for a host the route accepts (not an IPv6 literal). */
export function LinkConfirm({ url, onClose }: LinkConfirmProps) {
  const [error, setError] = useState<string>();
  const [trusting, setTrusting] = useState(false);
  const host = url === undefined ? '' : (webHost(url) ?? '');
  const close = (): void => {
    setError(undefined);
    onClose();
  };
  async function trust(): Promise<void> {
    setTrusting(true);
    try {
      await trustHost(host);
      window.open(url);
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTrusting(false);
    }
  }
  return (
    <AlertDialog open={url !== undefined} onOpenChange={(open) => { if (!open) close(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('link.confirm.title')}</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{url !== undefined && <UrlText url={url} host={host} />}</AlertDialogDescription>
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('link.confirm.cancel')}</AlertDialogCancel>
          {isTrustedHost(host) && <Button variant="outline" disabled={trusting} onClick={() => void trust()}>{t('link.confirm.trust', { host })}</Button>}
          <AlertDialogAction onClick={() => window.open(url)}>{t('link.confirm.open')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
