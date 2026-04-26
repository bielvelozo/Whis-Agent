---
feature: scheduled-messages
spec: "[[spec]]"
created: 2026-04-26
---
# Scheduled Messages Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recomendado pra esta plan, ~10 tasks, várias camadas) ou `superpowers:executing-plans` pra rodar inline. Steps em `[[tasks]]` usam checkbox `- [ ]` pra tracking.

**Goal:** Adicionar a segunda skill funcional do Whis — `scheduled-messages` — pra agendar mensagens proativas via Telegram, cobrindo recorrentes dinâmicos (bom dia + agenda) e one-shots literais (lembrete simples), com captura por anotação livre, storage SQLite próprio, engine in-process (loop tick 60s DB-driven), e 6 tools expostas via `inProcessMcpServers`.

**Architecture:** Skill markdown (`agent/skills/scheduled-messages/SKILL.md`) + nova tabela SQLite `scheduled_messages` (`@whis/storage`) + dispatcher in-process (`apps/worker/src/scheduler/`) + 6 tools criadas via `createSdkMcpServer` do Claude Agent SDK (mesmo process do worker, acesso direto ao repo via closure). Modo híbrido `kind: 'literal' | 'agent'` decidido pelo Whis na criação. Modo agent reusa `core.bind()` via novo `AgentCore.dispatchSynthetic(msg)` com flag `[scheduled_trigger]` no wrapper de contexto. Catch-up só pra one-shots <24h; recorrentes recalculam `next_fire_at` sem disparar retroativo.

**Tech Stack:** TS strict + Node 24 + pnpm 10 + Vitest + Docker Compose (existentes). **Nova dependência runtime:** `cron-parser` (~50KB, sem deps nativas) pra parsing de cron strings. **Nova API do SDK usada:** `createSdkMcpServer` do `@anthropic-ai/claude-agent-sdk` (slot `inProcessMcpServers` já cabeado no `ClaudeCodeBackend`). `zod` pra schemas das tools (já é peer-dep do SDK).

---

## Approach

A spec garante separação dura: Google Calendar = eventos formais, `scheduled-messages` = lembretes pessoais leves. Engine in-process com loop tick 60s elimina divergência DB-vs-memória do `node-cron`. Storage é tabela própria SQLite (`scheduled_messages`), nunca toca em `messages` ou `sessions`.

A primeira tarefa é **Task 0: Discovery**, que valida em runtime real (não assumido) duas peças:

1. **Lib `cron-parser` API + peso final.** Confirmar que aceita timezone string (`'America/Sao_Paulo'`), retorna iterator com `.next()`, valida cron strings malformadas com erro estruturado, e bundle size pós-`pnpm install` continua razoável (<100KB).
2. **`createSdkMcpServer` API surface.** Importar do `@anthropic-ai/claude-agent-sdk` e verificar shape exato (signature, schema format esperado — `zod` ou JSON Schema?), output format esperado pelas tools, e como a SDK injeta no `mcpServers` quando passado via `inProcessMcpServers`. Findings em `discovery-notes.md`.

A entrega tem **10 tasks** (1 discovery + 8 implementation + 1 smoke), agrupadas em 9 fases. Cada task termina em commit. O plan é TDD-first em tudo que toca lógica (repo, dispatcher, tools): teste falha → impl mínima → teste passa → commit. Markdown e wire-up (Tasks 7, 8) não têm test automatizado — validação é via boot real + smoke manual (Task 9).

A constraint **"worker code muda significativamente"** (diferente da spec 0003 que era pure markdown) implica que o quality-gate precisa subir de 91 → ~140 tests. Cada task de código adiciona seu bloco de tests no mesmo commit.

## Architecture

```
                   apps/worker (single Node process)
        ┌───────────────────────────────────────────────────────────────┐
        │                                                               │
        │  ┌──────────────────┐         ┌──────────────────────────┐    │
        │  │ Telegram channel │◄───────►│       AgentCore          │    │
        │  │ (existente)      │         │  - bind(channel)         │    │
        │  └──────────────────┘         │  - dispatchSynthetic 🆕  │    │
        │                               └──────────┬───────────────┘    │
        │                                          │                    │
        │                                          ▼                    │
        │                              ┌────────────────────────┐       │
        │                              │  ClaudeCodeBackend     │       │
        │                              │  + inProcessMcpServers │       │
        │                              │    (slot existente)    │       │
        │                              └──────────┬─────────────┘       │
        │                                         │ injeta              │
        │  ┌──────────────────────────────────────┼──────────────────┐  │
        │  │  NEW: scheduler/ subsystem           │                  │  │
        │  │                                      ▼                  │  │
        │  │   ┌────────────────────────────────────────────────┐    │  │
        │  │   │ In-process MCP server "scheduled-messages"     │    │  │
        │  │   │ (createSdkMcpServer + 6 zod-typed tools)       │    │  │
        │  │   │  schedule_list / create / edit / cancel /      │    │  │
        │  │   │  pause / resume                                │    │  │
        │  │   └─────────────────┬──────────────────────────────┘    │  │
        │  │                     │ closure                           │  │
        │  │                     ▼                                   │  │
        │  │   ┌──────────────────────────────────┐                  │  │
        │  │   │ ScheduledMessageRepo 🆕          │◄── @whis/storage │  │
        │  │   │ (SQLite, migration_002)          │                  │  │
        │  │   └─────────────┬────────────────────┘                  │  │
        │  │                 │                                       │  │
        │  │                 ▼                                       │  │
        │  │   ┌─────────────────────────────────────────────────┐   │  │
        │  │   │ ScheduledDispatcher 🆕 (loop tick 60s)          │   │  │
        │  │   │  - start(): catch-up + setInterval              │   │  │
        │  │   │  - tick(): SELECT due → dispatch → recompute    │   │  │
        │  │   │  - kind=literal:  channel.send(target, payload) │   │  │
        │  │   │  - kind=agent:    core.dispatchSynthetic(msg)   │   │  │
        │  │   │  - stop(): clearInterval + await tick em curso  │   │  │
        │  │   └─────────────────────────────────────────────────┘   │  │
        │  └────────────────────────────────────────────────────────┘   │
        └───────────────────────────────────────────────────────────────┘

        agent/skills/scheduled-messages/SKILL.md  ← injetado no system prompt
        agent/SOUL.md (Regras absolutas)          ← +1 linha (paralela à do Calendar)
```

**Component responsibilities:**

- **`packages/storage/src/db.ts`** — adiciona `MIGRATION_002` (CREATE TABLE scheduled_messages + índice). Idempotente, additive only. **Modificado.**
- **`packages/storage/src/scheduled-message-repo.ts`** — novo repo. Métodos: `insert`, `findById`, `findByTitle`, `findDue(now)`, `list(filter, limit)`, `markFired(id, now, nextFireAt)`, `delete(id)`, `pause(id)`, `resume(id, nextFireAt)`, `update(id, fields)`. Prepared statements + transações. **Novo.**
- **`packages/storage/src/scheduled-message-repo.test.ts`** — Vitest cobrindo CRUD + edge cases (boundary `next_fire_at`, paused=1 ignorado, transação atômica em update). **Novo.**
- **`packages/storage/src/index.ts`** — re-exporta `ScheduledMessageRepo` + `ScheduledMessageRecord`. **Modificado.**
- **`apps/worker/src/scheduler/dispatcher.ts`** — `ScheduledDispatcher` class. Constructor recebe `repo`, `channels`, `agentCore`, `ownerChatId`, `catchUpWindowMs`, `tickMs`, `logger`. **Novo.**
- **`apps/worker/src/scheduler/dispatcher.test.ts`** — Vitest com fake timers + mocks. Casos: boot recovery (3 cenários), tick dispara literal/agent, erro isolado por entry. **Novo.**
- **`apps/worker/src/scheduler/cron.ts`** — wrapper sobre `cron-parser`. `computeNextFire(cron, tz, from)` + `validateCron(cron)`. Centraliza exposição da lib (facilita troca futura). **Novo.**
- **`apps/worker/src/scheduler/cron.test.ts`** — Vitest. **Novo.**
- **`apps/worker/src/scheduler/tools.ts`** — `createScheduledMessagesMcpServer(deps)` — factory que retorna `InProcessMcpServer` com 6 tools. Cada tool: zod schema input, handler que valida + chama repo + retorna output JSON. **Novo.**
- **`apps/worker/src/scheduler/tools.test.ts`** — Vitest. Cada tool: input válido / inválido (cron malformado, when no passado, id inexistente) / proteção contra `userId === 'system:scheduler'` em writes. **Novo.**
- **`apps/worker/src/agent/core.ts`** — adiciona método `dispatchSynthetic(msg)`. Adiciona campo opcional `scheduledTrigger` em `IncomingMessage` (via extension de `channels/types.ts`). Modifica `wrapWithTelegramContext` pra incluir `scheduled_trigger:` block quando presente. **Modificado.**
- **`apps/worker/src/agent/core.test.ts`** — +5 cases pro `dispatchSynthetic` e wrapper. **Modificado.**
- **`apps/worker/src/channels/types.ts`** — adiciona campo opcional `scheduledTrigger?: { id: number; title: string }` em `IncomingMessage`. **Modificado.**
- **`apps/worker/src/index.ts`** — instancia `ScheduledMessageRepo`, `ScheduledDispatcher`, registra MCP server in-process no backend. Adiciona `dispatcher.start()` após canais subirem; `dispatcher.stop()` no shutdown. **Modificado.**
- **`agent/skills/scheduled-messages/SKILL.md`** — skill markdown (~150 linhas). Seções 1-8 do design. **Novo.**
- **`agent/SOUL.md`** — +1 regra absoluta paralela à do Calendar. **Modificado.**
- **`agent/skills/google-calendar/SKILL.md`** — +1 nota de "Quando NÃO usar" apontando pra `scheduled-messages`. **Modificado.**
- **`SMOKE.md`** — nova seção "Smoke `scheduled-messages`" com SM1-SM9. **Modificado.**
- **`AGENTS.md`** — já modificado no commit do spec (linha referenciando spec 0004 — feito em `427776a`). **Sem mudança nesta entrega.**
- **`apps/worker/package.json`** — adiciona `cron-parser` em `dependencies`. **Modificado.**
- **`docs/specs/0004-scheduled-messages/discovery-notes.md`** — Task 0 findings. **Novo.**
- **`docs/specs/0004-scheduled-messages/smoke-results.md`** — Task 9 resultados. **Novo.**

## Tech Stack

- **Runtime:** Node.js 24 (já temos).
- **Lib nova:** `cron-parser@^4` — parse + iterator de cron strings com suporte a timezone.
- **In-process MCP:** `createSdkMcpServer` do `@anthropic-ai/claude-agent-sdk` (já é dep). Tool schemas via `zod` (peer dep do SDK).
- **DB:** SQLite via `better-sqlite3` — single-process, single-connection (constraint atual).
- **Tests:** Vitest com fake timers (`vi.useFakeTimers()`) pro dispatcher; `:memory:` DB pros repos.
- **Setup user:** **zero** — feature funciona sem config adicional. Skill é always-active by default (igual `google-calendar`).

## File Structure

🆕 = novo, 🔧 = modificado, ✅ = não muda.

**`packages/storage/src/`:**
- `db.ts` 🔧 — MIGRATION_002 + entry no array MIGRATIONS
- `scheduled-message-repo.ts` 🆕 — repo
- `scheduled-message-repo.test.ts` 🆕 — tests do repo
- `index.ts` 🔧 — re-export

**`apps/worker/src/`:**
- `scheduler/dispatcher.ts` 🆕
- `scheduler/dispatcher.test.ts` 🆕
- `scheduler/cron.ts` 🆕
- `scheduler/cron.test.ts` 🆕
- `scheduler/tools.ts` 🆕
- `scheduler/tools.test.ts` 🆕
- `agent/core.ts` 🔧 — dispatchSynthetic + wrapper extension
- `agent/core.test.ts` 🔧 — +5 cases
- `channels/types.ts` 🔧 — campo opcional scheduledTrigger
- `index.ts` 🔧 — wire-up

**`apps/worker/`:**
- `package.json` 🔧 — `cron-parser`

**`agent/`:**
- `skills/scheduled-messages/SKILL.md` 🆕
- `skills/google-calendar/SKILL.md` 🔧 — nota "Quando NÃO usar"
- `SOUL.md` 🔧 — +1 regra absoluta

**Root:**
- `SMOKE.md` 🔧 — seção SM1-SM9
- `AGENTS.md` ✅ — já feito no commit do spec

**`docs/specs/0004-scheduled-messages/`:**
- `spec.md` ✅ — committed em `427776a`
- `plan.md` 🆕 — este arquivo
- `tasks.md` 🆕
- `discovery-notes.md` 🆕 — Task 0
- `smoke-results.md` 🆕 — Task 9

## Phase Ordering

Cada fase termina em estado verificável (quality-gate verde + commit).

1. **Phase 1: Discovery (Task 0).** Valida `cron-parser` + `createSdkMcpServer`. Estado: `discovery-notes.md` commitado, lib instalada via `pnpm add`.
2. **Phase 2: Storage layer (Task 1).** Migration_002 + repo + tests. Estado: ~15 novos tests passando, `pnpm test --filter @whis/storage` verde.
3. **Phase 3: Cron wrapper (Task 2).** `cron.ts` + tests. Estado: ~6 tests passando, lib isolada atrás de wrapper.
4. **Phase 4: AgentCore.dispatchSynthetic (Task 3).** Método novo + extensão de wrapper + tests. Estado: ~5 tests novos passando, `core.bind` existente intacto.
5. **Phase 5: ScheduledDispatcher (Task 4).** Classe + tests com fake timers. Estado: ~12 tests passando, dispatcher unitariamente verde, sem wire-up ainda.
6. **Phase 6: In-process MCP tools (Task 5).** 6 tools + tests. Estado: ~18 tests passando, tools chamam repo sem precisar do SDK rodando.
7. **Phase 7: Wire-up no index.ts (Task 6).** Instancia tudo, registra no backend, start/stop. Estado: `pnpm run quality-gate` verde, container sobe sem erro, log `scheduler_started`.
8. **Phase 8: Skills + SOUL (Task 7).** SKILL.md novo + nota no google-calendar + regra no SOUL. Estado: arquivos parseáveis, `soul_md_loaded` mostra bytes maiores no boot.
9. **Phase 9: Docs (Task 8).** SMOKE.md ganha SM1-SM9. Estado: humano em PC limpo consegue rodar smoke do SMOKE.md sem perguntar.
10. **Phase 10: Smoke manual (Task 9).** Executa SM1-SM9 via Telegram. Estado: `smoke-results.md` commitado, spec frontmatter `status: shipped`.

**Dependencies notáveis:**
- Task 1 (storage) é blocker pra Tasks 4 (dispatcher precisa do repo) e 5 (tools precisam do repo).
- Task 2 (cron) é blocker pra Task 4 (dispatcher) e 5 (tools).
- Task 3 (dispatchSynthetic) é blocker pra Task 4 (dispatcher precisa pra modo agent).
- Task 6 (wire-up) é blocker pra Task 9 (smoke). Tasks 7 e 8 podem rodar em paralelo a 6.
- Task 4 e 5 são paralelas entre si (dispatcher não chama tools nem vice-versa).

## Notas operacionais

- **Compose change não é necessário** — sem novos volumes, portas ou env vars. `whis_data` (já existe) persiste o SQLite com a tabela nova.
- **Migration roda automática no boot** via `runMigrations(db)` em `index.ts:67` (existente). Schema_version sobe pra 2 silenciosamente.
- **Sem mudança no Dockerfile** — `cron-parser` é pure JS, instala via `pnpm install` no build stage existente.
- **Backward compat:** spec 0001 (WhatsApp), 0002 (Telegram), 0003 (Calendar) intactas. Whis com Telegram + Calendar continua funcionando se a feature nova for desabilitada (basta não registrar o MCP server in-process — feito por skip no `index.ts` se preferir guard por env futuro). v1 sempre ativa.
- **Logs estruturados:** novos events `scheduler_*` definidos na spec — buscáveis em `pnpm run docker:logs:local` durante smoke.
- **Quality-gate alvo:** 91 tests atuais + ~50 novos = ~141 tests, todos verdes.

## Risks / Open Decisions

**Locked-in pelo brainstorming (não re-abrir sem voltar à spec):**
- Modo híbrido `kind: 'literal' | 'agent'` decidido na criação.
- Storage SQLite tabela própria (separação dura de Calendar).
- Engine A2 (loop tick 60s DB-driven, sem `node-cron`).
- Trigger model B1 (reusa `core.bind` via `dispatchSynthetic`).
- Tools via `createSdkMcpServer` (in-process, slot já cabeado no backend).
- Catch-up só pra one-shots <24h; recorrentes recalculam sem disparar.
- Operações v1: criar + listar + cancelar + editar + pausar/reativar.
- Confirmação enforced via SKILL.md + regra absoluta em SOUL.

**Resolvíveis em Task 0 (Discovery):**
- Versão exata de `cron-parser` (esperado `^4.x`, validar latest).
- API surface de `createSdkMcpServer`: shape do schema (zod nativo? JSON Schema?), shape do return da tool (objeto direto? `{ content: [{ type: 'text', text: ... }] }` estilo MCP?).
- Comportamento de `cron-parser` em DST (Brasil hoje sem horário de verão, mas teste defensivo).
- Confirmar que `pnpm add cron-parser --filter @whis/storage` ou `--filter worker` (decidir layer baseado em quem usa — provável `worker` só, já que cron wrapper mora em `apps/worker/src/scheduler/`).

**Aceitos como conhecidos:**
- Whis "esquecer" de pedir confirmação — regra absoluta em SOUL.md + few-shots na SKILL.md. Risco residual aceito.
- Drift de `setInterval` (±2s) aceito pra contexto pessoal.
- One-shot perdida >24h descartada silenciosamente — log é evidência suficiente.
- LLM gera prompt agent verboso na criação — aceito.

**Riscos novos:**
- Task 0 pode descobrir que `createSdkMcpServer` não está exportado publicamente do `@anthropic-ai/claude-agent-sdk` versão atual (ou tem nome diferente). Mitigação: o `ClaudeCodeBackend` já tem o slot `inProcessMcpServers` cabeado e o autor anotou "e.g. cron tools" — confirmar a API exata e ajustar nome do helper se necessário. Se for nome diferente, atualizar todas as tasks que importam.
- `cron-parser` pode não suportar timezone string (`'America/Sao_Paulo'`) na versão major considerada. Mitigação: alternativa `croner` (também aceita tz). Decisão na Task 0.

---

Execução detalhada está em `[[tasks]]`.
