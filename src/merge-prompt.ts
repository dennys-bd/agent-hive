// The first message of a session `resolve in the activity` opens on a PR in conflict (#758): a fixed, agent-neutral text in English, not a
// setting (docs/agent/settings-candidates.md). The page sends only its key and the base branch, which isBranchName checks before it is rendered.

/** The open route's `prompt` key for this text (#758): a key, never text from the page. */
export const MERGE_BASE_PROMPT = 'mergeBase';

/** The merge-from-base prompt (#758), on the PR's base remote (#854). */
export const mergeBasePrompt = (base: string, remote = 'origin'): string =>
  `The pull request of this branch conflicts with ${base}. Run \`git fetch ${remote} ${base}\`, merge \`${remote}/${base}\` into this branch and resolve `
  + 'every conflict, keeping the intent of both sides. Run the project\'s tests until they pass, then commit the merge and push the branch.';

const MAX_BRANCH = 255;
// git check-ref-format's refusals a branch name from a request could hit, and a leading `-` that would read as an option
const FORBIDDEN = /[~^:?*[\\]|\.\.|@[{]|\/\/|^[-/.]|[/.]$|\.lock$|\/\./;
// The name is written into an agent prompt (`git fetch origin ${base}`), so only a conservative charset passes, on top of git's rules
const SAFE_CHARS = /^[A-Za-z0-9._/-]+$/;
const hasControlOrSpace = (value: string): boolean => [...value].some((c) => c <= ' ' || c === '\u007f');

/** A branch name the page may send as the merge's base (#758). */
export const isBranchName = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value !== '@' && value.length <= MAX_BRANCH && SAFE_CHARS.test(value) && !hasControlOrSpace(value) && !FORBIDDEN.test(value);
