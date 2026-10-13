// Claude's models for the new session dialog (#257). Maintained by hand: claude has no command that lists them, so a new model or a retired
// one is an edit here. Most recent first. An alias's hint is the version it maps to today; the [1m] aliases carry none, since the page names
// their 1M context in its own language.
import type { LaunchOption } from '../types.js';

export const CLAUDE_ALIASES: readonly LaunchOption[] = [
  { id: 'fable', hint: 'fable 5.1' },
  { id: 'opus', hint: 'opus 5.5' },
  { id: 'sonnet', hint: 'sonnet 5.5' },
  { id: 'haiku', hint: 'haiku 5.5' },
  { id: 'opus[1m]' },
  { id: 'sonnet[1m]' },
];

export const CLAUDE_VERSIONS: readonly LaunchOption[] = [
  { id: 'claude-fable-5-1' },
  { id: 'claude-opus-5-5' },
  { id: 'claude-sonnet-5-5' },
  { id: 'claude-haiku-5-5' },
  { id: 'claude-opus-4-5' },
  { id: 'claude-sonnet-4-5' },
  { id: 'claude-haiku-4-5' },
  { id: 'claude-opus-4-1' },
];
