// Aero-position core for Bike Lab: turns per-frame pose landmarks (MediaPipe 33-point layout)
// from a side-on trainer video into a position timeline (aero / base bars / sitting up / standing).
// Works in browsers (window.Aero) and Node (module.exports) for testing. No DOM, no camera.
//
// Pipeline: landmarks -> features (angles, scaled by torso length) -> raw label per frame
// (nearest calibrated position) -> Tracker (a change must hold HOLD_S before it counts)
// -> segments -> summary.
(function (root) {
  'use strict';

  const L = { lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24 };
  const DEG = 180 / Math.PI;
  const POSITIONS = ['aero', 'base', 'up', 'stand'];
  const LABELS = { aero: 'Aero', base: 'Base bars', up: 'Sitting up', stand: 'Standing', none: 'No rider' };
  const CALIBRATED = ['aero', 'base', 'up']; // standing is detected from hip height, not calibrated
  const HOLD_S = 1.5;
  const MIN_VIS = 0.5;
  const STAND_RISE = 0.2;

  // How far apart features typically are between positions. Distances are divided by these,
  // so a 10° torso difference counts about as much as a 15° forearm difference.
  const SCALE = { torso: 10, forearm: 15, elbowDrop: 0.25 };

  // Defaults before calibration. [Guessing] from typical TT positions; calibration replaces them.
  const DEFAULT_CAL = {
    aero: { torso: 12, forearm: 0, elbowDrop: 0.55 },
    base: { torso: 25, forearm: -35, elbowDrop: 0.45 },
    up: { torso: 55, forearm: -50, elbowDrop: 0.35 },
    hipY: null,
  };

  const median = (arr) => {
    const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  // ---- 1. Features from one frame ----------------------------------------
  // lm: 33 landmarks, normalised 0..1 (x right, y down). W/H: frame size, so angles aren't squashed.
  // Only the side facing the camera is used; the far arm is hidden behind the bike.
  function features(lm, W = 1280, H = 720) {
    if (!lm) return null;
    const vis = (i) => lm[i].visibility ?? 1;
    const sideScore = (s) => vis(L[s + 'Sh']) + vis(L[s + 'El']) + vis(L[s + 'Wr']) + vis(L[s + 'Hip']);
    const s = sideScore('l') >= sideScore('r') ? 'l' : 'r';
    const P = (k) => ({ x: lm[L[s + k]].x * W, y: lm[L[s + k]].y * H, v: vis(L[s + k]) });
    const sh = P('Sh'), el = P('El'), wr = P('Wr'), hip = P('Hip');
    if (Math.min(sh.v, el.v, wr.v, hip.v) < MIN_VIS) return null;
    const torsoLen = Math.hypot(sh.x - hip.x, sh.y - hip.y);
    if (torsoLen < 1e-6) return null;
    const facing = sh.x >= hip.x ? 1 : -1; // +1: rider faces right
    // Torso angle above horizontal: 0 = flat back, 90 = bolt upright.
    const torso = Math.atan2(hip.y - sh.y, Math.abs(sh.x - hip.x)) * DEG;
    // Forearm angle, elbow -> wrist, measured in the riding direction: 0 = level, negative = hands dropping.
    const forearm = Math.atan2(el.y - wr.y, (wr.x - el.x) * facing) * DEG;
    // How far the elbow sits below the shoulder, in torso lengths.
    const elbowDrop = (el.y - sh.y) / torsoLen;
    return { torso, forearm, elbowDrop, hipY: hip.y / torsoLen, side: s };
  }

  // ---- 2. Calibration ------------------------------------------------------
  // samples: { aero: [features...], base: [...], up: [...] } recorded ~20 s each at setup.
  // Returns the median of each feature per position, plus seated hip height for standing detection.
  function calibrate(samples) {
    const cal = { hipY: null, n: {} };
    const hips = [];
    for (const pos of CALIBRATED) {
      const fs = (samples[pos] || []).filter(Boolean);
      cal.n[pos] = fs.length;
      if (fs.length < 10) throw new Error(`Not enough frames for "${LABELS[pos]}" (${fs.length}). Hold the position in view of the camera and try again.`);
      cal[pos] = { torso: median(fs.map((f) => f.torso)), forearm: median(fs.map((f) => f.forearm)), elbowDrop: median(fs.map((f) => f.elbowDrop)) };
      hips.push(...fs.map((f) => f.hipY));
    }
    cal.hipY = median(hips);
    // Warn when two positions look nearly the same to the camera: the tracker can't tell them apart.
    cal.warnings = [];
    for (let i = 0; i < CALIBRATED.length; i++) for (let j = i + 1; j < CALIBRATED.length; j++) {
      const a = CALIBRATED[i], b = CALIBRATED[j];
      if (distance(cal[a], cal[b]) < 1.2) cal.warnings.push(`${LABELS[a]} and ${LABELS[b]} look very similar from this camera angle.`);
    }
    return cal;
  }

  function distance(f, c) {
    return Math.hypot((f.torso - c.torso) / SCALE.torso, (f.forearm - c.forearm) / SCALE.forearm, (f.elbowDrop - c.elbowDrop) / SCALE.elbowDrop);
  }

  // ---- 3. Raw label for one frame -----------------------------------------
  // Standing: hip rises more than STAND_RISE torso lengths above its seated height.
  // [Guessing] Standing lifts the hip 15-25 cm, about 0.3-0.45 of a torso; 0.2 leaves margin for noise.
  function classify(f, cal = DEFAULT_CAL) {
    if (!f) return 'none';
    if (cal.hipY != null && cal.hipY - f.hipY > STAND_RISE) return 'stand';
    let best = 'aero', bestD = Infinity;
    for (const pos of CALIBRATED) {
      const d = distance(f, cal[pos]);
      if (d < bestD) { bestD = d; best = pos; }
    }
    return best;
  }

  // ---- 4. Tracker: debounced timeline -------------------------------------
  // push(t, label) with t in seconds. A new position only counts once it has held for HOLD_S;
  // the change is then back-dated to when it started, so durations stay right.
  // A gap with no frames longer than GAP_S (phone locked, app in background) becomes "none".
  const GAP_S = 2;
  function Tracker(holdS = HOLD_S) {
    const segs = [];
    let cur = null, candidate = null, candT = 0, lastT = null;
    return {
      push(t, label) {
        if (lastT !== null && t < lastT) return; // out-of-order frame
        if (cur && t - lastT > GAP_S) {
          cur.e = lastT;
          cur = { pos: 'none', s: lastT, e: t };
          segs.push(cur);
          candidate = null;
        }
        lastT = t;
        if (cur === null) { cur = { pos: label, s: t, e: t }; segs.push(cur); return; }
        if (label === cur.pos) { candidate = null; cur.e = t; return; }
        if (label !== candidate) { candidate = label; candT = t; }
        if (t - candT >= holdS) {
          cur.e = candT;
          cur = { pos: label, s: candT, e: t };
          segs.push(cur);
          candidate = null;
        } else {
          cur.e = t;
        }
      },
      current: () => (cur ? cur.pos : 'none'),
      segments: () => segs.map((x) => ({ ...x })),
    };
  }

  // ---- 5. Summary -----------------------------------------------------------
  // "No rider" time (out of frame, pose lost) is left out of the percentages.
  function summarize(segments) {
    const secs = Object.fromEntries([...POSITIONS, 'none'].map((p) => [p, 0]));
    let longest = 0, breaks = 0, prevSeen = null;
    for (const g of segments) {
      const d = Math.max(0, g.e - g.s);
      secs[g.pos] += d;
      if (g.pos === 'aero') longest = Math.max(longest, d);
      if (g.pos !== 'none') {
        if (prevSeen === 'aero' && g.pos !== 'aero') breaks++;
        prevSeen = g.pos;
      }
    }
    const seen = POSITIONS.reduce((a, p) => a + secs[p], 0);
    const pct = Object.fromEntries(POSITIONS.map((p) => [p, seen ? (secs[p] / seen) * 100 : 0]));
    const total = segments.length ? segments.at(-1).e - segments[0].s : 0;
    return { totalS: total, seenS: seen, secs, pct, aeroPct: pct.aero, longestAeroS: longest, breaks };
  }

  // ---- Synthetic rider for tests -----------------------------------------
  // Builds landmarks for a rider facing right in a given position. jitter: px of noise.
  function synthFrame(pos, { W = 1280, H = 720, jitter = 0, rand = Math.random } = {}) {
    const n = () => (rand() - 0.5) * 2 * jitter;
    const geo = {
      aero: { torso: 10, forearm: 2, upper: 80 },
      base: { torso: 26, forearm: -38, upper: 70 },
      up: { torso: 60, forearm: -55, upper: 60 },
      stand: { torso: 30, forearm: -30, upper: 65 },
    }[pos];
    const hip = { x: 500, y: pos === 'stand' ? 300 : 400 };
    const T = 260; // torso length in px
    const sh = { x: hip.x + T * Math.cos(geo.torso / DEG), y: hip.y - T * Math.sin(geo.torso / DEG) };
    const UA = 140, FA = 150;
    const el = { x: sh.x + UA * Math.cos(geo.upper / DEG) * 0.3, y: sh.y + UA * Math.sin(geo.upper / DEG) };
    const wr = { x: el.x + FA * Math.cos(geo.forearm / DEG), y: el.y - FA * Math.sin(geo.forearm / DEG) };
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.1 }));
    const put = (i, p, v = 0.95) => { lm[i] = { x: (p.x + n()) / W, y: (p.y + n()) / H, visibility: v }; };
    put(L.lSh, sh); put(L.lEl, el); put(L.lWr, wr); put(L.lHip, hip);
    put(L.rSh, sh, 0.3); put(L.rEl, el, 0.3); put(L.rWr, wr, 0.3); put(L.rHip, hip, 0.3);
    return lm;
  }

  const api = { POSITIONS, LABELS, CALIBRATED, HOLD_S, DEFAULT_CAL, features, calibrate, classify, Tracker, summarize, synthFrame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Aero = api;
})(typeof window !== 'undefined' ? window : globalThis);
