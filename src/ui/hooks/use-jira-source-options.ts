import { useCallback, useRef, useState } from 'react';
import { getJson } from '@/lib/api';
import type { SourceDraft } from '@/lib/settings-form';
import {
  type JiraIssueType, type JiraLinkType, type JiraProject, type JiraReadError,
  isJiraChosen, jiraIssueTypesUrl, jiraLinkTypesUrl, jiraProjectsUrl, jiraReadError,
} from '@/lib/settings-jira';

/** Which control a read belongs to (#822): the site select reads the projects; the project select the rest. */
export type JiraLoad = 'site' | 'project';
export interface JiraRowOptions { projects: JiraProject[]; issueTypes: JiraIssueType[]; linkTypes: JiraLinkType[]; errors: Partial<Record<JiraLoad, JiraReadError>> }
export const NO_JIRA_OPTIONS: JiraRowOptions = { projects: [], issueTypes: [], linkTypes: [], errors: {} };

export interface JiraSourceOptions {
  rows: Record<string, JiraRowOptions>; // by source row id
  loadSite(row: SourceDraft): Promise<void>; // the site's projects
  loadProject(row: SourceDraft): Promise<void>; // the project's issue types and the site's link types; columns and filter options ride loadColumns
  fail(rowId: string, load: JiraLoad, err: unknown): void; // a columns or filter-options failure of the row, shown at its project select
  projectGuard(rowId: string): () => boolean; // taken right after loadProject: false once a newer project read of the row or a site change overtook it
}

/** Each Jira row's options and inline errors (#822). A read a newer one of the same row and control overtook is dropped. */
export function useJiraSourceOptions(): JiraSourceOptions {
  const [rows, setRows] = useState<Record<string, JiraRowOptions>>({});
  const latest = useRef<Record<string, number>>({});
  const patch = useCallback((id: string, next: (row: JiraRowOptions) => JiraRowOptions) =>
    setRows((r) => ({ ...r, [id]: next(r[id] ?? NO_JIRA_OPTIONS) })), []);
  const fail = useCallback((id: string, load: JiraLoad, err: unknown) =>
    patch(id, (row) => ({ ...row, errors: { ...row.errors, [load]: jiraReadError(err) } })), [patch]);
  const bump = useCallback((key: string): number => {
    const n = (latest.current[key] ?? 0) + 1;
    latest.current = { ...latest.current, [key]: n };
    return n;
  }, []);
  const projectGuard = useCallback((id: string) => {
    const n = latest.current[`${id}:project`];
    return () => latest.current[`${id}:project`] === n;
  }, []);
  const read = useCallback(async <T,>(id: string, load: JiraLoad, run: () => Promise<T>, done: (row: JiraRowOptions, value: T) => JiraRowOptions) => {
    const key = `${id}:${load}`;
    const n = bump(key);
    patch(id, (row) => ({ ...row, errors: { ...row.errors, [load]: undefined } }));
    try { const value = await run(); if (latest.current[key] === n) patch(id, (row) => done(row, value)); }
    catch (err) { if (latest.current[key] === n) fail(id, load, err); }
  }, [patch, fail, bump]);
  // A new site voids what the old one's project read is still bringing, and the old project's types and error (#822)
  const loadSite = useCallback((row: SourceDraft) => {
    bump(`${row.id}:project`);
    patch(row.id, (r) => ({ ...r, issueTypes: [], linkTypes: [], errors: { ...r.errors, project: undefined } }));
    return row.jira.site === '' ? Promise.resolve()
    : read(row.id, 'site', () => getJson<JiraProject[]>(jiraProjectsUrl(row.jira.site)), (r, projects) => ({ ...r, projects }));
  }, [read, bump, patch]);
  const loadProject = useCallback((row: SourceDraft) => (!isJiraChosen(row.jira) ? Promise.resolve()
    : read(row.id, 'project', () => Promise.all([getJson<JiraIssueType[]>(jiraIssueTypesUrl(row.jira)), getJson<JiraLinkType[]>(jiraLinkTypesUrl(row.jira.site))]),
      (r, [issueTypes, linkTypes]) => ({ ...r, issueTypes, linkTypes }))), [read]);
  return { rows, loadSite, loadProject, fail, projectGuard };
}
