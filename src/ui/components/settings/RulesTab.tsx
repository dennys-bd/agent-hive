import { GithubApiGroup } from '@/components/settings/GithubApiGroup';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { SignalCard } from '@/components/settings/SignalCard';
import { SignalRulesGroup } from '@/components/settings/SignalRulesGroup';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { fmt, usageTotals } from '@/lib/usage';
import type { State } from '../../../types';

interface RulesTabProps { draft: SettingsDraft; state?: State; locale: string; onChange(patch: Partial<SettingsDraft>): void }

// Settings › regras' budget card (#512): per hour, per day, and the current usage read from the state.
function BudgetGroup({ draft, state, onChange }: Pick<RulesTabProps, 'draft' | 'state' | 'onChange'>) {
  const totals = state ? usageTotals(state.usage, Date.now()) : undefined;
  return (
    <SettingsGroup title="settings.group.budget">
      <div className="grid grid-cols-3 items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="settings-budget-hour">{t('settings.budgetHour')}</Label>
          <Input id="settings-budget-hour" type="number" min={0} step={1} placeholder={t('settings.budget.none')} defaultValue={draft.budgetHour} onChange={(e) => onChange({ budgetHour: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="settings-budget-day">{t('settings.budgetDay')}</Label>
          <Input id="settings-budget-day" type="number" min={0} step={1} placeholder={t('settings.budget.none')} defaultValue={draft.budgetDay} onChange={(e) => onChange({ budgetDay: e.target.value })} />
        </div>
        {totals && <p className="pb-2.5 text-muted-foreground text-xs">{t('usage.raw', { hour: fmt(totals.hour), day: fmt(totals.day) })}</p>}
      </div>
      <p className="text-muted-foreground text-xs">{t('settings.budgetHint')}</p>
    </SettingsGroup>
  );
}

export function RulesTab({ draft, state, locale, onChange }: RulesTabProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <BudgetGroup draft={draft} state={state} onChange={onChange} />
        <GithubApiGroup draft={draft} state={state} locale={locale} onChange={onChange} />
      </div>
      <SignalCard signals={draft.signals} onChange={(signals) => onChange({ signals })} />
      <SignalRulesGroup draft={draft} state={state} onChange={onChange} />
    </>
  );
}
