// The known spawn failures (#742), by the start of the message each site writes: agents.ts, config.ts, server-spawn.ts, worktree-steps.ts,
// worktree.ts, git and node-pty. The message itself can carry a path or a setup's output: only the code reaches a record. No import, so the
// page reads the same table for its short message (#945)

export type SpawnFailureCode =
  | 'agent_missing' | 'no_workspace' | 'workspace_gone' | 'command_disabled' | 'setup_failed' | 'checkout_dirty' | 'git_failed' | 'pty_failed' | 'error';

const SPAWN_FAILURES: readonly [RegExp, SpawnFailureCode][] = [
  [/^agent \S+ is not on PATH/, 'agent_missing'], [/^choose a workspace$/, 'no_workspace'], [/^workspace .+ (?:is gone|não existe mais)$/, 'workspace_gone'],
  [/^comando ".*" não está habilitado/, 'command_disabled'], [/^(?:setup|teardown) failed at line /, 'setup_failed'],
  [/ has changes that are not committed:$/, 'checkout_dirty'], // #945: ensureCheckout's refusal, git's porcelain lines after it
  [/^(?:fatal|error): |^base: /, 'git_failed'], [/posix_spawn|^pty /, 'pty_failed'],
];

/** run.spawn_failed's code (#742): one of a closed set read from the message's first line, `error` for any other. */
export const spawnFailureCode = (message: string): SpawnFailureCode => {
  const line = message.split('\n')[0] ?? '';
  return SPAWN_FAILURES.find(([pattern]) => pattern.test(line))?.[1] ?? 'error';
};
