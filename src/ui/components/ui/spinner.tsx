import { Loader2Icon } from 'lucide-react';

/** The mark of anything still in progress (#48): the toast's circling arc, so a running check reads as loading, not as a result beside the ✓
 * marks. It takes the tone of its parent; under reduced motion the arc stands still and still is not a dot. */
export function Spinner() {
  return <Loader2Icon aria-hidden="true" data-testid="spinner" className="inline-block size-3 align-[-0.125em] animate-spin motion-reduce:animate-none" />;
}
