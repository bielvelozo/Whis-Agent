# Whis

> **Agente pessoal de IA via WhatsApp, com vault Obsidian como memória durável.**

Whis (em homenagem ao personagem de Dragon Ball) é um agente pessoal self-hosted. O núcleo é deliberadamente pequeno: um listener de WhatsApp, um motor de raciocínio Claude, um vault Obsidian. Tudo o que o Whis *sabe fazer* — anotar, lembrar, ajudar com agenda, hábitos, trabalho — vive fora do core, como **skills** que você adiciona ao longo do tempo.

Baseado em [zeno-agent](https://github.com/ribeirogab/zeno-agent), com adaptações pro caso "WhatsApp + Obsidian + uso pessoal individual".

## Pré-requisitos

- Docker + Docker Compose.
- Plano Claude Pro ou Max (pra OAuth).
- Um número de WhatsApp dedicado (ou seu pessoal — risco de ban é baixo, mas anotado).
- Obsidian instalado pra editar o vault (opcional — você também pode editar `context/` direto em qualquer editor).

## Setup

```bash
# 1. Templates do profile
cp profile/.env.example profile/.env       # preencha EVOLUTION_API_KEY (gere string aleatória) e WHATSAPP_OWNER_NUMBER (seu número, formato 5511999999999)
cp profile/USER.example.md profile/USER.md # preencha com seu contexto pessoal/profissional
cp profile/mcp.example.json profile/mcp.json

# 2. Bootstrap do vault Obsidian
cp -r context.example context

# 3. Volume Docker (uma vez na vida)
docker volume create claude_home

# 4. Build
pnpm install
pnpm run docker:build

# 5. Token Claude OAuth (abre browser, copie token pro profile/.env)
pnpm run docker:setup-token
# → cole o token impresso no campo CLAUDE_CODE_OAUTH_TOKEN do profile/.env

# 6. Sobe os containers
pnpm run docker:up

# 7. Cria a instância Evolution + QR code
pnpm run evolution:setup
# → escaneie no WhatsApp: Configurações → Aparelhos conectados → Conectar dispositivo

# 8. Verifica
pnpm run docker:logs
# → aguarde ver "whis_online"
```

## Smoke test

1. Abra a conversa com o número pareado no WhatsApp.
2. Envie `oi`.
3. Espere ~5-10s — você deve ver:
   - Reação 👀 na sua mensagem (Whis lendo).
   - Reação 👀 desaparece quando o Whis termina.
   - Resposta personalizada usando seu nome (lido do `USER.md`).

Se algo não funcionar, `pnpm run docker:logs` mostra a sequência completa.

## Comandos do dia-a-dia

| Comando | O que faz |
|---|---|
| `pnpm run docker:up` | Sobe os containers em background |
| `pnpm run docker:down` | Desce |
| `pnpm run docker:logs` | Tail dos logs (worker + evolution) |
| `pnpm run docker:sh` | Shell dentro do whis-worker |
| `pnpm run docker:setup-token` | Renova o token Claude (quando expira) |
| `pnpm run evolution:setup` | Re-pareia o WhatsApp se a sessão cair |
| `pnpm run evolution:logs` | Tail só dos logs da Evolution |
| `pnpm run quality-gate` | Lint + typecheck + tests (rápido, local) |

## Estrutura do projeto

```
project-whis/
├── agent/                       # identidade do Whis (committed)
├── profile/                     # config pessoal (templates committed; reais gitignored)
├── context.example/             # template do vault Obsidian (committed)
├── context/                     # vault Obsidian REAL (gitignored)
├── apps/worker/                 # processo Node que escuta WhatsApp e fala com Claude
├── packages/storage/            # SQLite (sessões + auditoria de mensagens)
├── packages/logger/             # pino factory
├── infra/                       # Dockerfile, compose, scripts
└── docs/specs/0001-whis-mvp/    # spec, plan, tasks (deste MVP)
```

## Como adicionar uma skill nova

1. Crie a pasta: `mkdir -p profile/skills/<nome>`.
2. Adicione `SKILL.md` com frontmatter `name` + `description` (descrição é o que o Whis usa pra decidir quando ativar).
3. Adicione arquivos auxiliares se precisar (templates, scripts, dados).
4. Reinicie o worker: `pnpm run docker:down && pnpm run docker:up`. (Hot-reload de skills é planejado pós-MVP.)

Veja `agent/skills/google-calendar/SKILL.md` como exemplo de skill com integração MCP + protocolo de confirmação.

## Troubleshooting

| Sintoma | Solução |
|---|---|
| `whis_online` não aparece nos logs | Cheque `profile/.env` — alguma variável faltando |
| "evolution_health_failed" | A Evolution não subiu — `pnpm run evolution:logs` |
| Whis não reage a mensagem | Cheque `WHATSAPP_OWNER_NUMBER` — só o número listado é aceito |
| Token Claude expirado | `pnpm run docker:setup-token`, cola o novo no `.env`, `pnpm run docker:up -d --force-recreate` |
| `claude_home` volume não existe | `docker volume create claude_home` |
| QR code não aparece no `evolution:setup` | Sessão já está conectada. Ou abra o painel: `http://localhost:8081` |

## Arquitetura (TL;DR)

`Channel` (WhatsApp via Evolution) ↔ `AgentCore` (orquestrador) ↔ `AgentBackend` (Claude Code SDK) ↔ vault Obsidian (`context/`).

Detalhes em [docs/specs/0001-whis-mvp/spec.md](docs/specs/0001-whis-mvp/spec.md) e [plan.md](docs/specs/0001-whis-mvp/plan.md).
