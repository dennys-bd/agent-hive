import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { SettingSwitch } from '@/components/settings/SettingSwitch';
import { Progress } from '@/components/ui/progress';
import { t } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { countdown, inBackoff, latestQuota, percent } from '@/lib/usage';
import type { State } from '../../../types';

interface GithubApiGroupProps { draft: SettingsDraft; state?: State; locale: string; onChange(patch: Partial<SettingsDraft>): void }

// Settings › regras' GitHub API card (#512): the freshest quota reading, a bar of what is left (neutral: colour is status), the header switch.
export function GithubApiGroup({ draft, state, locale, onChange }: GithubApiGroupProps) {
  const quota = latestQuota(state?.syncs ?? {});
  const now = Date.now();
  return (
    <SettingsGroup title="settings.group.github">
      {quota
        ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="font-medium text-sm">{t('limits.github.left', { remaining: quota.remaining.toLocaleString(locale), limit: quota.limit.toLocaleString(locale) })}</span>
              <span className="text-muted-foreground text-xs">{t('limits.resets', { time: countdown(quota.resetsAt, now) })}</span>
            </div>
            <Progress aria-label={t('limits.github.bar')} value={percent(quota.remaining, quota.limit)} />
            {inBackoff(quota, now) && <p className="text-destructive text-xs">{t('limits.github.paused')}</p>}
          </>
        )
        : <p className="text-muted-foreground text-xs">{t('limits.github.none')}</p>}
      <p className="text-muted-foreground text-xs">{t('limits.github.hint')}</p>
      <div className="border-t pt-4">
        <SettingSwitch id="settings-show-github-quota" label="settings.showGithubQuota" hint="settings.showGithubQuota.hint" checked={draft.showGithubQuota} onCheckedChange={(showGithubQuota) => onChange({ showGithubQuota })} />
      </div>
    </SettingsGroup>
  );
}
