// A free session's picks (#257) in the shape the open routes admit, shared by the routes, the state loader and the spawn. Page-safe: no Node
// import. Each value reaches the argv as its own word, never through a shell; the rules keep an option out of a value's place.
import type { LaunchPick, Session } from './types.js';

export const MODEL_MAX = 100;
export const ARGS_MAX = 32;
export const ARG_MAX = 200;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]*$/; // never a leading '-', which would read as an option
const SPECIALIZED_AGENT = /^hive:[a-z0-9-]+$/; // the Hive plugin's agents only, named as codex-home's AGENT_NAME admits

export const isLaunchModel = (value: unknown): value is string => typeof value === 'string' && value.length <= MODEL_MAX && MODEL.test(value);

export const isLaunchArgs = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= ARGS_MAX && value.every((arg) => typeof arg === 'string' && arg.length >= 1 && arg.length <= ARG_MAX && !arg.includes('\u0000'));

export const isSpecializedAgent = (value: unknown): value is string => typeof value === 'string' && SPECIALIZED_AGENT.test(value);

/** A pick as a session or a worker carries it: absent stays absent, so a session with none has no key. */
export const withLaunch = (launch: LaunchPick | undefined): Pick<Session, 'launch'> => (launch === undefined ? {} : { launch });

/** The picks a saved session or a worker keeps (#257), field by field in the shape the routes admit: a hand-edited state.json cannot put an
 * option where a value goes. A field in any other shape drops alone; none left is no launch. */
export function savedLaunch(value: unknown): Pick<Session, 'launch'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const { model, specializedAgent, args } = value as Record<string, unknown>;
  const launch: LaunchPick = {
    ...(isLaunchModel(model) ? { model } : {}),
    ...(isSpecializedAgent(specializedAgent) ? { specializedAgent } : {}),
    ...(isLaunchArgs(args) && args.length > 0 ? { args: [...args] } : {}),
  };
  return Object.keys(launch).length === 0 ? {} : { launch };
}
