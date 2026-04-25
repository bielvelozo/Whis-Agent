# Whis — Agent Instructions

Whis é um agente pessoal. O dono desta instância é descrito em `profile/USER.md` (gitignored — `profile/USER.example.md` é o template). Este repositório é o workspace do Whis — onde sua identidade, capacidades, configuração e conhecimento operacional vivem.

## Antes de começar qualquer trabalho

1. Leia `docs/specs/0001-whis-mvp/spec.md` pra entender o escopo do MVP.
2. Se for implementar, modificar ou criar algo, decida: "Consigo descrever a solução completa em uma frase?"
   - **Sim** → implemente direto.
   - **Não** → use o flow `/brainstorming` → `spec.md` → `/writing-plans` → `plan.md` + `tasks.md` → implementação.
3. Se o usuário está apenas perguntando ou explorando — apenas responda.

## Comandos

O projeto é um monorepo Turborepo orquestrado por pnpm workspaces. **Todo runtime é Docker-only** — não há `pnpm dev`/`start` pra rodar apps localmente fora do container. Use `pnpm run quality-gate` pra feedback rápido local.

| Comando | O que faz |
|---|---|
| `pnpm run quality-gate` | Lint + typecheck + tests em todos os workspaces (via `turbo run`). Rápido, local, gate de cada commit. |
| `pnpm run lint` / `typecheck` / `test` / `build` | Passes individuais. |
| `pnpm run docker:build` | Builda a imagem multi-stage. |
| `pnpm run docker:up` / `down` / `logs` / `sh` | Lifecycle do container. |
| `pnpm run docker:setup-token` | Helper one-time pra obter o token Claude OAuth. |
| `pnpm run evolution:setup` | Cria instância Evolution + QR code. |

## Layout dos workspaces

```
apps/worker/          Listener WhatsApp + agent core + webhook server (Node)
packages/storage/     @whis/storage — DB + repos
packages/logger/      @whis/logger — pino factory
infra/                Dockerfile + docker-compose + entrypoint + setup-evolution
agent/                SOUL.md, mcp.json, skills/ (identidade — built-in)
profile/              .env, USER.md, config.yaml, mcp.json, skills/ (config pessoal)
context/              Vault Obsidian (gitignored — copiado de context.example/)
docs/specs/           Specs por feature, no formato Zeno (numerada)
```

## Locais de conhecimento

| O quê | Onde |
|---|---|
| Spec do MVP | `docs/specs/0001-whis-mvp/spec.md` |
| Plano de implementação | `docs/specs/0001-whis-mvp/plan.md` + `tasks.md` |
| Findings da Discovery | `docs/specs/0001-whis-mvp/discovery-notes.md` |
| Identidade do agente | `agent/SOUL.md` |
| Perfil do usuário | `profile/USER.md` (gitignored) |
| Configuração de skills | `profile/config.yaml` |

## Convenções

- **Idioma:** PT-BR no SOUL.md, no USER.md, e nos commits. Código + comentários técnicos em inglês.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `build:`). Sempre com footer `Co-Authored-By`.
- **Branches:** trabalhe em `main` direto pra MVP (uso pessoal solo). Quando virar multi-pessoa, branches por feature.
- **Specs:** numeradas (`0001-`, `0002-`, ...) seguindo o padrão Zeno.
