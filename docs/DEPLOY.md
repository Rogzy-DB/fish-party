# Putting Fish Party online

The website is three pieces behind one domain:

| path | what | how |
|---|---|---|
| `/` | the showcase site | static files: `site/` |
| `/party/` | a read-only tank | `serve.py`, `TANK_MODE=showcase` |
| `/tank/` | the shared tank anyone can draw into | `serve.py`, `TANK_MODE=public` |

## 1. The tanks (Docker)

```sh
cd deploy
printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 18)" > fish-party.env
chmod 600 fish-party.env
docker compose up -d --build
```

Both tanks listen on `127.0.0.1` only (8001, 8002); the web server is the only
door. All their state is in `deploy/data/` (party copy + shared tank): back it up.

Without Docker: run `tank/serve.py` twice with the same environment variables as
`deploy/run-tanks.sh` (a systemd unit each), after `pip install -r requirements.txt`.

## 2. The site + routing (Caddy)

```sh
rsync -aL --delete site/ /srv/fish-party/site/   # -L: templates/ and outlines/ are symlinks
```

Then add [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) to your Caddyfile
and reload. Caddy gets the HTTPS certificate by itself once the domain points at
the server. Keep `X-Frame-Options` at `SAMEORIGIN`, not `DENY`: the home page
embeds the party tank.

## 3. Moderating the shared tank

Every new fish waits in **`/tank/review`** (user `admin`, the password from
`fish-party.env`). One tap lets it swim, or pick another species, or discard it.
Nothing a stranger sends is visible before you accept it, the picture included.

Built-in limits (environment variables): `SUBMIT_MAX` fish per visitor per hour
(default 6), `PENDING_MAX` drawings waiting at once (default 300), 16 MB per
upload. `/tank/settings` hides a fish that's already swimming.

## 4. Updating

```sh
git pull && rsync -aL --delete site/ /srv/fish-party/site/
cd deploy && docker compose up -d --build
```
