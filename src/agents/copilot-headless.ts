// Copilot's headless runs (#330), node 5 of #608: none yet
export const HEADLESS_MCP = false; // no tester MCP config until node 5

export const headless = (): string[] => {
  throw new Error('copilot: headless runs are not supported yet');
};

export const headlessAnswer = (): string | undefined => undefined;
