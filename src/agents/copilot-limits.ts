// Copilot's plan limits, node 7 of #608 (gh api /copilot_internal/user, spike §7): no reading until then
import type { RateLimits } from '../types.js';

export const readCopilotPlanLimits = (): Promise<RateLimits | undefined> => Promise.resolve(undefined);
