# The party tank

46 sea creatures coloured on paper by the guests of a family party in June 2026,
scanned, recognised and swimming at `/party/` on the Fish Party website.

The drawings are shared under **CC BY-NC 4.0**: show them, remix them, use them to
demo your own tank, but not commercially. Credit: "Fish Party guests, 2026".

Run them on your machine:

    cp -r demo/party data/party
    FISH_DATA=data/party TANK_MODE=showcase python3 tank/serve.py
