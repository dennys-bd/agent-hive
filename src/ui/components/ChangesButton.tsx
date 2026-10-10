import { GitCompareArrowsIcon } from 'lucide-react';
import { useOpenChanges } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { type Activity, activityKey } from '@/lib/activities';
import type { TabGroup } from '@/lib/center-layout';

interface ChangesButtonProps { activity: Activity; group: TabGroup }

/** abrir alterações (#668): the shown file's changes pane, from the group's strip, right before dividir ⌄; only while the group shows a file
 * tab. The group's pointer down focuses it first, so the changes tab opens in this group. */
export function ChangesButton({ activity, group }: ChangesButtonProps) {
  const openChanges = useOpenChanges(activityKey(activity));
  const shown = group.tabs[group.active];
  if (shown?.kind !== 'file' || openChanges === undefined) return null;
  return (
    <Button type="button" size="icon-xs" variant="ghost" aria-label={t('changes.open')} title={t('changes.open')} onClick={() => openChanges(shown.path)}>
      <GitCompareArrowsIcon />
    </Button>
  );
}
