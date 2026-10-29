import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { listOf } from '@/lib/settings-languages';

/** The screen's row: a 96px label, the fields, a 118px state column. */
export const ROW_GRID = '-mx-2.5 grid grid-cols-[96px_minmax(0,1fr)_118px] items-start gap-3.5 rounded-md border-border/60 border-t px-2.5 py-2 text-[13px] [h3+&]:border-t-0';

interface RowGroupProps {
  label: string; hint?: string; isArm: boolean; isLocked: boolean; isOverridden: boolean;
  overriddenBy: readonly string[]; // base mode: the letters of the arms that override the row
  was?: ReactNode; onReset(): void; children: ReactNode;
}

/** One row of the settings (#462, #536): its fields, and in arm mode `igual à base` or `voltar à base`; in the base, the arms that override it.
 * The fields sit in a fieldset of their own, so a read-only dialog keeps its other buttons (ver em config, chevrons) working. */
export function RowGroup({ label, hint, isArm, isLocked, isOverridden, overriddenBy, was, onReset, children }: RowGroupProps) {
  const reset = (
    <Button type="button" size="sm" variant="link" className="h-auto p-0 text-[13px]" aria-label={t('benchmark.arms.settings.resetRow', { row: label })} onClick={onReset}>
      {t('benchmark.arms.settings.reset')}
    </Button>
  );
  const state = isArm
    ? (isOverridden ? (isLocked ? null : reset) : <span className="text-muted-foreground">{t('benchmark.arms.settings.same')}</span>)
    : overriddenBy.length > 0 && (
      <span className="text-muted-foreground">
        {t(overriddenBy.length === 1 ? 'benchmark.arms.settings.overriddenBy.one' : 'benchmark.arms.settings.overriddenBy.other', { arms: listOf(overriddenBy, t('settings.formatters.and')) })}
      </span>
    );
  return (
    <section aria-label={label} className={`${ROW_GRID} ${isArm && isOverridden ? 'bg-accent' : ''}`}>
      <div className="pt-1 text-[13px]">
        {label}
        {hint !== undefined && <small className="block text-muted-foreground text-xs">{hint}</small>}
      </div>
      <fieldset disabled={isLocked} className="contents [&_:disabled]:border-transparent">
        <div className="flex min-w-0 flex-col gap-2">
          {children}
          {was !== undefined && <span className="text-muted-foreground text-xs">{was}</span>}
        </div>
      </fieldset>
      <div className="pt-1 text-xs">{state}</div>
    </section>
  );
}

/** The screen's sg-h: a group's heading with its muted hint. */
export function GroupHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <h3 className="m-0 flex items-baseline gap-2.5 border-b pt-[18px] pb-1.5 font-medium text-muted-foreground text-xs">
      {title}
      {hint !== undefined && <span className="font-normal">{hint}</span>}
    </h3>
  );
}
