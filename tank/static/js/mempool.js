/*
 * mempool.js — Bitcoin mempool visualization for the Tank.
 *
 * Ported 1:1 from the first version of the tank: bubbles rise from the seabed,
 *   size  = tx output value, log-scaled
 *   color = fee rate (sat/vB), blue -> red
 * plus a gold new-block flash + fish-startle event.
 *
 * v1 fetched a server-proxied `api/mempool`. Here we hit the mempool API
 * directly (config.MEMPOOL_API). Data path is identical; if the API is
 * unreachable the poller can be pointed at a mock (see MempoolFeed.poll).
 *
 * Rendered as Pixi Graphics via a small pool. Bubble physics live here;
 * the renderer just calls feed.update(dt) + feed.draw().
 */

// --- v1 encodings, copied verbatim so the visual language matches v1 ---
function txBubbleColor(rate) {
  if (rate >= 50) return 0xff643c;   // red/orange — high
  if (rate >= 20) return 0xffb432;   // orange — medium-high
  if (rate >= 10) return 0x64dc64;   // green — medium
  if (rate >= 5)  return 0x50c3f7;   // cyan — low
  return 0x8ca0dc;                    // blue-gray — minimum
}
function txBubbleRadius(value) {
  const sats = Math.max(value || 0, 1);
  const r = 4 + (Math.log10(sats) - 4) * 4;
  return Math.max(3, Math.min(34, r)) + Math.random() * 1.5;
}

class MempoolBubble {
  constructor(tx, W, H) {
    this.x = Math.random() * W;
    this.y = H + Math.random() * 40;
    this.r = txBubbleRadius(tx.value);
    // a mempool backend sends rate; mempool.space sends fee + vsize only
    this.color = txBubbleColor(tx.rate || (tx.fee && tx.vsize ? tx.fee / tx.vsize : 1));
    this.speed = 20 + Math.random() * 40;
    this.phase = Math.random() * Math.PI * 2;
    this.alpha = 0.6 + Math.random() * 0.3;
    this.dead = false;
  }
  update(dt) {
    this.y -= this.speed * dt;
    this.phase += dt * 1.2;
    if (this.y < -20) this.dead = true;
  }
}

class MempoolFeed {
  constructor(PIXI, layer, cfg) {
    this.PIXI = PIXI;
    this.layer = layer;             // Pixi Container to draw into
    this.cfg = cfg;
    this.W = cfg.W; this.H = cfg.H;
    this.bubbles = [];
    this.seen = new Set();
    this.lastBlockHeight = 0;
    this.connected = false;
    this.gfx = new PIXI.Graphics();
    this.layer.addChild(this.gfx);
    this.blockFlashAlpha = 0;
    this.onBlock = cfg.onBlock || (() => {});
  }

  resize(w, h) { this.W = w; this.H = h; }

  async poll() {
    try {
      // 1) recent txs (via the dev-server proxy — same-origin, no CORS)
      // RELATIVE path (no leading "/") so it works both at the origin root AND
      // behind Caddy's handle_path /<app>/* prefix-strip (e.g. /tank/).
      const base = this.cfg.MEMPOOL_API || "";
      const res = await fetch(base + "api/mempool/recent", { cache: "no-store" });
      if (!res.ok) throw new Error("recent " + res.status);
      const txs = await res.json();
      this.connected = true;
      for (const tx of txs) {
        if (this.seen.has(tx.txid)) continue;
        this.seen.add(tx.txid);
        if (this.bubbles.length < 150) this.bubbles.push(new MempoolBubble(tx, this.W, this.H));
      }
      if (this.seen.size > 500) {
        const arr = [...this.seen]; this.seen.clear();
        arr.slice(-200).forEach((id) => this.seen.add(id));
      }
      // 2) block tip
      try {
        const hr = await fetch(base + "api/mempool/tip-height", { cache: "no-store" });
        if (hr.ok) {
          const h = parseInt(await hr.text(), 10);
          if (h > 0 && this.lastBlockHeight > 0 && h > this.lastBlockHeight) {
            this.blockFlashAlpha = 0.4;
            this.onBlock(h);
          }
          if (h > 0) this.lastBlockHeight = h;
        }
      } catch (e) { /* height optional */ }
    } catch (e) {
      this.connected = false;
      if (this.cfg.mock) this._injectMock();
    }
  }

  // Fallback: synthesize plausible txs so the code path still runs offline.
  _injectMock() {
    this.connected = false;
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const tx = {
        txid: "mock-" + Math.random().toString(36).slice(2),
        value: Math.pow(10, 3 + Math.random() * 6),
        rate: Math.pow(2, Math.random() * 7),
      };
      if (this.bubbles.length < 150) this.bubbles.push(new MempoolBubble(tx, this.W, this.H));
    }
  }

  update(dt) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.update(dt);
      if (b.dead) this.bubbles.splice(i, 1);
    }
    if (this.blockFlashAlpha > 0) this.blockFlashAlpha = Math.max(0, this.blockFlashAlpha - dt * 0.8);
  }

  draw() {
    const g = this.gfx;
    g.clear();
    for (const b of this.bubbles) {
      const wx = b.x + Math.sin(b.phase) * 10;
      // fill
      g.circle(wx, b.y, b.r).fill({ color: b.color, alpha: b.alpha * 0.3 });
      // ring
      g.circle(wx, b.y, b.r).stroke({ color: b.color, width: 1.2, alpha: b.alpha });
      // highlight
      g.circle(wx - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.2)
        .fill({ color: 0xffffff, alpha: Math.min(1, b.alpha * 0.5) });
    }
  }
}

window.MempoolFeed = MempoolFeed;
