# Deploying on a home server (Proxmox) with no open ports

This guide runs the **whole** Resenha backend (app server, chat and the LiveKit media server) in a single
container on a home Proxmox host, **without opening any port on the router**. Your friends only install
the Windows app.

> Prefer a VPS or a server where you can open ports? See [DEPLOY.md](DEPLOY.md).

```
                         ┌───────────── Cloudflare ─────────────┐
 Resenha app ──HTTPS───> │ Tunnel  (login, chat, voice signaling)│ <── cloudflared ──┐
      │                  │                                       │                   │  your Proxmox
      └─ audio/video ──> │ TURN    (relays audio and video, UDP) │ <── LiveKit ──────┤  (outbound
                         └───────────────────────────────────────┘                   │   connections
                                                                     app server ─────┘   only)
```

- **Cloudflare Tunnel** carries the website, the API, the chat and LiveKit's signaling to your server.
- **Cloudflare TURN (Realtime)** relays the audio and video. A tunnel can't carry WebRTC's UDP media, so
  clients send media to Cloudflare's TURN relay, and LiveKit reaches that relay from inside your network.

Both use **outbound** connections from your server, so nothing has to be opened on the router. This also
works behind **CGNAT**.

Clients on the **same LAN as the server** skip Cloudflare entirely and connect to LiveKit directly. That way
a friend streaming from your house doesn't spend your upload bandwidth on their own stream.

### What you need

| Item | Cost |
|---|---|
| A **domain** registered on Cloudflare | ~US$10/year for a `.com` |
| **Cloudflare Tunnel** | free |
| **Cloudflare TURN** | free up to 1,000 GB/month of relayed media ([pricing](https://developers.cloudflare.com/realtime/turn/)) |
| A Proxmox host with room for one container: 2 cores, 2 GB RAM, 16 GB disk | — |

---

## 1. Register a domain

1. Create an account at https://dash.cloudflare.com
2. Go to **Domain Registration → Register Domains** and buy a name (Cloudflare sells at cost).

This guide uses `yourdomain.com` as the example.

---

## 2. Create the TURN server (audio and video)

1. In the Cloudflare dashboard, open **Realtime** in the sidebar (older accounts may show it as **Calls**).
2. Go to **TURN Server → Create** and give it a name (e.g. `resenha`).
3. Write down both values:
   - **Turn Token ID**
   - **API Token** (shown **only once**, so copy it now)

---

## 3. Create the tunnel

1. Open https://one.dash.cloudflare.com (Zero Trust). The first time, it asks for a team name and a plan:
   choose **Free** (it may ask for a card, but the Free plan is not charged).
2. Go to **Networks → Tunnels → Create a tunnel → Cloudflared**.
3. Name it (e.g. `resenha`) and save.
4. On the install screen, pick **Docker** and copy **only the token**: the long string after `--token`
   (it starts with `eyJ`).

   > The dashboard waits on *"Waiting for your Tunnel to connect…"* until a connector is running. If you
   > want to get past this screen before installing Resenha, start a temporary connector in the container
   > from step 4: `docker run -d --name cloudflared-temp --restart unless-stopped --network host cloudflare/cloudflared:latest tunnel --no-autoupdate run --token YOUR_TOKEN`.
   > Remove it before step 6 (`docker rm -f cloudflared-temp`).

5. Create **two routes**: **Add route → Published application** (called *Public Hostnames* in older
   dashboards).

   | Subdomain | Domain | Service URL | Used for |
   |---|---|---|---|
   | `resenha` | `yourdomain.com` | `http://localhost:3000` | App, login and chat |
   | `voz` | `yourdomain.com` | `http://localhost:7880` | Voice signaling (LiveKit) |

   The URL needs the `http://` prefix. Use `http://`, not `https://`: Cloudflare already provides HTTPS
   to the outside world.

WebSockets are enabled by default on Cloudflare (**your domain → Network → WebSockets: On**).

---

## 4. Create the container on Proxmox

A **Debian 12 LXC container** is recommended (lightweight); a Debian/Ubuntu VM also works.

The fastest way is to paste this into the **Proxmox host shell** (*node → >_ Shell*). It picks the next free
ID and the default container storage, downloads the template, creates the container with the features Docker
needs (**nesting** and **keyctl**), starts it on boot, and installs Docker inside it:

```
CTID=$(pvesh get /cluster/nextid)
STORAGE=$(pvesm status -content rootdir | awk 'NR>1 {print $1; exit}')
pveam update
TEMPLATE=$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -n1)
pveam download local "$TEMPLATE"
read -rsp "Container root password: " PW; echo
pct create "$CTID" "local:vztmpl/$TEMPLATE" \
  --hostname resenha \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs "$STORAGE:16" \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --nameserver "1.1.1.1 8.8.8.8" \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 --onboot 1 \
  --password "$PW"
pct start "$CTID"
sleep 10
pct exec "$CTID" -- bash -c "apt-get update && apt-get install -y curl git && curl -fsSL https://get.docker.com | sh"
echo "Container $CTID ready. IP: $(pct exec "$CTID" -- hostname -I)"
```

If your network bridge isn't called `vmbr0`, change it (see *node → System → Network*). DHCP is fine: nothing
points at the container's IP.

<details>
<summary>Creating it from the web UI instead</summary>

1. **local → CT Templates → Templates**: download `debian-12-standard`.
2. **Create CT**: 16 GB disk, 2 cores, 2048 MB RAM, 512 MB swap, DHCP, DNS `1.1.1.1`.
3. **Before starting it**, enable **nesting** and **keyctl** in **Options → Features**.
4. Start it, open the **Console**, and install Docker:
   `apt-get update && apt-get install -y curl git && curl -fsSL https://get.docker.com | sh`

</details>

---

## 5. Get the code into the container

### Option A: from GitHub (recommended)

In the **container console**:

```bash
git clone https://github.com/luisf4/stream-app.git /root/resenha && cd /root/resenha/deploy/cloudflare
```

Secrets never go to Git (every `.env` file is git-ignored), so a public repository is safe.

### Option B: without Git (tarball)

Only `server/` and `deploy/` are needed. On your **Windows PC (PowerShell)**, in the project folder:

```bash
tar -czf resenha.tar.gz --exclude=node_modules --exclude=dist --exclude=data --exclude=.env server deploy
```

```bash
scp resenha.tar.gz root@PROXMOX_IP:/root/
```

On the **Proxmox host shell** (replace `102` with your container ID):

```
pct push 102 /root/resenha.tar.gz /root/resenha.tar.gz
```

In the **container console**:

```bash
mkdir -p /root/resenha && tar -xzf /root/resenha.tar.gz -C /root/resenha && cd /root/resenha/deploy/cloudflare
```

---

## 6. Run the installer

In the container, inside `/root/resenha/deploy/cloudflare`:

```bash
bash install.sh
```

The prompts are in Portuguese:

| Prompt | Meaning | What to enter |
|---|---|---|
| `Nome do servidor` | Server name | Shown at the top of the app |
| `Senha para os amigos entrarem` | Password | The password your friends will use (baked into the installer later) |
| `Canais de voz` | Voice channels | Initial channels, e.g. `General,Games,Movies` (manage them later from the app) |
| `Endereço do app` | App address | `resenha.yourdomain.com` |
| `Endereço da voz` | Voice address | Press Enter to use `voz.yourdomain.com` |
| `Token do túnel` | Tunnel token | The token from step 3 |
| `Turn Token ID` / `API Token` | TURN credentials | The values from step 2 |

The installer:

1. installs Docker and cron if missing;
2. generates the LiveKit keys and the JWT secret, and writes `deploy/cloudflare/.env` (mode `600`);
3. starts `app`, `livekit` and `cloudflared`;
4. schedules `ip-watch.sh` every 2 minutes, which restarts LiveKit when the home IP changes, or when LiveKit
   isn't advertising the right public IP.

### Verify

```bash
docker compose ps
```

All three services should be `running`, and the tunnel should show as **HEALTHY** in the Cloudflare dashboard.
Opening `https://resenha.yourdomain.com/api/health` should return `{"ok":true}`.

LiveKit must map your **public IP onto the LAN interface**:

```bash
docker compose logs livekit | grep "using external IPs" | tail -n1
```

Expected: something like `"ips": ["179.x.x.x/192.168.x.x"], "advertiseInternalIP": true`.

The app server log confirms TURN is enabled:

```bash
docker compose logs app | grep pronto
```

It should end with `(mídia via TURN do Cloudflare)` ("media via Cloudflare TURN").

### About the `.env` files

The `.env` files hold passwords and tokens, so they stay out of Git. Each one lives in a different place:

| File | Where it lives | How it gets there |
|---|---|---|
| `deploy/cloudflare/.env` | **in the container** | created by `install.sh` from your answers (recommended), **or** sent ready-made (below) |
| `client/.env` | **on your PC** | created from `client/.env.example`; only used when building the installer |
| `server/.env` | **on your PC** | local development only |

To send a ready-made `deploy/cloudflare/.env` instead of answering prompts (`install.sh` skips the questions
when the file already exists): fill in `deploy/cloudflare/.env.example` on your PC (generate `JWT_SECRET` and
`LIVEKIT_API_SECRET` as random strings of 32+ characters), then copy it into the container:

```bash
scp deploy\cloudflare\.env root@PROXMOX_IP:/root/resenha.env
```

```
pct push 102 /root/resenha.env /root/resenha/deploy/cloudflare/.env --perms 600 && rm /root/resenha.env
```

> Keep a copy of the server's `.env` somewhere safe (e.g. a password manager). Together with the `data/`
> folder, it's all you need to restore the server.

---

## 7. Build the app for your friends

On your PC, create `client/.env` from `client/.env.example`:

```ini
VITE_SERVER_URL=resenha.yourdomain.com
VITE_SERVER_PASSWORD=the-password-from-step-6
```

Build the installer:

```bash
cd client
npm run dist
```

Send `client/dist/Resenha-Setup-1.0.0.exe` to your friends; they only type a nickname. The voice address and the
TURN credentials are not in the app: the server hands them out at login.

The installer isn't code-signed, so Windows SmartScreen will warn on first run: **More info → Run anyway**.
Anyone with the `.exe` can join the server, because the password is inside it, so share it only with your friends.

---

## Bandwidth and stream quality

With the media server at home, **every viewer's copy of a stream leaves through your home upload**:

| Quality | Per viewer (text/code) | Per viewer (games/video) |
|---|---|---|
| 1080p 30 fps | up to ~4.5 Mbps | up to ~6 Mbps |
| 720p 30 fps | up to ~2.5 Mbps | up to ~3.5 Mbps |

Set `UPLOAD_MBPS` in `.env` to your measured upload: the app then splits ~70% of it among the people in the call
(the rest is left for voices and overhead) and drops 1080p to 720p when the slice gets small. Example: with
14 Mbps, one viewer gets the full ~6 Mbps, three get ~3.2 Mbps each, five get ~1.9 Mbps each at 720p.

Measure your upload from the container:

```bash
apt install -y speedtest-cli && speedtest-cli --secure --simple
```

TURN usage (shown in Cloudflare under **Realtime → TURN Server**): a 1080p stream with 3 viewers relays up to
~8 GB/hour, so the 1,000 GB free tier covers ~120 hours/month. Voice is negligible.

### Checking how each person is connected

In a call, hover over a video and click the **stats icon**. The `Conexão` ("Connection") line shows:

- `host UDP`: direct connection on the same LAN as the server (no upload used)
- `TURN via UDP`: through Cloudflare's relay (normal for friends outside your network)
- `TURN via TCP` / `TLS`: fallback for networks that block UDP (works, but stutters more on packet loss)

The same panel shows fps, bitrate, packet loss and `Limitado por` ("limited by": `CPU` or `banda`, i.e. bandwidth).

---

## After a reboot

Everything comes back on its own:

| Piece | Why it restarts automatically |
|---|---|
| The container | Created with `onboot: 1` (check with `pct config 102 \| grep onboot`) |
| Docker and cron | Enabled services (check with `systemctl is-enabled docker cron`) |
| `app`, `livekit`, `cloudflared` | `restart: unless-stopped` in Docker Compose |
| `ip-watch.sh` | Runs from cron every 2 minutes |

If LiveKit starts before the network is fully up and picks a wrong IP, `ip-watch.sh` fixes it within 2 minutes:
the website and chat work right away, but voice may need a couple of minutes.
Services you stop manually (`docker compose stop`/`down`) stay stopped until `docker compose up -d`.

---

## Maintenance

All commands run in `/root/resenha/deploy/cloudflare` inside the container.

| Task | Command |
|---|---|
| Update to the latest code | `cd /root/resenha && git pull && cd deploy/cloudflare && docker compose up -d --build` |
| App server logs | `docker compose logs -f app` |
| LiveKit logs | `docker compose logs -f livekit` |
| Tunnel logs | `docker compose logs -f cloudflared` |
| IP watchdog history | `cat ip-watch.log` |
| Apply `.env` changes | `docker compose up -d` |
| Update LiveKit and cloudflared images | `docker compose pull && docker compose up -d` |
| Back up messages and files | `tar -czf /root/backup-resenha-$(date +%F).tar.gz data .env` |

Tip: schedule a Proxmox backup of the container (**Datacenter → Backup**); it includes everything.

Changing the password **logs everyone out**. Also update `VITE_SERVER_PASSWORD` in `client/.env`, rebuild the
installer and send it again: old installers will show *"A senha embutida neste app está desatualizada"*
("the password embedded in this app is outdated").

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Docker won't start in the LXC (`permission denied`, `sysctl` or `overlay` errors) | **nesting/keyctl** not enabled | Stop the container, enable them in **Options → Features**, start it again (or use a VM) |
| Tunnel shows **DOWN** / **INACTIVE** | Wrong token or no internet | `docker compose logs cloudflared`; fix `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, then `docker compose up -d` |
| **502 Bad Gateway** | Route pointing to the wrong service | `resenha` → `http://localhost:3000`, `voz` → `http://localhost:7880` |
| Route URL rejected: *Invalid service URL format* | Missing protocol | Use `http://localhost:3000` (with `http://`) |
| Joining voice shows *"Falha ao preparar a conexão de voz (TURN)"* | Wrong Turn Token ID / API Token | Check `docker compose logs app`; fix `CLOUDFLARE_TURN_*` in `.env`, then `docker compose up -d` |
| Voice stuck on *"Conectando…"* ("connecting") | LiveKit didn't map the public IP onto the LAN interface | The last `using external IPs` line must show `PUBLIC_IP/192.168.x.x`. `ip-watch.sh` checks this every 2 minutes and restarts LiveKit (see `ip-watch.log`) |
| `ip-watch.log` full of `Resolving timed out` | The container's DNS is failing (this also breaks LiveKit's IP discovery) | On the Proxmox host: `pct set 102 --nameserver "1.1.1.1 8.8.8.8"`, then restart the container |
| Voice stopped after the internet dropped | The home IP changed | `ip-watch.sh` restarts LiveKit within 2 minutes |
| Streams stutter / low fps | Not enough home upload, or a weak PC encoding the stream | Open the stats panel: `Limitado por: banda` means bandwidth, so use 720p; `CPU` means the streamer's PC can't keep up |
| *"Não foi possível conectar ao servidor"* ("couldn't connect to the server") on one PC while it works for others | That network cached a "domain doesn't exist" answer from before the route was created | `ipconfig /flushdns`; if `nslookup resenha.yourdomain.com` still says *Non-existent domain*, restart the router (or your AdGuard/Pi-hole) or wait up to 30 min |
| Same error on a PC with a **VPN** (e.g. Proton, DNS `10.2.0.1`), and `nslookup` only returns IPv6 addresses | The VPN's DNS cached the old answer, and the VPN blocks IPv6 | Turn the VPN off, or exclude Resenha via the VPN's *Split Tunneling* (also better for voice) |
| Large uploads fail | Cloudflare free plan limits requests to 100 MB | Keep `MAX_UPLOAD_MB=95` |
| `install.sh: $'\r': command not found` | Windows line endings | `sed -i 's/\r$//' install.sh ip-watch.sh` |

---

## Alternative: no Cloudflare, with open ports

If you'd rather not use Cloudflare, the same container can run the open-ports stack with a free **DuckDNS**
hostname that follows your changing home IP:

1. Make sure your connection **isn't behind CGNAT**: the IP at https://api.ipify.org must match the WAN IP shown
   by your router. If it doesn't, ask your ISP for a public IP.
2. Create a subdomain at https://www.duckdns.org and copy the token.
3. Give the container a **static IP** and forward **TCP 80, 443, 7881** and **UDP 50000-50100** to it.
4. In the container, use the `deploy/` folder (not `deploy/cloudflare/`), run `bash install.sh` and enter the
   DuckDNS subdomain and token when asked.
5. In `client/.env`, use `VITE_SERVER_URL=yoursubdomain.duckdns.org`.

`deploy/duckdns.sh` updates DuckDNS every 5 minutes and restarts LiveKit when the IP changes. Maintenance and
troubleshooting for this mode are in [DEPLOY.md](DEPLOY.md).
