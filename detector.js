// Finds short inserts (1–3 frames) that do not belong to the surrounding video.
// Works on small RGBA thumbnails; content.js feeds it one thumbnail per frame.
(function (root) {
    'use strict';

    const W = 36, H = 64;            // thumbnail size (9:16, like a Reel)
    const GX = 4, GY = 8;            // grid: 32 cells of 9×8 px
    const MAX_RUN = 3;               // longest insert to look for, in frames
    const HISTORY = MAX_RUN + 2;     // frame before + run + frame after
    const TOP_CELLS = 3;             // a local flash must cover ~10% of the frame

    // Thresholds at "normal" sensitivity. Differences are 0..1 (mean |ΔRGB| / 255).
    const T_FLASH = 0.08;            // part of the picture changes, then comes back
    const T_CUT = 0.12;              // two hard cuts within MAX_RUN frames
    const SENSITIVITY = { low: 1.6, normal: 1, high: 0.6 };

    // Motion guard: in strobe-like or very fast footage every frame looks like a
    // hit, so a hit must also stand out from the recent frame-to-frame motion.
    const MOTION_LEN = 15;
    const MOTION_MIN = 6;
    const MOTION_PCT = 0.7;
    const MOTION_FACTOR = 3;

    const CW = W / GX, CH = H / GY;
    const NORM = 1 / (CW * CH * 3 * 255);

    function cellDiff(a, b) {
        const out = new Float64Array(GX * GY);
        for (let y = 0; y < H; y++) {
            const row = Math.floor(y / CH) * GX;
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                out[row + Math.floor(x / CW)] +=
                    Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            }
        }
        for (let c = 0; c < out.length; c++) out[c] *= NORM;
        return out;
    }

    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const percentile = (a, p) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
    const topMean = (a, n) => mean([...a].sort((x, y) => y - x).slice(0, n));

    class Detector {
        constructor(getSensitivity = () => 'normal') {
            this.getSensitivity = getSensitivity;
            this.reset();
        }

        reset() {
            this.frames = [];
            this.motion = [];
            this.seq = 0;
            this.lastHitSeq = -1;
        }

        // frame: { pixels: W×H RGBA, ...anything the caller wants back in a hit }.
        // Returns a hit for a run that ends one frame before this frame, or null.
        push(frame) {
            const f = { ...frame, seq: this.seq++ };
            const last = this.frames[this.frames.length - 1];
            if (last) {
                this.motion.push(mean(cellDiff(last.pixels, f.pixels)));
                if (this.motion.length > MOTION_LEN) this.motion.shift();
            }
            this.frames.push(f);
            if (this.frames.length > HISTORY) this.frames.shift();
            return this.check();
        }

        check() {
            const sens = SENSITIVITY[this.getSensitivity()] ?? 1;
            const guard = this.motion.length >= MOTION_MIN
                ? percentile(this.motion, MOTION_PCT) * MOTION_FACTOR * sens : 0;
            const tFlash = Math.max(T_FLASH * sens, guard);
            const tCut = Math.max(T_CUT * sens, guard);

            const n = this.frames.length;
            let best = null;
            for (let k = 1; k <= MAX_RUN && k + 2 <= n; k++) {
                const prev = this.frames[n - k - 2];
                const run = this.frames.slice(n - k - 1, n - 1);
                const next = this.frames[n - 1];
                if (run[0].seq <= this.lastHitSeq) continue;   // already reported

                const din = cellDiff(prev.pixels, run[0].pixels);
                const dout = cellDiff(run[k - 1].pixels, next.pixels);
                const dret = cellDiff(prev.pixels, next.pixels);

                // flash: cells jump away and come back (prev ≈ next).
                // cut:   the whole run is its own tiny shot (prev → run → next all differ).
                const flash = topMean(din.map((v, c) => Math.min(v, dout[c]) - dret[c]), TOP_CELLS);
                const cut = Math.min(mean(din), mean(dout));
                const score = Math.max(flash / tFlash, cut / tCut);
                if (score >= 1 && (!best || score > best.score)) {
                    best = { prev, run, next, score, flash, cut, reason: flash / tFlash >= cut / tCut ? 'flash' : 'cut' };
                }
            }
            if (best) this.lastHitSeq = best.run[best.run.length - 1].seq;
            return best;
        }
    }

    const api = { Detector, W, H, HISTORY, MAX_RUN, cellDiff };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BlinkDetector = api;
})(globalThis);
