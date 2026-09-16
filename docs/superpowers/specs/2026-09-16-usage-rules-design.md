# Agent Hive — sinal dinâmico por uso de tokens

Extensão do orçamento (`docs/superpowers/specs/2026-09-16-token-budget-design.md`) e do sinal (`docs/superpowers/specs/2026-09-16-signal-design.md`); a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`) é autoritativa pra tudo que não está aqui. Objetivo: o sinal e o teto de workers passam a ser **derivados** do uso (`State.usage`, amostras por turno) contra o orçamento (`State.budget`), por uma tabela de faixas na config. Regra pura `applyUsageRules(usage, budget, rules, now) → { signal, maxWorkers }`; o orquestrador combina o resultado com o sinal manual (o mais restritivo vence) e para de abrir job acima do teto dinâmico sem drenar nem matar worker vivo.

## O que o item 5 já entrega

- `State.usage: UsageSample[]` (uma amostra `{ at, tokens }` por turno, últimas 24 h) e `usageTotals(usage, now) → { hour, day }` em `src/usage.ts`.
- `Config.budget` / `State.budget: { maxTokensPerHour?, maxTokensPerDay? }` (ausente ou `0` = sem limite), copiado pro estado por `setBudget` no `configure` / `reconfigure`, e por `hive.ts` no boot.
- `hasBudget(usage, budget, now)` como segunda porta do `fill`, ao lado de `canStart`.
- Medidor na UI e campos de orçamento no formulário.

Este item não muda nada disso: só lê `usage` e `budget` e acrescenta a tabela.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Unidade da faixa | Percentual inteiro do orçamento usado: `{ "percent": 80, "signal": "yellow" }` | É como o roadmap escreve a tabela (50%, 60%, 80%, 90%); inteiro em JSON lê melhor que fração |
| Forma da regra | `UsageRule = { percent: number; maxWorkers?: number; signal?: Signal }`, pelo menos um dos dois efeitos | Uma linha da tabela do roadmap = um objeto; sem tipo separado por efeito |
| Percentual usado | `usedPercent(usage, budget, now)` = `max(hour / maxTokensPerHour, day / maxTokensPerDay) × 100` sobre `usageTotals`, só nas janelas com limite; limite ausente ou `0` → aquela janela não conta; sem nenhuma janela → `0` | Mesma semântica de "ausente ou 0 = sem limite" do item 5; a janela mais apertada manda. Sem dado = sem restrição, nunca o contrário |
| Combinação das faixas | Disparam todas as faixas com `percent <= usado`; `signal` = a pior entre as disparadas (`green < yellow < red`), `maxWorkers` = o menor entre as disparadas; nenhuma disparada → `{ signal: 'green' }` sem a chave `maxWorkers` | A tabela é cumulativa (80% já passou por 50% e 60%); ordem do array não importa |
| Manual × dinâmico | Sinal efetivo = o pior entre `state.signal` e o dinâmico; teto efetivo = `min(state.maxConcurrent, maxWorkers dinâmico)` | "Manual continua tendo prioridade" = vermelho à mão não vira verde; e o dinâmico também só pode restringir, nunca abrir |
| Onde as regras vivem | `Config.usageRules` (default `[]`), copiado pra `State.usageRules` por um evento `setUsageRules` no `configure` / `reconfigure`, e por `hive.ts` no boot — o mesmo caminho que `budget` já faz | O reducer só enxerga `State`; copiar segue o padrão do item 5 e deixa `limits` puro |
| Reduzir workers | Não drena (`setMax` continua sendo o único que marca `draining`). `fill` só deixa de abrir job enquanto `ocupados >= teto efetivo`; `N/M workers ativos` continua mostrando `state.maxConcurrent` | Roadmap: "reduzir workers não finaliza os que estão rodando" |
| Porta única | `canStart(signal, slots, limit?)`: verde **e** slot `vazio` sem `draining` **e** (`limit` ausente ou `ocupados < limit`); `fill` consulta antes de cada spawn com o sinal e o teto efetivos, e continua exigindo `hasBudget` | Roadmap do item 4: "o item 6 acrescenta o orçamento na mesma porta". `hasBudget` fica como está: é a linha dos 100% |
| Vermelho dinâmico | `Stop` marca `paused` quando o sinal **efetivo** é vermelho (já com a amostra daquele turno contada); `setSignal` só limpa `paused` se o sinal efetivo após a troca não é vermelho | Vermelho por orçamento se comporta como vermelho manual; senão o card mentiria |
| Quando o dinâmico afrouxa | Nenhum evento próprio: as amostras saem da janela com o tempo, e o `poll` (30 s) já chama `fill`. O `poll` também limpa `paused` se o sinal efetivo deixou de ser vermelho | Mesma decisão do item 5 pra "quando o orçamento reabre"; latência de até 30 s é irrelevante |
| Config | `usageRules` só em `hive.config.json`; fora do formulário e de `SetupBody` (`saveSetup` passa `current?.usageRules` pro `parseConfig`, como faz com `port` e `claudeArgs`) | Ajuste raro, feito à mão; o formulário não ganha campo neste item |
| Validação | `percent` inteiro 0–100; `maxWorkers` inteiro ≥ 0; `signal` ∈ `green/yellow/red`; regra sem efeito → erro | Falhar no boot com mensagem nomeando o campo, como o resto do `parseConfig` |
| UI | Sem mudança | O medidor do item 5 já mostra o uso; "por que está amarelo" fica pra depois, se fizer falta |
| Fora | Campo no setup, mostrar o sinal/teto efetivo na UI, calibrar os percentuais | Depois de medir por alguns dias |

## Config

```jsonc
{
  "budget": { "maxTokensPerHour": 2000000, "maxTokensPerDay": 20000000 },
  "usageRules": [
    { "percent": 50, "maxWorkers": 4 },
    { "percent": 60, "maxWorkers": 3 },
    { "percent": 80, "signal": "yellow" },
    { "percent": 90, "signal": "red" }
  ]
}
```

## Tipos

```ts
interface UsageRule { percent: number; maxWorkers?: number; signal?: Signal }
interface UsageLimits { signal: Signal; maxWorkers?: number }

interface Config { /* item 5 */ usageRules: UsageRule[] }
interface State { /* item 5 */ usageRules: UsageRule[] }
type HiveEvent = /* … */ | { type: 'setUsageRules'; usageRules: UsageRule[] };
```

## `src/usage-rules.ts` (novo)

```ts
export const SIGNAL_RANK: Record<Signal, number>; // green 0, yellow 1, red 2
export function worstSignal(a: Signal, b: Signal): Signal;
export function usedPercent(usage: UsageSample[], budget: Budget, now: number): number;
export function applyUsageRules(usage: UsageSample[], budget: Budget, rules: UsageRule[], now: number): UsageLimits;
```

Puro; só importa `usageTotals` de `src/usage.ts`.

## Orquestrador (`orchestrator.ts`)

- `limits(state, now): UsageLimits` = `{ signal: worstSignal(state.signal, dyn.signal), maxWorkers: min(state.maxConcurrent, dyn.maxWorkers) }` onde `dyn = applyUsageRules(state.usage, state.budget, state.usageRules, now)`.
- `canStart(signal, slots, limit?)` como na tabela. `fill` calcula `now` e `limits` uma vez, exige `hasBudget`, e consulta `canStart` antes de cada spawn.
- `Stop`, `setSignal`, `poll` e `setUsageRules` usam o sinal efetivo pra marcar / limpar `paused`.
- `initialState` ganha `usageRules: []`.

## Config (`config.ts`)

`parseConfig` lê `usageRules` com a validação da tabela; `DEFAULT_CONFIG.usageRules = []`.

## Servidor (`server.ts`) e boot (`hive.ts`)

`configure` / `reconfigure` disparam `setUsageRules` quando o estado e a config diferem (como `setBudget`); `hive.ts` copia `config.usageRules` pro estado salvo no boot (como `budget`). `saveSetup` passa `usageRules: current?.usageRules`.

## Estado persistido (`state-store.ts`)

`normalize` preenche `usageRules: []` em arquivos antigos.

## Testes

- `test/usage-rules.test.ts` (novo): `usedPercent` sem amostras, sem limite, limite `0`, só hora, só dia, pior das duas, amostra fora da janela; `applyUsageRules` com a tabela do roadmap em 0 / 49 / 50 / 55 / 65 / 85 / 95 %; ordem do array irrelevante; regra só de sinal não cria a chave `maxWorkers`; `worstSignal`.
- `test/orchestrator.test.ts`: `canStart` com `limit`; `poll` sob teto dinâmico abre só até o teto e não drena; teto abaixo dos ocupados não emite `kill` nem `draining` e o slot liberado fica vazio; uso alto → sinal efetivo amarelo → `fill` não abre; `Stop` sob vermelho dinâmico marca `paused`; `setSignal green` com dinâmico vermelho mantém `paused`; `poll` com o uso fora da janela limpa `paused`; uso não limpa vermelho manual; `setUsageRules` copia e roda `fill`; sem regras tudo como antes.
- `test/config.test.ts`: `usageRules` ausente → `[]`; regra válida; `percent` fora de 0–100, `signal` inválido, regra sem efeito → erro nomeando o campo.
- `test/state-store.test.ts`: `state.json` sem `usageRules` carrega `[]`.
- `test/setup.test.ts`: `usageRules` do arquivo sobrevive a um segundo `POST /setup` e chega na config viva.

## Critério de pronto

1. `hive.config.json` com o exemplo acima e `state.json` com amostras recentes somando 85% do orçamento/hora: ao reabrir, `máx. workers` continua o da config, o medidor mostra o uso, mas nenhum job novo abre e os vivos seguem até o fim. Amostras fora da janela (ou zeradas) → volta a puxar da fila no próximo `poll`.
2. Sem `usageRules`, `pnpm test` e o comportamento manual são idênticos ao item 5.
3. `pnpm test` verde com os testes acima.
