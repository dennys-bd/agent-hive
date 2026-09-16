# Agent Hive — roadmap

Cada item vira seu próprio ciclo spec → plan → implementação.

| # | Feature | Status | Spec |
|---|---|---|---|
| 1 | Entrypoint por command (`promptTemplate` com slash command, editável no form) | ✅ feito | `docs/superpowers/specs/2026-09-16-hive-cli-and-setup-design.md` |
| 2 | Board plugável: GitHub + Markdown | ✅ feito | `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md` |
| 3 | Board Asana | ⏳ a fazer | — |
| 4 | Board Jira | ⏳ a fazer | — |
| 5 | Blockers / dependências | ⏳ a fazer | — |
| 6 | Orçamento de tokens | ⏳ a fazer | — |

## 1. Entrypoint por command — ✅

`promptTemplate` aceita `{id}` (`{number}` é sinônimo), `{title}`, `{body}`, `{url}`; um slash command funciona como prompt inicial (`"/ship #{id}"`). Editável no formulário de configuração.

## 2. Board plugável: GitHub + Markdown — ✅

`config.board.type` escolhe o adapter (`src/boards/github.ts`, `src/boards/markdown.ts`); interface `Board` = `resolveFields`, `listQueue`, `setStatus`, `setupOptions`. Markdown = tabela `| id | título | status |` num `.md` com o resto do arquivo livre; escrita só na célula de status. Config legada (`project`) ainda aceita.

## 3. Board Asana

Terceiro adapter, mesma interface. Config `{ "type": "asana", "projectGid": "…" }` com token via env (`ASANA_TOKEN`), nunca no arquivo. `status.*` mapeia pras *sections* do project; `listQueue` = tasks da section da fila; `setStatus` = mover a task de section; `setupOptions` = sections do project. Decisões a fechar no spec: token só por env ou também por keychain; `Task.id` = gid; `{url}` = permalink da task; paginação.

## 4. Board Jira

Quarto adapter, mesma interface. Config `{ "type": "jira", "site": "…atlassian.net", "projectKey": "ABC", "boardId"?: n }` com token via env (`JIRA_EMAIL` + `JIRA_TOKEN`). `status.*` mapeia pros status do workflow; `setStatus` precisa passar por *transitions* (não é um `PUT` no campo), então o adapter resolve a transition cujo destino é o status pedido. `Task.id` = key (`ABC-12`), `{url}` = browse link. Decisões: JQL da fila (só `status = queue` ou também `assignee`/sprint), cloud vs server.

## 5. Blockers / dependências

Uma task só entra na fila se não tem dependência aberta. `Task` ganha `blockedBy?: string[]`; o `fill` do orquestrador pula tasks bloqueadas (regra pura, testável). Cada adapter decide de onde vem a informação: GitHub → sub-issues / `blockedBy`; markdown → uma coluna opcional `depende de` ou convenção `depends: T-12`; Asana → dependencies; Jira → issue links "is blocked by". O card/fila mostra "bloqueada por T-12".

## 6. Orçamento de tokens

Único item que muda o modelo: hoje o orquestrador só sabe "slot vazio ou não". Precisa de (a) um sinal de uso por worker — o `Stop` hook entrega `transcript_path`, dá pra somar tokens de lá, ou ler `ccusage` — e (b) um orçamento na config (`maxTokensPerHour`, `maxTokensPerDay`). O `fill` passa a exigir "tem slot **e** tem orçamento". Estado ganha `usage`, UI ganha um medidor. Antes de virar regra, medir por alguns dias pra saber a ordem de grandeza.

## Pendências

- Smoke test da v1 com workers reais contra o GitHub (critérios 1–5 do spec v1) — aguardando go.
- Integrar `feat/agent-hive-v1` em `main` (merge ou PR).
- Parked nos ledgers: reconfigurar pra outro board/project com workers vivos mantém slots presos aos ids antigos; título do picker do Electron ainda cita `hive.config.json`; `resolveFields` roda duas vezes por save; hoist do check de `Host` pra antes do `express.json`; duas instâncias do board markdown no mesmo arquivo podem perder um de dois writes simultâneos (sem corromper).
