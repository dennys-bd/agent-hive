import { useState } from 'react';
import { facetOptions, isRuleComplete } from '../../task-filter';
import type { Task, FilterRule } from '../../types';
import { FilterRules } from '@/components/settings/FilterRules';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t, tPlural } from '@/i18n';
import { readStageFilters, rulesFor, type StageFilters, withStageFilter, writeStageFilters } from '@/lib/stage-filters';

// A stage's view filter (#374): the #245 rules, read by the source filter's own matcher over the facets each task carries. It only hides
// tasks on screen: the source's filter in Settings is never read or written here; the rules go to the view state only (#484).

interface StageFiltersHandle { rulesOf(stage: string): FilterRule[]; set(stage: string, rules: FilterRule[]): void }

/** The flow's view filters, seeded from the view state once and written through on every change (#484). A write keeps only `stages`, the Hive's
 * current stage names: a filter saved for a stage that is gone is ignored until then, and dropped by it. */
export function useStageFilters(stages: string[]): StageFiltersHandle {
  const [filters, setFilters] = useState<StageFilters>(() => readStageFilters());
  const set = (stage: string, rules: FilterRule[]): void => {
    const next = withStageFilter(filters, stage, rules, stages);
    setFilters(next);
    writeStageFilters(next);
  };
  return { rulesOf: (stage) => rulesFor(filters, stage), set };
}

interface StageFilterDialogProps { stage: string; tasks: Task[]; rules: FilterRule[]; onApply(rules: FilterRule[]): void; onClose(): void }

/** Filtrar… (#374): the stage's rules in Settings' own filter editor, over a draft. The pickers offer the values the stage's tasks carry,
 * nothing fetched and no @me (the UI knows no polling login). Aplicar keeps the complete rules only, as Settings saves them: a rule with no
 * value would hide every task. Cancelar, Escape and the close button leave the saved rules as they were. */
export function StageFilterDialog({ stage, tasks, rules, onApply, onClose }: StageFilterDialogProps) {
  const [draft, setDraft] = useState(rules);
  const options = facetOptions(tasks.flatMap((c) => (c.item.facets ? [c.item.facets] : [])));
  const apply = (): void => {
    onApply(draft.filter(isRuleComplete));
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t('stage.filterTitle', { stage })}</DialogTitle></DialogHeader>
        <FilterRules rules={draft} options={options} onChange={setDraft} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('settings.cancel')}</Button>
          <Button type="button" onClick={apply}>{t('stage.filterApply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A filtered stage says so (#374), right under its header row, so hidden tasks never look lost: how many its rules hide, and Limpar filtro.
 * Nothing while the stage has no rule. */
export function FilterIndicator({ rules, hidden, onClear }: { rules: FilterRule[]; hidden: number; onClear(): void }) {
  if (rules.length === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
      {tPlural('stage.hidden', hidden, { n: hidden })}
      <Button type="button" size="xs" variant="ghost" onClick={onClear}>{t('stage.clearFilter')}</Button>
    </div>
  );
}
