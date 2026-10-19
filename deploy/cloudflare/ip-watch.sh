#!/usr/bin/env bash
# Mantém o LiveKit anunciando o IP público certo da casa.
# O LiveKit descobre o IP só ao iniciar e o anuncia para o TURN do Cloudflare. Ele precisa de
# reinício quando (1) o IP da casa muda, ou (2) na última inicialização a descoberta falhou e o IP
# público não ficou associado à interface da rede de casa. Sem isso a voz não conecta
# (site e chat continuam normais).
# Rodado pelo cron a cada 2 minutos (o install.sh configura isso).
set -uo pipefail
cd "$(dirname "$0")"

log() { echo "$(date '+%F %T') $*"; }

public_ip() {
  local url ip
  for url in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip="$(curl -4 -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "$ip"
      return 0
    fi
  done
  return 1
}

# O LiveKit escreve no log algo como: using external IPs {"ips": ["179.89.227.111/192.168.15.14"], ...}
livekit_announces() {
  # log inteiro: a linha só aparece ao iniciar, e numa conversa longa sairia de um --tail
  docker compose logs --no-log-prefix livekit 2>/dev/null \
    | grep 'using external IPs' | tail -n1 | grep -q "\"$1/"
}

restart_livekit() {
  log "$1 — reiniciando o LiveKit"
  docker compose restart livekit >/dev/null 2>&1
  sleep 10
  if livekit_announces "$IP"; then
    log "LiveKit anunciando $IP"
  else
    log "LiveKit ainda sem $IP (tenta de novo na próxima rodada)"
  fi
}

IP="$(public_ip)" || { log "não consegui descobrir o IP público (sem internet ou DNS falhando)"; exit 0; }

LAST_FILE=".last_ip"
LAST="$(cat "$LAST_FILE" 2>/dev/null || true)"
echo "$IP" > "$LAST_FILE"

if [ -n "$LAST" ] && [ "$IP" != "$LAST" ]; then
  restart_livekit "IP mudou: $LAST -> $IP"
elif ! livekit_announces "$IP"; then
  restart_livekit "LiveKit não está anunciando $IP"
fi
