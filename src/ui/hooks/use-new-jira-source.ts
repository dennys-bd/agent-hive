import { useRef, useState } from 'react';
import { getJson } from '@/lib/api';
import { jiraDefaults } from '@/lib/flow-sources';
import {
  EMPTY_JIRA, type JiraDraft, type JiraIssueType, type JiraLinkType, type JiraProject, type JiraReadError,
  jiraColumnsUrl, jiraIssueTypesUrl, jiraLinkTypesUrl, jiraProjectsUrl, jiraReadError,
} from '@/lib/settings-jira';

export interface NewJiraSource {
  jira: JiraDraft; projects: JiraProject[]; isLoading: boolean; error?: JiraReadError;
  isReady: boolean; // a project picked and its defaults read: the row is complete
  pickSite(site: string): void; pickProject(project: JiraProject): void; reset(): void;
}

// The project's statuses and issue types and the site's link types, in parallel (#822): Add waits for all three
async function readDefaults(jira: JiraDraft): Promise<Omit<JiraDraft, 'site' | 'project'>> {
  const [statuses, types, links] = await Promise.all([
    getJson<string[]>(jiraColumnsUrl(jira)), getJson<JiraIssueType[]>(jiraIssueTypesUrl(jira)), getJson<JiraLinkType[]>(jiraLinkTypesUrl(jira.site)),
  ]);
  return jiraDefaults(statuses, types, links);
}

/** The dialog's Jira side (#822): the picked site and project, the site's projects, and the read in flight. A read a newer pick overtook is dropped. */
export function useNewJiraSource(): NewJiraSource {
  const [jira, setJira] = useState<JiraDraft>(EMPTY_JIRA);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<JiraReadError>();
  const [hasDefaults, setHasDefaults] = useState(false);
  const latest = useRef(0);
  // a body of another shape throws inside `done` or `load`, and so reads as failed
  async function run<T>(load: () => Promise<T>, done: (value: T) => void): Promise<void> {
    const n = ++latest.current;
    setLoading(true); setError(undefined);
    try { const value = await load(); if (n === latest.current) done(value); }
    catch (err) { if (n === latest.current) setError(jiraReadError(err)); }
    finally { if (n === latest.current) setLoading(false); }
  }
  const pickSite = (site: string): void => {
    setJira({ ...EMPTY_JIRA, site }); setProjects([]); setHasDefaults(false);
    void run(() => getJson<JiraProject[]>(jiraProjectsUrl(site)), setProjects);
  };
  const pickProject = (project: JiraProject): void => {
    const picked = { ...jira, project: project.key };
    setJira(picked); setHasDefaults(false);
    void run(() => readDefaults(picked), (defaults) => { setJira({ ...picked, ...defaults }); setHasDefaults(true); });
  };
  const reset = (): void => { latest.current += 1; setJira(EMPTY_JIRA); setProjects([]); setLoading(false); setError(undefined); setHasDefaults(false); };
  return { jira, projects, isLoading, error, isReady: hasDefaults && !isLoading && error === undefined, pickSite, pickProject, reset };
}
