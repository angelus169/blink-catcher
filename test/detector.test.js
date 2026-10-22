// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Detector, W, H } = require('../detector.js');

// Deterministic noise, so compression-like jitter is the same on every run.
function rng(seed) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function frame(paint, noise = rng(1)) {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const [r, g, b] = paint(x, y);
            const i = (y * W + x) * 4;
            const j = (noise() - 0.5) * 8;
            px[i] = r + j; px[i + 1] = g + j; px[i + 2] = b + j; px[i + 3] = 255;
        }
    }
    return px;
}

// Scene A: warm gradient with a box that moves 1 px per frame.
const sceneA = t => frame((x, y) => {
    const box = Math.abs(x - (8 + (t % 20))) < 4 && Math.abs(y - 30) < 6;
    return box ? [30, 30, 220] : [120 + y, 80 + x, 60];
});
// Scene B: a different shot (cool tones, box moves vertically).
const sceneB = t => frame((x, y) => {
    const box = Math.abs(x - 18) < 5 && Math.abs(y - (10 + (t % 40))) < 5;
    return box ? [240, 240, 40] : [40, 90 + y, 150 + x];
});
const solid = (r, g, b) => frame(() => [r, g, b]);
const withPatch = (px, x0, y0, w, h) => {
    const out = px.slice();
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
        const i = (y * W + x) * 4;
        out[i] = out[i + 1] = out[i + 2] = 255;
    }
    return out;
};

function run(frames, sensitivity = 'normal') {
    const det = new Detector(() => sensitivity);
    const hits = [];
    frames.forEach((pixels, i) => {
        const hit = det.push({ pixels, i });
        if (hit) hits.push({ at: hit.run[0].i, len: hit.run.length, reason: hit.reason });
    });
    return hits;
}

const seq = (n, f, from = 0) => Array.from({ length: n }, (_, t) => f(from + t));

test('steady video: no hits', () => {
    assert.deepEqual(run(seq(150, sceneA)), []);
});

test('normal scene cut: no hit', () => {
    assert.deepEqual(run([...seq(60, sceneA), ...seq(60, sceneB, 60)]), []);
});

test('one full-frame insert is caught', () => {
    const f = seq(90, sceneA);
    f[45] = solid(230, 20, 20);
    assert.deepEqual(run(f), [{ at: 45, len: 1, reason: 'flash' }]);
});

test('one partial insert (small white box) is caught', () => {
    const f = seq(90, sceneA);
    f[45] = withPatch(f[45], 22, 2, 12, 14);    // ~7% of the frame, top right
    assert.deepEqual(run(f), [{ at: 45, len: 1, reason: 'flash' }]);
});

test('a two-frame insert is caught as one hit', () => {
    const f = seq(90, sceneA);
    f[45] = f[46] = solid(20, 20, 230);
    assert.deepEqual(run(f), [{ at: 45, len: 2, reason: 'flash' }]);
});

test('an insert exactly at a scene cut is caught', () => {
    const f = [...seq(45, sceneA), solid(20, 230, 20), ...seq(44, sceneB, 46)];
    assert.deepEqual(run(f), [{ at: 45, len: 1, reason: 'cut' }]);
});

test('two different inserts back to back are both caught', () => {
    const f = seq(90, sceneA);
    f[45] = solid(230, 20, 20);
    f[46] = solid(20, 20, 230);
    assert.deepEqual(run(f).map(h => h.at), [45, 46]);
});

test('strobe footage: the motion guard stops a flood of hits (≈30 without it)', () => {
    const f = [...seq(30, sceneA), ...seq(60, t => (t % 2 ? solid(250, 250, 250) : sceneA(t)), 30)];
    assert.ok(run(f).length <= 5, `got ${run(f).length} hits`);
});

test('sensitivity: a faint insert needs "high"', () => {
    const f = seq(90, sceneA);
    f[45] = f[45].map((v, i) => (i % 4 === 3 ? v : v + 18));   // slightly brighter frame
    assert.deepEqual(run(f, 'normal'), []);
    assert.equal(run(f, 'high').length, 1);
});

test('reset forgets history (loop or seek)', () => {
    const det = new Detector();
    seq(30, sceneA).forEach(pixels => det.push({ pixels }));
    det.reset();
    assert.equal(det.push({ pixels: solid(230, 20, 20) }), null);
    assert.equal(det.push({ pixels: sceneA(0) }), null);
});
