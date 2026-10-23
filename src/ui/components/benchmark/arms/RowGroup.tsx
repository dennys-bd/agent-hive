import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

interface RowGroupProps { label: string; isArm: boolean; isOverridden: boolean; onReset(): void; children: ReactNode }

/** One row of the settings (#462): its fields, and in arm mode `igual à base` or `voltar à base`. In base mode every row is plain. */
export function RowGroup({ label, isArm, isOverridden, onReset, children }: RowGroupProps) {
  const state = isOverridden
    ? <Button type="button" size="sm" variant="ghost" aria-label={t('benchmark.arms.settings.resetRow', { row: label })} onClick={onReset}>{t('benchmark.arms.settings.reset')}</Button>
    : <span className="text-muted-foreground text-xs">{t('benchmark.arms.settings.same')}</span>;
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="font-medium text-[13px]">{label}</h3>
        {isArm && state}
      </div>
      {children}
    </section>
  );
}
