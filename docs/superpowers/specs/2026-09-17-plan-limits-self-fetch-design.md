# Agent Hive — limites do plano sem depender de worker rodando

Extensão dos limites do plano (`docs/superpowers/specs/2026-09-16-rate-limits-design.md`); a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`) é autoritativa pra tudo que não está aqui. Card: [issue #34](https://github.com/dennys-bd/agent-hive/issues/34) — "Show plan limits without depending on a running worker". Objetivo: o cabeçalho mostra `sessão NN% · semana NN%` assim que o Hive abre e continua atualizando enquanto ele está parado em amarelo, sem nenhum worker vivo.

## O problema

Hoje a única fonte é a status line dos workers (`POST /hooks/status`). Um Hive recém-aberto mostra no máximo o último valor salvo no `state.json`, com a hora antiga; um Hive parado não atualiza nunca. A issue deixou a fonte em aberto: uma sessão Claude própria só pra ler a status line, ou o endpoint interno de uso que o app da Anthropic usa.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Fonte | `GET https://api.anthropic.com/api/oauth/usage` com o token OAuth que o próprio Claude Code guarda (header `Authorization: Bearer …` e `anthropic-beta: oauth-2025-04-20`). Endpoint não documentado | A sessão própria custa um turno de API por leitura (conta contra o limite que está medindo e contra o orçamento do item 5), leva 10–20 s (tmux + boot do `claude` + resposta) e a status line só roda na TUI interativa, não em `claude -p`. O endpoint é instantâneo, sem tokens gastos e é o que o `/usage` e os monitores de uso da comunidade leem. Sendo não documentado, o parse é defensivo e uma falha nunca derruba nada |
| Token | Lido a cada leitura, nesta ordem: `CLAUDE_CODE_OAUTH_TOKEN` no ambiente; `<CLAUDE_CONFIG_DIR ou ~/.claude>/.credentials.json` (`claudeAiOauth.accessToken`); no macOS, `security find-generic-password -s "Claude Code-credentials" -w` (mesmo JSON). Nenhum → falha da leitura. Nunca guardado no Hive, no `State`, no `hive.config.json` nem no log | Mesma precedência do Claude Code; o Claude Code renova o token sozinho, então ler na hora evita cache vencido. `security` via `execFile` com argv, como todo processo externo |
| Quem lê | `src/plan-limits.ts`: `readPlanLimits(deps)` → `RateLimits \| undefined`. `fetch`, `exec`, `env`, `platform` e `now` injetáveis; o servidor recebe um `PlanLimitsReader` em `ServerDeps.readPlanLimits`. **Sem o dep, o servidor não lê** (é o que os testes fazem); `main.ts` e `run.ts` passam o leitor real via `bootHive(repo, { readPlanLimits })` | Teste nunca toca credencial nem rede; o único lugar que liga a rede é a entrada do processo |
| Cadência | No `configure` (boot e primeiro setup) e a cada 5 min (`PLAN_LIMITS_INTERVAL_MS`) por um timer próprio em `listen`, limpo no `close`. A status line dos workers continua alimentando entre uma leitura e outra | Um Hive parado atualiza sozinho; o endpoint é barato. Sem ligar ao timer do board, que tem backoff próprio |
| Parse (`parseUsage`) | Cada chave do corpo que bate em `WINDOW_KEY` com `{ utilization: number, resets_at: string }` vira `RateLimitWindow`: `utilization` finito ≥ 0 limitado a 100; `resets_at` vira ISO (data inválida descarta a janela); `null` ou outra forma descarta; máx. 8 janelas; nenhuma → `undefined`. Chaves extras (`extra_usage`) caem no filtro | Mesmos limites de `parseRateLimits`; o `State` nunca recebe forma arbitrária de um endpoint que pode mudar |
| Reducer | `{ type: 'rateLimits'; workerId?: string; rateLimits }`: sem `workerId`, é leitura do próprio Hive e é aceita sempre; com `workerId`, a regra atual (só slot ocupado) | O dado é da conta; a exigência de worker vivo só existia porque o canal era de qualquer processo local. A leitura própria não passa por rota |
| Falha | Leitura que rejeita (sem token, 401, rede, forma inválida) mantém o último valor e o Hive segue. `log.info('plan limits: <motivo>')` só quando o motivo muda e `plan limits: ok` na volta; o corpo da resposta nunca vai pro log, só o status HTTP | Usuário de API key (sem OAuth) não pode ver um erro a cada 5 min no stderr; mas a razão precisa estar no `hive.log` uma vez |
| Rede | Host fixo na constante; timeout de 10 s (`AbortSignal.timeout`); sem retry | Único destino possível; a próxima leitura é o retry |
| Fable / por modelo | O endpoint devolve `seven_day_opus`, `seven_day_sonnet`… quando o plano tem; entram pelo mesmo `windowLabel` (`semana opus`) | O que #13 deixou fora por falta de fonte vem de graça; nada de lista fechada |
| UI | Sem mudança: `renderLimits` já mostra qualquer janela e o `às HH:MM` | O `at` da leitura própria é a hora da leitura, como hoje |
| Fora | Renovar o token (refresh token), uso em sinal/orçamento, `extra_usage`, botão de atualizar, Windows (só env e arquivo, sem Keychain) | Depois, se fizer falta |

## Tipos

```ts
type HiveEvent = /* … */ | { type: 'rateLimits'; workerId?: string; rateLimits: RateLimits }; // sem workerId: leitura do Hive
/** Lê os limites do plano da conta do Claude Code; rejeita quando não dá (sem token, rede, 401). */
type PlanLimitsReader = () => Promise<RateLimits | undefined>;
```

`ServerDeps.readPlanLimits?: PlanLimitsReader`. `bootHive(repo, deps: Pick<ServerDeps, 'readPlanLimits'> = {})`.

## `src/rate-limits.ts`

```ts
export function parseUsage(body: unknown, now: Date): RateLimits | undefined; // corpo do /api/oauth/usage
```

Puro como o resto do arquivo. `parseRateLimits` e `parseUsage` dividem o coletor de janelas (filtro de chave, corte em `MAX_WINDOWS`, `undefined` sem janela); só o parse de uma janela difere (`used_percentage` + epoch vs `utilization` + ISO).

## `src/plan-limits.ts` (novo)

```ts
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PLAN_LIMITS_INTERVAL_MS = 5 * 60_000;
export interface PlanLimitsDeps { fetch?: typeof fetch; exec?: Exec; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; now?: () => Date }
export async function readOAuthToken(deps): Promise<string>;   // env → .credentials.json → Keychain (darwin); nenhum → rejeita
export async function readPlanLimits(deps = {}): Promise<RateLimits | undefined>;
```

- `readOAuthToken`: `.credentials.json` ausente ou sem `claudeAiOauth.accessToken` string não vazia → próximo passo; `security` que falha (item ausente, Keychain trancado) → próximo passo; no fim `Error('no Claude Code OAuth token (env, .credentials.json or Keychain)')`.
- `readPlanLimits`: token → `fetch(USAGE_URL, { headers, signal })`; `!res.ok` → `Error('HTTP <status>')`; JSON inválido → rejeita; senão `parseUsage(json, now())`.
- O token só existe dentro da chamada; nenhuma mensagem de erro carrega ele.

## Servidor (`server.ts`)

- `refreshPlanLimits()`: sem `deps.readPlanLimits` ou sem `live` → nada. Chama o leitor; valor → `dispatch({ type: 'rateLimits', rateLimits })`; `undefined` → nada; rejeição → log conforme a tabela.
- Exposto em `HiveServer.refreshPlanLimits()`, como `poll`: `configure()` chama depois do `poll()`, e `bootHive` em modo hive (que não passa por `configure`) chama depois do seu `poll()`. `listen` arma `setInterval(refreshPlanLimits, PLAN_LIMITS_INTERVAL_MS)`; `close` limpa.
- `describeEvent` (`log.ts`): `rateLimits source=hive` quando não há `workerId`.
- `POST /hooks/status` inalterado.

## `hive.ts`, `main.ts`, `run.ts`

`bootHive(repo, deps)` repassa `readPlanLimits` aos dois `createServer` e chama `server.refreshPlanLimits()` depois do `poll()` em modo hive; `main.ts` e `run.ts` chamam `bootHive(repo, { readPlanLimits })` importando de `plan-limits.js`.

## Orquestrador

`setRateLimits(state, workerId, rateLimits)`: `workerId === undefined` → `{ ...state, rateLimits }`; senão a regra atual.

## Testes

- `test/rate-limits.test.ts`: `parseUsage` com corpo realista (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet: null`, `extra_usage: {…}`) → três janelas, `resetsAt` em ISO, `at = now`; `utilization` acima de 100 limitado; `resets_at` não parseável descarta a janela; nada válido / corpo não objeto → `undefined`; mais de 8 → corta.
- `test/plan-limits.test.ts` (novo): token do env manda `Authorization: Bearer` e `anthropic-beta` pra `USAGE_URL` e devolve o parse; token do `.credentials.json` (via `CLAUDE_CONFIG_DIR` num tmp) quando o env não tem; Keychain via `exec` falso no darwin quando o arquivo não existe, com o argv exato; sem nenhum → rejeita e o `fetch` não roda; `401` → rejeita com `HTTP 401` e a mensagem não contém o token; JSON inválido → rejeita.
- `test/orchestrator.test.ts`: `rateLimits` sem `workerId` grava mesmo sem slot ocupado, sem efeitos, sem mutar a entrada.
- `test/server.test.ts`: com `readPlanLimits` falso, depois do `POST /setup` o `State` tem `rateLimits`; leitor que rejeita deixa o `State` como estava, o servidor segue e o log tem uma linha `plan limits:`; sem o dep nada é lido.
- `test/hive.test.ts`: `bootHive` com `readPlanLimits` falso preenche `rateLimits` no boot.

## Critério de pronto

1. Abrir o Hive numa conta Pro/Max com o Claude Code logado mostra `sessão NN% ▮▮ reseta HH:MM · semana NN% …` no header sem nenhum worker, e o valor muda sozinho a cada 5 min.
2. Sem token (API key) o header fica vazio (ou com o último valor salvo), o Hive segue e o `hive.log` tem uma linha `plan limits: no Claude Code OAuth token…`.
3. `pnpm test` verde (252 → 267).
