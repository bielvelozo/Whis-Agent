---
status: draft
feature: gcal-remote-resilience
created: 2026-05-20
shipped: null
---
# Resiliência do Google Calendar em deploy remoto — re-auth via Telegram + persistência de tokens em CDs

**Status:** Draft
**Scope:** Tornar o setup `google-calendar` (spec 0003) operacional em deploy remoto (EC2). Duas frentes:
1. **Re-autenticação via Telegram quando o token expira** — Whis conduz o flow inteiro pelo chat (detectar erro → oferecer reconexão → entregar URL de auth **junto** com o comando de SSH tunnel necessário → confirmar sucesso). Cobre tanto o setup inicial (G1) quanto o token-expirou (G7) da spec 0003 no contexto remoto.
2. **Persistência de tokens entre CDs** — garantir que ciclos de deploy não derrubem `gcal_tokens/google-calendar-mcp/tokens.json`. Inclui auto-restore on-empty via backup tarball quando o volume vier vazio (novo host, `down -v` acidental, etc).

A spec **não** muda comportamento local (`docker:up:local`) — o flow remoto é puramente aditivo, ativado por presença de uma env var. Skills, regras do SOUL, e contratos do MCP não mudam.

## Context

A spec 0003 entregou o setup do Google Calendar pressupondo deploy local (Docker Desktop no Windows do Gabriel). O `SKILL.md` afirma textualmente:

> **Sem paste-code.** O MCP usa callback HTTP automático. Garanta que o user abra a URL em browser na **mesma máquina** rodando o container — `localhost:3500-3505` precisa ser alcançável.

Em 2026-05-19 o Whis foi pra deploy remoto (EC2 `ubuntu@18.231.48.71`), e duas coisas quebraram simultaneamente:

1. **Volume `gcal_tokens` foi criado vazio no host remoto** (primeiro CD → primeiro boot → Docker named volume novo). Os tokens OAuth do setup local nunca tinham sido replicados pro servidor. Sintoma: skill `google-calendar` retornou *"MCP server não disponível"* / *"Authentication token is invalid or expired. Please re-run the authentication process (npm run auth)"* no Telegram, e Whis (sem instrução pro caso remoto) sugeriu *"alguém com acesso ao servidor precisaria rodar `npm run auth`"* — sugestão que vem do próprio erro do MCP e está errada (a tool canônica é `manage-accounts auth <nickname>` exposta pelo `@cocal/google-calendar-mcp`, não um script `npm`).
2. **Mesmo após restore manual** (tarball `backups/gcal_tokens.tar.gz` extraído pro volume), os tokens estavam expirados — refresh tokens do Google em apps OAuth ainda em **Testing mode** expiram em 7 dias independente de uso. Re-autenticar exige que o browser do Gabriel alcance `http://localhost:3500/oauth2callback`, o que **não funciona no setup remoto** porque `localhost` do browser é a máquina do Gabriel, não a EC2.

A solução pra (2) é **SSH tunnel**: `ssh -L 3500:localhost:3500 ... ubuntu@<host>` cria uma ponte entre o port 3500 do laptop do Gabriel e o port 3500 da EC2 (onde o MCP está escutando). Após o tunnel, Google redireciona pro `localhost:3500` do Gabriel → tunnel encaminha pra EC2 → MCP captura o code → grava tokens. O Gabriel precisa abrir o tunnel **antes** de clicar na URL de auth, e manter aberto durante todo o flow (timeout do MCP é 5 min).

A solução pra (1) tem duas camadas complementares:
- **Imediata:** auto-restore on-empty no entrypoint do container — quando o volume `gcal_tokens` está vazio no boot e existe um tarball seed em `/app/backups/gcal_tokens.tar.gz`, extrai antes de chamar `exec`. Permite recovery automático se um próximo CD recriar o volume.
- **Operacional:** documentar workflow de backup periódico do tarball + sincronização pro servidor remoto via scp (o tarball cria/atualiza fora do git, pra não vazar refresh tokens em commits).

A `@cocal/google-calendar-mcp` **não suporta redirect URI customizado** — é hard-coded `http://localhost:<porta>/oauth2callback` no source (validado em `docs/specs/0003-google-calendar-skill/discovery-notes.md:25-26`). E o Google Cloud Console **não aceita redirect URIs públicos pra OAuth Desktop App type** — só `http://localhost` / `http://127.0.0.1`. Não há atalho: a única forma de viabilizar callback localhost num server remoto é tunelar.

**Decisão fundante:** em vez de embutir o comando SSH na skill markdown (que seria estático e copiaria credenciais como `whis-key.pem` pro repo), o flow lê o comando de uma **env var no `.env` do server** (`WHIS_AUTH_TUNNEL_HINT`) e injeta no system prompt do Whis em runtime via novo bloco "Deployment context" no `buildSystemPrompt()`. Locally, a var é ausente → bloco não aparece → comportamento atual preservado. Remoto, a var existe → bloco aparece → Whis instrui o tunnel proativamente sempre que precisar entregar uma URL de OAuth.

## Problem Statement

Dois problemas concretos, observados em 2026-05-19/20:

**P1. Token expirado no deploy remoto não tem caminho de recovery via Telegram.**
Hoje o Whis detecta o erro de auth (mensagem do MCP entra na resposta da tool), mas o SKILL.md instrui "abra URL na mesma máquina rodando o container" — impossível em remoto. Whis ou (a) ignora a contradição e oferece reauth genericamente (esperado pelo G7) mas a URL retornada fica inalcançável, ou (b) sugere ao Gabriel "rode npm run auth" copiado do erro literal do MCP (foi o que aconteceu na chat de 2026-05-19). Em ambos, Gabriel precisa de instrução adicional manual sobre como tunelar. O recovery deveria ser self-service via chat.

**P2. CDs limpam o volume `gcal_tokens` sem aviso prévio nem mecanismo de seed.**
O `docker-compose.yml` declara `gcal_tokens` como named volume. Quando o CD pipeline (futuro, ainda sendo definido) rodar `docker compose down -v` (ou for um novo host) o volume zera. Sem mecanismo automático de re-seed, cada incidente desse exige (a) recuperar tarball local válido, (b) `scp` pro server, (c) `docker run alpine tar -xzf ...` manual antes de subir o stack. Workflow operacional caro e fácil de errar.

A spec resolve os dois problemas entregando:
- **Env-driven SSH tunnel hint** no system prompt → Whis menciona o comando proativamente sempre que entregar OAuth URL.
- **Entrypoint auto-restore** → boot detecta volume vazio + tarball presente → restaura antes de iniciar o worker.
- **Bind mount read-only do `backups/`** → tarball acessível do container sem rebuild de imagem.

## Non-Goals

Explicitamente **fora do escopo**:

1. **Múltiplos hosts remotos / multi-tenant.** Spec assume **um único setup remoto** (EC2 do Gabriel) e **um único setup local** (Docker Desktop no Windows). Se virar multi-host no futuro, `WHIS_AUTH_TUNNEL_HINT` ainda funciona (uma var por `.env`), mas dimensionar pra múltiplas chaves SSH simultâneas etc. é outra spec.
2. **Re-auth automatizada sem clique humano.** Whis não vai chamar `manage-accounts auth` sem o Gabriel responder "sim" — o protocolo de confirmação humana herdado do SOUL.md continua absoluto.
3. **Trocar `@cocal/google-calendar-mcp` por implementação custom** que aceite redirect URI público. O MCP atual cobre todas as funcionalidades; a limitação localhost é do Google Desktop App type. Spec não justifica refactor.
4. **Backup automatizado dos tokens em horário fixo.** A spec adiciona mecanismo de **restore**; backup periódico (cron que faz `tar -czf backups/gcal_tokens.tar.gz ...` semanalmente) é mencionado em "Risks" como sugestão futura, sem implementação aqui.
5. **Versionar tarballs de backup no git.** `backups/*.tar.gz` permanece untracked + adicionado ao `.gitignore` explicitamente. Sincronização Gabriel→servidor é manual via `scp` (workflow operacional, não automação).
6. **Mudar publishing status do OAuth app no Google Cloud Console.** Mudar de "Testing" pra "In production" (sem submeter pra verification) reduz drasticamente a frequência de re-auths (refresh tokens param de expirar em 7d). Isso é ação manual do Gabriel no console — fora do escopo da entrega de código. Documentado em SMOKE.md como follow-up recomendado.
7. **Reauth flow pra outros MCPs hipotéticos** que tenham callback localhost. A env var é nominalmente genérica (`WHIS_AUTH_TUNNEL_HINT`), e o bloco no system prompt menciona "Google Calendar" porque é o único caso real hoje. Se outro MCP entrar com mesma característica, generalização é refinamento.
8. **Detecção automática do tipo de erro de auth pelo Whis.** Whis continua confiando no texto que o MCP retorna (e no padrão "Authentication token is invalid or expired"). Não há parser estruturado — é orientação no SKILL.md G7.
9. **SSH tunnel via outra ferramenta** (mosh, gosh, etc). `ssh` padrão OpenSSH é assumido — já existe no Windows 11 (`C:\WINDOWS\System32\OpenSSH\ssh.exe`).

## Constraints

**Técnicas:**

- `@cocal/google-calendar-mcp` v2.x continua com redirect URI hard-coded `http://localhost:<porta>/oauth2callback`. Não há fork/patch.
- Google OAuth Desktop App **só aceita redirect URIs localhost** — confirmado pela limitação histórica do tipo.
- SSH tunnel exige porta livre em **ambos** os lados (host do Gabriel + EC2). O port range do MCP é 3500-3505 (escolhe primeira livre); tunnel precisa cobrir o range inteiro pra ser robusto a colisão na EC2.
- Tunnel precisa estar **vivo durante todo o callback**. Timeout do MCP é 5 min — janela suficiente pra Gabriel abrir o tunnel + autorizar.
- Entrypoint é shell script POSIX (`infra/entrypoint.sh`) sem dependências exóticas (já tem `tar` na imagem `node:24-slim` via apt).
- Volume `gcal_tokens` é named volume Docker. Bind mount NÃO é alternativa boa porque o MCP grava tokens em runtime (refresh flow do Google) — escrever de volta na `backups/` mistura seed com estado live e cria confusão. Auto-restore via entrypoint mantém named volume como source of truth.
- Worker code (TypeScript) só ganha mudança em `apps/worker/src/agent/system-prompt.ts` (uma função existente). Sem novos arquivos, sem novos endpoints, sem mudança no `core.ts` / canal Telegram / MCP wiring.
- Variável de ambiente `WHIS_AUTH_TUNNEL_HINT` é **opcional**. Ausente ⇒ comportamento atual (idêntico ao local). Presente ⇒ Whis sabe que está em deploy remoto e age proativamente. Sem default — não vamos chutar comando SSH no código.
- Tests Vitest mantidos verdes. Adicionar 1-2 tests pra `buildSystemPrompt` cobrindo presença/ausência da var.

**Organizacionais:**

- Gabriel é o único user do servidor remoto hoje. Chave SSH (`whis-key.pem`) está em `C:\Users\gabri\Downloads\whis-key.pem`. Não vamos exigir reorganização da chave pra spec funcionar — o comando do tunnel referencia o caminho atual; se Gabriel mover, ele atualiza a env var.
- Backup tarball atual (`backups/gcal_tokens.tar.gz`) existe local + foi enviado pro server em 2026-05-20. Spec assume que esse arquivo existe nos dois lados; flow de "como gerar um tarball novo" é documentado em SMOKE.md.
- Sem migration de dados. Tokens existentes no volume continuam válidos (quando válidos). Se expirados, Gabriel reauthentica via Telegram seguindo o novo G7.

**De arquitetura (pra evitar débito imediato):**

- **Não** introduzir conceito de "ambientes" no worker (`WHIS_ENV=local|remote`). Continua sendo conjunto de envs e arquivos; presença/ausência de `WHIS_AUTH_TUNNEL_HINT` é o sinal natural.
- **Não** acoplar entrypoint a tipos específicos de backup. Restore é genérico ("se volume vazio + tarball presente → extrai") — facilita reuso futuro pra outros volumes (`whis_data`, `claude_home`).
- **Não** introduzir job de cron / heartbeat no worker pra backup automático. Backup periódico é mencionado como melhoria futura; v1 é operacional manual.
- **Não** mudar `agent/mcp.json` nem `infra/Dockerfile`. Mudanças se concentram em compose + entrypoint + system-prompt + SKILL.md + `.env.example`.

**De comunicação:**

- Idioma: PT-BR no SKILL.md, no SMOKE.md, e no bloco "Deployment context" do system prompt (Whis fala PT-BR com Gabriel — coerência).
- Mensagens novas do Whis no Telegram continuam no tom do SOUL: calmo, prático, sem floreios. Comando SSH dentro de bloco `code` (markdown V2 do Telegram renderiza monospace).

## User Stories / Scenarios

**R1 — Setup inicial em servidor remoto (uma vez por nickname, pós-deploy):**

Pré-condição: deploy remoto novo, volume `gcal_tokens` vazio, `profile/.env` no server tem `WHIS_AUTH_TUNNEL_HINT` setado, MCP carregado sem erro no boot.

1. Gabriel no Telegram: *"conecta meu calendário pessoal"* (ou Whis detecta primeira tentativa de calendar e oferece).
2. Whis chama `manage-accounts` (action `auth`, nickname `personal`).
3. MCP levanta auth server na primeira porta livre em 3500-3505 dentro do container (mapeada pro mesmo port na EC2) e retorna URL longa do Google.
4. Whis responde no chat com **duas peças** em blocos separados (Markdown V2):
   - Bloco 1: comando SSH tunnel exato + instrução "abre isso em outro terminal e mantém aberto".
   - Bloco 2: URL de autorização + instrução "depois que o tunnel estiver aberto, clica nessa URL e autoriza. Timeout de 5min".
5. Gabriel abre terminal local PowerShell, cola comando, autentica (chave já configurada), tunnel ativo.
6. Gabriel clica URL no browser → Google login → autoriza acesso ao Calendar → Google redireciona pra `http://localhost:3500/oauth2callback?code=...` → browser do Gabriel → tunnel → EC2 → MCP captura code → grava token em `/home/node/.config/google-calendar-mcp/tokens.json` (dentro do volume).
7. Whis recebe sinal de sucesso da próxima resposta da tool (na verdade do callback handler dentro do MCP), confirma: *"Conectado. Posso listar eventos do calendário personal."*
8. Repete pra `work` (passo 1 com *"agora conecta o trabalho"*).

**R2 — Token expirou em deploy remoto (G7 da spec 0003, refinado pra remoto):**

1. Gabriel: *"que reuniões eu tenho hoje?"*
2. Whis tenta `list-events` → MCP responde com erro contendo "Authentication token is invalid or expired".
3. Whis (orientado por SKILL.md G7 + deployment context) traduz: *"Token do calendário **personal** expirou. Posso reconectar pra você?"*
   - **NÃO** sugere "rode npm run auth no servidor" (regressão documentada).
4. Gabriel: *"sim"*
5. A partir daqui idêntico a R1 passo 2-7.

**R3 — Boot em volume vazio com tarball seed presente:**

Pré-condição: `gcal_tokens` volume foi recriado (`down -v` ou novo host). `/app/backups/gcal_tokens.tar.gz` montado read-only.

1. Container inicia → executa `infra/entrypoint.sh`.
2. Entrypoint roda lógica de symlink de skills (preservada).
3. **Novo:** entrypoint checa `[ ! -s /home/node/.config/google-calendar-mcp/tokens.json ]` (não existe ou vazio) **AND** `[ -f /app/backups/gcal_tokens.tar.gz ]`.
   - Match → extrai tarball pra `/home/node/.config/` (preservando structure `google-calendar-mcp/tokens.json`).
   - Log estruturado: `gcal_tokens_restore source=/app/backups/gcal_tokens.tar.gz`.
4. Entrypoint chama `exec "$@"` → worker sobe normalmente.
5. MCP encontra `tokens.json` no path esperado → operacional.

**R4 — Boot em volume já populado (skip restore):**

Pré-condição: `gcal_tokens/google-calendar-mcp/tokens.json` já existe (deploy normal após primeiro setup).

1. Container inicia → entrypoint.
2. Checagem `[ ! -s ... ]` falha (arquivo existe e tem conteúdo) → bloco de restore pulado.
3. Log estruturado opcional: `gcal_tokens_present skip_restore=true`.
4. `exec "$@"` normal.

**R5 — Boot sem tarball seed (deploy fresh ou local-dev sem backup):**

1. Container inicia → entrypoint.
2. `[ ! -s ... ]` true (volume vazio).
3. `[ -f /app/backups/gcal_tokens.tar.gz ]` false (tarball não montado / não existe).
4. Bloco de restore pulado silenciosamente (com log informativo `gcal_tokens_seed_unavailable`).
5. Worker sobe; MCP carrega; primeira tool de Calendar retorna erro de auth; Whis dispara R1 / R2.

**R6 — Gabriel atualiza o tarball local (workflow de backup manual):**

Pré-condição: tokens locais estão frescos e funcionando (validado por Whis local conseguir listar agenda).

1. Gabriel roda no PowerShell:
   ```powershell
   docker run --rm `
     -v whis_gcal_tokens:/source:ro `
     -v "${PWD}\backups:/backup" `
     alpine sh -c "cd /source && tar -czf /backup/gcal_tokens.tar.gz ."
   ```
2. Arquivo `backups/gcal_tokens.tar.gz` é atualizado com timestamp novo.
3. Gabriel sincroniza pro server:
   ```powershell
   scp -i C:\Users\gabri\Downloads\whis-key.pem .\backups\gcal_tokens.tar.gz ubuntu@18.231.48.71:/home/ubuntu/Whis-Agent/backups/
   ```
4. No próximo CD/restart do server, R4 acontece (volume ainda populado, skip). Se um dia R3 disparar, o seed estará atualizado.

## Success Criteria

Esta entrega está **pronta** quando:

1. **`infra/docker-compose.yml`** ganha bind mount `./backups:/app/backups:ro` no service `whis-worker`, listado junto aos outros bind mounts (`./agent`, `./profile`, `./context`). Sem mudança em volumes nomeados (`gcal_tokens` continua igual).
2. **`infra/entrypoint.sh`** ganha bloco de auto-restore antes do `exec "$@"` final. Bloco:
   - Detecta volume vazio (`[ ! -s /home/node/.config/google-calendar-mcp/tokens.json ]`).
   - Detecta tarball disponível (`[ -f /app/backups/gcal_tokens.tar.gz ]`).
   - Se ambos: `tar -xzf /app/backups/gcal_tokens.tar.gz -C /home/node/.config/` + log no stderr.
   - É idempotente — re-rodar com volume já populado não faz nada.
3. **`apps/worker/src/agent/system-prompt.ts`** — função `buildSystemPrompt()` ganha bloco "Deployment context" injetado quando `process.env.WHIS_AUTH_TUNNEL_HINT?.trim()` está não-vazio. Bloco é posicionado **entre** `# About the user` e `# Active skills`. Conteúdo do bloco descreve:
   - "Whis está rodando em deploy remoto."
   - "OAuth callbacks pra Google Calendar precisam de SSH tunnel localhost→server."
   - "Sempre que precisar mandar uma URL de auth pro Gabriel, mande **primeiro** o comando de tunnel."
   - Literal do comando vindo da env var.
   - Lembrete da janela de 5 min do MCP.
4. **`agent/skills/google-calendar/SKILL.md`** atualizado:
   - G1 step 3 (linha ~137 atual) reescrito pra **não** afirmar "mesma máquina rodando o container" como verdade universal. Em vez disso: "se houver Deployment context no system prompt mencionando SSH tunnel, prepende o comando do tunnel antes da URL".
   - G7 reforçado: "Ignore sugestões de `npm run auth` que vierem no texto do erro do MCP — a tool canônica é `manage-accounts auth <nickname>`. Sempre ofereça reauth pelo chat."
   - Reads sem mudança.
5. **`profile/.env.example`** ganha bloco documentando `WHIS_AUTH_TUNNEL_HINT`.
6. **`.gitignore`** ganha linha explícita pra evitar vazar refresh tokens, e `backups/.gitkeep` é criado.
7. **`apps/worker/tests/` ganha test(s) novo(s)** validando `buildSystemPrompt`.
8. **`SMOKE.md`** ganha nova seção "Deploy remoto — Google Calendar OAuth".
9. **`AGENTS.md`** ganha linha mencionando a spec na tabela "Locais de conhecimento".
10. **`pnpm run quality-gate`** continua verde.
11. **Smoke test manual ponta-a-ponta** no server EC2.
12. **Smoke test do auto-restore (R3)** local.

## Risks and Mitigations

Ver risks detalhados na spec — incluem possível conflito de port range 3500-3505 no Windows do Gabriel, tarball stale, mismatch de shell no Windows, etc. Mitigações documentadas em SMOKE.md.

## Open Questions

Nenhuma bloqueante. Esclarecimentos menores resolvíveis na implementação.

## Out-of-scope follow-ups

- OAuth app → Production no Google Cloud Console (reduz expiração de 7d).
- Backup periódico automatizado (cron / skill `backup-routine`).
- `WHIS_AUTH_TUNNEL_HINT` virar map (gcal, gmail, drive, ...) quando outros MCPs com callback localhost surgirem.
- Generalizar entrypoint auto-restore pra outros volumes (`whis_data`, `claude_home`).
