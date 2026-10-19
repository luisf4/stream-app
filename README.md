# Resenha

Repositório: https://github.com/luisf4/stream-app

"Discord caseiro" para você e seus amigos: **um servidor só**, alguns **canais de voz**, e em cada canal:

- 🎙️ voz (com supressão de ruído por IA, mutar/ensurdecer, volume por pessoa, atalhos globais)
- 🖥️ compartilhamento de tela **com o áudio do PC** (até 1440p 60fps)
- 📷 webcam
- 💬 chat de texto com histórico, imagens (otimizadas antes de enviar), vídeos e arquivos (colar print com Ctrl+V ou arrastar)

```
client/             App Windows (Electron + React)
server/             API + chat em tempo real (Node + Fastify + Socket.IO + SQLite)
deploy/             VPS/servidor com portas abertas (servidor + LiveKit + Caddy com HTTPS)
deploy/cloudflare/  Servidor em casa SEM abrir portas (Cloudflare Tunnel + TURN do Cloudflare)
```

A mídia (voz/vídeo/tela) passa pelo [LiveKit](https://livekit.io), um servidor WebRTC open source
que roda junto com o servidor: cada pessoa envia o vídeo uma vez e ele distribui para os outros.

---

## Progresso

### Feito

- [x] **Servidor**: login com senha do servidor + apelido, canais (criar/renomear/apagar), chat com
      histórico em SQLite, envio de arquivos, presença de quem está em cada canal de voz
- [x] **App Windows (Electron)**: voz com mutar/ensurdecer, volume por pessoa, indicador de quem fala,
      atalhos globais, bandeja, notificações e sons
- [x] **Compartilhar tela com áudio do PC**, webcam e palco de vídeo (focar / tela cheia)
- [x] **Supressão de ruído com IA (RNNoise)**, rodando no próprio PC: tira ventilador, teclado e barulho
      de fundo; dá para trocar na hora e testar o microfone em Configurações
- [x] **Imagens otimizadas antes de enviar** (até 2560 px, WebP): um print 4K de 9 MB vira ~0,5 MB
- [x] **Entrada na voz em ~2 s** pelo TURN do Cloudflare (antes demorava 15-25 s ou falhava)
- [x] **Instalador `.exe`** (`npm run dist`, ~82 MB)
- [x] **Endereço e senha embutidos no build** via `client/.env` — os amigos só digitam o apelido
- [x] **Deploy com portas abertas** (`deploy/`): Caddy com HTTPS automático, `sslip.io` e DuckDNS opcional
- [x] **Deploy em casa sem abrir portas** (`deploy/cloudflare/`): Cloudflare Tunnel + TURN do Cloudflare
- [x] **TURN do Cloudflare testado**: a voz conectou com o LiveKit atrás do roteador, sem nenhuma porta aberta
- [x] **Reinício automático do LiveKit quando o IP de casa muda** (`deploy/cloudflare/ip-watch.sh`)
- [x] **Container LXC criado no Proxmox** com Docker (nesting + keyctl)
- [x] **Cloudflare Tunnel criado e conectado**
- [x] **Rotas do túnel**: `resenha.resenhalive.stream` → `http://localhost:3000` e `voz.resenhalive.stream` → `http://localhost:7880`
- [x] **Código no GitHub** ([luisf4/stream-app](https://github.com/luisf4/stream-app))
- [x] **Servidor rodando no Proxmox** pelo `deploy/cloudflare/install.sh`
- [x] **Instalador gerado** com o endereço e a senha embutidos (pede só o apelido)
- [x] **Login funcionando de dois PCs**, incluindo um amigo de fora (com VPN desligada)

### Falta

- [ ] Testar voz e tela 1080p com os amigos e olhar o consumo no painel do TURN
- [ ] Conferir se o áudio da tela não leva a voz dos amigos junto (eco); se levar, criar o módulo nativo
      que exclui o próprio app da captura
- [ ] Gerar **tokens novos** do túnel e do TURN no painel do Cloudflare (os atuais passaram pelo chat) e
      atualizar no `.env` do servidor

---

## 1. Rodar no seu PC (para testar)

Precisa do **Node.js 22.13+** (recomendado 24 LTS): https://nodejs.org

**a) LiveKit** — baixe o `livekit_<versão>_windows_amd64.zip` em
https://github.com/livekit/livekit/releases e extraia em `tools/livekit/`. Na raiz do projeto:

```bash
tools\livekit\livekit-server.exe --dev --config deploy\livekit.yaml
```

**b) Servidor**

```bash
cd server
npm install
npm run dev
```

Para testar com o TURN do Cloudflare, crie `server/.env` com `CLOUDFLARE_TURN_KEY_ID` e
`CLOUDFLARE_TURN_API_TOKEN` (sem eles, a voz conecta direto, como numa rede local).

**c) App**

```bash
cd client
npm install
npm run dev
```

No app, use o endereço `localhost:3000` e a senha `amigos`.
Para testar com duas pessoas no mesmo PC, abra uma segunda instância com outro login:

```bash
npm run dev:2
```

---

## 2. Hospedar

| Onde | Guia |
|------|------|
| **Servidor em casa (Proxmox) sem abrir portas** — Cloudflare Tunnel + TURN do Cloudflare | **[DEPLOY-PROXMOX.md](DEPLOY-PROXMOX.md)** |
| VPS ou servidor com portas abertas — LiveKit próprio, sem limite de uso | [DEPLOY.md](DEPLOY.md) |

**Atualizar o servidor** depois de mudar o código (no servidor, dentro da pasta do deploy usado):

```bash
git pull
docker compose up -d --build
```

Mensagens e arquivos ficam na pasta `data/` do deploy — faça backup dela.

---

## 3. Gerar o instalador `.exe`

Para os amigos só digitarem o apelido, antes do build copie `client/.env.example`
para `client/.env` e preencha `VITE_SERVER_URL` e `VITE_SERVER_PASSWORD`
(detalhes no [DEPLOY.md](DEPLOY.md#6-configurar-o-app-com-o-seu-servidor-antes-do-build)).

```bash
cd client
npm run dist
```

O instalador sai em `client/dist/Resenha-Setup-1.0.0.exe`. Mande para os amigos.
Como o app não é assinado digitalmente, o Windows pode mostrar "O Windows protegeu o computador":
clique em **Mais informações → Executar assim mesmo**.

---

## Segredos fora do Git

Os arquivos com senha e tokens **não vão para o repositório** (estão no `.gitignore`):

| Arquivo | Contém |
|---------|--------|
| `server/.env` | credenciais do TURN para testes locais |
| `client/.env` | endereço e senha do servidor embutidos no app |
| `deploy/.env`, `deploy/cloudflare/.env` | senha, chaves do LiveKit, token do túnel e do TURN |

Só os modelos `*.env.example` são versionados. Como cada `.env` chega no lugar certo (incluindo enviar
o do servidor para o container do Proxmox) está em
[DEPLOY-PROXMOX.md → Os arquivos `.env`](DEPLOY-PROXMOX.md#os-arquivos-env-não-vão-pelo-github).

---

## Como usar

- **Clique** num canal para ver o chat e quem está nele; **duplo clique** (ou "Entrar no canal") entra na voz.
- **Clique direito** num canal: renomear/apagar. Clique direito num amigo na voz: volume dele.
- Clique num vídeo para **focar**, duplo clique para **tela cheia**.
- Atalhos globais padrão: **Ctrl+Shift+M** (mutar) e **Ctrl+Shift+D** (ensurdecer) — mude em Configurações.
- Fechar a janela deixa o app na bandeja (dá pra desligar em Configurações).

## Observações

- **Áudio da tela:** o app pede ao Windows para não capturar o som do próprio Resenha (a voz dos amigos),
  mas isso depende da versão do Chromium/Windows. Se alguém ouvir eco da própria voz quando você transmite
  com áudio, o próximo passo é um pequeno módulo nativo que exclui o processo do app da captura
  (é o que o Discord faz).
- **Consumo do TURN do Cloudflare:** 1.000 GB/mês grátis. Tela 1080p60 com 3 pessoas assistindo gasta até
  ~12,6 GB/hora (~80 h/mês); em 1080p30 ~120 h/mês; só voz é quase nada.
- **Arquivos enviados** ficam acessíveis por um link secreto e longo (não listável); trate como "quem tem o link vê".
