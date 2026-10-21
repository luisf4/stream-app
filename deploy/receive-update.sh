#!/usr/bin/env bash
# Recebe do GitHub Actions os instaladores novos do app (Windows) e guarda em data/updates/,
# de onde o servidor entrega a atualização automática (/api/updates).
# É o "command=" fixo da chave do GitHub Actions no authorized_keys do root: aquela chave só
# consegue rodar isto, nunca um shell.
#   put <arquivo>   grava o que chegar no stdin em data/updates/<arquivo>
#   prune           apaga os instaladores antigos (fica com os 3 mais novos)
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)/data/updates"
mkdir -p "$dir"

read -r action name rest <<<"${SSH_ORIGINAL_COMMAND:-}" || true

case "${action:-}" in
  put)
    if [[ -n "${rest:-}" || ! "${name:-}" =~ ^(latest\.yml|Resenha-Setup-[0-9]+\.[0-9]+\.[0-9]+\.exe(\.blockmap)?)$ ]]; then
      echo "arquivo não permitido: ${name:-}" >&2
      exit 1
    fi
    tmp="$(mktemp "$dir/.upload.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    head -c 500M >"$tmp"
    chmod 644 "$tmp"
    # troca de uma vez: o app nunca baixa um arquivo pela metade
    mv -f "$tmp" "$dir/$name"
    trap - EXIT
    ;;
  prune)
    ls -1t "$dir"/Resenha-Setup-*.exe 2>/dev/null | tail -n +4 | while read -r old; do
      rm -f "$old" "$old.blockmap"
    done
    ;;
  *)
    echo "uso: put <arquivo> | prune" >&2
    exit 1
    ;;
esac
