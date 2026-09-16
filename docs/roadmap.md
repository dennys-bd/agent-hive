# Agent Hive — roadmap

Cada item vira seu próprio ciclo spec → plan → implementação. Ordem sugerida: 1 → 2 → 3 → 4.

## 1. Entrypoint por command (só config)

Hoje o worker recebe `promptTemplate` com `{number}`, `{title}`, `{body}`, `{url}`. Pra um command do Claude Code (ex.: um `/ship` que faz spec, plan e implementa), basta a config apontar pra ele:

```json
"promptTemplate": "/ship #{number}"
```

Nada a implementar. Vale documentar no README e talvez expor o template no formulário de configuração (hoje é só arquivo).

## 2. Board plugável: `.md`, Asana, …

Fronteira já existe: `src/board.ts` expõe `listQueue`, `setStatus`, `listProjects`, `listStatusOptions`. Um novo backend é outro arquivo com essas funções, escolhido por config:

```json
"board": { "type": "markdown", "path": "TASKS.md" }
"board": { "type": "github", "project": { "owner": "@me", "number": 6 } }
"board": { "type": "asana", "projectGid": "…" }
```

Decisões a fechar no spec: formato do `.md` (checklist por seção? front-matter por task?), como `setStatus` reescreve o arquivo sem perder o resto, o que o formulário de setup mostra por tipo de board.

## 3. Blockers / dependências

Uma task só entra na fila se não tem dependência aberta. `Task` ganha `blockedBy?: string[]`; o `fill` do orquestrador pula tasks bloqueadas (regra pura, testável). Cada adapter decide de onde vem a informação: no GitHub, sub-issues / `blockedBy`; no `.md`, uma convenção tipo `depends: #12`. O card/fila mostra "bloqueada por #12".

## 4. Orçamento de tokens

Único item que muda o modelo: hoje o orquestrador só sabe "slot vazio ou não". Precisa de (a) um sinal de uso por worker — o `Stop` hook entrega `transcript_path`, dá pra somar tokens de lá, ou ler `ccusage` — e (b) um orçamento na config (`maxTokensPerHour`, `maxTokensPerDay`). O `fill` passa a exigir "tem slot **e** tem orçamento". Estado ganha `usage`, UI ganha um medidor. Antes de virar regra, medir por alguns dias pra saber a ordem de grandeza.

## Pendências da v1

- Smoke test com workers reais (critérios 1–5 do spec v1) — aguardando go.
- Integrar `feat/agent-hive-v1` em `main` (merge ou PR).
- Parked nos ledgers: reconfigurar pra outro project com workers vivos; título do picker do Electron ainda cita `hive.config.json`; `resolveFields` roda duas vezes por save; hoist do check de `Host` pra antes do `express.json`.
