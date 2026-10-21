# Deploying on a VPS

This guide puts the Resenha backend on a cloud VPS so your friends can connect from anywhere. You end up with three Docker containers:

| Container | Role | Ports |
|---|---|---|
| `caddy` | Automatic HTTPS (Let's Encrypt) and reverse proxy | TCP 80, 443 |
| `app` | Login, channels, chat and uploads (Node + SQLite) | internal (3000) |
| `livekit` | Voice, video and screen sharing (WebRTC SFU) | TCP 7881, UDP 7882 |

**No domain needed:** by default the installer uses `YOUR-IP.sslip.io` (e.g. `203-0-113-5.sslip.io`), a free
wildcard DNS name that resolves to your IP and gets a real HTTPS certificate. With your own domain, point an
**A record** at the VPS (see [Using your own domain](#using-your-own-domain)).

> Moving from the old Proxmox + Cloudflare Tunnel setup? See
> [Moving from the Proxmox/Cloudflare setup](#moving-from-the-proxmoxcloudflare-setup-same-domain).

---

## 1. Create the server

Any **Ubuntu 22.04/24.04 or Debian 12** machine with **1 vCPU and 1–2 GB of RAM** is enough for a group of friends.

| Provider | Suggested plan | Price | Notes |
|---|---|---|---|
| Oracle Cloud | Ampere A1 (ARM) | free | Requires a card at signup; has an extra firewall (see step 2) |
| Hetzner | CX22 | ~€4/month | 20 TB of traffic included |
| DigitalOcean / Vultr | 1 GB | ~US$6/month | Less traffic included |

**Traffic:** a 1080p 30 fps stream uses up to ~10 Mbps **per viewer** (720p: ~5 Mbps); in "games and video" mode up to ~20 Mbps (720p: ~10 Mbps), and 60 fps uses about 1.5× that. Three friends watching
3 hours a day every day is roughly 1.2 TB/month (2.4 TB in "games and video" mode).

Use **SSH key** login when creating the VPS and note its **public IP**.

---

## 2. Open the ports

In the provider's firewall (security group / firewall / security list), allow **inbound** traffic from
anywhere (`0.0.0.0/0`):

| Protocol | Ports | Used for |
|---|---|---|
| TCP | 22 | SSH (usually open already) |
| TCP | 80 | HTTPS certificate issuance |
| TCP | 443 | App: API, chat and voice signaling |
| TCP | 7881 | Voice/video fallback when UDP is blocked |
| UDP | 7882 | Voice/video (main path) |

Don't open TCP 7880 (LiveKit's plain HTTP signaling): Caddy already serves it over HTTPS at `wss://DOMAIN/rtc`.

### Oracle Cloud only

Oracle's Ubuntu images ship with `iptables` rules that block everything except SSH. After logging in (step 3), run:

```bash
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443,7881 -j ACCEPT
```

```bash
sudo iptables -I INPUT -p udp --dport 7882 -j ACCEPT
```

```bash
sudo netfilter-persistent save
```

---

## 3. Get the code onto the server

### Option A: from GitHub (recommended)

```bash
git clone https://github.com/luisf4/stream-app.git ~/resenha && cd ~/resenha/deploy
```

### Option B: from Windows without Git (PowerShell)

Windows 11 ships with `tar` and `scp`. Only `server/` and `deploy/` are needed. In the project folder:

```bash
tar -czf resenha.tar.gz --exclude=node_modules --exclude=dist --exclude=data --exclude=.env server deploy
```

```bash
scp resenha.tar.gz ubuntu@YOUR_IP:~
```

Replace `ubuntu` with your server's user (Oracle: `ubuntu`, Hetzner: `root`). Then log in and extract:

```bash
ssh ubuntu@YOUR_IP
```

```bash
mkdir -p ~/resenha && tar -xzf ~/resenha.tar.gz -C ~/resenha && cd ~/resenha/deploy
```

---

## 4. Run the installer

Inside `deploy/`:

```bash
sudo bash install.sh
```

The prompts are in Portuguese:

| Prompt | Meaning | What to enter |
|---|---|---|
| `Domínio` | Domain | Press Enter for `YOUR-IP.sslip.io`, or type your own domain (the same one baked into an app you already shipped) |
| `Nome do servidor` | Server name | Shown at the top of the app |
| `Senha para os amigos entrarem` | Password | The password your friends will use (the same one baked into an app you already shipped) |
| `Canais de voz` | Voice channels | Initial channels, e.g. `General,Games,Movies` |

The installer then:

1. installs Docker, curl, openssl and cron if missing;
2. generates the secrets and writes `deploy/.env` (mode `600`);
3. checks that the domain resolves to this server's public IP (otherwise the HTTPS certificate can't be issued)
   and asks before going on if it doesn't;
4. opens the ports in `ufw` if it's active;
5. builds and starts the containers;
6. if the code came from `git clone`, schedules `auto-update.sh` every 10 minutes (pulls `main` and redeploys).

It finishes by printing the address to use, e.g. `Pronto! No app, use o endereço: https://203-0-113-5.sslip.io`
("Done! In the app, use this address").

> The first start takes 1–3 minutes (image build and certificate issuance).

---

## 5. Verify

```bash
docker compose ps
```

`app`, `livekit` and `caddy` should all be `running`. LiveKit should announce the VPS's public IP:

```bash
docker compose logs livekit | grep "using external IPs"
```

Then, from your PC:

```bash
curl https://YOUR-DOMAIN/api/health
```

Expected response: `{"ok":true}`.

Join a voice channel and ask a friend to join too, ideally **from a different network** (e.g. a phone hotspot),
to confirm the UDP port is reachable. The stats icon on a video should show a direct UDP connection.

---

## 6. Build the app with your server baked in

So that friends **only type a nickname**, the server address and password are embedded in the installer at
build time. On your PC:

1. In `client/`, copy the template:

   ```bash
   copy .env.example .env
   ```

2. Edit `client/.env`:

   ```ini
   VITE_SERVER_URL=203-0-113-5.sslip.io
   VITE_SERVER_PASSWORD=the-password-you-chose
   ```

   | Variable | Value |
   |---|---|
   | `VITE_SERVER_URL` | The address from step 4, with or without `https://`. LiveKit's address and ports are **not** needed: the server sends them to the app. |
   | `VITE_SERVER_PASSWORD` | Same as `SERVER_PASSWORD` in `deploy/.env` |

3. Build:

   ```bash
   cd client
   npm run dist
   ```

The installer is created at `client/dist/Resenha-Setup-1.0.0.exe`. It isn't code-signed, so Windows SmartScreen
warns on first run: **More info → Run anyway**.

`client/.env` is read at build time (and by `npm run dev` after a restart). Without it, the app asks for address,
password and nickname, which is handy for testing against `localhost:3000`.

> If you change the server password or domain, update `client/.env`, rebuild and resend the installer. Old builds
> show *"A senha embutida neste app está desatualizada"* ("the embedded password is outdated").
>
> Anyone with the `.exe` can join, because the password is inside it, so share it only with your friends.
> `.env` files are git-ignored.

---

## 7. Automatic app updates (Windows)

Friends install the app **once**. After that, every push to `main` that touches `client/` publishes a new version:

1. the **Release Windows** workflow (`.github/workflows/release-win.yml`) builds the installer on a GitHub Windows
   runner, numbering it `1.1.<run number>`;
2. it sends the installer, its `.blockmap` and `latest.yml` to the VPS over SSH, into `deploy/data/updates/`;
3. the app checks `https://DOMAIN/api/updates/` on startup and every 10 minutes, downloads the new version in the
   background (only the changed blocks, when possible) and installs it silently, never during a call: right away
   if it finished within 2 minutes of opening the app (like Discord), when the window is closed to the tray, or
   when the app quits. A notification and a card also offer **Reiniciar e instalar** ("restart and install"), and
   **Configurações → Conta → Procurar atualização** checks on demand. The log is in `%APPDATA%\Resenha\logs\updater.log`.

The update files are only served to requests carrying the server password, which the app already has. They aren't
published as GitHub releases or artifacts because the repository is public and the installer contains the password.

Setup (once):

1. Create a key just for the workflow: `ssh-keygen -t ed25519 -f resenha_ci -N ""`.
2. On the VPS, allow it to run **only** the upload script (one line in `/root/.ssh/authorized_keys`):

   ```
   restrict,command="/root/resenha/deploy/receive-update.sh" ssh-ed25519 AAAA... resenha-ci
   ```

3. In the repository, add the secrets `VITE_SERVER_URL`, `VITE_SERVER_PASSWORD`, `VPS_HOST`, `VPS_SSH_KEY` (the
   private key) and `VPS_KNOWN_HOSTS` (output of `ssh-keyscan -t ed25519 VPS_IP`).

macOS builds don't update themselves: macOS only accepts an app swap when the app is signed with a paid Apple
Developer certificate.

---

## Bandwidth and stream quality

The SFU forwards one copy of each stream **per viewer**, from the server's upload:

| Quality | Per viewer (text/code) | Per viewer (games/video) |
|---|---|---|
| 1080p 60 fps | up to ~15 Mbps | up to ~30 Mbps |
| 1080p 30 fps | up to ~10 Mbps | up to ~20 Mbps |
| 720p 60 fps | up to ~8 Mbps | up to ~15 Mbps |
| 720p 30 fps | up to ~5 Mbps | up to ~10 Mbps |

VPS plans usually have plenty of upload; what matters is the **monthly traffic** included in the plan (see step 1).

In a call, the **stats icon** on each video shows resolution, fps, bitrate, packet loss, the connection type and
`Limitado por` ("limited by": `CPU` or `banda`, i.e. bandwidth). That's the quickest way to find out why a stream
stutters.

---

## Maintenance

All commands run inside `deploy/`.

| Task | Command |
|---|---|
| Update to the latest code | Automatic: `auto-update.sh` runs every 10 minutes from cron and redeploys when `main` has new commits touching `server/` or `deploy/`. Manually: `bash auto-update.sh` |
| Auto-update log | `tail -f auto-update.log` |
| App server logs | `docker compose logs -f app` |
| LiveKit logs | `docker compose logs -f livekit` |
| Caddy (HTTPS) logs | `docker compose logs -f caddy` |
| Apply `.env` changes | `docker compose up -d` |
| Update LiveKit and Caddy images | `docker compose pull && docker compose up -d` |
| Back up messages and files | `tar -czf ~/backup-resenha-$(date +%F).tar.gz data .env` |

To restore on a new server, extract the backup inside `deploy/` before running `docker compose up -d --build`.

All services use `restart: unless-stopped`, and Docker is enabled at boot, so **everything comes back after a
reboot**.

Changing the password **logs everyone out**; rebuild and resend the installer with the new `VITE_SERVER_PASSWORD`.

### `.env` variables

| Variable | Description |
|---|---|
| `DOMAIN` | Public hostname (e.g. `203-0-113-5.sslip.io`, `resenha.yourdomain.com`) |
| `SERVER_NAME` | Name shown in the app |
| `SERVER_PASSWORD` | Password to join |
| `JWT_SECRET` | Session signing secret (keep private) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit keys (keep private) |
| `CHANNELS` | Channels created on the **first** start (manage them from the app afterwards) |
| `MAX_UPLOAD_MB` | Max file size in the chat (default 100) |
| `IMAGE_TTL_DAYS` | Chat images are deleted from the server after this many days (default 30; `0` keeps them forever). Videos and other files are kept |

### Using your own domain

1. Create an **A record** pointing `resenha.yourdomain.com` to the server IP. On Cloudflare DNS, set it to
   **DNS only** (grey cloud): the proxy limits uploads to 100 MB and adds a hop to every request.
2. Set `DOMAIN=` in `deploy/.env` and run `docker compose up -d`.
3. Update `VITE_SERVER_URL` in `client/.env`, rebuild the installer and resend it.

### Moving from the Proxmox/Cloudflare setup (same domain)

The app finds LiveKit through the server, so if the new server keeps the old `APP_DOMAIN` and password, **the
installer your friends already have keeps working**, with no rebuild.

1. **Cloudflare dashboard:** in Zero Trust → Networks → Tunnels, delete the tunnel's public hostnames (the app
   domain and the `voz.` one). Then in DNS, replace the app domain's tunnel CNAME with an **A record** pointing at
   the VPS IP, **DNS only** (grey cloud).
2. **VPS:** run `install.sh` with `Domínio` = the old `APP_DOMAIN` and the same `SERVER_PASSWORD`. Copying the old
   `JWT_SECRET` into `deploy/.env` is optional: with it, friends stay logged in; without it, they type their
   nickname once more.
3. **Proxmox:** in the old `deploy/cloudflare/` folder, stop it with `docker compose down`, then remove the
   `ip-watch.sh` line from `crontab -e`.

This setup starts with an empty server (no messages or files from the old one).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App says *"Não foi possível conectar ao servidor"* ("couldn't connect to the server") | Port 443 closed or certificate not issued yet | Check step 2; see `docker compose logs caddy` |
| Caddy shows certificate / ACME errors | Port 80 closed, or the domain doesn't point at the VPS | Open TCP 80 (Let's Encrypt needs it); check the A record (DNS only, no tunnel CNAME) |
| Chat works but voice is stuck on *"Conectando…"* ("connecting") or drops | LiveKit ports blocked | Open UDP 7882 and TCP 7881; on Oracle, run the `iptables` commands |
| Connected to voice but nobody hears anybody | UDP blocked on someone's network | Make sure TCP 7881 is open (automatic fallback) |
| Streams stutter / low fps | Not enough upload, or a weak PC encoding the stream | Check the stats panel: use 720p if limited by bandwidth (`banda`) |
| *"Senha do servidor incorreta"* ("wrong server password") for everyone | Password changed in `.env` | Use the current one (`grep SERVER_PASSWORD .env`) and rebuild the installer |
| Large uploads fail | Above `MAX_UPLOAD_MB` | Raise it in `.env`, then `docker compose up -d` |
| `install.sh: $'\r': command not found` | Windows line endings | `sed -i 's/\r$//' install.sh` |
| Containers keep restarting on a 1 GB server | Out of memory during the build | Add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |

---

## Security notes

- Only people with the password can join; sessions last 30 days, and changing the password invalidates them all.
- Files uploaded to the chat are served from long random (unlisted) URLs: anyone with the link can open them.
- Keep `deploy/.env` private (the installer creates it with mode `600`).
- Keep the server updated: `sudo apt update && sudo apt upgrade -y`.
