# Agent Hive — roadmap

Cada item vira seu próprio ciclo spec → plan → implementação.

| id | título | status | spec |
|---|---|---|---|
| 1 | Entrypoint por command (`promptTemplate` com slash command, editável no form) | feito | `docs/superpowers/specs/2026-09-16-hive-cli-and-setup-design.md` |
| 2 | Board plugável: GitHub + Markdown | feito | `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md` |
| 3 | Blockers / dependências | feito | `docs/superpowers/specs/2026-09-16-blockers-design.md` |
| 4 | Sinal verde / amarelo / vermelho | a fazer | — |
| 5 | Orçamento de tokens | a fazer | — |
| 6 | Sinal dinâmico por uso de tokens | a fazer | — |
| 7 | Board Asana | a fazer | — |
| 8 | Board Jira | a fazer | — |

Boards novos (7, 8) não são prioridade; ficam depois do sinal e do orçamento.

## 1. Entrypoint por command — feito

`promptTemplate` aceita `{id}` (`{number}` é sinônimo), `{title}`, `{body}`, `{url}`; um slash command funciona como prompt inicial (`"/ship #{id}"`). Editável no formulário de configuração.

## 2. Board plugável: GitHub + Markdown — feito

`config.board.type` escolhe o adapter (`src/boards/github.ts`, `src/boards/markdown.ts`); interface `Board` = `resolveFields`, `listQueue`, `setStatus`, `setupOptions`. Markdown = tabela `| id | título | status |` num `.md` com o resto do arquivo livre; escrita só na célula de status. Config legada (`project`) ainda aceita.


## 3. Blockers / dependências — feito

Uma task só entra na fila se não tem dependência aberta. `Task` ganha `blockedBy?: string[]`; o `fill` do orquestrador pula tasks bloqueadas (regra pura, testável). Cada adapter decide de onde vem a informação: GitHub → sub-issues / `blockedBy`; markdown → uma coluna opcional `depende de` ou convenção `depends: T-12`; Asana → dependencies; Jira → issue links "is blocked by". O card/fila mostra "bloqueada por T-12".

- Branch: worktree-hive-3-blockers-dependencias
- Plan: docs/superpowers/plans/2026-09-16-blockers.md
- PR: https://github.com/dennys-bd/agent-hive/pull/6

## 4. Sinal verde / amarelo / vermelho

Um estado global `signal: "green" | "yellow" | "red"` que o `fill` do orquestrador consulta antes de abrir job novo. **Verde**: comportamento atual. **Amarelo**: workers vivos terminam a iteração, mas nenhum job novo é iniciado. **Vermelho**: troca pra modo manual — cada worker pausa ao fim da iteração atual, e só volta quando o sinal sair do vermelho ou alguém retomar à mão. Nunca mata iteração no meio. Ajustável na UI (três botões) e por API. Regra pura e testável: `canStart(signal, slots)`.

## 5. Orçamento de tokens

Único item que muda o modelo: hoje o orquestrador só sabe "slot vazio ou não". Precisa de (a) um sinal de uso por worker — o `Stop` hook entrega `transcript_path`, dá pra somar tokens de lá, ou ler `ccusage` — e (b) um orçamento na config (`maxTokensPerHour`, `maxTokensPerDay`). O `fill` passa a exigir "tem slot **e** tem orçamento". Estado ganha `usage`, UI ganha um medidor. Antes de virar regra, medir por alguns dias pra saber a ordem de grandeza.

## 6. Sinal dinâmico por uso de tokens

Depende de 4 e 5. O sinal e o número de workers passam a ser derivados do `usage` contra o orçamento, por uma tabela de faixas na config, ex.:

| uso do orçamento | efeito |
|---|---|
| 50% | `maxWorkers` cai pra 4 |
| 60% | `maxWorkers` cai pra 3 |
| 80% | sinal amarelo |
| 90% | sinal vermelho |

Reduzir workers não finaliza os que estão rodando: só deixa de disparar job novo até a contagem viva ficar abaixo do novo teto. Sinal manual (item 4) continua tendo prioridade — se alguém pôs vermelho à mão, o dinâmico não sobe pra verde. Regra pura: `applyUsageRules(usage, budget, rules) → { signal, maxWorkers }`.


## 7. Board Asana

Terceiro adapter, mesma interface. Config `{ "type": "asana", "projectGid": "…" }` com token via env (`ASANA_TOKEN`), nunca no arquivo. `status.*` mapeia pras *sections* do project; `listQueue` = tasks da section da fila; `setStatus` = mover a task de section; `setupOptions` = sections do project. Decisões a fechar no spec: token só por env ou também por keychain; `Task.id` = gid; `{url}` = permalink da task; paginação.

## 8. Board Jira

Quarto adapter, mesma interface. Config `{ "type": "jira", "site": "…atlassian.net", "projectKey": "ABC", "boardId"?: n }` com token via env (`JIRA_EMAIL` + `JIRA_TOKEN`). `status.*` mapeia pros status do workflow; `setStatus` precisa passar por *transitions* (não é um `PUT` no campo), então o adapter resolve a transition cujo destino é o status pedido. `Task.id` = key (`ABC-12`), `{url}` = browse link. Decisões: JQL da fila (só `status = queue` ou também `assignee`/sprint), cloud vs server.

## Pendências

- Smoke test da v1 com workers reais contra o GitHub (critérios 1–5 do spec v1) — aguardando go.
- Integrar `feat/agent-hive-v1` em `main` (merge ou PR).
- Parked nos ledgers: reconfigurar pra outro board/project com workers vivos mantém slots presos aos ids antigos; título do picker do Electron ainda cita `hive.config.json`; `resolveFields` roda duas vezes por save; hoist do check de `Host` pra antes do `express.json`; duas instâncias do board markdown no mesmo arquivo podem perder um de dois writes simultâneos (sem corromper).
