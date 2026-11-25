import { HostChips } from '@/components/settings/HostChips';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { t } from '@/i18n';
import { withHost } from '@/lib/settings-hosts';

interface TrustedDomainsGroupProps {
  hosts: string[];
  onChange(hosts: string[]): void;
}

// Trusted domain chips (#404, #513): links to these hosts and their subdomains open without asking
export function TrustedDomainsGroup({ hosts, onChange }: TrustedDomainsGroupProps) {
  return (
    <SettingsGroup title="settings.trustedDomains" hint="settings.trustedDomains.hint">
      <HostChips
        hosts={hosts} onChange={onChange} add={withHost} addLabel={t('settings.trustedDomains.add')}
        removeLabel={(host) => t('settings.trustedDomains.remove', { host })} error={(host) => t('settings.error.trustedDomain', { host })}
      />
    </SettingsGroup>
  );
}
