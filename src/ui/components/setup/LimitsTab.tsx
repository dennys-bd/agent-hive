import { RulesEditor } from '@/components/setup/RulesEditor';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/i18n';
import { fmt, usageTotals } from '@/lib/usage';
import type { SetupDraft } from '@/lib/setup-form';
import type { State } from '../../../types';

interface LimitsTabProps { draft: SetupDraft; state?: State; onChange(patch: Partial<SetupDraft>): void }

export function LimitsTab({ draft, state, onChange }: LimitsTabProps) {
  const totals = state ? usageTotals(state.usage, Date.now()) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="setup-budget-hour">{t('setup.budgetHour')}</Label>
          <Input id="setup-budget-hour" type="number" min={0} step={1} defaultValue={draft.budgetHour} onChange={(e) => onChange({ budgetHour: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="setup-budget-day">{t('setup.budgetDay')}</Label>
          <Input id="setup-budget-day" type="number" min={0} step={1} defaultValue={draft.budgetDay} onChange={(e) => onChange({ budgetDay: e.target.value })} />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t('setup.budgetHint')}</p>
      {totals && <p className="text-muted-foreground text-xs">{t('usage.raw', { hour: fmt(totals.hour), day: fmt(totals.day) })}</p>}
      <RulesEditor rules={draft.rules} onChange={(rules) => onChange({ rules })} />
      <p className="text-muted-foreground text-xs">{t('setup.rulesHint')}</p>
    </div>
  );
}
