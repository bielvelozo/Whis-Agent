---
feature: cicd
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-05-08
---
# Setup one-time da EC2 + GitHub repo

Passos manuais executados **uma vez** pelo Gabriel antes do primeiro deploy automatizado funcionar. Não fazem parte do código — são config de infraestrutura.

Pré-requisitos: SSH funcionando na EC2 (deploy manual atual já tem isso).

---

## 1. Criar user dedicado `whis-deploy` na VM

```bash
ssh ec2-user@<EC2_HOST>  # ou ubuntu@, conforme AMI
sudo useradd -m -s /bin/bash whis-deploy
sudo usermod -aG docker whis-deploy
```

Verificar:
```bash
id whis-deploy
# uid=...(whis-deploy) gid=...(whis-deploy) groups=...(whis-deploy),...(docker)
```

## 2. Criar `/opt/whis` owned pelo deploy user

```bash
sudo mkdir -p /opt/whis
sudo chown -R whis-deploy:whis-deploy /opt/whis
```

## 3. Clonar o repo em `/opt/whis`

Como o user `whis-deploy` ainda não tem chave Git, clonar via HTTPS:

```bash
sudo -u whis-deploy git clone https://github.com/bielvelozo/Whis-Agent.git /opt/whis
```

Se o repo for privado, criar um deploy key (read-only) em GitHub `Settings → Deploy keys` e configurar `~/.ssh/config` no `whis-deploy`. Por ora o repo é público (assumir; ajustar se mudar).

## 4. Copiar `profile/` e `context/` do laptop pra VM

Esses dirs são gitignored — não vêm pelo `git clone`.

No laptop (Windows PowerShell):
```powershell
scp -r profile <user>@<EC2_HOST>:/tmp/whis-profile
scp -r context <user>@<EC2_HOST>:/tmp/whis-context
```

Na VM:
```bash
sudo mv /tmp/whis-profile /opt/whis/profile
sudo mv /tmp/whis-context /opt/whis/context
sudo chown -R whis-deploy:whis-deploy /opt/whis/profile /opt/whis/context
```

## 5. Gerar par SSH dedicado pro GitHub Actions

No laptop:
```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\whis-deploy -C "whis-deploy@github-actions" -N '""'
```

Cuidado: `-N ""` (sem passphrase) — Actions não pode digitar senha.

## 6. Adicionar pubkey em `authorized_keys` do `whis-deploy`

No laptop:
```powershell
type $HOME\.ssh\whis-deploy.pub | clip
# (ou copiar manualmente do arquivo)
```

Na VM (logado como user que tem sudo, e.g. `ec2-user` ou `ubuntu`):

```bash
sudo -u whis-deploy mkdir -p /home/whis-deploy/.ssh
sudo -u whis-deploy chmod 700 /home/whis-deploy/.ssh
# Cole o conteúdo da pubkey:
sudo -u whis-deploy tee -a /home/whis-deploy/.ssh/authorized_keys
# (Ctrl+D pra finalizar)
sudo -u whis-deploy chmod 600 /home/whis-deploy/.ssh/authorized_keys
```

(Ou use `ssh-copy-id -i ~/.ssh/whis-deploy.pub whis-deploy@<EC2_HOST>` se preferir — exige PasswordAuth temporariamente, geralmente não disponível em EC2.)

Testar do laptop:
```powershell
ssh -i $HOME\.ssh\whis-deploy whis-deploy@<EC2_HOST> 'docker --version && cat /opt/whis/package.json | findstr `"name`"'
```

Esperado: print da versão do Docker + linha `"name": "whis"`. Sem prompt de senha.

## 7. Gerar PAT do GitHub pra GHCR

Em https://github.com/settings/tokens (classic ou fine-grained):

- **Classic**: escopo `read:packages` apenas.
- **Fine-grained**: scope `Account permissions → packages` = `Read`.

Expiration: 90d ou 1y. **Anotar data de expiração** — quando próximo, regenerar e atualizar secret `GHCR_PAT`.

Copiar o token (mostrado uma única vez).

## 8. Criar package GHCR (primeiro push)

Duas opções:

**Opção A — deixar primeiro deploy criar:**
First run de `deploy.yml` faz `docker push` que cria o package automaticamente. Depois ir em `https://github.com/users/bielvelozo/packages/container/whis-worker/settings`:
1. Confirmar visibility = `private`.
2. Em `Manage Actions access`, adicionar repo `Whis-Agent` com role `Write`.

**Opção B — push manual primeiro (preferível):**
```powershell
$env:GHCR_PAT = "<token gerado no item 7>"
$env:GHCR_PAT | docker login ghcr.io -u bielvelozo --password-stdin
docker pull hello-world
docker tag hello-world ghcr.io/bielvelozo/whis-worker:bootstrap
docker push ghcr.io/bielvelozo/whis-worker:bootstrap
docker logout ghcr.io
```

Depois ajustar visibility + Actions access conforme item 1 acima.

## 9. Configurar 6 secrets do repo

Em `https://github.com/bielvelozo/Whis-Agent/settings/secrets/actions`, criar:

| Name | Valor |
|---|---|
| `EC2_HOST` | IP público ou DNS da EC2 |
| `EC2_USER` | `whis-deploy` |
| `EC2_SSH_KEY` | conteúdo de `~/.ssh/whis-deploy` (privada, **com** linhas BEGIN/END) |
| `GHCR_PAT` | PAT criado no item 7 |
| `TELEGRAM_BOT_TOKEN` | mesmo do `profile/.env` (chave `TELEGRAM_BOT_TOKEN`) |
| `TELEGRAM_OWNER_CHAT_ID` | mesmo do `profile/.env` |

## 10. Confirmar Security Group da EC2

A SG da EC2 já aceita 22 do mundo (deploy manual atual depende disso). Sem mudança. Em `AWS Console → EC2 → Security Groups`, confirmar regra inbound:

- Type: SSH
- Port: 22
- Source: 0.0.0.0/0

(Se quiser endurecer no futuro: source = lista de IPs do GitHub Actions de https://api.github.com/meta. Fora do escopo desta spec.)

## 11. Smoke do setup (sem deploy ainda)

Antes de mergear `deploy.yml`, validar que SSH + docker login + git fetch funcionam manualmente. Do laptop:

```powershell
ssh -i $HOME\.ssh\whis-deploy whis-deploy@<EC2_HOST>
```

Na VM:
```bash
cd /opt/whis
git fetch --depth=1 origin main
echo "<GHCR_PAT>" | docker login ghcr.io -u bielvelozo --password-stdin
docker pull ghcr.io/bielvelozo/whis-worker:bootstrap  # se Opção B do item 8
docker logout ghcr.io
```

Tudo OK = setup pronto. Pode mergear deploy.yml.

---

## Renovação do PAT

PAT expira (90d ou 1y). Quando faltar 1 mês:

1. Gerar novo PAT (item 7).
2. Atualizar secret `GHCR_PAT` em `Settings → Secrets`.
3. Revogar PAT antigo.

Sem isso, `docker pull` no `deploy.sh` falha com 401 → deploy quebra.

---

## Rotação da chave SSH

Se a chave `whis-deploy` vazar (improvável mas possível):

1. Gerar novo par no laptop (item 5, sobrescrevendo).
2. Adicionar nova pubkey em `authorized_keys` (item 6).
3. Atualizar secret `EC2_SSH_KEY` no GitHub.
4. Remover pubkey antiga de `authorized_keys`.
