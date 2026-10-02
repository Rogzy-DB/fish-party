# Hosting a Fish Party

What we learned running one for ~70 guests.

## You need

- **A computer** to run the tank: any laptop, or a Raspberry Pi 5.
- **A screen on the wall:** a projector (best: a big soft wall in a dim corner) or a
  TV. Anything with a browser works, smart TVs included. Open
  `http://<computer>:8000/` full-screen (F11 / kiosk mode).
- **Wi-Fi** that the guests' phones and the computer share.
- **For paper:** a printer, ~2 sheets per guest
  ([`templates/all-12-templates.pdf`](../templates/all-12-templates.pdf), A4,
  "fit to page"), pencils or felt pens, and a table.

## Two ways in

1. **Paint on a phone** — `http://<computer>:8000/draw`. Pick a creature, colour,
   name it, *Swim!*. Nothing to print, nothing to recognise: the fastest path, and
   the one kids queue for. Put the address on a QR code by the table.
2. **Paper** — guests colour a sheet, then someone photographs it at
   `http://<computer>:8000/upload` (outline fully in frame, light background).
   The recogniser cuts it out and finds the species. If it isn't sure, the drawing
   waits in `/review` and you pick the species with one tap: nothing is ever
   guessed wrong in front of everyone.

## On the night

- **Settings from your phone:** `/settings` resizes every fish, toggles the sound,
  hides a fish (oops, that one was a shopping list).
- **Bigger crowds, slower screens:** the tank was tuned on a Raspberry Pi 5 driving
  a TV. Smart-TV browsers have little memory: past ~100 fish, prefer a laptop.
- **No internet?** Everything works offline except the Bitcoin bubbles, which fall
  back to pretend ones.
- **Afterwards:** everything is in the `data/` folder. Keep it: it makes a lovely
  showcase (`TANK_MODE=showcase`), and you can put it online.

## Good to know

- A guest name is free text: it is trimmed to 40 characters and always shown as
  plain text. If the tank goes online, think twice about children's first names.
- The tank page reloads new fish every 10 seconds; no need to refresh the wall.
