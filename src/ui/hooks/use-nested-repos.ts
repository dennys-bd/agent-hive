import { useEffect, useState } from 'react';
import type { NestedReposAnswer } from '../../types';
import { getJson } from '@/lib/api';

const NONE: NestedReposAnswer = { repos: [], suggested: [] };
const isAnswer = (read: unknown): read is NestedReposAnswer =>
  typeof read === 'object' && read !== null && Array.isArray((read as NestedReposAnswer).repos) && Array.isArray((read as NestedReposAnswer).suggested);

/** A workspace folder's nested repos as GET /settings/nested-repos reads them (#653), read again when the folder or the listed paths change;
 * none while the folder is empty, not a repository's top level, or the read fails. Anything but the answer's shape reads as none. */
export function useNestedRepos(path: string, repos: readonly string[]): NestedReposAnswer {
  const [answer, setAnswer] = useState<NestedReposAnswer>(NONE);
  const listed = repos.join(',');
  useEffect(() => {
    const folder = path.trim();
    if (folder === '') {
      setAnswer(NONE);
      return undefined;
    }
    let live = true;
    getJson<unknown>(`/settings/nested-repos?${new URLSearchParams({ path: folder, repos: listed })}`).then(
      (read) => { if (live) setAnswer(isAnswer(read) ? read : NONE); },
      () => { if (live) setAnswer(NONE); },
    );
    return () => { live = false; };
  }, [path, listed]);
  return answer;
}
