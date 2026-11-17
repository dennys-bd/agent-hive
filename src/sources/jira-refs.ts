import type { RefGrammar } from '../blocker-refs.js';

// An issue key, its project part as jira-queries.ts's PROJECT_KEY. Written out so the UI's bundle of blocker-refs pulls in no Jira call
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Jira's entry of REF_GRAMMARS (#820): a key names its own project, so no ref is short and every one passes namespaced both ways. */
export const jiraRefs: RefGrammar = {
  refOf: (text) => (JIRA_KEY.test(text.trim()) ? text.trim() : undefined),
  isShort: () => false,
  forms: 'ABC-12',
};
