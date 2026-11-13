import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { WorkspaceRemoval } from '@/components/settings/WorkspaceRemoval';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';
import type { WorkspaceHoldings } from '../../../types';

interface WorkspaceRemoveButtonProps { name: string; label: string; isSaved: boolean; isDisabled: boolean; onRemove(): void }

const holdsNothing = (h: WorkspaceHoldings): boolean => !h.running && [h.activities, h.worktrees, h.branches, h.tasks].every((list) => list.length === 0);

/** The × of a workspace card (#751). An unsaved row leaves the form at once; a saved one first reads what it still holds, and anything held opens
 * the removal dialog, already filled. A failed read is a toast in the UI's own words, never the server's, and the × works again. */
export function WorkspaceRemoveButton({ name, label, isSaved, isDisabled, onRemove }: WorkspaceRemoveButtonProps) {
  const [isReading, setIsReading] = useState(false);
  const [holdings, setHoldings] = useState<WorkspaceHoldings>();
  const read = (): void => {
    setIsReading(true);
    getJson<WorkspaceHoldings>(`/workspaces/${encodeURIComponent(name)}/holdings`)
      .then((answer) => { if (holdsNothing(answer)) onRemove(); else setHoldings(answer); })
      .catch(() => toast.error(t('settings.workspaces.removal.readFailed', { name }), { description: t('settings.workspaces.removal.readFailed.hint') }))
      .finally(() => setIsReading(false));
  };
  return (
    <>
      <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} disabled={isDisabled || isReading} aria-busy={isReading || undefined} onClick={isSaved ? read : onRemove}>
        {isReading ? <Spinner /> : <XIcon />}
      </Button>
      {holdings && (
        <WorkspaceRemoval name={name} holdings={holdings} open onOpenChange={(open) => { if (!open) setHoldings(undefined); }} onRemove={onRemove} />
      )}
    </>
  );
}
