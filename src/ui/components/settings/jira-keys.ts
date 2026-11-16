import type { MessageKey } from '@/i18n';
import type { JiraConnectError, JiraSiteStatus } from '../../../types';

// Each entry is a MessageKey, so tsc refuses a missing code or a missing key (#817)
export const REFUSAL_KEY: Record<JiraConnectError, MessageKey> = {
  'invalid-site': 'settings.connections.jira.error.invalid-site',
  refused: 'settings.connections.jira.error.refused',
  unreachable: 'settings.connections.jira.error.unreachable',
};

/** A refused reconnect says the old login stays (the server keeps it). */
export const REFUSAL_RECONNECT_KEY: Record<JiraConnectError, MessageKey> = {
  ...REFUSAL_KEY,
  refused: 'settings.connections.jira.error.refusedReconnect',
  unreachable: 'settings.connections.jira.error.unreachableReconnect',
};

export const STATE_KEY: Record<JiraSiteStatus['state'], MessageKey> = {
  connected: 'settings.connections.jira.connected',
  refused: 'settings.connections.jira.refused',
  unreachable: 'settings.connections.jira.unreachable',
};

export const JIRA_FORM_KEYS = {
  site: 'settings.connections.jira.site', email: 'settings.connections.jira.email', token: 'settings.connections.jira.token',
  tokenLink: 'settings.connections.jira.tokenLink', submit: 'settings.connections.jira.connect', cancel: 'settings.cancel',
  reconnect: 'settings.auth.reconnect', disconnect: 'settings.connections.jira.disconnect',
} satisfies Record<string, MessageKey>;
