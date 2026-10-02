/*
 * meshbody.js — per-vertex body deformation for the Tank (PixiJS v8).
 *
 * The reusable FOUNDATION the 12 species will eventually share. Today only the
 * jellyfish is wired to it; the other 11 stay on the cheap sprite-transform
 * wobble in tank.js (applyWobble). We migrate them one at a time.
 *
 * WHY a mesh: the old wobble is a whole-sprite skew/scale — it can't ripple a
 * tentacle or squash only the top of a bell. A mesh is a grid of vertices over
 * the fish texture; we move each vertex individually every frame, so the SHAPE
 * deforms, not just the bounding box.
 *
 * WHERE the animation comes from: a per-species *deformation profile* — a pure
 * function of (u, v, t, params, out):
 *     u ∈ [0,1]  horizontal texture coord (0=left, 1=right)
 *     v ∈ [0,1]  VERTICAL   texture coord (0=TOP, 1=BOTTOM)   <- the spec's `v`
 *     t          LIVE seconds (real wall-clock phase, advanced by real dt) so
 *                the deformation ANIMATES — this is the static-time bug the
 *                blueprint called out, fixed by construction here.
 *     params     the species' tunables (from species.json wobble.*)
 *     out        {x, y} written IN PLACE — pixel offset in the mesh's local,
 *                UN-scaled texture space (foundation multiplies by size).
 * The profile returns an offset added to each vertex's rest position. Movement
 * (boids) lives on the parent container transform and is kept fully separate
 * from this body-local deformation layer.
 *
 * CPU deform (not a GLSL shader): we mutate the aPosition buffer and call
 * .update(). At ~12x16 verts x a handful of jellyfish this is trivially cheap
 * and dodges shipping/άmaintaining a custom shader — while still being true
 * per-vertex deformation driven by a live time value.
 */
(function () {
  "use strict";
  const PIXI = window.PIXI;

  // registry of deformation profiles, keyed by name. A species' wobble.mesh
  // names which profile it uses; today only "jellyfish" is registered.
  const PROFILES = {};
  function registerProfile(name, fn) { PROFILES[name] = fn; }
  function getProfile(name) { return PROFILES[name] || null; }

  /*
   * MeshBody — one deformable creature body.
   *
   *   new MeshBody(texture, { cols, rows, profile, params })
   *
   * Owns a PIXI.Mesh (add .view to a container). Call update(t, extra) each
   * frame with LIVE seconds; it recomputes every vertex from rest + profile.
   * Transform (position/scale/tint/alpha) is set by the caller on .view, so
   * the boids layer and the deformation layer never touch each other.
   */
  class MeshBody {
    constructor(texture, opts = {}) {
      const cols = this.cols = Math.max(2, opts.cols || 12); // verts across
      const rows = this.rows = Math.max(2, opts.rows || 16); // verts down
      this.profileFn = opts.profile || null;
      this.params = opts.params || {};

      // Build a plane grid over the texture. PlaneGeometry lays out a
      // (cols x rows) vertex lattice with aPosition (pixels) + aUV (0..1).
      const w = texture.width, h = texture.height;
      this.geo = new PIXI.PlaneGeometry({
        width: w, height: h,
        verticesX: cols, verticesY: rows,
      });

      this.mesh = new PIXI.Mesh({ geometry: this.geo, texture });
      // anchor-equivalent: shift so the mesh is centered on its origin, matching
      // the sprites' anchor(0.5) so swap-in needs no position math.
      this.mesh.pivot.set(w / 2, h / 2);

      // snapshot rest positions + per-vertex uv (v = vertical coord we steer on)
      const pos = this.geo.getBuffer("aPosition");
      const uv = this.geo.getBuffer("aUV");
      this.posBuf = pos;
      this.rest = Float32Array.from(pos.data); // immutable base lattice
      this.uv = Float32Array.from(uv.data);
      this.texW = w; this.texH = h;
      this._out = { x: 0, y: 0 };
    }

    get view() { return this.mesh; }

    setProfile(fn, params) { this.profileFn = fn; if (params) this.params = params; }

    /*
     * Recompute every vertex: rest + profile(u, v, t) offset. `t` is LIVE
     * seconds; `extra` is an optional per-creature bag (e.g. startle) passed
     * through to the profile. Offsets are returned by the profile in
     * normalized texture units and scaled by texture size here, so a profile
     * is resolution-independent.
     */
    update(t, extra) {
      const fn = this.profileFn;
      const data = this.posBuf.data;
      const rest = this.rest, uv = this.uv;
      const out = this._out;
      const sw = this.texW, sh = this.texH;
      const params = this.params;
      const n = rest.length; // 2 floats per vertex
      if (!fn) {
        // no profile -> identity (rest pose)
        if (data !== rest) data.set(rest);
        this.posBuf.update();
        return;
      }
      for (let i = 0, j = 0; i < n; i += 2, j += 2) {
        const u = uv[j], v = uv[j + 1];
        out.x = 0; out.y = 0;
        fn(u, v, t, params, out, extra);
        data[i] = rest[i] + out.x * sw;
        data[i + 1] = rest[i + 1] + out.y * sh;
      }
      this.posBuf.update();
    }

    destroy() {
      this.mesh.destroy();
      this.geo.destroy();
    }
  }

  // ------------------------------------------------------------------
  // JELLYFISH deformation profile.
  //
  // The texture splits at params.bellSplit (v below = bell, above = tentacles):
  //   BELL (v < bellSplit): a bouncy vertical squash-and-stretch coil/spring.
  //     A springy (non-sinusoidal, snappier) pulse drives it. Squash =
  //     compress vertically + bulge wider; stretch = lengthen + narrow, so it
  //     reads volume-preserving and springy, not a flat scale. The bell's TOP
  //     (v→0) moves most; the rim (v→split) least, so it contracts "into
  //     itself".
  //   TENTACLES (v > bellSplit): a lateral traveling sine wave. Amplitude grows
  //     toward the bottom (v→1); phase travels DOWNWARD (waveSpeed*v term) so
  //     the tentacles ripple instead of swinging rigidly.
  //
  // Returns the pulse value on out via a stash so the mover can sync vertical
  // bob to the power-stroke (see jellyBellPhase()).
  // ------------------------------------------------------------------

  // A springy pulse in [-1..1]: a sine base sharpened so the "spring open"
  // (stretch) reads as a quicker snap than the slow squash. Deterministic in t.
  function springPulse(t, freq) {
    const s = Math.sin(t * freq);
    // asymmetry: bias toward the open (positive) state and sharpen the snap
    return Math.sign(s) * Math.pow(Math.abs(s), 0.7);
  }

  registerProfile("jellyfish", function (u, v, t, p, out, extra) {
    const freq = p.freq != null ? p.freq * Math.PI * 2 * 0.5 : Math.PI; // wobble.freq -> rad/s (~kept close to old feel)
    const split = p.bellSplit != null ? p.bellSplit : 0.55;

    // shared spring pulse: +1 = fully sprung open (tall+narrow), -1 = squashed
    const pulse = springPulse(t, p.pulseFreq != null ? p.pulseFreq : (freq / (Math.PI * 2)));

    if (v <= split) {
      // ---- BELL: squash / stretch about the rim (v = split) ----
      const bellAmp = p.bellAmp != null ? p.bellAmp : 0.16;
      // depth from top: 1 at top (v=0), 0 at rim (v=split)
      const fromTop = 1 - (v / split);
      // vertical: stretch (pulse>0) pulls top UP (negative y) away from rim;
      // squash (pulse<0) pushes it DOWN toward the rim. Scaled by fromTop so
      // the rim is the anchor and the dome does the moving.
      out.y = -pulse * bellAmp * fromTop;
      // horizontal volume-trade: when squashed (pulse<0) bulge WIDER; when
      // stretched (pulse>0) pull narrower. Centered on u=0.5.
      const widen = -pulse * bellAmp * (p.bellWiden != null ? p.bellWiden : 0.9);
      out.x = (u - 0.5) * widen * fromTop;
    } else {
      // ---- TENTACLES: lateral traveling wave, amplitude grows downward ----
      const tAmp = p.tentAmp != null ? p.tentAmp : 0.10;
      const waveSpeed = p.waveSpeed != null ? p.waveSpeed : 3.0; // phase travel down
      const waveFreq = p.waveFreq != null ? p.waveFreq : 6.0;    // temporal ripple
      // 0 at split -> 1 at bottom; square-ish so tips swing most
      const depth = (v - split) / (1 - split);
      const grow = depth * depth;
      // traveling wave: phase = time*waveFreq - v*waveSpeed*2π (travels DOWN)
      const phase = t * waveFreq - v * waveSpeed * Math.PI * 2;
      out.x = Math.sin(phase) * tAmp * grow;
      // a touch of vertical follow so tips also lift/drop with the sway
      out.y = Math.cos(phase) * tAmp * 0.25 * grow;
      // tentacles also ride the bell's pulse a little (get pulled up on stretch)
      out.y += -pulse * 0.02 * grow;
    }
  });

  // ------------------------------------------------------------------
  // OCTOPUS deformation profile.
  //
  // Same top/bottom split idea as the jellyfish but NO bell pulse (octopus
  // stays upright, doesn't jet-bob). The head/mantle (v < headSplit) only
  // breathes faintly; the ARMS (v > headSplit) each ripple on their own:
  //   - a lateral traveling sine (phase travels DOWN the arm, like the jelly),
  //   - amplitude grows toward the tips (v→1), squared so the tips move most,
  //   - a PER-COLUMN phase offset (from u) so the left/right arms wave out of
  //     sync — that's what makes it read as many little tentacles, not a sheet.
  // ------------------------------------------------------------------
  registerProfile("octopus", function (u, v, t, p, out, extra) {
    const split = p.headSplit != null ? p.headSplit : 0.42;
    const tAmp = p.tentAmp != null ? p.tentAmp : 0.14;
    const waveFreq = p.waveFreq != null ? p.waveFreq : 4.0;   // temporal ripple
    const waveSpeed = p.waveSpeed != null ? p.waveSpeed : 2.2; // phase travel down
    const spread = p.spread != null ? p.spread : 6.0;          // per-column desync

    if (v <= split) {
      // ---- head / mantle: faint breathing squash about the top ----
      const bAmp = p.breatheAmp != null ? p.breatheAmp : 0.02;
      const breathe = Math.sin(t * (p.breatheFreq != null ? p.breatheFreq : 1.3));
      const fromTop = 1 - (v / split);
      out.y = -breathe * bAmp * fromTop;
      out.x = (u - 0.5) * breathe * bAmp * 0.8 * fromTop;
    } else {
      // ---- arms: independent traveling waves, growing to the tips ----
      // grow=depth^2 keeps the motion in the LONG bottom arms only — owner
      // preference (2026-07-05): the "spread to every arm" version read worse
      // (whole-blob wobble); the concentrated bottom-arm sway looks natural.
      const depth = (v - split) / (1 - split);   // 0 at head rim -> 1 at tips
      const grow = depth * depth;
      const colPhase = (u - 0.5) * spread;        // each column (arm) desynced
      const phase = t * waveFreq - v * waveSpeed * Math.PI * 2 + colPhase;
      out.x = Math.sin(phase) * tAmp * grow;
      // slight vertical curl so tips also reach/coil, not just sway sideways
      out.y = Math.cos(phase * 0.9) * tAmp * 0.3 * grow;
    }
  });

  // ------------------------------------------------------------------
  // SWIM deformation profile — the generic side-view fish body wave.
  //
  // Canonical fish face RIGHT: head at u=1, TAIL at u=0. A real fish swims by
  // passing an undulation from head to tail, the tail sweeping most. So:
  //   - displace each column VERTICALLY (out.y) — for a side-view fish the tail
  //     fin beats up/down in the image plane,
  //   - amplitude grows toward the tail (u→0), `taper` keeps the head stiff,
  //   - the wave phase travels head→tail (the tail lags), so it ripples along
  //     the body instead of the whole fish flapping as one plank.
  // Reusable by every side-view swimmer (shark first; whale/angelfish/… later).
  // ------------------------------------------------------------------
  registerProfile("swim", function (u, v, t, p, out, extra) {
    const amp = p.swimAmp != null ? p.swimAmp : 0.08;
    const waveFreq = p.waveFreq != null ? p.waveFreq : 1.6;  // tail beats / sec
    const waveLen = p.waveLen != null ? p.waveLen : 0.7;     // waves along body
    const taper = p.taper != null ? p.taper : 2.0;           // head-stiffness
    const tail = 1 - u;                       // 0 at head (u=1) -> 1 at tail (u=0)
    const grow = Math.pow(tail, taper);
    const phase = t * waveFreq * Math.PI * 2 - tail * waveLen * Math.PI * 2;
    out.x = 0;
    out.y = Math.sin(phase) * amp * grow;
  });

  // Live bell pulse value for the mover to sync vertical bob to the power
  // stroke. Same springPulse the profile uses, so they stay in phase.
  function jellyBellPhase(t, p) {
    return springPulse(t, p && p.pulseFreq != null ? p.pulseFreq
      : (p && p.freq != null ? p.freq * 0.5 : 0.5));
  }

  window.MeshBody = MeshBody;
  window.MeshBodyProfiles = { register: registerProfile, get: getProfile, jellyBellPhase };
})();
