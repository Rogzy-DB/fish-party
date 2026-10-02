#!/bin/sh
# party tank: a read-only copy of demo/party, seeded once into the data volume
[ -d /data/party ] || cp -r /app/demo/party /data/party
mkdir -p /data/commons
FISH_DATA=/data/party TANK_MODE=showcase \
  python3 /app/tank/serve.py --host 0.0.0.0 --port 8001 &
FISH_DATA=/data/commons TANK_MODE=public \
  exec python3 /app/tank/serve.py --host 0.0.0.0 --port 8002
