import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { JIRA_CONNECT_ERRORS, type JiraConnectError, type JiraSiteStatus } from '../../types';
import { t } from '@/i18n';
import { getJson, postJson, sendJson } from '@/lib/api';

const SITES = '/settings/jira/sites';

export interface JiraLogin { site: string; email: string; token: string }
/** connected: the listing was reloaded; a refusal code: shown inline, no toast; failed: the toast was shown. Every one but connected keeps the form open. */
export type JiraConnectOutcome = 'connected' | 'failed' | JiraConnectError;
export interface JiraSites {
  sites: JiraSiteStatus[] | undefined; // undefined until the first answer
  connect(login: JiraLogin): Promise<JiraConnectOutcome>;
  disconnect(site: string): Promise<void>;
}

const isConnectError = (value: unknown): value is JiraConnectError => (JIRA_CONNECT_ERRORS as readonly unknown[]).includes(value);
const failed = (): void => { toast.error(t('settings.connections.jira.failed')); };

// A refusal's code is the 400's body.error (parseJson keeps the body on the error); anything else is no refusal of Jira's
const outcomeOf = (err: unknown): JiraConnectOutcome => {
  const code = (err as { body?: { error?: unknown } } | null)?.body?.error;
  if (isConnectError(code)) return code;
  failed();
  return 'failed';
};

/** GET /settings/jira/sites when the card mounts and after every connect or disconnect (#817). No polling: nothing changes on its own. */
export function useJiraSites(): JiraSites {
  const [sites, setSites] = useState<JiraSiteStatus[]>();
  const latest = useRef(0); // overlapping reloads can answer out of order: only the newest one's answer is shown
  const reload = useCallback(async (): Promise<void> => {
    const n = ++latest.current;
    try {
      const answer = await getJson<unknown>(SITES);
      if (n !== latest.current) return;
      setSites(Array.isArray(answer) ? (answer as JiraSiteStatus[]) : []); // the server's array, else nothing to show
    } catch {
      failed();
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const connect = async (login: JiraLogin): Promise<JiraConnectOutcome> => {
    try {
      await postJson<JiraSiteStatus>(SITES, login);
    } catch (err) {
      return outcomeOf(err);
    }
    await reload();
    return 'connected';
  };
  const disconnect = async (site: string): Promise<void> => {
    try {
      await sendJson<unknown>('DELETE', `${SITES}/${encodeURIComponent(site)}`);
    } catch {
      failed();
    }
    await reload();
  };
  return { sites, connect, disconnect };
}
