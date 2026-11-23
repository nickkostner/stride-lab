// Run with: node --test 'form-lab/test/*.test.cjs'   (Node 22+). Kept outside web/ so it isn't deployed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../web/aero.js');

// Seeded random so tests don't flake.
function rng(seed = 1) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

function calibrated(jitter = 4) {
  const rand = rng(7);
  const samples = {};
  for (const p of A.CALIBRATED) samples[p] = Array.from({ length: 60 }, () => A.features(A.synthFrame(p, { jitter, rand })));
  return A.calibrate(samples);
}

test('features: aero has a flatter torso and more level forearm than sitting up', () => {
  const aero = A.features(A.synthFrame('aero')), up = A.features(A.synthFrame('up'));
  assert.ok(Math.abs(aero.torso - 10) < 1, `aero torso ${aero.torso}`);
  assert.ok(Math.abs(aero.forearm - 2) < 1, `aero forearm ${aero.forearm}`);
  assert.ok(up.torso > 50 && up.forearm < -40);
  assert.equal(aero.side, 'l'); // the brighter (visible) side wins
});

test('features: rider facing left gives the same angles', () => {
  const lm = A.synthFrame('base').map((q) => ({ ...q, x: 1 - q.x }));
  const f = A.features(lm), g = A.features(A.synthFrame('base'));
  assert.ok(Math.abs(f.torso - g.torso) < 0.01 && Math.abs(f.forearm - g.forearm) < 0.01);
});

test('features: low visibility returns null', () => {
  const lm = A.synthFrame('aero').map((q) => ({ ...q, visibility: 0.2 }));
  assert.equal(A.features(lm), null);
  assert.equal(A.classify(null), 'none');
});

test('classify: calibrated positions are recognised with noisy landmarks', () => {
  const cal = calibrated();
  const rand = rng(99);
  for (const p of A.POSITIONS) {
    let right = 0;
    for (let i = 0; i < 100; i++) right += A.classify(A.features(A.synthFrame(p, { jitter: 6, rand })), cal) === p;
    assert.ok(right >= 90, `${p}: ${right}/100`);
  }
});

test('classify: uncalibrated defaults still separate aero from sitting up', () => {
  assert.equal(A.classify(A.features(A.synthFrame('aero'))), 'aero');
  assert.equal(A.classify(A.features(A.synthFrame('up'))), 'up');
});

test('calibrate: refuses too few frames', () => {
  assert.throws(() => A.calibrate({ aero: [], base: [], up: [] }), /Not enough frames/);
});

test('tracker: a blip shorter than the hold time does not break the streak', () => {
  const tr = A.Tracker(1.5);
  for (let t = 0; t <= 60; t += 0.2) tr.push(t, t > 30 && t < 31 ? 'up' : 'aero');
  const segs = tr.segments();
  assert.equal(segs.length, 1);
  assert.equal(segs[0].pos, 'aero');
});

test('tracker: a real change is back-dated to when it started', () => {
  const tr = A.Tracker(1.5);
  for (let t = 0; t <= 60; t = +(t + 0.2).toFixed(1)) tr.push(t, t < 40 ? 'aero' : 'up');
  const segs = tr.segments();
  assert.deepEqual(segs.map((s) => s.pos), ['aero', 'up']);
  assert.equal(segs[1].s, 40);
  assert.equal(segs[0].e, 40);
});

test('tracker: a long gap without frames is recorded as no rider', () => {
  const tr = A.Tracker(1.5);
  for (let t = 0; t <= 10; t += 0.5) tr.push(t, 'aero');
  for (let t = 40; t <= 50; t += 0.5) tr.push(t, 'aero');
  const segs = tr.segments();
  assert.deepEqual(segs.map((s) => [s.pos, s.s, s.e]), [['aero', 0, 10], ['none', 10, 40], ['aero', 40, 50]]);
});

test('summarize: aero %, longest stretch and breaks', () => {
  const segs = [
    { pos: 'aero', s: 0, e: 600 }, { pos: 'up', s: 600, e: 660 }, { pos: 'none', s: 660, e: 700 },
    { pos: 'aero', s: 700, e: 1000 }, { pos: 'stand', s: 1000, e: 1040 },
  ];
  const s = A.summarize(segs);
  assert.equal(s.totalS, 1040);
  assert.equal(s.seenS, 1000);           // "no rider" left out
  assert.equal(s.aeroPct, 90);
  assert.equal(s.longestAeroS, 600);
  assert.equal(s.breaks, 2);             // aero->up, aero->stand
});

test('end to end: 10 min ride with sit-ups is tracked within a few seconds', () => {
  const cal = calibrated();
  const rand = rng(3);
  const tr = A.Tracker();
  const script = (t) => (t < 240 ? 'aero' : t < 270 ? 'up' : t < 330 ? 'base' : t < 335 ? 'stand' : 'aero');
  for (let t = 0; t < 600; t += 0.2) {
    // 5 fps; every 25th frame lost, every 13th frame a misclassification-prone big jitter.
    const k = Math.round(t * 5);
    const lm = k % 25 === 0 ? null : A.synthFrame(script(t), { jitter: k % 13 === 0 ? 40 : 5, rand });
    tr.push(t, A.classify(lm && A.features(lm), cal));
  }
  const s = A.summarize(tr.segments());
  // Truth: aero 240 + 265 = 505 of 600 s.
  assert.ok(Math.abs(s.secs.aero - 505) < 6, `aero s ${s.secs.aero}`);
  assert.ok(Math.abs(s.secs.stand - 5) < 3, `stand s ${s.secs.stand}`);
  assert.equal(s.breaks, 1);
});
