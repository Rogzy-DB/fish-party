# AGENTS.md — for an AI assistant setting up Fish Party

You are helping someone host a Fish Party: guests colour sea creatures (on paper or
on a phone) and the drawings swim on a projected wall. Read this file first, then
explain the project to your user in plain words before doing anything.

## What it is

- `tank/serve.py` — the tank server (Python 3 standard library). It serves the
  aquarium page for the wall, the phone pages and the guests' fish.
- `recognizer/` — OpenCV code that cuts a photographed paper drawing out and
  recognises which of the 12 creatures it is. Installed by `requirements.txt`.
- `templates/` — the 12 A4 colouring sheets (`all-12-templates.pdf` = all of them).
- All state lives in one folder, `data/` by default (fish PNGs, `labels.json`,
  `settings.json`).

## Set it up on the user's computer

1. Check `python3 --version` (a current Python 3) and `git --version`. If one is
   missing, tell the user and ask before installing anything system-wide.
2. Install inside a virtual environment, never with a system-wide `pip`:
   ```sh
   git clone https://github.com/Rogzy-DB/fish-party
   cd fish-party
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   ```
3. Start the tank so phones on the same Wi-Fi can reach it:
   ```sh
   .venv/bin/python tank/serve.py --host 0.0.0.0 --port 8000
   ```
   It runs in the foreground; Ctrl+C stops it. The default mode, `home`, is meant
   for a private network: anyone who can reach it can add fish and open the settings.
4. Find the computer's address on the local network (for example `192.168.1.20`) and
   give the user:
   - **the wall**: `http://<address>:8000/` (open it full screen, F11);
   - **the guests' phones**: `http://<address>:8000/draw` (offer a QR code);
   - **paper drawings**: `http://<address>:8000/upload`;
   - **the host's own phone**: `/settings` (fish size, sound, hide a fish) and
     `/review` (paper drawings the recogniser was unsure about).

## Check it works

- `http://127.0.0.1:8000/` shows the aquarium.
- Open `/draw` on a phone, paint any creature, tap “Swim!”: it appears on the wall
  within about ten seconds.
- If the computer's firewall blocks port 8000, phones won't connect: say so and let
  the user decide whether to allow it.

## Good to know

- **Bitcoin bubbles** come from `https://mempool.space` by default. A node owner can
  set `MEMPOOL_API=http://<their-mempool>`. Without internet, pretend bubbles appear;
  nothing else needs the internet.
- **Never put `home` mode on the internet.** A public tank uses `TANK_MODE=public`
  and an `ADMIN_PASSWORD`; see `docs/DEPLOY.md`.
- Guest names are plain text, trimmed to 40 characters. Remind the user to think
  twice about children's first names if the tank ever goes online.
- The full checklist for the night is in `docs/HOST-A-PARTY.md`.
