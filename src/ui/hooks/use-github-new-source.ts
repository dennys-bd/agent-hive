import { useState } from 'react';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';
import { projectsUrl } from '@/lib/settings-form';
import type { GithubAuth, ProjectSummary } from '../../types';

export const DEFAULT_OWNER = '@me';

/** The GitHub half of the new-source dialog (#514): the owner, the projects it lists, the picked number, and the one error line the dialog shares with the Jira half. */
export function useGithubNewSource(auth: GithubAuth) {
  const [owner, setOwner] = useState(DEFAULT_OWNER);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [number, setNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function load(): Promise<void> {
    const url = projectsUrl(auth, { owner });
    if (!url) return;
    setLoading(true);
    setError(undefined);
    try {
      const list = await getJson<ProjectSummary[]>(url);
      setProjects(list);
      if (list.length === 0) setError(t('settings.error.noProjects', { owner }));
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }

  function reset(): void { setOwner(DEFAULT_OWNER); setProjects([]); setNumber(''); setError(undefined); }

  return { owner, setOwner, projects, number, setNumber, loading, error, setError, load, reset };
}
