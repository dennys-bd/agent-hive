import { useEffect, useState } from 'react';
import type { MachineId, NestedReposAnswer } from '../../types';
import { getJson } from '@/lib/api';

const NONE: NestedReposAnswer = { repos: [], suggested: [] };
const isAnswer = (read: unknown): read is NestedReposAnswer =>
  typeof read === 'object' && read !== null && Array.isArray((read as NestedReposAnswer).repos) && Array.isArray((read as NestedReposAnswer).suggested);

/** A workspace folder's nested repos as GET /settings/nested-repos reads them (#653), read again when the folder, on the machine the draft names (#932), or the listed paths change;
 * none while the folder is empty, not a repository's top level, or the read fails. Anything but the answer's shape reads as none. */
export function useNestedRepos(path: string, repos: readonly string[], machine: MachineId): NestedReposAnswer {
  const [answer, setAnswer] = useState<NestedReposAnswer>(NONE);
  const listed = repos.join(',');
  useEffect(() => {
    const folder = path.trim();
    if (folder === '') {
      setAnswer(NONE);
      return undefined;
    }
    let live = true;
    getJson<unknown>(`/settings/nested-repos?${new URLSearchParams({ path: folder, repos: listed, machine })}`).then(
      (read) => { if (live) setAnswer(isAnswer(read) ? read : NONE); },
      () => { if (live) setAnswer(NONE); },
    );
    return () => { live = false; };
  }, [path, listed, machine]);
  return answer;
}
