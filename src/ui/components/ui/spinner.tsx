import { Loader2Icon } from 'lucide-react';
import { t } from '@/i18n';

/** The mark of anything still in progress (#48): the toast's circling arc, so a running check reads as loading, not as a result beside the ✓
 * marks. It takes the tone of its parent; under reduced motion the arc stands still and still is not a dot. */
export function Spinner() {
  return <Loader2Icon aria-hidden="true" data-testid="spinner" className="inline-block size-3 align-[-0.125em] animate-spin motion-reduce:animate-none" />;
}

/** A view of a repository the read model never synced (#182): the spinner, named for a screen reader, in the hint tone. Syncing is no
 * status, so it takes no status colour; it stands where a 0 or an empty list would read as "no issues". */
export function Syncing() {
  const label = t('repos.syncing');
  return <span role="status" aria-label={label} title={label} className="text-muted-foreground"><Spinner /></span>;
}
