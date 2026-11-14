import type { RefGrammar } from '../blocker-refs.js';

// #56's `12`, `#12` or `owner/repo#12`; the repository needs its `#`, so `acme/r12` is no ref. Nine digits stay inside GraphQL's Int. One
// regex for what the adapter parses and what the add row accepts (#810 decision 4)
export const GITHUB_REF = /^(?:([\w.-]+)\/([\w.-]+)#|#?)(\d{1,9})$/;

/** GitHub's entry of REF_GRAMMARS (#810): a short ref is a bare number, an issue of the item's own repository, as GitHub's picker reads it. */
export const githubRefs: RefGrammar = {
  refOf: (text) => {
    const match = GITHUB_REF.exec(text.trim());
    if (match === null) return undefined;
    return match[1] === undefined ? match[3] : match[0]; // `#12` goes to the route as `12`
  },
  isShort: (id) => /^\d+$/.test(id),
  forms: '12, #12, owner/repo#12',
};
