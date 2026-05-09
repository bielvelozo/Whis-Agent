#!/bin/sh
# Whis container entrypoint.
# Symlinks skills from /app/agent/skills (built-in) and /app/profile/skills (user)
# into /home/node/.claude/skills so the Claude Agent SDK's user-level setting
# source picks up both. Profile skills override agent skills on name collision.
set -eu

# Validate profile/.env has all keys present in profile/.env.example.
# Catches drift where new env vars added to .env.example didn't make it
# to the VM's .env after a deploy.
ENV_FILE=/app/profile/.env
ENV_EXAMPLE=/app/profile/.env.example
if [ -f "$ENV_EXAMPLE" ] && [ -f "$ENV_FILE" ]; then
  MISSING=""
  while IFS= read -r line; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    [ -z "$key" ] && continue
    if ! grep -q "^${key}=" "$ENV_FILE"; then
      MISSING="${MISSING} ${key}"
    fi
  done < "$ENV_EXAMPLE"
  if [ -n "$MISSING" ]; then
    echo "FATAL: profile/.env missing keys from .env.example:${MISSING}" >&2
    echo "       Add these keys to /opt/whis/profile/.env on the VM and re-deploy." >&2
    exit 1
  fi
fi

AGENT_SKILLS=/app/agent/skills
PROFILE_SKILLS=/app/profile/skills
DEST=/home/node/.claude/skills

[ -d "$AGENT_SKILLS" ] || { echo "skills_bootstrap_failed: $AGENT_SKILLS missing" >&2; exit 1; }
[ -d "$PROFILE_SKILLS" ] || { echo "skills_bootstrap_failed: $PROFILE_SKILLS missing" >&2; exit 1; }

mkdir -p "$DEST"

for d in "$AGENT_SKILLS"/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  ln -sfn "$d" "$DEST/$name"
done

for d in "$PROFILE_SKILLS"/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  if [ -L "$DEST/$name" ]; then
    echo "skill_override: profile/$name replaces agent/$name" >&2
  fi
  ln -sfn "$d" "$DEST/$name"
done

exec "$@"
