/*
 * scene.js — the Scene book renderer.
 *
 * Reads static/scenes.json and turns each entry into a background:
 *   - a vertical gradient sky (palette top/mid/bottom) baked to a texture,
 *   - an optional DECORATION layer (coral reef / greek ruins / submarine),
 *     ported 1:1 from v1's canvas-2D procedural art.
 *
 * Decoration art is canvas-2D. The clean faithful port: draw each decoration's
 * 2D art into an OFFSCREEN canvas and use it as a PIXI texture/Sprite in the
 * decorLayer (stays in the Pixi scene graph, still parallax-able). Static art is
 * baked ONCE. Animated art (submarine's moving sub + dust) is redrawn into its
 * canvas each frame and re-uploaded (throttled) — reasonable because the canvas
 * is display-sized, not 4k.
 *
 * Adding a scene = add a JSON entry (+ optional decoration id). No engine edit.
 * Illustrated-art backdrops later = a `backdrop_image` field (seam below).
 *
 * Public API:
 *   const book = await SceneBook.load(PIXI, bgLayer, decorLayer, W, H);
 *   book.update(dt);   // per frame: rotation timer, animated decor
 *   book.resize(W, H);
 *   book.next() / book.prev();   // manual cycle (returns scene name)
 *   book.onBanner = (name) => {...};   // hook for the rotation banner
 */
(function () {
  "use strict";

  // ---- CONFIG ----
  const ROTATE_EVERY_S = 90;    // seconds between auto rotations (v1 used 300)
  const BLEND_DURATION_S = 6;   // seconds to cross-fade between scenes

  // ---------------------------------------------------------------------------
  // DECORATION ART — ported verbatim from the first version of the tank.
  // Each: { animated:bool, draw(ctx,W,H,tSec,palette) }.
  // palette = { top,mid,bottom,glow } arrays [r,g,b].
  // ---------------------------------------------------------------------------
  const DECORATIONS = {
    coral_reef: {
      animated: true,   // seaweed sways
      draw(ctx, W, H, t, p) {
        const dark = `rgba(${p.bottom[0] * 0.22 | 0},${p.bottom[1] * 0.28 | 0},${p.bottom[2] * 0.35 | 0},0.9)`;
        ctx.fillStyle = dark;
        // Seafloor hump
        ctx.beginPath();
        ctx.moveTo(0, H);
        ctx.quadraticCurveTo(W * 0.5, H - 50, W, H);
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
        // Coral clumps
        const corals = [
          [0.07, 60, 90], [0.20, 85, 135], [0.34, 55, 75],
          [0.52, 105, 160], [0.70, 70, 105], [0.87, 60, 85],
        ];
        for (const [cx, cw, ch] of corals) {
          const x = cx * W, y = H - 20;
          ctx.beginPath();
          ctx.moveTo(x - cw / 2, y);
          ctx.bezierCurveTo(x - cw / 3, y - ch * 0.6, x - cw / 5, y - ch, x, y - ch * 0.95);
          ctx.bezierCurveTo(x + cw / 5, y - ch, x + cw / 3, y - ch * 0.6, x + cw / 2, y);
          ctx.closePath(); ctx.fill();
          // Side branch
          ctx.beginPath();
          ctx.moveTo(x - cw * 0.3, y - ch * 0.3);
          ctx.bezierCurveTo(x - cw * 0.55, y - ch * 0.75, x - cw * 0.3, y - ch * 0.95, x - cw * 0.2, y - ch * 0.7);
          ctx.lineTo(x - cw * 0.15, y - ch * 0.3);
          ctx.closePath(); ctx.fill();
        }
        // Seaweed strips swaying
        const weedCol = `rgba(${p.glow[0] * 0.25 | 0},${p.glow[1] * 0.45 | 0},${p.glow[2] * 0.35 | 0},0.85)`;
        ctx.fillStyle = weedCol;
        for (let i = 0; i < 6; i++) {
          const x = (0.08 + i * 0.16) * W;
          const height = 80 + (i * 17) % 50;
          const phase = t * 1.2 + i * 0.7;
          const seg = 10;
          ctx.beginPath();
          for (let s = 0; s <= seg; s++) {
            const sy = H - 20 - (s / seg) * height;
            const sway = Math.sin(phase + s * 0.4) * (s / seg) * 18;
            (s === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, x + sway - 3, sy);
          }
          for (let s = seg; s >= 0; s--) {
            const sy = H - 20 - (s / seg) * height;
            const sway = Math.sin(phase + s * 0.4) * (s / seg) * 18;
            ctx.lineTo(x + sway + 3, sy);
          }
          ctx.closePath(); ctx.fill();
        }
      },
    },

    greek_ruins: {
      animated: false,   // fully static — bake once
      draw(ctx, W, H, t, p) {
        const stone = `rgba(${p.glow[0] * 0.55 | 0},${p.glow[1] * 0.45 | 0},${p.glow[2] * 0.35 | 0},0.88)`;
        const stoneDim = `rgba(${p.glow[0] * 0.35 | 0},${p.glow[1] * 0.28 | 0},${p.glow[2] * 0.22 | 0},0.88)`;
        ctx.fillStyle = stoneDim;
        ctx.fillRect(0, H - 20, W, 20);
        ctx.fillStyle = stone;
        const cols = [
          [0.10, 230, false],
          [0.28, 120, true],
          [0.48, 280, false],
          [0.70, 160, true],
          [0.87, 210, false],
        ];
        for (const [xr, h, broken] of cols) {
          const x = xr * W;
          ctx.fillRect(x - 22, H - h, 44, h);
          if (!broken) {
            ctx.fillRect(x - 30, H - h - 14, 60, 14);
            ctx.fillRect(x - 34, H - h - 22, 68, 8);
          } else {
            ctx.beginPath();
            ctx.moveTo(x - 22, H - h);
            ctx.lineTo(x - 12, H - h - 8);
            ctx.lineTo(x - 2, H - h + 4);
            ctx.lineTo(x + 10, H - h - 6);
            ctx.lineTo(x + 22, H - h + 2);
            ctx.lineTo(x + 22, H - h);
            ctx.closePath(); ctx.fill();
          }
          ctx.fillRect(x - 32, H - 20, 64, 16);
        }
        ctx.fillRect(W * 0.36, H - 38, 56, 18);
        ctx.fillRect(W * 0.40, H - 22, 44, 18);
        ctx.fillRect(W * 0.58, H - 32, 40, 12);
        ctx.beginPath();
        ctx.moveTo(W * 0.58, H - 20);
        ctx.lineTo(W * 0.58, H - 140);
        ctx.quadraticCurveTo(W * 0.62, H - 190, W * 0.66, H - 160);
        ctx.lineTo(W * 0.655, H - 150);
        ctx.quadraticCurveTo(W * 0.625, H - 170, W * 0.60, H - 140);
        ctx.lineTo(W * 0.60, H - 20);
        ctx.closePath(); ctx.fill();
      },
    },

    submarine: {
      animated: true,   // moving sub + drifting dust + spinning prop
      draw(ctx, W, H, t, p) {
        // Ambient dust particles
        for (let i = 0; i < 12; i++) {
          const px = ((i * 137 + t * 20) % (W + 40)) - 20;
          const py = ((i * 211 + t * 8) % H);
          ctx.fillStyle = `rgba(200,220,255,0.18)`;
          ctx.beginPath();
          ctx.arc(px, py, 1.5 + (i % 3) * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
        const cycle = 45;
        const progress = (t % cycle) / cycle;
        if (progress > 0.82) return;
        const a = progress / 0.82;
        const subW = 240, subH = 58;
        const x = a * (W + subW + 200) - subW - 100;
        const y = H * 0.42 + Math.sin(t * 0.6) * 10;

        ctx.save();
        ctx.translate(x, y);
        // Bubble trail
        for (let i = 0; i < 10; i++) {
          const bx = -subW / 2 - 15 - i * 18;
          const by = Math.sin(t * 2.2 + i) * 6;
          ctx.beginPath();
          ctx.arc(bx, by, 3 + (i % 3) * 1.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(240,250,255,${(0.35 - i * 0.03).toFixed(2)})`;
          ctx.fill();
        }
        // Body
        ctx.fillStyle = `rgba(${p.glow[0] * 0.85 | 0},${p.glow[1] * 0.7 | 0},${p.glow[2] * 0.45 | 0},0.94)`;
        ctx.beginPath();
        ctx.ellipse(0, 0, subW / 2, subH / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        // Dark belly accent
        ctx.fillStyle = `rgba(0,0,0,0.18)`;
        ctx.beginPath();
        ctx.ellipse(0, subH * 0.2, subW / 2 * 0.85, subH / 2 * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        // Conning tower
        ctx.fillStyle = `rgba(${p.glow[0] * 0.6 | 0},${p.glow[1] * 0.5 | 0},${p.glow[2] * 0.32 | 0},0.94)`;
        ctx.fillRect(-18, -subH / 2 - 22, 46, 24);
        // Periscope
        ctx.fillRect(14, -subH / 2 - 36, 4, 14);
        ctx.fillRect(14, -subH / 2 - 40, 14, 4);
        // Windows
        ctx.fillStyle = `rgba(255,238,140,0.95)`;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(-55 + i * 55, 0, 6, 0, Math.PI * 2);
          ctx.fill();
        }
        // Propeller
        ctx.save();
        ctx.translate(subW / 2 + 8, 0);
        ctx.rotate(t * 9);
        ctx.strokeStyle = `rgba(30,30,30,0.75)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-10, 0); ctx.lineTo(10, 0);
        ctx.moveTo(0, -10); ctx.lineTo(0, 10);
        ctx.stroke();
        ctx.restore();
        ctx.restore();
      },
    },
  };

  // ---- small color helpers ----
  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const lerp3 = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const smoothstep = (t) => t * t * (3 - 2 * t);

  // Build the { top,mid,bottom,glow } palette a scene draws with.
  function scenePalette(scene) {
    const pl = scene.palette || {};
    return { top: pl.top, mid: pl.mid, bottom: pl.bottom, glow: scene.glow };
  }

  // Gradient sky texture (thin, stretched — like the existing tank).
  function makeGradientTexture(PIXI, h, pal) {
    const c = document.createElement("canvas");
    c.width = 4; c.height = Math.max(2, h | 0);
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, rgb(pal.top));
    grad.addColorStop(0.5, rgb(pal.mid));
    grad.addColorStop(1, rgb(pal.bottom));
    g.fillStyle = grad; g.fillRect(0, 0, 4, c.height);
    return PIXI.Texture.from(c);
  }

  // ---------------------------------------------------------------------------
  // A single scene's visual: gradient sprite (+ optional baked/animated decor).
  // ---------------------------------------------------------------------------
  class SceneVisual {
    constructor(PIXI, scene, W, H) {
      this.PIXI = PIXI;
      this.scene = scene;
      this.pal = scenePalette(scene);
      this.W = W; this.H = H;

      // gradient sky
      this.grad = new PIXI.Sprite(makeGradientTexture(PIXI, H, this.pal));
      this.grad.width = W; this.grad.height = H;

      // decoration
      this.decorId = scene.decorations || null;
      this.decor = this.decorId ? DECORATIONS[this.decorId] : null;
      this.parallax = scene.parallax != null ? scene.parallax : 0.06;
      this.decorSprite = null;
      this.decorCanvas = null;
      this.decorCtx = null;
      this.decorTex = null;
      this._animAccum = 0;

      if (this.decor) this._buildDecor();
    }

    _buildDecor() {
      const PIXI = this.PIXI;
      // Offscreen canvas at DISPLAY resolution (respect TV memory ceiling —
      // never render at 4k). Cap the long side.
      const maxLong = 1920;
      const scale = Math.min(1, maxLong / Math.max(this.W, this.H));
      const cw = Math.max(2, Math.round(this.W * scale));
      const ch = Math.max(2, Math.round(this.H * scale));
      const c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      this.decorCanvas = c;
      this.decorCtx = c.getContext("2d");
      this._canvasScale = scale;

      this._redrawDecor(0);
      this.decorTex = PIXI.Texture.from(c);
      this.decorSprite = new PIXI.Sprite(this.decorTex);
      this.decorSprite.width = this.W;
      this.decorSprite.height = this.H;
    }

    _redrawDecor(t) {
      const ctx = this.decorCtx;
      const c = this.decorCanvas;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      // draw art in canvas-pixel space (scaled from display coords)
      ctx.scale(this._canvasScale, this._canvasScale);
      this.decor.draw(ctx, this.W, this.H, t, this.pal);
    }

    // Advance animated decoration; re-upload the texture (throttled ~20fps).
    updateDecor(dt, t) {
      if (!this.decor || !this.decor.animated) return;
      this._animAccum += dt;
      if (this._animAccum < 1 / 20) return;
      this._animAccum = 0;
      this._redrawDecor(t);
      this.decorTex.source.update();
    }

    setAlpha(a) {
      this.grad.alpha = a;
      if (this.decorSprite) this.decorSprite.alpha = a;
    }

    setParallaxOffset(dx, dy) {
      if (!this.decorSprite) return;
      this.decorSprite.x = dx * this.parallax;
      this.decorSprite.y = dy * this.parallax * 0.5;
    }

    resize(W, H) {
      this.W = W; this.H = H;
      this.grad.texture = makeGradientTexture(this.PIXI, H, this.pal);
      this.grad.width = W; this.grad.height = H;
      if (this.decor) {
        // rebuild the offscreen canvas at the new size
        if (this.decorTex) this.decorTex.destroy(true);
        this._buildDecor();
      }
    }

    destroy() {
      this.grad.destroy();
      if (this.decorSprite) this.decorSprite.destroy();
      if (this.decorTex) this.decorTex.destroy(true);
    }
  }

  // ---------------------------------------------------------------------------
  // SceneBook — owns the scene list, rotation, glows, and the two layers.
  // ---------------------------------------------------------------------------
  class SceneBook {
    constructor(PIXI, bgLayer, decorLayer, scenes, W, H) {
      this.PIXI = PIXI;
      this.bgLayer = bgLayer;
      this.decorLayer = decorLayer;
      this.scenes = scenes;
      this.W = W; this.H = H;
      this.onBanner = null;

      this.curIdx = 0;
      this.nextIdx = null;
      this.blend = 0;
      this.timeUntilNext = ROTATE_EVERY_S;
      this.tSec = 0;

      // current + (during transition) next visuals
      this.curVis = new SceneVisual(PIXI, scenes[0], W, H);
      this.nextVis = null;
      this._mount(this.curVis);
      this.curVis.setAlpha(1);

      // NOTE: v1 had NO glow blobs — just the clean gradient + decorations.
      // An earlier v2 draft added additive "glow" circles here; they read as
      // muddy smears over the gradient and were removed (owner feedback
      // 2026-07-02: "the previous version background were better").
    }

    _mount(vis) {
      // gradient goes into bgLayer (behind glows -> add glows after);
      // decoration goes into decorLayer.
      this.bgLayer.addChildAt(vis.grad, 0);
      if (vis.decorSprite) this.decorLayer.addChild(vis.decorSprite);
    }
    _unmount(vis) {
      if (vis.grad.parent) vis.grad.parent.removeChild(vis.grad);
      if (vis.decorSprite && vis.decorSprite.parent) vis.decorSprite.parent.removeChild(vis.decorSprite);
    }

    // ---- rotation control ----
    _startTransition(toIdx) {
      if (this.nextIdx !== null) return;
      const n = this.scenes.length;
      this.nextIdx = (toIdx == null) ? (this.curIdx + 1) % n : ((toIdx % n) + n) % n;
      if (this.nextIdx === this.curIdx) { this.nextIdx = null; return; }
      this.nextVis = new SceneVisual(this.PIXI, this.scenes[this.nextIdx], this.W, this.H);
      this._mount(this.nextVis);
      this.nextVis.setAlpha(0);
      this.blend = 0;
      if (this.onBanner) this.onBanner(this.scenes[this.nextIdx].name);
    }

    _commitTransition() {
      this._unmount(this.curVis);
      this.curVis.destroy();
      this.curVis = this.nextVis;
      this.curIdx = this.nextIdx;
      this.nextVis = null;
      this.nextIdx = null;
      this.blend = 0;
      this.timeUntilNext = ROTATE_EVERY_S;
      this.curVis.setAlpha(1);
    }

    // Jump instantly to a scene index (no crossfade) — used by the review /
    // screenshot harness to capture each scene deterministically.
    showScene(idx) {
      const n = this.scenes.length;
      idx = ((idx % n) + n) % n;
      if (this.nextVis) { this._unmount(this.nextVis); this.nextVis.destroy(); this.nextVis = null; this.nextIdx = null; }
      this._unmount(this.curVis);
      this.curVis.destroy();
      this.curVis = new SceneVisual(this.PIXI, this.scenes[idx], this.W, this.H);
      this.curIdx = idx;
      this._mount(this.curVis);
      this.curVis.setAlpha(1);
      this.blend = 0;
      this.timeUntilNext = ROTATE_EVERY_S;
      return this.scenes[idx].name;
    }

    next() { this._startTransition(this.curIdx + 1); return this.scenes[this.nextIdx ?? this.curIdx].name; }
    prev() { this._startTransition(this.curIdx - 1); return this.scenes[this.nextIdx ?? this.curIdx].name; }
    currentName() { return this.scenes[this.curIdx].name; }

    // ---- per-frame ----
    update(dt) {
      this.tSec += dt;

      if (this.nextIdx === null) {
        this.timeUntilNext -= dt;
        if (this.timeUntilNext <= 0) this._startTransition();
      } else {
        this.blend += dt / BLEND_DURATION_S;
        const s = smoothstep(Math.min(1, this.blend));
        this.curVis.setAlpha(1 - s);
        this.nextVis.setAlpha(s);
        if (this.blend >= 1) this._commitTransition();
      }

      // animated decorations
      this.curVis.updateDecor(dt, this.tSec);
      if (this.nextVis) this.nextVis.updateDecor(dt, this.tSec);

      const tSlow = performance.now() * 0.0001;

      // gentle parallax drift of the decoration layer
      const pdx = Math.sin(tSlow * 1.3) * 24;
      const pdy = Math.cos(tSlow * 0.9) * 10;
      this.curVis.setParallaxOffset(pdx, pdy);
      if (this.nextVis) this.nextVis.setParallaxOffset(pdx, pdy);
    }

    resize(W, H) {
      this.W = W; this.H = H;
      this.curVis.resize(W, H);
      if (this.nextVis) this.nextVis.resize(W, H);
    }

    static async load(PIXI, bgLayer, decorLayer, W, H) {
      const data = await (await fetch("static/scenes.json", { cache: "no-store" })).json();
      const scenes = (data.scenes || []).filter((s) => s && s.palette);
      if (!scenes.length) throw new Error("scenes.json has no valid scenes");
      return new SceneBook(PIXI, bgLayer, decorLayer, scenes, W, H);
    }
  }

  window.SceneBook = SceneBook;
})();
