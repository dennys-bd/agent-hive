// Settings › execution › accounts (#964): the draft's account per provider and what the form sends. Out of settings-form.ts, which is near
// 400 lines; the card's rows join it, pure so node:test checks them.
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountsConfig } from '../../types.js';

/** One name per provider; '' = the machine's login, which the config writes as a member left out (#952): no sentinel name reaches hive.config.json. */
export type AccountsDraft = Record<AccountProvider, string>;

export const accountsDraft = (saved: AccountsConfig | undefined): AccountsDraft =>
  Object.fromEntries(ACCOUNT_PROVIDERS.map((provider) => [provider, saved?.[provider] ?? ''])) as AccountsDraft;

/** What the form sends: only the providers on a stored account. */
export const accountsFrom = (draft: AccountsDraft): AccountsConfig =>
  Object.fromEntries(ACCOUNT_PROVIDERS.flatMap((provider) => (draft[provider] === '' ? [] : [[provider, draft[provider]]]))) as AccountsConfig;
