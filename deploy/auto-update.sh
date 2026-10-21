#!/usr/bin/env bash
# Atualiza o servidor sozinho quando chega commit novo na main do GitHub.
# Só recompila/reinicia se mudou algo em server/ ou deploy/ (commit só do client não derruba a call).
# Rodado pelo cron a cada 10 minutos (o install.sh configura isso).
set -uo pipefail
cd "$(dirname "$0")"

log() { echo "$(date '+%F %T') $*"; }

# Tudo dentro de main: o bash lê o script inteiro antes de rodar, então o git pull pode
# trocar este arquivo no meio da execução sem quebrar nada.
main() {
  # build demorado + cron = duas execuções ao mesmo tempo; a segunda só sai
  exec 9>.auto-update.lock
  flock -n 9 || exit 0

  git fetch -q origin main || { log "git fetch falhou"; exit 0; }
  local old new changed
  old="$(git rev-parse HEAD)"
  new="$(git rev-parse origin/main)"
  [ "$old" = "$new" ] && exit 0

  if ! git merge -q --ff-only origin/main; then
    log "não deu para atualizar $old -> $new (mudanças locais no servidor?)"
    exit 0
  fi
  log "atualizado: $(git log --oneline -1)"

  changed="$(git diff --name-only "$old" "$new")"
  if ! grep -qE '^(server|deploy)/' <<<"$changed"; then
    log "nada de server/ ou deploy/ mudou, sem reiniciar"
    exit 0
  fi

  if docker compose up -d --build --remove-orphans; then
    # o compose não reinicia quando só o arquivo de config montado muda
    grep -qx 'deploy/livekit.yaml' <<<"$changed" && docker compose restart livekit
    grep -qx 'deploy/Caddyfile' <<<"$changed" && docker compose restart caddy
    docker image prune -f >/dev/null
    log "deploy ok"
  else
    log "docker compose falhou (o que estava rodando continua no ar)"
  fi
}

main
exit
