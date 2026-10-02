/*
 * tank.js — the Tank renderer (PixiJS v8 / WebGL).
 *
 * Scene graph (forked from the official PixiJS "fish-pond" tutorial):
 *
 *   stage
 *   ├── bgLayer        full-screen gradient background + parallax glow blobs
 *   ├── decorLayer     seabed / silhouettes (parallax, drawn behind creatures)
 *   ├── creatureLayer  the boids (depth-sorted: far/back first)
 *   ├── mempoolLayer   Bitcoin tx bubbles + block flash
 *   └── waterLayer     TilingSprite caustics overlay (screen blend)
 *   + stage-wide DisplacementFilter  (light distortion / fake caustics)
 *
 * Behavior comes entirely from BoidWorld (boids.js) reading species.json.
 * Body wobble is per-species, driven by a LIVE time/phase (creature.wobblePhase,
 * advanced by real dt in boids.js — NOT a static uniform, per the blueprint fix).
 */
(async () => {
  "use strict";
  const PIXI = window.PIXI;

  const CONFIG = window.TANK_CONFIG || {};
  // "" is a valid value (same-origin -> use the dev-server proxy). Only fall
  // back when the key is genuinely absent (undefined), not merely empty.
  const MEMPOOL_API = (CONFIG.MEMPOOL_API !== undefined)
    ? CONFIG.MEMPOOL_API : "http://127.0.0.1:8999";
  // How many copies of each real fish to spawn. 1 = exactly OUR fish (correct
  // default; the tank is meant to be our real drawings, sparse is fine). Bump
  // to 2 for a livelier tank — it clones real fish, never invents species.
  const SPAWN_INSTANCES = CONFIG.SPAWN_INSTANCES || 1;

  // ---------------- viewport scaling (phone "step back from the glass") -------
  // The projector is the primary surface and must look EXACTLY as it always has,
  // so desktop/projector keeps a 1:1 world (SCENE_SCALE 1, FISH_SCALE 1) and none
  // of the maths below changes anything there.
  //
  // On a phone the tank read as massively zoomed in. Two independent knobs:
  //   SCENE_SCALE  scales the WHOLE stage down and grows the world to match, so
  //                background, decor, bubbles and fish all shrink together and
  //                you simply see MORE tank — literally stepping back.
  //   FISH_SCALE   an ADDITIONAL shrink applied to creature bodies only, on top
  //                of the scene scale.
  const MOBILE_MAX_WIDTH = 640;   // the one breakpoint — v1 used the same value
  const SCENE_SCALE_MOBILE = 0.6;
  const FISH_SCALE_MOBILE = 0.5;  // was 0.4; bumped 25% on the owner's call
  const isMobileViewport = () =>
    Math.min(window.innerWidth, window.innerHeight) < MOBILE_MAX_WIDTH;
  const sceneScale = () => (isMobileViewport() ? SCENE_SCALE_MOBILE : 1);
  const fishScale = () => (isMobileViewport() ? FISH_SCALE_MOBILE : 1);
  // Global body-size dial from the server settings (the phone-as-remote). 1 =
  // the "m" preset = the untouched projector look. It COMPOSES with the
  // mobile/desktop fishScale above, so desktop at defaults stays pixel-identical.
  let settingsSizeMult = 1;
  const effectiveFishScale = () => fishScale() * settingsSizeMult;

  const app = new PIXI.Application();
  await app.init({
    background: 0x02060f,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    preference: "webgl",
  });
  document.getElementById("stage").appendChild(app.canvas);

  // W/H are WORLD units, not screen pixels. With the stage scaled by S, a screen
  // of `app.screen.width` px shows `app.screen.width / S` world units — so every
  // downstream consumer (scene book, water, boids bounds, mempool, spawn edges)
  // is built at world size and the whole thing is shrunk once at the stage.
  // On desktop S = 1 and W/H are exactly the old values.
  let S = sceneScale();
  app.stage.scale.set(S);
  let W = app.screen.width / S, H = app.screen.height / S;

  // ---------------- layers ----------------
  const bgLayer = new PIXI.Container();
  const decorLayer = new PIXI.Container();
  const creatureLayer = new PIXI.Container();
  const mempoolLayer = new PIXI.Container();
  const waterLayer = new PIXI.Container();
  app.stage.addChild(bgLayer, decorLayer, creatureLayer, mempoolLayer, waterLayer);

  // ---------------- background: the Scene book (scene.js) ----------------
  // Backgrounds are now DATA (static/scenes.json), not hardcoded here. The
  // SceneBook builds a gradient sky + palette-tinted drifting glows into bgLayer
  // and a procedural decoration (coral / ruins / submarine) into decorLayer,
  // auto-rotates them, and cross-fades. See static/js/scene.js + scenes.json.
  const sceneBook = await window.SceneBook.load(PIXI, bgLayer, decorLayer, W, H);
  sceneBook.onBanner = (name) => showBanner(name);

  // ---------------- water overlay (TilingSprite caustics) ----------------
  // Procedurally build a soft caustic tile, then tile it across the tank and
  // scroll it. Screen blend gives the shimmering light-on-water feel.
  function makeCausticTile(size) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    g.clearRect(0, 0, size, size);
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * size, y = Math.random() * size;
      const r = 20 + Math.random() * 70;
      // draw the blob 9 times on a 3x3 torus so the tile wraps SEAMLESSLY —
      // without this every tile edge shows as a visible grid line on flat
      // background colors.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bx = x + ox * size, by = y + oy * size;
          if (bx < -r || bx > size + r || by < -r || by > size + r) continue;
          const rad = g.createRadialGradient(bx, by, 0, bx, by, r);
          rad.addColorStop(0, "rgba(180,235,255,0.14)");
          rad.addColorStop(1, "rgba(180,235,255,0)");
          g.fillStyle = rad; g.fillRect(0, 0, size, size);
        }
      }
    }
    return PIXI.Texture.from(c);
  }
  const causticTex = makeCausticTile(256);
  const water = new PIXI.TilingSprite({ texture: causticTex, width: W, height: H });
  water.blendMode = "add";
  // Whisper-faint. v1 had NO caustic layer — the background was a clean gradient.
  // At 0.35 the tiled blobs read as a muddy cloudy wash over the sky (owner:
  // "i hate the new weird background, go back to the original"). Keep just a hint.
  water.alpha = 0.06;
  waterLayer.addChild(water);

  // ---------------- displacement filter (stage-wide light distortion) ----------------
  function makeDisplacementTexture(size) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // smooth low-frequency noise via summed sines
        const n = (Math.sin(x * 0.08) + Math.sin(y * 0.11) + Math.sin((x + y) * 0.05)) / 3;
        const m = (Math.cos(x * 0.06) + Math.sin(y * 0.09)) / 2;
        const i = (y * size + x) * 4;
        img.data[i] = 128 + n * 90;
        img.data[i + 1] = 128 + m * 90;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return PIXI.Texture.from(c);
  }
  const dispTex = makeDisplacementTexture(256);
  dispTex.source.wrapMode = "repeat";
  const dispSprite = new PIXI.Sprite(dispTex);
  dispSprite.width = W; dispSprite.height = H;
  // Gentle. At scale 14 this warped the background gradient into a wavy, uneven
  // "weird" sky. v1 had no displacement at all — keep a barely-there ripple so
  // the water feels alive without distorting the clean gradient.
  const dispFilter = new PIXI.DisplacementFilter({ sprite: dispSprite, scale: 4 });
  app.stage.addChild(dispSprite);
  // The stage-wide displacement is a FULL-SCREEN GPU pass every frame — its cost
  // is fixed by screen resolution, independent of fish count. MEASURED on the Pi
  // TV: 26fps with it, 35fps without (+34%), for a ripple invisible at scale 4.
  // So it's OFF by default (the caustic water layer still gives the underwater
  // feel). Opt back in on a capable GPU with TANK_CONFIG.FILTERS=true.
  const FILTERS_ON = CONFIG.FILTERS === true
    && !location.search.includes("nofilter");
  if (FILTERS_ON) app.stage.filters = [dispFilter];

  // ---------------- load species book (behavior only) ----------------
  // species.json now carries ONLY behavior profiles. The LOOK of each creature
  // is the guest's own drawing, fetched from the manifest below.
  const registry = await (await fetch("static/species.json", { cache: "no-store" })).json();

  // ---------------- load the REAL fish manifest + their textures ----------
  // Each entry is a real recognized guest drawing: {id, species, texture_url}.
  // RELATIVE fetch so it works behind a reverse proxy's prefix-strip (e.g. /tank/).
  let manifest = [];
  try {
    manifest = await (await fetch("api/fish/manifest", { cache: "no-store" })).json();
  } catch (e) {
    console.error("[tank] failed to load fish manifest", e);
  }
  // Load each real drawing's texture (keyed by fish id). Skip any species not
  // in the book, and any texture that fails to load (retry once).
  const texByFish = new Map();
  for (const f of manifest) {
    if (!registry.species.some((s) => s.id === f.species)) {
      console.warn("[tank] manifest fish", f.id, "has unknown species", f.species, "- skipping");
      continue;
    }
    let tex = null;
    for (let attempt = 0; attempt < 2 && !tex; attempt++) {
      try { tex = await PIXI.Assets.load(f.texture_url); }
      catch (e) { if (attempt) console.warn("[tank] texture load failed", f.id, f.texture_url, e); }
    }
    if (tex) texByFish.set(f.id, tex);
  }
  const usable = manifest.filter((f) => texByFish.has(f.id));
  console.log("[tank] manifest:", manifest.length, "fish, textures loaded:", usable.length);

  // ---------------- boids world ----------------
  const world = new window.BoidWorld(W, H, registry);
  world.setFishScale(effectiveFishScale());   // no-op (1) on the projector at defaults

  // ---------------- organic staggered entrance ----------------
  // Don't dump every fish in at once. Queue them (shuffled) and release one at a
  // time over the first ~SPAWN_WINDOW seconds — each either SWIMS IN from a
  // random edge or FADES IN "from the background". Feels like the tank fills up
  // over the first minutes. (Mid-show uploads still pop in via refreshManifest.)
  // ?spawn=<seconds> shortens it (an embed, a screenshot); the wall keeps 150
  const SPAWN_PARAM = parseFloat(new URLSearchParams(location.search).get("spawn"));
  const SPAWN_WINDOW = SPAWN_PARAM > 0 ? SPAWN_PARAM : (CONFIG.SPAWN_WINDOW || 150);
  const pending = [];
  for (const f of usable) for (let i = 0; i < SPAWN_INSTANCES; i++) pending.push(f);
  for (let i = pending.length - 1; i > 0; i--) {     // Fisher–Yates shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [pending[i], pending[j]] = [pending[j], pending[i]];
  }
  const pendingIds = new Set(pending.map((f) => f.id));
  const spawnTotal = Math.max(1, pending.length);    // FIXED avg gap over the window
  let spawnClock = 0, nextSpawnAt = 0.6;             // first fish ~0.6s in
  const spawnGap = () =>
    (SPAWN_WINDOW / spawnTotal) * (0.4 + Math.random() * 1.2);

  // place a creature just off a random edge, swimming inward
  function enterFromEdge(c) {
    const sp = c.maxSpeed || 40, m = 70, jitter = () => (Math.random() - 0.5) * sp * 0.3;
    const e = Math.floor(Math.random() * 4);
    if (e === 0)      { c.pos.set(-m, Math.random() * H);      c.vel.set(sp, jitter()); }
    else if (e === 1) { c.pos.set(W + m, Math.random() * H);   c.vel.set(-sp, jitter()); }
    else if (e === 2) { c.pos.set(Math.random() * W, -m);      c.vel.set(jitter(), sp); }
    else              { c.pos.set(Math.random() * W, H + m);   c.vel.set(jitter(), -sp); }
  }

  function releaseOne() {
    const f = pending.shift();
    if (!f) return;
    if (!pending.some((p) => p.id === f.id)) pendingIds.delete(f.id);
    const c = world.add(f.species, f.id, f.texture_url);
    if (!c) return;
    c.spawnT = liveT;                                 // drives the fade-in
    if (Math.random() < 0.6) enterFromEdge(c);        // ~60% swim in, else fade in place
    makeSprite(c);
  }

  // Body node per creature — textured with THAT fish's real drawing.
  // Two kinds share the creatureLayer:
  //   sprites  — the cheap transform-wobble body (11 species, unchanged)
  //   meshes   — the new per-vertex deformable body (MeshBody); jellyfish only.
  // A creature whose profile.wobble.mesh names a registered profile AND has a
  // real texture gets a mesh; everything else stays a sprite.
  const sprites = new Map();
  const meshes = new Map();

  // base opacity = optional per-species alpha (translucency) * depth falloff
  function baseAlpha(c) {
    const a = (c.profile.alpha != null) ? c.profile.alpha : 1;
    return c.alpha * a;
  }
  // spawn fade-in: 0→1 over ~1.5s from the creature's spawn time (organic entrance)
  function spawnFade(c) {
    return c.spawnT == null ? 1 : Math.min(1, (liveT - c.spawnT) / 1.5);
  }

  function meshProfileFor(c) {
    const w = c.profile.wobble || {};
    if (!w.mesh || !window.MeshBodyProfiles) return null;
    return window.MeshBodyProfiles.get(w.mesh);
  }

  function makeSprite(c) {
    const tex = c.fishId ? texByFish.get(c.fishId) : null;
    // mesh path: only when we have a real texture AND a registered profile
    const profFn = tex ? meshProfileFor(c) : null;
    if (profFn) {
      const w = c.profile.wobble;
      const body = new window.MeshBody(tex, {
        cols: w.cols || 12, rows: w.rows || 16,
        profile: profFn, params: w,
      });
      body.view.alpha = baseAlpha(c);
      creatureLayer.addChild(body.view);
      meshes.set(c.id, body);
      return body.view;
    }
    const s = new PIXI.Sprite(tex || PIXI.Texture.WHITE);
    s.anchor.set(0.5);
    s.alpha = baseAlpha(c);
    creatureLayer.addChild(s);
    sprites.set(c.id, s);
    return s;
  }
  // (no initial makeSprite loop — creatures arrive via the staggered releaser)

  function destroyBody(c) {
    const m = meshes.get(c.id);
    if (m) { m.view.parent?.removeChild(m.view); m.destroy(); meshes.delete(c.id); }
    const s = sprites.get(c.id);
    if (s) { s.parent?.removeChild(s); s.destroy(); sprites.delete(c.id); }
  }

  // ---------------- live manifest refresh (upload page / review tray) -------
  // Every 10s re-fetch the manifest: newly accepted fish swim in, discarded
  // fish swim out, a review-tray species change respawns the fish with its
  // new behavior. The initial load above stays untouched.
  async function refreshManifest() {
    let fresh;
    try {
      fresh = await (await fetch("api/fish/manifest", { cache: "no-store" })).json();
    } catch (e) { return; }
    const byId = new Map(fresh.map((f) => [f.id, f]));

    // despawn: gone from the manifest, or species changed in review
    for (const c of [...world.creatures]) {
      if (!c.fishId) continue;
      const f = byId.get(c.fishId);
      if (f && f.species === c.species) continue;
      world.remove(c);
      destroyBody(c);
      if (!f) texByFish.delete(c.fishId);
    }

    // spawn: new ids (and species-changed fish removed just above)
    const live = new Set(world.creatures.map((c) => c.fishId));
    let added = 0;
    for (const f of fresh) {
      if (live.has(f.id)) continue;
      if (pendingIds.has(f.id)) continue;   // still in the initial release queue — don't jump it
      if (!registry.species.some((s) => s.id === f.species)) continue;
      let tex = texByFish.get(f.id);
      if (!tex) {
        // bust the texture cache: a re-decided fish keeps its URL
        try { tex = await PIXI.Assets.load(f.texture_url + "?v=" + Date.now()); }
        catch (e) { continue; }
        texByFish.set(f.id, tex);
      }
      const c = world.add(f.species, f.id, f.texture_url);
      if (c) { c.spawnT = liveT; enterFromEdge(c); makeSprite(c); added++; }
    }
    if (added) showBanner(added === 1 ? "a new fish joins!" : added + " new fish join!");
  }
  setInterval(refreshManifest, 10000);

  // ---------------- live settings refresh (the phone-as-remote) -------------
  // Same 10s cadence: pull the server settings and steer the projected tank —
  // fishSize preset -> global body multiplier, sound on/off + volume -> the
  // ambient <audio> (driven via index.html's __applyAudioSettings). Hidden fish
  // are already excluded server-side from the manifest, so refreshManifest above
  // removes them from the tank; nothing to do here for visibility.
  async function refreshSettings() {
    let s;
    try { s = await (await fetch("api/settings", { cache: "no-store" })).json(); }
    catch (e) { return; }
    const m = Number(s.fishSizeMultiplier);
    if (m > 0 && m !== settingsSizeMult) {
      settingsSizeMult = m;
      world.setFishScale(effectiveFishScale());   // re-tunes every body live
    }
    if (window.__applyAudioSettings) window.__applyAudioSettings(!!s.soundOn, Number(s.volume));
  }
  setInterval(refreshSettings, 10000);
  refreshSettings();

  // ---------------- HUD ----------------
  const countEl = document.getElementById("count");
  const mhud = document.getElementById("mempool-hud");
  const fpsEl = document.getElementById("fps");
  const banner = document.getElementById("banner");
  function showBanner(text) {
    banner.textContent = text;
    banner.classList.add("show");
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => banner.classList.remove("show"), 2200);
  }

  // ---------------- mempool feed ----------------
  const feed = new window.MempoolFeed(PIXI, mempoolLayer, {
    MEMPOOL_API, W, H, mock: true,
    onBlock: (h) => {
      showBanner("BLOCK " + h + " !");
      // startle everything: a scene-wide flee from center
      world.setTouch(W / 2, H / 2);
    },
  });
  const blockFlash = new PIXI.Graphics();
  mempoolLayer.addChild(blockFlash);
  feed.poll();
  setInterval(() => feed.poll(), 3000);

  // ---------------- interaction: pointer = flee, click = food ----------------
  // screen px -> world units (the stage is scaled by S, the DOM event is not)
  function toWorld(e) {
    const r = app.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / S, y: (e.clientY - r.top) / S };
  }
  app.canvas.addEventListener("pointermove", (e) => {
    const p = toWorld(e);
    world.setTouch(p.x, p.y);
  });
  app.canvas.addEventListener("pointerdown", (e) => {
    const p = toWorld(e);
    world.addFood(p.x, p.y);
    showBanner("food!");
  });

  // ---------------- resize ----------------
  // Re-tunes the viewport scaling too, so rotating a phone (or dragging a
  // desktop window across the breakpoint) re-fits instead of staying stuck at
  // the scale it happened to boot with.
  function onResize() {
    S = sceneScale();
    app.stage.scale.set(S);
    W = app.screen.width / S; H = app.screen.height / S;
    water.width = W; water.height = H;
    dispSprite.width = W; dispSprite.height = H;
    sceneBook.resize(W, H);
    world.resize(W, H);
    world.setFishScale(effectiveFishScale());
    feed.resize(W, H);
  }
  window.addEventListener("resize", onResize);

  // ---------------- keyboard: manual scene cycle (review) ----------------
  // M / ArrowRight = next scene, ArrowLeft = previous. Auto-rotation continues.
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M" || e.key === "ArrowRight") sceneBook.next();
    else if (e.key === "ArrowLeft") sceneBook.prev();
  });

  // ---------------- wobble helpers (per-species body animation) ----------------
  // Sprite-based wobble: lateral undulation (skew), pulse (scale), tail-wave,
  // paddle. Driven by creature.wobblePhase (LIVE — advanced by real dt).
  function applyWobble(c, s) {
    const w = c.profile.wobble || { style: "undulate", amp: 0.08, freq: 6 };
    const p = c.wobblePhase;
    const amp = w.amp || 0.08;
    const baseScale = c.scaleFactor;
    let sx = baseScale, sy = baseScale, skew = 0, rot = c.heading;

    switch (w.style) {
      case "pulse": {
        // jellyfish: rhythmic bell contraction (squash/stretch), no heading flip
        const pulse = Math.sin(p);
        sx = baseScale * (1 - amp * pulse);
        sy = baseScale * (1 + amp * pulse);
        rot = 0;                 // jellyfish stay upright
        break;
      }
      case "tail_wave": {
        // seahorse: gentle horizontal tail sway via skew, mostly upright
        skew = Math.sin(p) * amp;
        rot = Math.sin(p * 0.5) * 0.15;   // slight bob
        sx = baseScale; sy = baseScale;
        // seahorse faces the direction of travel but stays near-vertical
        rot += (c.vel.x < 0 ? -0.1 : 0.1);
        break;
      }
      case "paddle": {
        // turtle / manta: slow vertical bob + faint skew (flipper stroke)
        sy = baseScale * (1 + amp * Math.sin(p));
        skew = Math.sin(p) * amp * 0.5;
        break;
      }
      case "scuttle": {
        // crab: quick side-to-side shuffle, no heading flip, stays flat
        skew = Math.sin(p) * amp;
        sx = baseScale * (1 + 0.3 * amp * Math.sin(p * 2));
        rot = 0;
        break;
      }
      case "idle": {
        // sea urchin: near-static, faint breathing pulse, upright
        const b = 1 + amp * 0.5 * Math.sin(p);
        sx = baseScale * b; sy = baseScale * b;
        rot = 0;
        break;
      }
      case "startle": {
        // pufferfish: cruise normally; puff (scale up) when startled/fleeing
        skew = Math.sin(p) * amp * 0.6;
        const puff = 1 + 0.35 * (c.startled || 0);
        sx = baseScale * puff; sy = baseScale * puff;
        break;
      }
      case "undulate":
      default: {
        // fish/shark: lateral body wave — skew perpendicular to travel + tail squash
        skew = Math.sin(p) * amp;
        sy = baseScale * (1 + 0.4 * amp * Math.sin(p * 2));
        break;
      }
    }
    // upright styles keep the drawing right-way-up (no heading rotation / no
    // vertical flip): jellyfish pulse, urchin idle, crab scuttle.
    const upright = (w.style === "pulse" || w.style === "idle" || w.style === "scuttle");
    return { sx, sy, skew, rot, upright };
  }

  // ---------------- Director (ambient tricks, ported from v1) ----------------
  // Every 5–14s pick a random free swimmer and give it a flourish, with a
  // banner. Upright/floor creatures (jelly, crab, urchin, seahorse, octopus)
  // sit these out — a spinning urchin looks wrong. Tricks that pull a fish off
  // its normal path (dash/loop) are self-limited by the trick timer.
  const TRICKS = [
    { name: "dash", label: "whoosh!", dur: () => 1.2 + Math.random() * 0.8 },
    { name: "spin", label: "spin!", dur: () => 1.2 + Math.random() * 0.8 },
    { name: "zigzag", label: "zigzag!", dur: () => 2.0 + Math.random() * 0.8 },
    { name: "loop", label: "loop!", dur: () => 2.2 + Math.random() * 0.8 },
    { name: "dance", label: "dance!", dur: () => 2.8 },
  ];
  const director = {
    next: 5 + Math.random() * 5,
    update(dt) {
      this.next -= dt;
      if (this.next > 0) return;
      this.next = 5 + Math.random() * 9;
      const cands = world.creatures.filter(
        (c) => !c.trick && (c.profile.orient === "swim"));
      if (!cands.length) return;
      const f = cands[(Math.random() * cands.length) | 0];
      const t = TRICKS[(Math.random() * TRICKS.length) | 0];
      f.setTrick(t.name, t.dur());
      showBanner(t.label);
    },
  };

  // ---------------- trick glow (v1 port) ----------------
  // v1 lit a fish up during a trick (cyan shadowBlur halo). Here: a shared
  // ColorMatrix that brightens + super-saturates, toggled onto a creature's
  // view only while it's mid-trick, so the body "gets more coloured" during the
  // flourish. Cheap — only the 1–2 tricking fish carry the filter at a time.
  const trickGlow = new PIXI.ColorMatrixFilter();
  trickGlow.brightness(1.45, false);
  trickGlow.saturate(0.7, true);
  const GLOW = [trickGlow];
  function setGlow(view, on, c) {
    if (on && !c._glow) { view.filters = GLOW; c._glow = true; }
    else if (!on && c._glow) { view.filters = null; c._glow = false; }
  }

  // ---------------- main loop ----------------
  let waterOffset = 0;
  let dispPhase = 0;
  let fpsSmooth = 60;
  let liveT = 0;   // LIVE seconds — drives mesh vertex deformation over real time

  app.ticker.add((ticker) => {
    const dt = Math.min(0.05, ticker.deltaMS / 1000);
    liveT += dt;

    // physics
    world.step(dt);
    director.update(dt);
    feed.update(dt);

    // organic staggered entrance: trickle the initial fish in over SPAWN_WINDOW
    if (pending.length) {
      spawnClock += dt;
      if (spawnClock >= nextSpawnAt) { releaseOne(); nextSpawnAt = spawnClock + spawnGap(); }
    }

    // background: rotation timer, glow drift, animated decorations
    sceneBook.update(dt);

    // water + displacement animation (LIVE time — the shimmer moves)
    waterOffset += dt * 12;
    water.tilePosition.x = Math.sin(waterOffset * 0.15) * 40;
    water.tilePosition.y = -waterOffset * 6;
    if (FILTERS_ON) {
      dispPhase += dt;
      dispSprite.x = Math.sin(dispPhase * 0.6) * 30;
      dispSprite.y = Math.cos(dispPhase * 0.4) * 30;
      // DisplacementFilter.scale is a read-only Point in Pixi v8 — mutate x/y,
      // don't reassign the property (that throws and would kill the ticker).
      const ds = 4 + Math.sin(dispPhase) * 1.5;
      if (dispFilter.scale && dispFilter.scale.x !== undefined) {
        dispFilter.scale.x = ds; dispFilter.scale.y = ds;
      }
    }

    // draw creatures + wobble
    for (const c of world.creatures) {
      // --- mesh-bodied creatures: per-vertex deformation ---
      const body = meshes.get(c.id);
      if (body) {
        const w = c.profile.wobble || {};
        const morient = c.profile.orient || "upright";
        if (morient === "upright") {
          // jellyfish / octopus: no heading rotation. Jellyfish also gets a
          // vertical bob synced to the bell power-stroke (body-local; the boids
          // position is untouched). Octopus has no bobAmp -> bob = 0.
          const pulse = window.MeshBodyProfiles.jellyBellPhase(liveT, w);
          const bob = -pulse * (w.bobAmp || 0) - (w.bobDrift || 0) * 0.5;
          body.view.x = c.pos.x;
          body.view.y = c.pos.y + bob;
          body.view.rotation = 0;
          body.view.scale.set(c.scaleFactor);
        } else {
          // swim mesh (shark): the body-local tail wave lives in the profile;
          // here we only orient the whole body — face travel by MIRRORING X +
          // pitch toward travel, exactly like the sprite swim path.
          const sf = c.scaleFactor;
          body.view.x = c.pos.x; body.view.y = c.pos.y;
          if (c.trick && c.trick.name === "spin") {
            body.view.rotation = c.trick.data.spinPhase;   // barrel-roll
            body.view.scale.set(sf, sf);
          } else {
            const facingLeft = c.vel.x < 0;
            const vx = c.vel.x, vy = c.vel.y, sp = Math.hypot(vx, vy) || 1;
            let pitch = Math.asin(Math.max(-1, Math.min(1, vy / sp)));
            const mp = c.profile.max_pitch_deg;
            if (mp != null) { const m = mp * Math.PI / 180; pitch = Math.max(-m, Math.min(m, pitch)); }
            body.view.rotation = facingLeft ? -pitch : pitch;
            body.view.scale.set(facingLeft ? -sf : sf, sf);
          }
        }
        body.update(liveT);                     // recompute vertices from LIVE t
        body.view.alpha = baseAlpha(c) * spawnFade(c);
        setGlow(body.view, !!c.trick, c);       // light up mid-trick
        continue;
      }
      // --- sprite-bodied creatures (the other 11): unchanged wobble ---
      let s = sprites.get(c.id);
      if (!s) s = makeSprite(c);
      // makeSprite may have created a mesh for a late-spawned jellyfish
      if (!s || meshes.has(c.id)) continue;
      setGlow(s, !!c.trick, c);                  // light up mid-trick
      s.alpha = baseAlpha(c) * spawnFade(c);      // fade in on spawn
      s.x = c.pos.x; s.y = c.pos.y;
      const wob = applyWobble(c, s);
      const facingLeft = c.vel.x < 0;
      // --- trick: SPIN is a barrel-roll — override rotation with the spin angle
      // and don't mirror (a full 360 already shows both sides). A little pop on
      // any trick makes it read as a flourish. ---
      if (c.trick && c.trick.name === "spin") {
        const pop = 1.12;
        s.rotation = c.trick.data.spinPhase;
        s.scale.set(wob.sx * pop, wob.sy * pop);
        s.skew.set(0, wob.skew);
        continue;
      }
      const pop = c.trick ? 1.1 : 1;
      // orientation — how the drawing turns to face where it's going:
      //   "upright"  jellyfish / urchin / crab / seahorse / octopus: never
      //              rotate (belly-down as drawn), keep their sway via skew.
      //   "swim"     every fish: the HEAD LEADS the travel direction. We face
      //              left/right by MIRRORING on X (never a vertical flip), so
      //              the belly always stays down and the fish never swims
      //              tail-first. A gentle max_pitch_deg keeps big/lazy fish
      //              (whale) from rearing fully vertical; omit for agile ones.
      // Sprite art faces RIGHT; PIXI rotation is clockwise with +y downward, so
      // rotation = +pitch tips the nose DOWN. Facing left mirrors X, which flips
      // the visual sense of rotation, hence the sign is NOT negated there — this
      // exact convention is what the 8-direction test below locks in.
      const orient = c.profile.orient || (wob.upright ? "upright" : "swim");
      if (orient === "upright") {
        s.rotation = 0;
        s.scale.set(wob.sx * pop, wob.sy * pop);
        s.skew.set(0, wob.skew);
      } else {
        const vx = c.vel.x, vy = c.vel.y;
        const sp = Math.hypot(vx, vy) || 1;
        let pitch = Math.asin(Math.max(-1, Math.min(1, vy / sp)));  // -pi/2..pi/2, + = nose down
        const mp = c.profile.max_pitch_deg;
        if (mp != null) { const m = mp * Math.PI / 180; pitch = Math.max(-m, Math.min(m, pitch)); }
        // when facing left we mirror on X (scale.x < 0), which reverses the
        // visual sense of rotation — so the pitch must be negated too, or the
        // head tips the wrong way vertically (nose down while swimming up).
        s.rotation = facingLeft ? -pitch : pitch;
        s.scale.set((facingLeft ? -wob.sx : wob.sx) * pop, wob.sy * pop);
        s.skew.set(0, wob.skew);
      }
    }

    // depth sort: far (higher depth) drawn first / behind. Both sprite bodies
    // and mesh bodies live in creatureLayer, so tag whichever this creature has.
    for (const c of world.creatures) {
      const node = meshes.get(c.id)?.view || sprites.get(c.id);
      if (node) node.__depth = c.depth;
    }
    creatureLayer.children.sort((a, b) => (b.__depth ?? 0) - (a.__depth ?? 0));

    // mempool
    feed.draw();
    blockFlash.clear();
    if (feed.blockFlashAlpha > 0) {
      blockFlash.rect(0, 0, W, H).fill({ color: 0xffc832, alpha: feed.blockFlashAlpha });
    }

    // HUD
    fpsSmooth = fpsSmooth * 0.95 + ticker.FPS * 0.05;
    countEl.textContent = world.count();
    if (fpsEl) fpsEl.textContent = fpsSmooth.toFixed(0);
    if (feed.connected) {
      mhud.style.opacity = "0.75";
      mhud.textContent = "₿ " + feed.lastBlockHeight + " · " + feed.bubbles.length + " tx";
    } else {
      mhud.style.opacity = "0.4";
      mhud.textContent = "₿ (mock) · " + feed.bubbles.length + " tx";
    }
  });

  // expose for debugging / screenshot harness
  window.__tank = { app, world, feed, sprites, meshes, sceneBook, get liveT() { return liveT; } };
  console.log("[tank] started with", world.count(), "creatures");
})();
