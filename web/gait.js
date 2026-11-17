// Gait analysis core: turns per-frame pose landmarks (MediaPipe 33-point layout)
// from a side-on running video into running-form metrics.
// Works in browsers (window.Gait) and Node (module.exports) for testing.
(function (root) {
  'use strict';

  const L = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
    lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };
  const LEFT_LEG = [L.lKnee, L.lAnk, L.lHeel, L.lToe];
  const RIGHT_LEG = [L.rKnee, L.rAnk, L.rHeel, L.rToe];
  const DEG = 180 / Math.PI;

  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const median = (arr) => {
    const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const pct = (arr, p) => {
    const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const i = Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))));
    return v[i];
  };
  // Interior angle at b (degrees) formed by a-b-c.
  const angle3 = (a, b, c) => {
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const d = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    return Math.acos(Math.max(-1, Math.min(1, d))) * DEG;
  };

  // ---- 1. Normalise input -------------------------------------------------
  function toPixels(frames, w, h) {
    return frames.map((f) => ({ t: f.t, p: f.lm ? f.lm.map((q) => ({ x: q.x * w, y: q.y * h, v: q.visibility ?? 1 })) : null }));
  }

  // Fill short detection gaps (<= maxGap frames) by linear interpolation.
  function fillGaps(fr, maxGap) {
    let i = 0;
    while (i < fr.length) {
      if (fr[i].p) { i++; continue; }
      let j = i; while (j < fr.length && !fr[j].p) j++;
      const a = fr[i - 1], b = fr[j];
      if (a && b && a.p && b.p && j - i <= maxGap) {
        for (let k = i; k < j; k++) {
          const u = (k - (i - 1)) / (j - (i - 1));
          fr[k].p = a.p.map((q, n) => ({ x: q.x + (b.p[n].x - q.x) * u, y: q.y + (b.p[n].y - q.y) * u, v: Math.min(q.v, b.p[n].v) }));
          fr[k].filled = true;
        }
      }
      i = j;
    }
    return fr;
  }

  // In side view the detector often swaps left/right legs between frames.
  // Re-label each frame so each leg stays continuous with the previous frame.
  function fixLegSwaps(fr) {
    let prev = null, swaps = 0;
    for (const f of fr) {
      if (!f.p) { prev = null; continue; }
      if (prev) {
        let keep = 0, swap = 0;
        for (let k = 0; k < 4; k++) {
          keep += dist(f.p[LEFT_LEG[k]], prev[LEFT_LEG[k]]) + dist(f.p[RIGHT_LEG[k]], prev[RIGHT_LEG[k]]);
          swap += dist(f.p[RIGHT_LEG[k]], prev[LEFT_LEG[k]]) + dist(f.p[LEFT_LEG[k]], prev[RIGHT_LEG[k]]);
        }
        if (swap < keep * 0.6) {
          for (let k = 0; k < 4; k++) { const t = f.p[LEFT_LEG[k]]; f.p[LEFT_LEG[k]] = f.p[RIGHT_LEG[k]]; f.p[RIGHT_LEG[k]] = t; }
          swaps++;
        }
      }
      prev = f.p;
    }
    return swaps;
  }

  function smooth(fr, win) {
    const half = win >> 1;
    return fr.map((f, i) => {
      if (!f.p) return f;
      const p = f.p.map((q, n) => {
        let sx = 0, sy = 0, c = 0;
        for (let k = i - half; k <= i + half; k++) {
          const g = fr[k];
          if (g && g.p) { sx += g.p[n].x; sy += g.p[n].y; c++; }
        }
        return { x: sx / c, y: sy / c, v: q.v };
      });
      return { ...f, p };
    });
  }

  // ---- 2. Signal helpers ---------------------------------------------------
  function detrend(series, dt, windowSec) {
    const half = Math.max(1, Math.round(windowSec / dt / 2));
    return series.map((v, i) => {
      let s = 0, c = 0;
      for (let k = i - half; k <= i + half; k++) if (Number.isFinite(series[k])) { s += series[k]; c++; }
      return Number.isFinite(v) ? v - s / c : NaN;
    });
  }

  // Step period from the autocorrelation of the hip's vertical bounce
  // (the pelvis rises and falls once per step).
  function stepPeriod(sig, dt) {
    const minLag = Math.round(60 / 230 / dt), maxLag = Math.round(60 / 120 / dt);
    const mean = median(sig);
    const x = sig.map((v) => (Number.isFinite(v) ? v - mean : 0));
    const ac = (lag) => { let s = 0, n = 0; for (let i = 0; i + lag < x.length; i++) { s += x[i] * x[i + lag]; n++; } return n ? s / n : 0; };
    const r0 = ac(0) || 1;
    let best = -Infinity, bestLag = NaN;
    const vals = [];
    for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) vals[lag] = ac(lag) / r0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = vals[lag];
      if (v > vals[lag - 1] && v >= vals[lag + 1] && v > best) { best = v; bestLag = lag; }
    }
    if (!Number.isFinite(bestLag)) return { period: NaN, confidence: 0 };
    // Parabolic interpolation for sub-frame precision.
    const a = vals[bestLag - 1], b = vals[bestLag], c = vals[bestLag + 1];
    const off = (a - c) / (2 * (a - 2 * b + c) || 1);
    return { period: (bestLag + (Number.isFinite(off) ? Math.max(-0.5, Math.min(0.5, off)) : 0)) * dt, confidence: best };
  }

  // Live streams deliver frames at uneven times and drop some. Resample to an
  // even grid so the analysis can assume a constant frame interval.
  function resample(samples, fps) {
    const out = [];
    if (samples.length < 2) return out;
    const dt = 1 / fps, t0 = samples[0].t, t1 = samples[samples.length - 1].t;
    let k = 0;
    for (let t = t0; t <= t1 + 1e-9; t += dt) {
      while (k < samples.length - 2 && samples[k + 1].t < t) k++;
      const a = samples[k], b = samples[k + 1];
      if (!a.lm || !b.lm || b.t - a.t > 4 * dt) { out.push({ t: t - t0, lm: Math.abs(a.t - t) < dt / 2 ? a.lm : Math.abs(b.t - t) < dt / 2 ? b.lm : null }); continue; }
      const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
      out.push({ t: t - t0, lm: a.lm.map((q, n) => ({ x: q.x + (b.lm[n].x - q.x) * u, y: q.y + (b.lm[n].y - q.y) * u, z: 0, visibility: Math.min(q.visibility ?? 1, b.lm[n].visibility ?? 1) })) });
    }
    return out;
  }

  // ---- 3. Main analysis ------------------------------------------------------
  function analyze(rawFrames, opts) {
    const { width, height, heightCm = 175 } = opts;
    if (!rawFrames || rawFrames.length < 20) throw new Error('Not enough frames. Use a clip of at least 3 seconds.');
    const dt = median(rawFrames.slice(1).map((f, i) => f.t - rawFrames[i].t));
    let fr = fillGaps(toPixels(rawFrames, width, height), 4);
    const detected = fr.filter((f) => f.p).length / fr.length;
    if (detected < 0.6) throw new Error('A runner was found in only ' + Math.round(detected * 100) + '% of frames. Film side-on with your whole body in view.');
    const swaps = fixLegSwaps(fr);
    fr = smooth(fr, dt <= 0.021 ? 3 : 1); // smooth only at 50+ fps; at lower rates it smears landings. Medians over many steps handle noise instead.
    const ok = fr.filter((f) => f.p);

    // Running direction: nose ahead of ears, cross-checked with toes ahead of heels.
    const dirVotes = ok.map((f) => {
      const ear = mid(f.p[L.lEar], f.p[L.rEar]);
      const toe = mid(f.p[L.lToe], f.p[L.rToe]), heel = mid(f.p[L.lHeel], f.p[L.rHeel]);
      return Math.sign(f.p[L.nose].x - ear.x) * 2 + Math.sign(toe.x - heel.x);
    });
    const dir = median(dirVotes) >= 0 ? 1 : -1;

    // Scale: thigh + shank is about 49% of standing height.
    const legPx = median(ok.flatMap((f) => [
      dist(f.p[L.lHip], f.p[L.lKnee]) + dist(f.p[L.lKnee], f.p[L.lAnk]),
      dist(f.p[L.rHip], f.p[L.rKnee]) + dist(f.p[L.rKnee], f.p[L.rAnk])]));
    const cmPerPx = (0.49 * heightCm) / legPx;

    const hipMid = fr.map((f) => (f.p ? mid(f.p[L.lHip], f.p[L.rHip]) : null));
    const hipY = hipMid.map((h) => (h ? h.y : NaN));
    const hipYd = detrend(hipY, dt, 1.0);
    const sp = stepPeriod(hipYd, dt);
    const cadence = 60 / sp.period;

    // Vertical oscillation: median peak-to-trough of the pelvis within each step window.
    const win = Math.max(3, Math.round(sp.period / dt));
    const osc = [];
    for (let i = 0; i + win <= hipYd.length; i += Math.max(1, Math.round(win / 2))) {
      const seg = hipYd.slice(i, i + win).filter(Number.isFinite);
      if (seg.length > win * 0.7) osc.push(Math.max(...seg) - Math.min(...seg));
    }
    const vertOscCm = median(osc) * cmPerPx;

    // Foot contacts. Lowest foot point per leg; image y grows downward.
    const legs = [
      { name: 'Left', hip: L.lHip, knee: L.lKnee, ank: L.lAnk, heel: L.lHeel, toe: L.lToe },
      { name: 'Right', hip: L.rHip, knee: L.rKnee, ank: L.rAnk, heel: L.rHeel, toe: L.rToe }];
    const footLow = (f, g) => Math.max(f.p[g.heel].y, f.p[g.toe].y, f.p[g.ank].y);
    const ground = pct(ok.map((f) => Math.max(footLow(f, legs[0]), footLow(f, legs[1]))), 92);
    const th = 0.045 * legPx;
    const minSep = Math.round((sp.period * 1.4) / dt);
    const contacts = [];
    const onSeries = legs.map((g) => fr.map((f) => (f.p ? footLow(f, g) > ground - th : false)));

    // Landing and toe-off times are interpolated between frames where the foot
    // crosses the ground band, so low-frame-rate cameras (15-20 fps) still give
    // sub-frame timing and joint angles at the moment of landing.
    const level = ground - th;
    const lerpP = (a, b, u) => a.map((q, n) => ({ x: q.x + (b[n].x - q.x) * u, y: q.y + (b[n].y - q.y) * u, v: q.v }));
    const cross = (k, g, lv) => { // fraction between frame k-1 and k where footLow crosses lv
      const a = footLow(fr[k - 1], g), b = footLow(fr[k], g);
      return b === a ? 0.5 : Math.max(0, Math.min(1, (lv - a) / (b - a)));
    };
    legs.forEach((g, li) => {
      const on = onSeries[li];
      let last = -Infinity;
      for (let i = 1; i < fr.length; i++) {
        if (!on[i] || on[i - 1] || !fr[i].p || !fr[i - 1].p) continue;
        { let ok2 = true; for (let k = i - 1; k <= Math.min(fr.length - 1, i + 8); k++) if (!fr[k].p) ok2 = false; if (!ok2) continue; }
        if (i - last < minSep) continue;
        let j = i; while (j < fr.length && on[j]) j++;
        if (j >= fr.length || !fr[j].p || !fr[j - 1].p) break; // contact runs past the clip end: duration unknown
        // The detection band is wide to survive noise; time the landing at a tighter
        // level near this stance's lowest foot position.
        let low = -Infinity; for (let k = i; k < j; k++) if (fr[k].p) low = Math.max(low, footLow(fr[k], g));
        const tight = low - 0.3 * th;
        let k0 = i; while (k0 < j && footLow(fr[k0], g) < tight) k0++;
        const u0 = cross(k0, g, tight), u1 = cross(j, g, level);
        const tOn = fr[k0 - 1].t + u0 * (fr[k0].t - fr[k0 - 1].t), tOff = fr[j - 1].t + u1 * (fr[j].t - fr[j - 1].t); // real timestamps: live frames are unevenly spaced
        if (tOff - tOn < 0.08) continue;
        last = i;
        const p = lerpP(fr[k0 - 1].p, fr[k0].p, u0);
        const hip = mid(p[L.lHip], p[L.rHip]);
        const knee = p[g.knee], ank = p[g.ank], heel = p[g.heel], toe = p[g.toe];
        let maxFlex = 0;
        for (let k = i; k < j; k++) if (fr[k].p) maxFlex = Math.max(maxFlex, 180 - angle3(fr[k].p[g.hip], fr[k].p[g.knee], fr[k].p[g.ank]));
        contacts.push({
          leg: g.name, frame: u0 < 0.5 ? k0 - 1 : k0, t: tOn, p,
          gctMs: (tOff - tOn) * 1000,
          overstrideCm: dir * (ank.x - hip.x) * cmPerPx,
          shinDeg: Math.atan2(dir * (ank.x - knee.x), ank.y - knee.y) * DEG,
          kneeFlexContact: 180 - angle3(p[g.hip], knee, ank),
          kneeFlexMax: Math.max(maxFlex, 180 - angle3(p[g.hip], knee, ank)),
          footDeg: Math.atan2(heel.y - toe.y, dir * (toe.x - heel.x)) * DEG,
        });
      }
    });
    contacts.sort((a, b) => a.frame - b.frame);

    // Posture across the whole clip.
    const trunk = ok.map((f) => {
      const sh = mid(f.p[L.lSh], f.p[L.rSh]), hp = mid(f.p[L.lHip], f.p[L.rHip]);
      return Math.atan2(dir * (sh.x - hp.x), hp.y - sh.y) * DEG;
    });
    const elbow = ok.flatMap((f) => [angle3(f.p[L.lSh], f.p[L.lEl], f.p[L.lWr]), angle3(f.p[L.rSh], f.p[L.rEl], f.p[L.rWr])]);
    const kneeSeries = fr.map((f) => (f.p ? [180 - angle3(f.p[L.lHip], f.p[L.lKnee], f.p[L.lAnk]), 180 - angle3(f.p[L.rHip], f.p[L.rKnee], f.p[L.rAnk])] : [NaN, NaN]));

    // Refine cadence from interpolated landing times when enough steps alternate cleanly.
    let cadenceFinal = cadence;
    if (contacts.length >= 5) {
      const gaps = contacts.slice(1).map((c, i) => c.t - contacts[i].t);
      const good = gaps.filter((g) => Math.abs(g - sp.period) < 0.25 * sp.period);
      if (good.length >= gaps.length * 0.8) cadenceFinal = 60 / (good.reduce((a, b) => a + b, 0) / good.length);
    }
    const m = (k) => median(contacts.map((c) => c[k]));
    const footDeg = m('footDeg');
    const strike = !Number.isFinite(footDeg) ? '—' : footDeg > 8 ? 'Heel' : footDeg < -3 ? 'Forefoot' : 'Midfoot';
    const byLeg = (k) => legs.map((g) => median(contacts.filter((c) => c.leg === g.name).map((c) => c[k])));

    const metrics = {
      cadence: cadenceFinal, vertOscCm, gctMs: m('gctMs'), overstrideCm: m('overstrideCm'), shinDeg: m('shinDeg'),
      kneeFlexContact: m('kneeFlexContact'), kneeFlexMax: m('kneeFlexMax'), footDeg, strike,
      trunkDeg: median(trunk), elbowDeg: median(elbow),
      gctBalance: (() => { const [a, b] = byLeg('gctMs'); return Number.isFinite(a) && Number.isFinite(b) ? (a / (a + b)) * 100 : NaN; })(),
    };

    return {
      metrics, contacts, dir, dt, cmPerPx, legPx, ground,
      quality: { detected, swaps, frames: fr.length, steps: contacts.length, cadenceConfidence: sp.confidence },
      series: { t: fr.map((f) => f.t), hipY: hipYd.map((v) => v * cmPerPx), knee: kneeSeries, on: onSeries },
      frames: fr,
    };
  }

  // ---- 4. Scoring + coaching -------------------------------------------------
  // Ranges are general guidance for distance running at easy-to-steady pace.
  const RULES = [
    { key: 'cadence', label: 'Cadence', unit: 'spm', dp: 0, good: [165, 190], watch: [158, 198],
      what: 'Steps per minute, from the rhythm of your pelvis rising and falling.',
      low: 'Your step rate is low, which usually means longer strides that land ahead of your body.',
      high: 'Your step rate is very high. Fine for fast running; at easy pace it can mean short, choppy steps.',
      fix: ['Run 3 × 3 min at your current pace with a metronome set 5% faster.', 'Quick-feet drill: 4 × 15 s of fast, light steps on the spot.'] },
    { key: 'vertOscCm', label: 'Vertical oscillation', unit: 'cm', dp: 1, good: [5, 10], watch: [4, 12],
      what: 'How far your hips move up and down each step.',
      low: 'Very little bounce. Check you are not shuffling.', high: 'A lot of energy goes into moving up rather than forward.',
      fix: ['Think “run tall, push the ground back”, not up.', 'Pogo hops: 3 × 20 quick, low, stiff-ankle hops.', 'A-skips: 3 × 20 m.'] },
    { key: 'gctMs', label: 'Ground contact time', unit: 'ms', dp: 0, good: [0, 270], watch: [0, 310],
      what: 'How long each foot stays on the ground. Measured to the nearest frame, so treat it as approximate.',
      high: 'Long ground contact. Usually goes with overstriding or weak calf and foot stiffness.',
      fix: ['Pogo hops: 3 × 20.', 'Single-leg calf raises: 3 × 15 each side, slow lowering.', 'Skipping rope: 3 × 60 s.'] },
    { key: 'shinDeg', label: 'Shin angle at landing', unit: '°', dp: 0, good: [-6, 7], watch: [-10, 11],
      what: 'Angle of your lower leg when the foot first touches down. Positive means the foot lands in front of the knee.',
      high: 'Your foot lands well in front of your knee. That is the clearest sign of overstriding and it brakes every step.',
      low: 'Your foot lands behind your knee, which is unusual. Check the clip is truly side-on.',
      fix: ['Raise cadence 5% (see cadence).', 'Wall drill: lean on a wall and practise placing the foot under the hip, 3 × 10 each leg.', 'Strides with a “land under you” cue, 6 × 80 m.'] },
    { key: 'overstrideCm', label: 'Foot ahead of hips', unit: 'cm', dp: 0, good: [-5, 22], watch: [-10, 30],
      what: 'Horizontal distance from your hips to your ankle at landing.',
      high: 'Your foot lands far ahead of your centre of mass.', low: 'Foot lands behind the hips. Check the camera angle.',
      fix: ['Same fixes as shin angle: higher cadence, land under the hip.'] },
    { key: 'kneeFlexContact', label: 'Knee bend at landing', unit: '°', dp: 0, good: [12, 28], watch: [8, 34],
      what: 'How bent your knee is as the foot touches down.',
      low: 'You land on a nearly straight leg, which sends more impact up the leg.', high: 'Very bent at landing. You may be sitting low.',
      fix: ['Soft-landing cue: land quietly.', 'Forward lunges: 3 × 10 each leg.', 'Drop squats: 3 × 8, stick the landing.'] },
    { key: 'kneeFlexMax', label: 'Knee bend in stance', unit: '°', dp: 0, good: [32, 50], watch: [27, 56],
      what: 'Deepest knee bend while the foot is on the ground. This is your shock absorption.',
      low: 'Stiff leg through stance.', high: 'Deep knee collapse in stance. Often a sign of quad or glute fatigue.',
      fix: ['Split squats: 3 × 10 each leg.', 'Step-downs off a box: 3 × 10 each leg, slow.'] },
    { key: 'trunkDeg', label: 'Trunk lean', unit: '°', dp: 0, good: [3, 11], watch: [0, 15],
      what: 'Forward lean of your torso from vertical (shoulders over hips).',
      low: 'Upright or leaning back. Often comes with overstriding.', high: 'Bent forward a lot, often from the waist rather than the ankles.',
      fix: ['Lean from the ankles, not the waist.', 'Dead bugs: 3 × 10.', 'Hip-flexor stretch: 2 × 45 s each side.'] },
    { key: 'elbowDeg', label: 'Elbow angle', unit: '°', dp: 0, good: [65, 110], watch: [50, 130],
      what: 'Median bend at the elbow during arm swing.',
      low: 'Arms held very tight.', high: 'Arms quite straight, which slows your arm swing and your rhythm.',
      fix: ['Hold the elbow near 90° and drive it back.', 'Seated arm-swing drill: 3 × 30 s.'] },
  ];

  function status(rule, v) {
    if (!Number.isFinite(v)) return 'na';
    if (v >= rule.good[0] && v <= rule.good[1]) return 'good';
    if (v >= rule.watch[0] && v <= rule.watch[1]) return 'watch';
    return 'fix';
  }

  function score(result) {
    const items = RULES.map((r) => {
      const v = result.metrics[r.key];
      const s = status(r, v);
      const dirn = !Number.isFinite(v) ? null : v < r.good[0] ? 'low' : v > r.good[1] ? 'high' : null;
      return { ...r, value: v, status: s, note: dirn ? r[dirn] || '' : '' };
    });
    const pts = { good: 100, watch: 62, fix: 25 };
    const scored = items.filter((i) => i.status !== 'na');
    const overall = scored.length ? Math.round(scored.reduce((a, i) => a + pts[i.status], 0) / scored.length) : NaN;
    return { items, overall };
  }

  // ---- 5. Synthetic runner (for the example report and tests) ---------------
  // Piecewise-smooth joint angles over one gait cycle (p in [0,1), contact at p=0).
  function interp(keys, p) {
    for (let i = 0; i < keys.length - 1; i++) {
      const [p0, v0] = keys[i], [p1, v1] = keys[i + 1];
      if (p >= p0 && p <= p1) { const u = (p - p0) / (p1 - p0); const s = (1 - Math.cos(u * Math.PI)) / 2; return v0 + (v1 - v0) * s; }
    }
    return keys[keys.length - 1][1];
  }
  function synthRunner(o = {}) {
    const cad = o.cadence ?? 164, dur = o.duration ?? 8, fps = o.fps ?? 30, W = 1280, H = 720, dir = o.dir ?? 1;
    const heightPx = 560, seg = { thigh: 0.245 * heightPx, shank: 0.246 * heightPx, foot: 0.11 * heightPx, trunk: 0.3 * heightPx, upper: 0.17 * heightPx, fore: 0.15 * heightPx };
    const stride = 120 / cad; // seconds per stride (two steps)
    const reach = o.reach ?? 8; // extra forward thigh angle at landing (overstride)
    const thighK = [[0, 22 + reach], [0.15, 3], [0.34, -20], [0.62, 16], [0.86, 30 + reach], [1, 22 + reach]];
    const kneeK = [[0, 14], [0.14, 40], [0.34, 24], [0.6, 115], [0.84, 62], [0.95, 18], [1, 14]];
    const footK = [[0, 14], [0.08, 0], [0.18, 0], [0.34, -42], [0.5, -30], [0.75, -5], [0.92, 16], [1, 14]];
    const trunkDeg = o.trunk ?? 5;
    const ground = 660;
    const frames = [];
    const rad = Math.PI / 180;
    const legPts = (hip, p) => {
      const th = interp(thighK, p) * rad, kf = interp(kneeK, p) * rad, fa = interp(footK, p) * rad;
      const knee = { x: hip.x + dir * Math.sin(th) * seg.thigh, y: hip.y + Math.cos(th) * seg.thigh };
      const sh = th - kf;
      const ank = { x: knee.x + dir * Math.sin(sh) * seg.shank, y: knee.y + Math.cos(sh) * seg.shank };
      const heel = { x: ank.x - dir * 0.25 * seg.foot * Math.cos(fa), y: ank.y + 0.25 * seg.foot * Math.sin(fa) + 12 };
      const toe = { x: heel.x + dir * Math.cos(fa) * seg.foot, y: heel.y - Math.sin(fa) * seg.foot };
      return { knee, ank, heel, toe };
    };
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    for (let i = 0; i < dur * fps; i++) {
      const t = i / fps + (o.t0 ?? 0);
      const pL = (t / stride) % 1, pR = (pL + 0.5) % 1;
      const hip0 = { x: W / 2 - dir * 40, y: 0 };
      const a = legPts(hip0, pL), b = legPts(hip0, pR);
      // Hip height is set by the stance leg; in flight, blend between toe-off and landing.
      const lowOf = (q) => Math.max(q.heel.y, q.toe.y);
      const ST = 0.34;
      let dy;
      if (pL < ST) dy = ground - lowOf(a);
      else if (pR < ST) dy = ground - lowOf(b);
      else {
        const pa = pL >= ST && pR >= ST ? (pL > pR ? pL : pR) : pL; // leg about to land
        const u = (pa - (1 - (0.5 - ST))) / (0.5 - ST); // 0 at toe-off of other leg, 1 at landing
        const land = legPts(hip0, 0), off = legPts(hip0, ST);
        const d0 = ground - lowOf(off), d1 = ground - lowOf(land);
        dy = d0 + (d1 - d0) * Math.min(1, Math.max(0, u)) - Math.sin(Math.min(1, Math.max(0, u)) * Math.PI) * 10;
      }
      const shift = (q) => ({ x: q.x, y: q.y + dy });
      const hip = shift(hip0); const A = { knee: shift(a.knee), ank: shift(a.ank), heel: shift(a.heel), toe: shift(a.toe) }; const B = { knee: shift(b.knee), ank: shift(b.ank), heel: shift(b.heel), toe: shift(b.toe) };
      const tr = trunkDeg * rad;
      const sh = { x: hip.x + dir * Math.sin(tr) * seg.trunk, y: hip.y - Math.cos(tr) * seg.trunk };
      const head = { x: sh.x + dir * 22, y: sh.y - 70 };
      const arm = (p) => { const s = Math.sin(p * 2 * Math.PI) * 38 * rad; const el = { x: sh.x - dir * Math.sin(s) * seg.upper, y: sh.y + Math.cos(s) * seg.upper }; const fa = s - 85 * rad; return { el, wr: { x: el.x - dir * Math.sin(fa) * seg.fore, y: el.y + Math.cos(fa) * seg.fore } }; };
      const armL = arm(pR), armR = arm(pL);
      const lm = new Array(33).fill(null).map(() => ({ ...head }));
      const set = (k, q, vis = 0.95) => { lm[k] = { x: (q.x + rnd() * 2.4) / W, y: (q.y + rnd() * 2.4) / H, z: 0, visibility: vis }; };
      set(L.nose, { x: head.x + dir * 18, y: head.y + 4 });
      set(L.lEar, { x: head.x - dir * 6, y: head.y }); set(L.rEar, { x: head.x - dir * 4, y: head.y });
      for (let k = 1; k <= 10; k++) if (k !== 7 && k !== 8) set(k, { x: head.x + dir * 8, y: head.y - 4 });
      set(L.lSh, sh); set(L.rSh, { x: sh.x + 2, y: sh.y });
      set(L.lEl, armL.el); set(L.rEl, armR.el); set(L.lWr, armL.wr); set(L.rWr, armR.wr);
      for (const k of [17, 19, 21]) set(k, armL.wr); for (const k of [18, 20, 22]) set(k, armR.wr);
      set(L.lHip, hip); set(L.rHip, { x: hip.x + 2, y: hip.y });
      set(L.lKnee, A.knee); set(L.lAnk, A.ank); set(L.lHeel, A.heel); set(L.lToe, A.toe);
      set(L.rKnee, B.knee); set(L.rAnk, B.ank); set(L.rHeel, B.heel); set(L.rToe, B.toe);
      frames.push({ t: i / fps, lm });
    }
    return { frames, width: W, height: H, heightCm: 178 };
  }

  const api = { analyze, resample, score, status, RULES, synthRunner, L };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Gait = api;
})(typeof window !== 'undefined' ? window : globalThis);
