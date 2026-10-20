#!/usr/bin/env bash
# Instala o servidor do Resenha em casa (Proxmox/LXC/VM) com Cloudflare Tunnel + TURN do Cloudflare.
# Nenhuma porta precisa ser aberta no roteador.
# Uso (dentro de deploy/cloudflare/):  sudo bash install.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo bash install.sh"
  exit 1
fi

echo "==> Resenha - instalação (Cloudflare Tunnel, sem abrir portas)"

if ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1 || ! command -v crontab >/dev/null 2>&1; then
  apt-get update && apt-get install -y curl openssl cron
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# ask "pergunta" [padrão] — o texto da pergunta vai para o stderr, a resposta para o stdout
ask() {
  local prompt="$1" default="${2:-}" value
  while true; do
    if [ -n "$default" ]; then
      read -rp "$prompt [$default]: " value
      value="${value:-$default}"
    else
      read -rp "$prompt: " value
    fi
    if [ -n "$value" ]; then
      echo "$value"
      return
    fi
  done
}

if [ ! -f .env ]; then
  SERVER_NAME="$(ask 'Nome do servidor' 'Resenha')"
  while true; do
    read -rsp "Senha para os amigos entrarem: " SERVER_PASSWORD
    echo
    [ -n "$SERVER_PASSWORD" ] && break
  done
  CHANNELS="$(ask 'Canais de voz (separados por vírgula)' 'Geral,Jogos,Filmes')"

  echo
  echo "--- Endereços (os mesmos dos Public Hostnames do túnel) ---"
  APP_DOMAIN="$(ask 'Endereço do app (ex: resenha.seudominio.com)')"
  APP_DOMAIN="${APP_DOMAIN#https://}"
  ROOT_DOMAIN="${APP_DOMAIN#*.}"
  LIVEKIT_DOMAIN="$(ask 'Endereço da voz' "voz.${ROOT_DOMAIN}")"
  LIVEKIT_DOMAIN="${LIVEKIT_DOMAIN#https://}"

  echo
  echo "--- Cloudflare Tunnel (Zero Trust → Networks → Tunnels → token) ---"
  CLOUDFLARE_TUNNEL_TOKEN="$(ask 'Token do túnel')"

  echo
  echo "--- TURN do Cloudflare (Realtime → TURN Server) ---"
  CLOUDFLARE_TURN_KEY_ID="$(ask 'Turn Token ID')"
  CLOUDFLARE_TURN_API_TOKEN="$(ask 'API Token')"

  cat > .env <<EOF
SERVER_NAME=${SERVER_NAME}
SERVER_PASSWORD=${SERVER_PASSWORD}
JWT_SECRET=$(openssl rand -hex 32)
CHANNELS=${CHANNELS}
MAX_UPLOAD_MB=95
APP_DOMAIN=${APP_DOMAIN}
LIVEKIT_DOMAIN=${LIVEKIT_DOMAIN}
LIVEKIT_API_KEY=API$(openssl rand -hex 6)
LIVEKIT_API_SECRET=$(openssl rand -hex 32)
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
CLOUDFLARE_TURN_KEY_ID=${CLOUDFLARE_TURN_KEY_ID}
CLOUDFLARE_TURN_API_TOKEN=${CLOUDFLARE_TURN_API_TOKEN}
EOF
  chmod 600 .env
  echo "==> .env criado"
fi

mkdir -p data
echo "==> Subindo os containers..."
docker compose up -d --build

# Reinicia o LiveKit sozinho se o IP de casa mudar (a cada 2 minutos)
bash ip-watch.sh
CRON_LINE="*/2 * * * * cd '$(pwd)' && bash ip-watch.sh >> ip-watch.log 2>&1"
{ crontab -l 2>/dev/null | grep -v 'ip-watch.sh' || true; echo "$CRON_LINE"; } | crontab -

APP_DOMAIN="$(grep '^APP_DOMAIN=' .env | cut -d= -f2)"
echo
echo "Pronto! Confira no painel do Cloudflare se o túnel aparece como HEALTHY."
echo "Teste: https://${APP_DOMAIN}/api/health  (deve mostrar {\"ok\":true})"
echo "No client/.env do app use:  VITE_SERVER_URL=${APP_DOMAIN}"
