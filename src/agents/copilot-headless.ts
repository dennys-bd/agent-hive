// Copilot's headless runs (#877, node 5 of #608). The prompt on stdin asks for the schema's JSON (Copilot has no schema flag, spike §4), and
// -s prints the answer alone on stdout. Every run gets a Copilot home of its own in the run's temp folder (headlessEnv); the flags keep the
// worktree's instructions, the built-in GitHub server and the question form out, and offer the narrowest tool set the run needs
import { join } from 'node:path';
import type { HeadlessRun } from './runner.js';

export const HEADLESS_MCP = true; // #474: --additional-mcp-config loads the tester's file

const HOME_DIR = 'copilot-home';
const SCHEMA_INSTRUCTION = '\n\nAnswer with one JSON object that matches this JSON Schema, and nothing else: no prose, no code fence.\n\n';
// -s: the answer alone; no AGENTS.md / CLAUDE.md (probe C); no built-in GitHub server (probe F); no question form a headless run cannot answer
const BASE_FLAGS: readonly string[] = ['-s', '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user'];
const TOOLS_FLAG = '--available-tools'; // never bare: with no value it offers every tool (probe F)
const PLAIN_TOOLS: readonly string[] = ['view']; // one read tool, in the run's empty temp folder: no shell, no write
const READ_TOOLS: readonly string[] = ['view', 'rg', 'glob']; // the issue's grep is rg in 1.0.112 (probe F); spike probe 10 saw no write with these
const MODEL_FLAG = '--model';
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const FENCE = /^```(?:json)?\r?\n([\s\S]*?)\r?\n?```$/;

interface McpTool { server: string; tool: string }

// The tester's mcp__<server>__<tool>; any other name is no rule Copilot takes here, so it is dropped
const mcpTool = (name: string): McpTool | undefined => {
  const match = MCP_TOOL.exec(name);
  return match === null ? undefined : { server: match[1], tool: match[2] };
};
const mcpTools = (run: HeadlessRun): McpTool[] => (run.mcpConfig === undefined ? [] : (run.allowedTools ?? []).flatMap((name) => mcpTool(name) ?? []));
const builtInTools = (run: HeadlessRun): readonly string[] => (run.readOnlyTools ? READ_TOOLS : PLAIN_TOOLS);

// A tester run offers only its MCP tools, named <server>-<tool> (spike §1, hive-hive_ping); with none left, the run's built-in read tools
const toolWords = (run: HeadlessRun, tools: readonly McpTool[]): string[] => [
  TOOLS_FLAG, ...(tools.length > 0 ? tools.map(({ server, tool }) => `${server}-${tool}`) : builtInTools(run)),
];

// A non-interactive run denies what no rule allows: one Server(tool) rule per tool (--help)
const mcpWords = (run: HeadlessRun, tools: readonly McpTool[]): string[] => (run.mcpConfig === undefined ? [] : [
  '--additional-mcp-config', `@${run.mcpConfig}`, ...tools.map(({ server, tool }) => `--allow-tool=${server}(${tool})`),
]);

/** The argv after `copilot`; cwd is the process's own and outsideRepo needs no flag (Copilot runs in a plain folder). */
export const headless = (run: HeadlessRun): string[] => {
  const tools = mcpTools(run);
  return [...BASE_FLAGS, ...toolWords(run, tools), ...mcpWords(run, tools), ...(run.model === undefined ? [] : [MODEL_FLAG, run.model])];
};

/** -s's stdout, trimmed, one surrounding fence stripped: models fence JSON despite the prompt, and the callers' parsers do not. */
export const headlessAnswer = (stdout: string): string | undefined => {
  const text = stdout.trim();
  const answer = (FENCE.exec(text)?.[1] ?? text).trim();
  return answer === '' ? undefined : answer;
};

/** Copilot has no schema flag (spike §4): the prompt asks for the JSON the callers' parsers read, the schema last. */
export const headlessPrompt = (prompt: string, schema: string): string => `${prompt}${SCHEMA_INSTRUCTION}${schema}`;

// A fresh home trusts no folder, so a worktree's repository hooks never load (probes A, B, D), and it holds the session folder Copilot always
// writes (no --no-session-persistence, spike §4), which goes with the run's folder. COPILOT_ALLOW_ALL exactly "true" would trust the cwd
// again (`copilot help environment`); empty is off, whatever was inherited. No update check per run, as #873's workers
export const headlessEnv = ({ dir }: HeadlessRun): Record<string, string> =>
  ({ COPILOT_HOME: join(dir, HOME_DIR), COPILOT_AUTO_UPDATE: 'false', COPILOT_ALLOW_ALL: '' });
