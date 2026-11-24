import { RadioGroup } from 'radix-ui';
import { type ReactNode, useId } from 'react';
import { AGENT_COLOR, AgentIcon } from '@/components/SessionLabel';
import { type AddSlots, ClaudeAccountAdd, FailedLine, GithubLoginAdd, TextButton } from '@/components/settings/AccountAdd';
import { scrollToConnections } from '@/components/settings/ConnectionsGroup';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Spinner } from '@/components/ui/spinner';
import { type Accounts, useAccounts } from '@/hooks/use-accounts';
import { t } from '@/i18n';
import { type AccountRow, accountRows, listOf, shownValue } from '@/lib/settings-accounts';
import type { SettingsDraft } from '@/lib/settings-form';
import { type SettingEntry, settingAnchor } from '@/lib/settings-search';
import { agentName } from '../../../agents';
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountsConfig } from '../../../types';

// Settings › execution › accounts (#964, the handoff): one single choice per provider, saved with the form as accounts. Each group is a Radix
// radio group, so it takes one tab stop and the arrows move between its rows. Claude's and Copilot's headers carry their mark in their own
// colour; GitHub is no agent: no mark. #965: Claude's and GitHub's groups add an account at once, outside the draft; Copilot's group is only a
// choice over GitHub's logins.

type Patch = (patch: Partial<SettingsDraft>) => void;
interface AccountsCardProps { draft: SettingsDraft; saved: AccountsConfig; onChange: Patch; onOpenFlow(): void }
interface GroupProps extends AccountsCardProps { provider: AccountProvider; accounts: Accounts; slots?: AddSlots }

const GH_SETUP_GIT = 'gh auth setup-git'; // the same in both languages' hint: shown in mono
const groupName = (provider: AccountProvider): string => (provider === 'github' ? t('settings.accounts.github') : agentName(provider));

// The selection drives gh; git's pushes follow it only through gh's credential helper. The link lands on fluxo's connections card, as
// FlowSection's change link does
function GithubHint({ onOpenFlow }: { onOpenFlow(): void }) {
  const [before, after = ''] = t('settings.accounts.github.hint').split(GH_SETUP_GIT);
  return (
    <span className="text-muted-foreground text-xs">
      {before}<span className="font-mono">{GH_SETUP_GIT}</span>{after}{' '}
      <button type="button" className="text-review" onClick={() => { onOpenFlow(); scrollToConnections(); }}>{t('settings.accounts.github.connection')}</button>
    </span>
  );
}

function GroupHeader({ provider, nameId, action, onOpenFlow }: { provider: AccountProvider; nameId: string; action?: ReactNode; onOpenFlow(): void }) {
  return (
    <div className="flex min-h-8 items-center gap-3">
      <span className="flex items-center gap-2">
        {provider !== 'github' && <AgentIcon agent={provider} className={`size-4 shrink-0 ${AGENT_COLOR[provider] ?? ''}`} />}
        <span id={nameId} className="font-semibold text-sm">{groupName(provider)}</span>
      </span>
      {provider === 'copilot' && <span className="text-muted-foreground text-xs">{t('settings.accounts.copilot.hint')}</span>}
      {provider === 'github' && <GithubHint onOpenFlow={onOpenFlow} />}
      {action}
    </div>
  );
}

// A radio dot, its name and an optional muted note; selection shows as the dot's fill (shape, not colour), the ring muted-foreground for 3:1.
function Row({ row }: { row: AccountRow }) {
  const id = useId();
  const label = row.value === '' ? (row.login ?? t('settings.accounts.machine')) : row.value;
  const note = row.value === '' && row.login !== undefined ? t('settings.accounts.machine') : undefined;
  return (
    <div className="flex min-h-8 items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <RadioGroup.Item
        id={id} value={row.value} aria-labelledby={`${id}-label`} aria-describedby={[note && `${id}-note`, row.isGone && `${id}-gone`].filter(Boolean).join(' ') || undefined}
        className="flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=checked]:border-primary"
      >
        <RadioGroup.Indicator className="block size-2 rounded-full bg-primary" />
      </RadioGroup.Item>
      <label id={`${id}-label`} htmlFor={id} className="cursor-pointer whitespace-nowrap text-sm">{label}</label>
      {note && <span id={`${id}-note`} className="truncate text-muted-foreground text-xs">{note}</span>}
      {row.isGone && <span id={`${id}-gone`} className="truncate text-destructive text-xs">{t('settings.accounts.gone')}</span>}
    </div>
  );
}

function AccountGroup({ provider, accounts, draft, saved, onChange, onOpenFlow, slots }: GroupProps) {
  const nameId = useId();
  const list = listOf(provider);
  const isFailed = accounts.errors[list];
  const isLoading = !isFailed && accounts[list] === undefined;
  const pick = (value: string): void => onChange({ accounts: { ...draft.accounts, [provider]: value } });
  return (
    <div id={settingAnchor('settings.accounts', provider)} className="flex flex-col gap-3 border-t px-5 py-4 first:border-t-0">
      <GroupHeader provider={provider} nameId={nameId} action={slots?.action} onOpenFlow={onOpenFlow} />
      {isLoading && <p role="status" className="flex items-center gap-1.5 text-muted-foreground text-xs"><Spinner />{t('settings.accounts.loading')}</p>}
      {isFailed && (
        <FailedLine text={t(list === 'claude' ? 'settings.accounts.failed.claude' : 'settings.accounts.failed.github')}>
          <TextButton onClick={accounts.refetch}>{t('settings.accounts.retry')}</TextButton>
        </FailedLine>
      )}
      <RadioGroup.Root aria-labelledby={nameId} value={shownValue(provider, accounts, draft.accounts[provider])} onValueChange={pick} className="-mx-2 flex flex-col gap-0.5">
        {accountRows(provider, accounts, saved[provider]).map((row) => <Row key={row.value} row={row} />)}
      </RadioGroup.Root>
      {slots?.foot}
    </div>
  );
}

export function AccountsCard({ draft, saved, onChange, onOpenFlow }: AccountsCardProps) {
  const accounts = useAccounts();
  // A provider's group, which an add wraps to hand it the header's action and the foot; the order is ACCOUNT_PROVIDERS'
  const group = (provider: AccountProvider) => (slots?: AddSlots): ReactNode => (
    <AccountGroup provider={provider} accounts={accounts} draft={draft} saved={saved} onChange={onChange} onOpenFlow={onOpenFlow} slots={slots} />
  );
  return (
    <SettingsGroup title="settings.accounts" hint="settings.accounts.hint" flush>
      <ClaudeAccountAdd onConnected={accounts.refetch} render={group('claude')} />
      {group('copilot')()}
      <GithubLoginAdd onConnected={accounts.refetch} render={group('github')} />
    </SettingsGroup>
  );
}

/** The card's entries of the Settings search (#964): one per group, landing on it; the agents' by their own name, as the card shows it. */
export function accountsEntries(): SettingEntry[] {
  return ACCOUNT_PROVIDERS.map((provider): SettingEntry => ({
    label: provider === 'github' ? 'settings.accounts.github' : { raw: agentName(provider) },
    path: ['settings.section.execution', 'settings.accounts'], view: { section: 'execution' }, anchor: settingAnchor('settings.accounts', provider),
  }));
}
