/*
 * boids.js — Reynolds steering engine for the Tank.
 *
 * ONE rule for every creature (Reynolds/Nature-of-Code):
 *     steering = desired_velocity - current_velocity   (applied as acceleration)
 *
 * A Creature owns position/velocity/acceleration (Vec2) and a `profile` (the
 * species entry from species.json). Each frame the world computes steering
 * forces from the active behaviors weighted by the profile, sums them (clamped
 * to max_force), integrates, and clamps speed to the profile range.
 *
 * Neighborhood is bounded: radius + view angle. Neighbor queries go through a
 * SpatialHash grid so 100+ creatures stay cheap (no O(n^2) full scan).
 *
 * This module is pure math — no Pixi, no DOM. The renderer maps position/heading
 * onto sprites and reads `wobblePhase` for body animation.
 */

// ---------------- Vec2 ----------------
class Vec2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
  clone() { return new Vec2(this.x, this.y); }
  add(v) { this.x += v.x; this.y += v.y; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; return this; }
  scale(s) { this.x *= s; this.y *= s; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; return this; }
  len() { return Math.hypot(this.x, this.y); }
  len2() { return this.x * this.x + this.y * this.y; }
  norm() { const l = this.len(); if (l > 1e-6) { this.x /= l; this.y /= l; } return this; }
  setLen(n) { this.norm().scale(n); return this; }
  limit(max) {
    const l2 = this.len2();
    if (l2 > max * max) { const l = Math.sqrt(l2); this.x = (this.x / l) * max; this.y = (this.y / l) * max; }
    return this;
  }
  static sub(a, b) { return new Vec2(a.x - b.x, a.y - b.y); }
}

// ---------------- Spatial hash ----------------
// Uniform grid bucketed by cell size. Good enough for a few hundred agents;
// avoids the O(n^2) neighbor scan that would tank framerate on the TV browser.
class SpatialHash {
  constructor(cellSize) { this.cell = cellSize; this.map = new Map(); }
  _key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }
  clear() { this.map.clear(); }
  insert(item) {
    const cx = Math.floor(item.pos.x / this.cell);
    const cy = Math.floor(item.pos.y / this.cell);
    const k = this._key(cx, cy);
    let b = this.map.get(k);
    if (!b) { b = []; this.map.set(k, b); }
    b.push(item);
  }
  // Collect items within `radius` of pos (broad phase: scans overlapping cells).
  query(pos, radius, out) {
    out.length = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(pos.x / this.cell);
    const cy = Math.floor(pos.y / this.cell);
    for (let gx = cx - r; gx <= cx + r; gx++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        const b = this.map.get(this._key(gx, gy));
        if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    }
    return out;
  }
}

// ---------------- Creature ----------------
let _cid = 0;
class Creature {
  constructor(profile, x, y, fishId, textureUrl) {
    this.id = _cid++;
    this.fishId = fishId || null;        // the real guest-drawing id
    this.textureUrl = textureUrl || null; // relative URL to that drawing PNG
    this.profile = profile;
    this.species = profile.id;
    this.role = profile.role || "neutral";
    this.pos = new Vec2(x, y);
    const ang = Math.random() * Math.PI * 2;
    const sp = rand(profile.speed[0], profile.speed[1]);
    this.vel = new Vec2(Math.cos(ang) * sp, Math.sin(ang) * sp);
    this.acc = new Vec2();
    this.maxSpeed = sp;                       // this individual's cruise speed
    this.minSpeed = profile.speed[0] * 0.5;
    this.maxForce = profile.max_force;
    this.turnRate = profile.turn_rate;
    // depth in [0,1] within the species band (0 = front/near, 1 = back/far)
    this.depth = rand(profile.depth_band[0], profile.depth_band[1]);
    // near = larger, faster, more opaque
    const t = this.depth;
    this.depthScale = 1 - 0.5 * t;            // 1.0 near .. 0.5 far
    this.alpha = 1 - 0.45 * t;                // 1.0 near .. 0.55 far
    // baseScaleFactor is this individual's INTRINSIC size (species range x depth).
    // scaleFactor is what the renderer draws with = base x the world's fishScale
    // (1 on the projector; shrunk on a phone — see BoidWorld.setFishScale).
    this.baseScaleFactor = rand(profile.scale[0], profile.scale[1]) * this.depthScale;
    this.scaleFactor = this.baseScaleFactor;
    this.heading = ang;
    this.wanderAngle = Math.random() * Math.PI * 2;
    this.wobblePhase = Math.random() * Math.PI * 2;
    this.viewCos = Math.cos((profile.view_angle_deg || 300) * 0.5 * Math.PI / 180);
    this.startled = 0;                        // decays; boosts speed when fleeing
    this.hunt = 0;                            // predator strike cooldown (s). >0 = peeling off, don't re-lock
    this.trick = null;                        // {name, t, dur, data} — Director-triggered flourish (v1 port)
  }

  applyForce(f, w) { this.acc.addScaled(f, w); }

  // Director hook: begin a temporary "trick" that overrides normal steering for
  // `dur` seconds (dash / spin / zigzag / loop / dance — ported from v1). The
  // renderer reads .trick for the spin rotation + a little pop.
  setTrick(name, dur) {
    const d = { spinPhase: 0, phase: 0 };
    const heading = Math.atan2(this.vel.y, this.vel.x);
    if (name === "spin") d.rate = Math.PI * 3 * (Math.random() < 0.5 ? 1 : -1);
    // one full revolution over the trick duration, guaranteed (turn_rate would
    // otherwise cap a force-based loop into a shallow arc)
    if (name === "loop") d.omega = (Math.random() < 0.5 ? 1 : -1) * (Math.PI * 2) / dur;
    if (name === "zigzag") d.base = heading;
    if (name === "dance") { d.ax = this.pos.x; d.ay = this.pos.y; }
    this.trick = { name, t: 0, dur, data: d };
  }
}

function rand(a, b) { return a + Math.random() * (b - a); }

// ---------------- World ----------------
class BoidWorld {
  constructor(width, height, registry) {
    this.W = width; this.H = height;
    this.registry = registry;
    this.byId = new Map(registry.species.map((s) => [s.id, s]));
    this.creatures = [];
    this.predators = [];
    this.grid = new SpatialHash(140);
    this._neighbors = [];
    this.food = [];               // {pos, life}
    this.touch = null;            // {pos, life} — a flee point
    // Soft border: a fish may drift this many px PAST a viewport edge before the
    // turn-back force begins (v1 "disappear a tiny bit and come back"). Kept
    // small + the force ramps with distance, so bodies only DIP off and return.
    this.escape = 55;
    // Extra body-size multiplier applied on top of each creature's intrinsic
    // scale. 1 = the projector look (untouched). The mobile renderer drops this
    // so fish read as small distant bodies rather than filling the phone.
    this.fishScale = 1;
  }

  resize(w, h) { this.W = w; this.H = h; }

  // Re-tune every body (existing AND future) to a new size multiplier. Cheap,
  // and safe to call from the resize handler on an orientation change.
  setFishScale(s) {
    this.fishScale = s;
    for (const c of this.creatures) c.scaleFactor = c.baseScaleFactor * s;
  }

  // Spawn one creature per REAL recognized fish. `manifest` is a list of
  // {id, species, texture_url}; `instances` (>=1) optionally clones each fish
  // that many times for a livelier tank (default 1 = exactly our fish).
  spawnFromManifest(manifest, instances = 1) {
    const n = Math.max(1, instances | 0);
    for (const f of manifest) {
      if (!this.byId.has(f.species)) continue;  // never invent a species
      for (let i = 0; i < n; i++) this.add(f.species, f.id, f.texture_url);
    }
    return this.creatures.length;
  }

  add(speciesId, fishId, textureUrl) {
    const p = this.byId.get(speciesId);
    if (!p) return null;
    const x = Math.random() * this.W;
    // seed vertical position inside the species' preferred band so floor
    // creatures start on the floor and drifters start high.
    let y;
    if (p.y_band) y = (p.y_band[0] + Math.random() * (p.y_band[1] - p.y_band[0])) * this.H;
    else y = Math.random() * this.H;
    const c = new Creature(p, x, y, fishId, textureUrl);
    c.scaleFactor = c.baseScaleFactor * this.fishScale;
    this.creatures.push(c);
    if (c.role === "predator") this.predators.push(c);
    return c;
  }

  // remove a creature (review-tray discard / species change while live)
  remove(c) {
    const i = this.creatures.indexOf(c);
    if (i >= 0) this.creatures.splice(i, 1);
    const j = this.predators.indexOf(c);
    if (j >= 0) this.predators.splice(j, 1);
  }

  addFood(x, y) { this.food.push({ pos: new Vec2(x, y), life: 8 }); }
  setTouch(x, y) { this.touch = { pos: new Vec2(x, y), life: 0.9 }; }

  count() { return this.creatures.length; }

  step(dt) {
    this.t = (this.t || 0) + dt;   // world clock (drives deterministic sways)
    // rebuild spatial hash
    this.grid.clear();
    for (const c of this.creatures) this.grid.insert(c);

    // decay ephemeral stimuli
    for (const f of this.food) f.life -= dt;
    this.food = this.food.filter((f) => f.life > 0);
    if (this.touch) { this.touch.life -= dt; if (this.touch.life <= 0) this.touch = null; }

    for (const c of this.creatures) this._steer(c, dt);
    for (const c of this.creatures) this._integrate(c, dt);
  }

  _steer(c, dt) {
    const p = c.profile;
    const w = p.weights || {};
    c.acc.set(0, 0);

    // --- trick override (Director flourish) — replaces normal steering for the
    // duration so the move reads cleanly; still bounce off walls. Dance is
    // kinematic (handled in _integrate); the rest are force-driven here. ---
    if (c.trick) { this._trickForces(c); this._walls(c); return; }

    // --- schooling (separation / alignment / cohesion) ---
    if (p.schooling && p.neighbor_radius > 0) {
      this._school(c, p, w);
    } else if (w.separation) {
      // non-schoolers keep personal space from EVERYONE (cross-species): this
      // is what stops the tank collapsing into one overlapping clump.
      const sep = this._separation(c, p.separation_radius, false);
      if (sep) c.applyForce(sep, w.separation);
    }

    // --- wander ---
    if (w.wander) {
      c.wanderAngle += (Math.random() - 0.5) * 0.6;
      const wc = new Vec2(Math.cos(c.wanderAngle), Math.sin(c.wanderAngle)).scale(c.maxSpeed);
      c.applyForce(this._steerTo(c, wc), w.wander);
    }

    // --- cruise (shark/big swimmers): hold the current bearing at full speed so
    // the creature crosses the tank in long majestic sweeps instead of milling
    // in place. Walls turn it at the edges; this is what makes a shark PATROL. ---
    if (w.cruise) {
      const des = c.vel.clone().setLen(c.maxSpeed);
      c.applyForce(this._steerTo(c, des), w.cruise);
    }

    // --- vertical patrol (seahorse): commit to swimming UP the full height,
    // then reverse at the top and swim DOWN — a slow full-screen bob, not a
    // random drift that cancels out. `vertical_bias` (0..1) scales how strongly
    // it commits vs the horizontal jitter of wander above.
    if (p.vertical_bias) {
      // patrol between the species' y_band edges (seahorse: near full height;
      // jellyfish: a gentle upper-water range), reversing at each end. Falls
      // back to near-full-height if no band is set.
      const topY = this.H * (p.y_band ? p.y_band[0] : 0.07);
      const botY = this.H * (p.y_band ? p.y_band[1] : 0.93);
      if (c.bobDir === undefined) c.bobDir = Math.random() < 0.5 ? 1 : -1;
      if (c.pos.y < topY) c.bobDir = 1;
      else if (c.pos.y > botY) c.bobDir = -1;
      // optional gentle horizontal sway (h_sway) so the patrol reads as a lazy
      // drifting S rather than a straight vertical rail — jellyfish lateral
      // drift. Per-creature phase (c.id) keeps a group from swaying in unison.
      const swayX = p.h_sway
        ? Math.sin(this.t * 0.3 + c.id * 1.7) * c.maxSpeed * p.h_sway : 0;
      const des = new Vec2(swayX, c.bobDir * c.maxSpeed);
      c.applyForce(this._steerTo(c, des), 1.2 * p.vertical_bias + 0.4);
    }

    // --- vertical drift (jellyfish/seahorse buoyancy) ---
    if (w.drift_up) {
      const up = new Vec2(0, -c.maxSpeed);
      c.applyForce(this._steerTo(c, up), w.drift_up);
    }

    // --- vertical band keeping (depth-band habitat: floor-dwellers on the
    // floor, jellyfish up high). A soft force pulls the creature toward its
    // preferred vertical slice; strength scales with how far outside it is.
    if (p.y_band) {
      const top = p.y_band[0] * this.H, bot = p.y_band[1] * this.H;
      let dy = 0;
      if (c.pos.y < top) dy = top - c.pos.y;
      else if (c.pos.y > bot) dy = bot - c.pos.y;   // negative -> pull up
      if (dy !== 0) {
        const des = new Vec2(0, Math.sign(dy) * c.maxSpeed);
        const span = Math.max(1, this.H * 0.25);
        const strength = Math.min(1.5, Math.abs(dy) / span);
        c.applyForce(this._steerTo(c, des), (p.y_band_force || 0.5) * (0.5 + strength));
      }
    }

    // --- predator/prey (distance-scaled) ---
    if (w.pursue) this._pursue(c, p, w);
    if (w.evade) this._evadePredators(c, p, w);

    // --- flee from touch point ---
    if (this.touch && w.flee) {
      const d = Vec2.sub(c.pos, this.touch.pos);
      const dist = d.len();
      const rad = p.flee_radius || 220;
      if (dist < rad && dist > 1e-3) {
        d.setLen(c.maxSpeed);
        const strength = (1 - dist / rad);
        c.applyForce(this._steerTo(c, d), w.flee * strength);
        c.startled = Math.max(c.startled, 0.9 * strength);
      }
    }

    // --- seek food (all creatures with any appetite: prey + neutrals) ---
    if (this.food.length && c.role !== "predator") {
      let best = null, bd = 1e9;
      for (const f of this.food) {
        const dd = Vec2.sub(f.pos, c.pos).len2();
        if (dd < bd) { bd = dd; best = f; }
      }
      if (best && bd < 500 * 500) {
        const des = Vec2.sub(best.pos, c.pos).setLen(c.maxSpeed);
        c.applyForce(this._steerTo(c, des), 1.6);
      }
    }

    // --- wall avoidance (steer back toward the tank) ---
    this._walls(c);
  }

  _school(c, p, w) {
    const ns = this.grid.query(c.pos, p.neighbor_radius, this._neighbors);
    const sep = new Vec2(), ali = new Vec2(), coh = new Vec2();
    let nSep = 0, nAli = 0, nCoh = 0;
    const r2 = p.neighbor_radius * p.neighbor_radius;
    const sr2 = p.separation_radius * p.separation_radius;
    const heading = c.vel.clone().norm();
    for (let i = 0; i < ns.length; i++) {
      const o = ns[i];
      if (o === c || o.species !== c.species) continue;
      const off = Vec2.sub(o.pos, c.pos);
      const d2 = off.len2();
      if (d2 > r2 || d2 < 1e-6) continue;
      // view angle gate
      const dir = off.clone().norm();
      if (heading.x * dir.x + heading.y * dir.y < c.viewCos) continue;
      // separation (push away, weighted by closeness)
      if (d2 < sr2) { const away = off.clone().scale(-1 / Math.sqrt(d2)); sep.add(away); nSep++; }
      // alignment
      ali.add(o.vel); nAli++;
      // cohesion
      coh.add(o.pos); nCoh++;
    }
    if (nSep) { sep.scale(1 / nSep).setLen(c.maxSpeed); c.applyForce(this._steerTo(c, sep), w.separation || 1); }
    if (nAli) { ali.scale(1 / nAli).setLen(c.maxSpeed); c.applyForce(this._steerTo(c, ali), w.alignment || 1); }
    if (nCoh) {
      coh.scale(1 / nCoh);
      const des = Vec2.sub(coh, c.pos).setLen(c.maxSpeed);
      c.applyForce(this._steerTo(c, des), w.cohesion || 1);
    }
  }

  _separation(c, radius, sameSpeciesOnly) {
    const ns = this.grid.query(c.pos, radius, this._neighbors);
    const out = new Vec2(); let n = 0;
    const r2 = radius * radius;
    for (let i = 0; i < ns.length; i++) {
      const o = ns[i];
      if (o === c) continue;
      if (sameSpeciesOnly && o.species !== c.species) continue;
      const off = Vec2.sub(o.pos, c.pos);
      const d2 = off.len2();
      if (d2 > r2 || d2 < 1e-6) continue;
      out.add(off.clone().scale(-1 / Math.sqrt(d2))); n++;
    }
    if (!n) return null;
    out.scale(1 / n).setLen(c.maxSpeed);
    return this._steerTo(c, out);
  }

  // Force-driven trick motion (dance is kinematic in _integrate). dir = current
  // heading, perp = its left normal. Each pushes hard so the flourish dominates.
  _trickForces(c) {
    const tk = c.trick, sp = c.maxSpeed;
    const dir = c.vel.clone().norm();
    if (dir.len2() < 1e-6) dir.set(1, 0);
    const perp = new Vec2(-dir.y, dir.x);
    let des;
    switch (tk.name) {
      case "dash":   // shoot forward (integrator lifts the speed cap)
        des = dir.clone().scale(sp * 4); break;
      case "loop":   // velocity is rotated directly in _integrate — no force here
        return;
      case "zigzag": // forward + oscillating lateral = a weave
        des = dir.clone().scale(sp * 1.2).add(perp.clone().scale(sp * 1.3 * Math.sin(tk.t * 11))); break;
      case "spin":   // glide gently; the barrel-roll is visual (renderer)
        des = dir.clone().scale(sp * 0.35); break;
      default:       // dance — kinematic; no force
        return;
    }
    c.applyForce(this._steerTo(c, des), 3);
  }

  _pursue(c, p, w) {
    // Just struck: peel off and cruise for a beat so we DON'T re-lock onto the
    // same prey and orbit it. This is the key fix — a predator that seeks a
    // moving point forever can only spiral around it.
    if (c.hunt > 0) return;

    // chase the nearest prey within pursue_radius; lead its position slightly
    const rad = p.pursue_radius || 400;
    let best = null, bd = rad * rad;
    const ns = this.grid.query(c.pos, rad, this._neighbors);
    for (let i = 0; i < ns.length; i++) {
      const o = ns[i];
      if (o.role !== "prey") continue;
      const d2 = Vec2.sub(o.pos, c.pos).len2();
      if (d2 < bd) { bd = d2; best = o; }
    }
    if (!best) return;
    const dist = Math.sqrt(bd);

    // STRIKE: within strike_radius, commit one straight fast lunge THROUGH the
    // prey, then disengage (hunt cooldown). The dash-through-and-peel-off is what
    // replaces the death-spiral — the shark shoots past and arcs away to cruise.
    const strike = p.strike_radius || 150;
    if (dist < strike) {
      const des = Vec2.sub(best.pos, c.pos).setLen(c.maxSpeed);
      c.applyForce(this._steerTo(c, des), (w.pursue || 1) * 1.6);
      c.hunt = p.hunt_cooldown || 3.0;
      c.startled = Math.max(c.startled, 0.5);   // brief burst of speed on the dash
      return;
    }

    // APPROACH: outside strike range, glide toward the lead point (gentle, so it
    // arcs in on a wide line rather than snapping into a tight turn).
    const lead = best.pos.clone().addScaled(best.vel, Math.min(0.5, dist / c.maxSpeed));
    const des = Vec2.sub(lead, c.pos).setLen(c.maxSpeed);
    const strength = (1 - dist / rad);       // closer = stronger
    c.applyForce(this._steerTo(c, des), w.pursue * (0.4 + strength));
  }

  _evadePredators(c, p, w) {
    const rad = p.flee_radius || 240;
    for (let i = 0; i < this.predators.length; i++) {
      const pr = this.predators[i];
      const off = Vec2.sub(c.pos, pr.pos);
      const dist = off.len();
      if (dist < rad && dist > 1e-3) {
        // predict predator's near-future position, flee from it
        const future = pr.pos.clone().addScaled(pr.vel, 0.3);
        const away = Vec2.sub(c.pos, future).setLen(c.maxSpeed);
        const strength = (1 - dist / rad);
        c.applyForce(this._steerTo(c, away), w.evade * (0.6 + 1.6 * strength));
        c.startled = Math.max(c.startled, strength);
      }
    }
  }

  _walls(c) {
    // Steer back once a fish is `escape` px BEYOND an edge — so bodies dip off
    // and return instead of being penned in. The pull RAMPS with how far past
    // the edge (1.6 → ~4.6), tightly capping the excursion to a small dip.
    const E = this.escape, F = c.maxSpeed;
    let dx = 0, dy = 0, over = 0;
    if (c.pos.x < -E) { dx = F; over = Math.max(over, -E - c.pos.x); }
    else if (c.pos.x > this.W + E) { dx = -F; over = Math.max(over, c.pos.x - this.W - E); }
    if (c.pos.y < -E) { dy = F; over = Math.max(over, -E - c.pos.y); }
    else if (c.pos.y > this.H + E) { dy = -F; over = Math.max(over, c.pos.y - this.H - E); }
    if (dx !== 0 || dy !== 0) {
      const strength = 1.8 + Math.min(5, over / 35);
      c.applyForce(this._steerTo(c, new Vec2(dx, dy)), strength);
    }
  }

  // desired - current, force-limited => the one Reynolds rule
  _steerTo(c, desired) {
    const f = Vec2.sub(desired, c.vel);
    f.limit(c.maxForce);
    return f;
  }

  _integrate(c, dt) {
    // --- trick lifecycle (Director flourish) ---
    if (c.trick) {
      c.trick.t += dt;
      c.trick.data.spinPhase += (c.trick.data.rate || 0) * dt;   // spin barrel-roll angle
      if (c.trick.name === "dance") {
        // sway in place around the anchor point (v1 dance), face-flip on the sway
        const d = c.trick.data; d.phase += dt * 8;
        c.pos.x = d.ax + Math.sin(d.phase) * 26;
        c.pos.y = d.ay + Math.cos(d.phase * 2) * 10;
        c.vel.set(Math.cos(d.phase) * 6, 0);   // renderer faces the sway direction
        const wob = c.profile.wobble || { freq: 6 };
        c.wobblePhase += dt * wob.freq * 2.0;
        if (c.trick.t >= c.trick.dur) c.trick = null;
        return;   // kinematic — skip force integration
      }
    }

    c.acc.limit(c.maxForce * 3);
    c.vel.addScaled(c.acc, dt);

    // LOOP: rotate the velocity vector directly so the fish carves a full circle
    // (a force-steered turn would be clamped by turn_rate into a shallow arc).
    if (c.trick && c.trick.name === "loop") {
      const om = c.trick.data.omega * dt, cs = Math.cos(om), sn = Math.sin(om);
      const vx = c.vel.x, vy = c.vel.y;
      c.vel.x = vx * cs - vy * sn; c.vel.y = vx * sn + vy * cs;
    }

    // startle boost decays; predator strike cooldown ticks down
    let topSpeed = c.maxSpeed;
    if (c.startled > 0) { topSpeed *= 1 + 1.4 * c.startled; c.startled = Math.max(0, c.startled - dt * 1.5); }
    if (c.hunt > 0) c.hunt = Math.max(0, c.hunt - dt);
    // tricks that travel need a higher speed ceiling
    if (c.trick) {
      if (c.trick.name === "dash") topSpeed *= 4;
      else if (c.trick.name === "loop" || c.trick.name === "zigzag") topSpeed *= 1.5;
    }

    // clamp speed to band
    const sp = c.vel.len();
    if (sp > topSpeed) c.vel.setLen(topSpeed);
    else if (sp < c.minSpeed) c.vel.setLen(c.minSpeed);

    c.pos.addScaled(c.vel, dt);

    // hard wrap safety (only for truly-lost fish; must sit well beyond `escape`
    // so normal off-edge dips are NOT teleported)
    const pad = 400;
    if (c.pos.x < -pad) c.pos.x = this.W + pad;
    if (c.pos.x > this.W + pad) c.pos.x = -pad;
    if (c.pos.y < -pad) c.pos.y = this.H + pad;
    if (c.pos.y > this.H + pad) c.pos.y = -pad;

    // smooth heading toward velocity, capped by turn_rate
    const target = Math.atan2(c.vel.y, c.vel.x);
    let d = ((target - c.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    const step = Math.max(-c.turnRate * dt, Math.min(c.turnRate * dt, d));
    c.heading += step;

    // advance body wobble (LIVE — driven by real dt and current speed; a trick
    // flicks the tail faster, like v1)
    const wob = c.profile.wobble || { freq: 6 };
    const speedNorm = Math.min(1.6, sp / c.maxSpeed);
    c.wobblePhase += dt * wob.freq * (0.5 + speedNorm) * (c.trick ? 1.8 : 1);

    // end the trick once its time is up (non-dance; dance returns earlier)
    if (c.trick && c.trick.t >= c.trick.dur) c.trick = null;
  }
}

// expose globally (UMD-free simple globals; renderer reads these)
window.BoidWorld = BoidWorld;
window.Creature = Creature;
window.Vec2 = Vec2;
