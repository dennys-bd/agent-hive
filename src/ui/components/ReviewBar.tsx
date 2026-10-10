import type { ReactNode } from 'react';
import type { FileDiff } from '../../types';
import { CountsText } from '@/components/DiffFile';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t, tPlural } from '@/i18n';
import { countsOf, type DiffLayout } from '@/lib/diff-rows';

/** What both panes' bars share beyond their left part (#592). */
export interface ReviewBarState {
  layout: DiffLayout; reviewed: number; hideReviewed: boolean; onLayout(layout: DiffLayout): void; onRefresh(): void; onHideReviewed(hide: boolean): void;
}
interface ReviewBarProps extends ReviewBarState { label: string; left: ReactNode; files?: FileDiff[]; notice?: ReactNode }

/** A review pane's bar (#591, #592): 40px, 12px muted; the pane's own left part, then the totals, the progress, a notice, unified | side by
 * side, ocultar revisados and atualizar (#270). */
export function ReviewBar({ label, left, files, notice, layout, reviewed, hideReviewed, onLayout, onRefresh, onHideReviewed }: ReviewBarProps) {
  return (
    <div role="toolbar" aria-label={label} className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-muted-foreground text-xs">
      {left}
      {files && <span>{tPlural('diff.files', files.length, { n: files.length })} · <CountsText counts={countsOf(files.flatMap((f) => f.hunks))} /></span>}
      {files && (
        <span className="flex items-center gap-1.5">
          <Progress value={files.length === 0 ? 0 : (reviewed / files.length) * 100} className="h-1 w-20 bg-muted" indicatorClassName="bg-foreground" />
          {t('diff.reviewedCount', { n: reviewed, m: files.length })}
        </span>
      )}
      {notice}
      <ToggleGroup type="single" size="xs" aria-label={t('diff.layout')} value={layout} onValueChange={(next) => { if (next === 'unified' || next === 'split') onLayout(next); }}>
        <ToggleGroupItem value="unified">{t('diff.unified')}</ToggleGroupItem>
        <ToggleGroupItem value="split">{t('diff.split')}</ToggleGroupItem>
      </ToggleGroup>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={hideReviewed} onChange={(e) => onHideReviewed(e.target.checked)} />
        {t('diff.hideReviewed')}
      </label>
      <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={onRefresh}>{t('diff.refresh')}</Button>
    </div>
  );
}
