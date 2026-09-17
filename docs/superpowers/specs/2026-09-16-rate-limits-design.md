# Agent Hive — limites do plano (sessão / semana) na tela inicial

Extensão do orçamento (`docs/superpowers/specs/2026-09-16-token-budget-design.md`); a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`) é autoritativa pra tudo que não está aqui. Card: [issue #13](https://github.com/dennys-bd/agent-hive/issues/13) — "On home screen have the usage / limits for current session, week, fable". Objetivo: o cabeçalho do dashboard mostra os limites do plano Claude que o `/usage` do Claude Code mostra — a janela de 5 h ("sessão") e a semanal — em percentual usado e hora do reset, ao lado do medidor de tokens do item 5.

## De onde vem o dado

O Claude Code não expõe os limites em nenhum hook; expõe no JSON que envia ao comando da **status line** (`rate_limits.five_hour` / `rate_limits.seven_day`, cada um com `used_percentage` e `resets_at` em epoch segundos; só em plano Pro/Max e só depois da primeira resposta da API — [docs](https://code.claude.com/docs/en/statusline.md)). O Hive já entrega aos workers um arquivo de settings (`.hive/hooks.json`, via `--settings`); ele ganha uma `statusLine` cujo comando manda esse JSON pro Hive, do mesmo jeito que os hooks fazem com `/hooks/event`.

O limite semanal por modelo (o "fable" do título) **não está documentado** em lugar nenhum acessível por programa: nem na status line nem em API pública; o único caminho seria o token OAuth do Keychain contra um endpoint não documentado. Fica fora. O que este item garante é que **qualquer janela** que o Claude Code mandar em `rate_limits` aparece na tela com o nome que vier — se um dia vier `seven_day_fable`, aparece sem mudar nada.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Fonte | `statusLine` no `.hive/hooks.json` dos workers, comando `curl` que faz `POST /hooks/status` com o stdin e o header `x-hive-worker` (mesmo padrão de `hookCommand`) | Único canal documentado; sem credencial, sem rede externa, sem dependência nova |
| Fable | Fora. A UI renderiza toda janela recebida, com rótulo pelo nome da chave | Não há forma documentada; ler o token do Keychain pra um endpoint não documentado é frágil e sensível. Se o Claude Code passar a mandar, aparece sozinho |
| Status line do worker | O comando imprime o corpo da resposta do Hive (`text/plain`, uma linha: `sessão 23% · semana 41%`) | A `statusLine` do Hive substitui a do usuário dentro dos workers (precedência do `--settings`); devolver o resumo dos limites deixa a aba do worker útil em vez de vazia |
| Rota | `POST /hooks/status`: sempre responde 200; header `x-hive-worker` obrigatório; corpo = JSON da status line; o servidor extrai `rate_limits` e despacha `rateLimits` | Mesma superfície local dos hooks; o corpo inteiro nunca é guardado |
| Validação (`parseRateLimits`) | Chave `/^[a-z][a-z0-9_]{0,31}$/`, no máximo 8 janelas; `used_percentage` finito ≥ 0; `resets_at` inteiro > 0 (segundos) → ISO. Janela sem os dois campos é descartada; nenhuma válida → nada é despachado | Qualquer processo local pode bater na rota; o estado nunca recebe forma ou tamanho arbitrário |
| Tipo | `RateLimitWindow { usedPercent: number; resetsAt: string }`, `RateLimits { at: string; windows: Record<string, RateLimitWindow> }`, `State.rateLimits?: RateLimits` | `at` = quando chegou (a leitura é da última status line vista, não em tempo real); `resetsAt` em ISO como os outros instantes do `State` |
| Reducer | `{ type: 'rateLimits'; workerId; rateLimits }` → se `workerId` está num slot ocupado, `{ ...state, rateLimits }`, sem efeitos, sem `fill` | Dado é da conta, não do worker; mas só worker vivo alimenta, como nos hooks. Só exibição neste item |
| Persistência | `rateLimits` vai pro `state.json`; `normalize` mantém se a forma bate, senão apaga | Reabrir o Hive mostra o último valor conhecido com a hora, em vez de nada |
| Frequência | Cada status line vira um dispatch (persist + broadcast) | Mesma ordem de grandeza dos hooks `PreToolUse` / `PostToolUse`, que já fazem isso por tool call |
| UI | `#limits` no header, ao lado de `#usage`: por janela `rótulo NN%` + `<meter max=100>` + `reseta HH:MM`; no fim `· às HH:MM` (o `at`). Vazio sem dado | Formato do medidor do item 5; a hora do reset é o que o `/usage` mostra |
| Rótulos | `five_hour` → `sessão`, `seven_day` → `semana`, `seven_day_<x>` → `semana <x>`, outro → chave com `_` trocado por espaço | Cobre os documentados e o hipotético por modelo sem lista fechada |
| Sinal / orçamento | Não entram. `fill`, `hasBudget` e `usageRules` continuam só com `State.usage` | Issue pede mostrar; usar o limite do plano como porta é outro item |
| Fora | Endpoint OAuth, encadear a status line do usuário, cor de alerta, gate pelo limite | Depois, se fizer falta |

## `.hive/hooks.json`

```jsonc
{
  "hooks": { /* item v1 */ },
  "statusLine": {
    "type": "command",
    "command": "curl -s -m 2 -X POST http://127.0.0.1:47821/hooks/status -H \"x-hive-worker: $HIVE_WORKER_ID\" -H 'content-type: application/json' -d @-; exit 0"
  }
}
```

## Tipos

```ts
interface RateLimitWindow { usedPercent: number; resetsAt: string } // ISO
interface RateLimits { at: string; windows: Record<string, RateLimitWindow> }
interface State { /* item 6 */ rateLimits?: RateLimits }
type HiveEvent = /* … */ | { type: 'rateLimits'; workerId: string; rateLimits: RateLimits };
```

## `src/rate-limits.ts` (novo)

```ts
export const MAX_WINDOWS = 8;
export function parseRateLimits(body: unknown, now: Date): RateLimits | undefined; // lê body.rate_limits
export function isRateLimits(value: unknown): value is RateLimits; // forma persistida, pro state-store
export function formatRateLimits(limits: RateLimits): string; // "sessão 23% · semana 41%", a linha da status line
export function windowLabel(key: string): string;
```

Puro; sem import do orquestrador nem de `node:*`.

## `hooks-settings.ts`

`statusCommand(port)` ao lado de `hookCommand`; `renderHooksSettings` devolve `{ hooks, statusLine }`.

## Servidor (`server.ts`)

`POST /hooks/status`: `res.type('text/plain')`; sem `x-hive-worker` ou sem janela válida → corpo vazio; senão despacha `rateLimits` e responde `formatRateLimits` da carga recebida (a linha é calculada do payload, não do `State`: um `workerId` desconhecido recebe a linha e o reducer ignora, como em `/hooks/event`).

## Orquestrador, estado, UI

- `reduce` ganha o caso `rateLimits` (tabela acima).
- `normalize` em `state-store.ts` usa `isRateLimits`.
- `app.ts`: `renderLimits(state.rateLimits)` chamado em `render`; `index.html` ganha `<span id="limits" class="dash"></span>` com o estilo de `#usage`.

## Testes

- `test/rate-limits.test.ts` (novo): `parseRateLimits` com o exemplo das docs (dois `windows`, `resetsAt` em ISO, `at` = `now`); janela extra (`seven_day_fable`) mantida; chave inválida, `used_percentage` não numérico, `resets_at` ausente → descartadas; mais de 8 → corta; sem `rate_limits` ou corpo não objeto → `undefined`; `formatRateLimits`; `windowLabel`; `isRateLimits`.
- `test/hooks-settings.test.ts`: `statusCommand` posta em `/hooks/status` e termina em `exit 0`; `renderHooksSettings` inclui `statusLine` de tipo `command`.
- `test/orchestrator.test.ts`: `rateLimits` de worker ocupado grava e não emite efeito; de `workerId` desconhecido não muda o estado; estado de entrada não é mutado.
- `test/state-store.test.ts`: `state.json` com `rateLimits` válido carrega; com forma inválida carrega sem a chave.
- `test/setup.test.ts`: `POST /hooks/status` com carga válida responde 200 e a linha; sem header, ou sem `rate_limits`, responde 200 vazio; com `workerId` desconhecido o `State` fica sem `rateLimits` e o servidor segue de pé (mesmo padrão do teste de `/hooks/event`).

## Critério de pronto

1. Com um worker aberto pelo Hive em plano Pro/Max, depois da primeira resposta o header mostra `sessão NN% ▮▮ reseta HH:MM · semana NN% ▮▮ reseta …· às HH:MM`, e a aba do worker mostra `sessão NN% · semana NN%` na status line. Reabrir o Hive mostra o mesmo valor com a hora antiga.
2. Sem worker rodando (ou plano API), nada aparece e nada quebra.
3. `pnpm test` verde com os testes acima (153 → 167).
