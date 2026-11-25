import { HostChips } from '@/components/settings/HostChips';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { t } from '@/i18n';
import { withGitlabHost } from '@/lib/settings-hosts';

interface GitlabHostsGroupProps {
  hosts: string[];
  onChange(hosts: string[]): void;
}

/** The self-hosted GitLab hosts (#1044, decision 10), right under the connections, whatever the sources: a repository on one of them, or on
 * gitlab.com, is GitLab's. gitlab.com itself is never a chip, since it always is one. */
export function GitlabHostsGroup({ hosts, onChange }: GitlabHostsGroupProps) {
  return (
    <SettingsGroup title="settings.gitlabHosts" hint="settings.gitlabHosts.hint">
      <HostChips
        hosts={hosts} onChange={onChange} add={withGitlabHost} addLabel={t('settings.gitlabHosts.add')}
        removeLabel={(host) => t('settings.gitlabHosts.remove', { host })} error={(host) => t('settings.error.gitlabHost', { host })}
      />
    </SettingsGroup>
  );
}
