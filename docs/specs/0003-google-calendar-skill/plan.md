---
feature: google-calendar-skill
spec: "[[spec]]"
created: 2026-04-25
---
# Google Calendar Skill — Implementation Plan

> **For agentic workers:** Use a subagent-driven loop or inline execution to implement this plan task-by-task. Steps in `[[tasks]]` use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar a primeira skill funcional do Whis — `google-calendar` — via MCP server `@cocal/google-calendar-mcp@^2`, com multi-account (`personal` + `work`), timezone Brasil, confirmação enforced antes de toda escrita, e aposentadoria do `hello-world` (validador do MVP).

**Architecture:** Skill é **pure markdown** (`agent/skills/google-calendar/SKILL.md`). Toda integração é via `agent/mcp.json` declarando o server (npx-driven) + 1 regra absoluta nova em `agent/SOUL.md` reforçando o protocolo de confirmação. Worker code TypeScript **não muda**. Tokens OAuth persistem em volume Docker novo `gcal_tokens` mapeado em `/home/node/.config`. Setup do user é interativo via chat com Whis no Telegram (tool `manage-accounts` do MCP, sem script CLI novo).

**Tech Stack:** Igual a 0001/0002 (TS strict + Node 24 + pnpm 10 + Docker Compose). **Nova dependência runtime:** `@cocal/google-calendar-mcp@^2` baixada via `npx` em runtime (sem entrar em `package.json`). Sem Vitest/Biome touches (skill é markdown). Sem mudança no Dockerfile (Node + npx já existem).

---

## Approach

A spec garante que a integração Calendar é puramente declarativa do ponto de vista do worker — `agent/mcp.json` declara o server, o loader em `apps/worker/src/agent/mcp.ts` (já existe, sem mudança) processa, e o Claude Agent SDK injeta as tools. A skill é o "prompt-engineering layer" que ensina o Whis a (a) escolher entre as tools certas pra cada intent, (b) rotear entre accounts `personal`/`work` por inferência semântica, (c) sempre passar `timeZone: "America/Sao_Paulo"` em ops temporais, (d) seguir o protocolo de 3 passos antes de qualquer write (resumo → aguarda `sim` → executa → confirma).

A primeira tarefa é **Task 0: Discovery**, que valida em runtime real (não assumido) duas peças do MCP `@cocal/google-calendar-mcp@^2.6` que a spec deixou como Open Questions: (1) shape exato do `manage-accounts auth` flow — single-call (URL → wait callback) vs two-call (URL → user paste code → second call passa code), porque G1 da spec depende disso; (2) path exato onde a lib salva os tokens — `~/.config/google-calendar-mcp/` vs `~/.config/@cocal/google-calendar-mcp/` — porque define se o volume mount em `/home/node/.config` é largo o suficiente. Findings em `docs/specs/0003-google-calendar-skill/discovery-notes.md`.

A entrega tem **8 tasks**: discovery + 6 mudanças focadas (gitignore, compose, mcp.json, SOUL, SKILL, hello-world removal) + smoke manual. O agrupamento maximiza commits pequenos e ortogonais. SKILL.md (Task 5) é o artefato com mais conteúdo a escrever (~150 linhas de markdown) — essa task tem a maior carga, todas as outras são trocas pontuais.

A constraint **"worker code não muda"** é validada por inspeção: nenhuma task toca em `apps/worker/src/`, `packages/`, ou tests. Quality-gate roda no fim só pra confirmar que ninguém quebrou nada — count de tests permanece 91.

## Architecture

```
                docker network interno
        ┌───────────────────────────────────┐
        │  whis-worker (Node)               │
        │                                   │
        │  Claude Agent SDK                 │
        │      │                            │
        │      │ stdio                      │
        │      ▼                            │
        │  ┌──────────────────────┐         │
        │  │ npx @cocal/google-   │         │
        │  │   calendar-mcp@^2    │  HTTPS  │  ────►  api.google.com
        │  │                      │  ─────────────►   /calendar/v3
        │  │  - 12 tools          │         │  ◄──────  + OAuth refresh
        │  │  - multi-account     │         │
        │  │  - tokens em fs      │         │
        │  └──────────────────────┘         │
        │           │                       │
        │           ▼                       │
        │  /home/node/.config/              │
        │   └─ google-calendar-mcp/         │
        │       ├─ personal.json (oauth)    │
        │       └─ work.json (oauth)        │
        │      ▲                            │
        │      │ volume gcal_tokens         │
        └──────┼────────────────────────────┘
               │
               ▼
        [ host volume "gcal_tokens" — persiste rebuilds ]


        agent/skills/google-calendar/SKILL.md      ← injetado no system prompt (always_active)
        agent/mcp.json                              ← declara o server pro SDK
        agent/SOUL.md (Regras absolutas)            ← +1 linha enforcing confirmação write
        profile/google-credentials.json (gitignored) ← OAuth Desktop app credentials
```

**Component responsibilities:**

- **MCP server `@cocal/google-calendar-mcp@^2`** — externo, executado via npx pelo Claude Agent SDK. Expõe 12 tools, gerencia OAuth, persiste tokens. Não nosso código.
- **`agent/mcp.json`** — declara o server (command, args, env). Loader (`apps/worker/src/agent/mcp.ts`) já trata interpolação e logs. Sem mudança no loader. **Modificado.**
- **`agent/SOUL.md`** — +1 regra absoluta na seção *"Regras absolutas de segurança"* enforcing protocolo de confirmação antes de write. **Modificado (1 linha).**
- **`agent/skills/google-calendar/SKILL.md`** — instruções pro Whis: when_to_use, ferramentas, protocolo de 3 passos, formato MarkdownV2 de eventos, padrões G1-G7, roteamento de account. **Novo.**
- **`agent/skills/hello-world/`** — diretório inteiro **deletado**. Foi validador do MVP, missão cumprida.
- **`profile/google-credentials.example.json`** — template do JSON do OAuth Desktop app (estrutura sem segredos). **Novo (committed).**
- **`profile/google-credentials.json`** — real, gitignored. Criado pelo user uma vez (download do Google Cloud Console). **Não committed.**
- **`infra/docker-compose.yml`** — adiciona volume `gcal_tokens` em `whis-worker.volumes` + na seção `volumes:` raiz. **Modificado.**
- **`.gitignore`** — adiciona `profile/google-credentials.json`. **Modificado.**
- **`SMOKE.md`** — nova seção "Setup Google Calendar" com Etapas 1-3 + troubleshooting. **Modificado.**
- **`AGENTS.md`** — atualiza tabela de "Locais de conhecimento" referenciando spec 0003. **Modificado.**
- **`docs/specs/0003-google-calendar-skill/discovery-notes.md`** — findings da Task 0. **Novo.**
- **`docs/specs/0003-google-calendar-skill/smoke-results.md`** — resultados do smoke. **Novo (Task 7).**

## Tech Stack

- **Runtime:** Node.js 24 (já temos).
- **MCP server:** `@cocal/google-calendar-mcp@^2` via `npx -y` (zero install no Dockerfile; npx baixa em runtime e cacheia em `/home/node/.npm`).
- **OAuth:** scope `https://www.googleapis.com/auth/calendar` (full read+write).
- **Cloud setup:** Google Cloud project + Calendar API enabled + OAuth consent screen (External, Testing) + Desktop app credentials. ~5min manual no console.
- **Storage tokens:** filesystem em `/home/node/.config/google-calendar-mcp/` (path validado em Task 0). Volume Docker `gcal_tokens` persiste.
- **Tests:** zero novos. Skill é markdown — validação é via smoke manual.

## File Structure

🆕 = novo, 🔧 = modificado, 🗑 = deletado, ✅ = não muda.

**`agent/`:**
- `skills/google-calendar/SKILL.md` 🆕 — skill markdown
- `skills/hello-world/SKILL.md` 🗑 — aposentado
- `skills/hello-world/` 🗑 — diretório inteiro
- `mcp.json` 🔧 — adiciona entry google-calendar
- `SOUL.md` 🔧 — +1 regra absoluta

**`profile/`:**
- `google-credentials.example.json` 🆕 — template
- `config.yaml` ✅ — `always_active_skills: []` permanece (ver Task 6 pra detalhe)

**`infra/`:**
- `docker-compose.yml` 🔧 — volume `gcal_tokens`

**Root:**
- `.gitignore` 🔧 — adiciona `profile/google-credentials.json`
- `SMOKE.md` 🔧 — seção Setup Google Calendar + troubleshooting
- `AGENTS.md` 🔧 — referencia spec 0003

**`apps/worker/src/`:** ✅ — **nada muda**. Loader de mcp.json já existe e funciona (validado em Task 0).

**`docs/specs/0003-google-calendar-skill/`:**
- `spec.md` ✅ — já escrita e aprovada
- `plan.md` 🆕 — este arquivo
- `tasks.md` 🆕
- `discovery-notes.md` 🆕 — Task 0
- `smoke-results.md` 🆕 — Task 8

## Phase Ordering

Cada fase termina em estado verificável.

1. **Phase 1: Discovery (Task 0)** — não-código. Estado: `discovery-notes.md` commitado, manage-accounts flow validado, path dos tokens confirmado.
2. **Phase 2: Infra & Templates (Tasks 1-3)** — `.gitignore`, `profile/google-credentials.example.json`, `infra/docker-compose.yml`, `agent/mcp.json`. Estado: `pnpm run quality-gate` continua verde, `docker compose config` valida.
3. **Phase 3: SOUL.md (Task 4)** — 1 linha nova de regra absoluta. Estado: SOUL parseável, system_prompt loaded.
4. **Phase 4: SKILL.md (Task 5)** — a maior task, ~150 linhas de markdown. Estado: SKILL parseável (frontmatter válido), referencia tools que existem no MCP.
5. **Phase 5: hello-world removal (Task 6)** — `git rm -r agent/skills/hello-world/`. Estado: README/SMOKE referências verificadas.
6. **Phase 6: Docs (Task 7)** — SMOKE.md + AGENTS.md updates. Estado: humano em PC limpo consegue seguir Setup Google Calendar do SMOKE.md sem perguntar.
7. **Phase 7: Smoke manual (Task 8)** — execução G1-G7 da spec. Estado: `smoke-results.md` commitado, spec frontmatter `status: shipped`.

**Dependencies notáveis:**
- Tasks 1-3 podem ser paralelizadas (independentes entre si).
- Task 5 (SKILL.md) depende de Task 0 (precisa ter manage-accounts flow validado pra documentar G1 corretamente).
- Task 6 depende de Tasks 5 + Task 4 (hello-world só pode ser deletado quando google-calendar já estiver pronto pra ser a única skill).
- Task 8 depende de tudo anterior + setup manual do user no Google Cloud Console.

## Notas operacionais

- **Compose change exige rebuild** — adicionar volume implica `docker compose down` + `docker:build` (ou só `up -d --force-recreate`) pra propagar.
- **`npx` cold start** adiciona ~3-5s no primeiro boot (download da lib). Subsequentes usam cache em `/home/node/.npm`. Não persistido em volume na v1; aceito.
- **Backward compat:** spec 0001 (WhatsApp) e 0002 (Telegram) intactas. WhatsApp dormente (`WHATSAPP_ENABLED=false` default) continua sem subir Postgres+Evolution. Skill funciona em ambos canais quando ativos — single SOUL+SKILL atende qualquer canal.
- **`mcp.ts` loader** já loga `mcp_server_enabled name=google-calendar layer=agent` quando carrega. SC#15 da spec satisfeito sem mudança de código.

## Risks / Open Decisions

**Locked-in pelo brainstorming (não re-abrir sem voltar à spec):**
- MCP `@cocal/google-calendar-mcp@^2` (`@^2` pinado pra evitar major bump acidental).
- Pure markdown skill (sem TS novo no worker).
- OAuth Desktop app, scope `calendar` full.
- Multi-account `personal` + `work`, roteamento por inferência semântica (SOUL extension).
- Tokens em volume Docker `gcal_tokens`.
- Setup via chat com Whis (sem script `pnpm run gcal:setup`).
- Confirmação enforced via SKILL.md + regra absoluta em SOUL.md.
- Hello-world aposentada nesta entrega.

**Resolvíveis em Task 0 (Discovery):**
- ~~Versão exata pinada~~ — `^2.6` (latest minor era 2.6.1 em mar/2026; npx pega latest com `@^2`).
- Shape exato do `manage-accounts auth` flow — one-shot (URL retorna, MCP escuta callback HTTP) vs two-shot (URL retorna, user cola code, segunda call). Define G1.5-9 da spec.
- Path exato dos tokens — `~/.config/google-calendar-mcp/` vs `~/.config/@cocal/google-calendar-mcp/`. Volume mount em `/home/node/.config` é largo o suficiente em ambos casos, mas vale documentar.

**Aceitos como conhecidos:**
- Whis "esquecer" de pedir confirmação — regra absoluta em SOUL.md + few-shot examples em SKILL.md. Risco residual aceito.
- OAuth scope `calendar` (full) é amplo — é teu próprio account, ok pra v1.
- `npx` cold start lento — ~3-5s aceito.

**Riscos novos:**
- Task 0 pode descobrir que `manage-accounts` exige callback HTTP em porta específica, o que invalida G1 (que assume paste-code). Mitigação: SKILL.md fica condicional — se MCP exigir callback, instruções mudam pra "abre URL, autoriza, copy URL final" e pode exigir port mapping no compose. Re-spec se grave.

---

Execução detalhada está em `[[tasks]]`.
