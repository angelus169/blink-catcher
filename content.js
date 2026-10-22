// Watches playing <video> elements, feeds every frame to BlinkDetector and keeps
// the frames it catches, so a one-frame insert can be looked at without pausing by hand.
(() => {
    'use strict';

    const { Detector, W, H, HISTORY } = globalThis.BlinkDetector;
    const store = globalThis.chrome?.storage?.local;
    const MAX_CATCHES = 50;

    const settings = { enabled: true, sensitivity: 'normal', pauseOnCatch: false };
    let speed = 1;                  // not saved: every page load starts at 1×
    const seen = new WeakSet();
    const monitors = new Set();
    const catches = [];             // oldest first

    const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

    /* ------------------------------------------------------------ */
    /* Frame capture                                                */
    /* ------------------------------------------------------------ */
    function watch(video) {
        if (seen.has(video) || !video.requestVideoFrameCallback) return;
        seen.add(video);

        const m = {
            video, frames: 0, gaps: 0, blocked: false, busyMs: 0, lastSeen: 0,
            dropped0: video.getVideoPlaybackQuality().droppedVideoFrames,
        };
        const det = new Detector(() => settings.sensitivity);
        // Full-size copies of the last HISTORY frames: when a hit is confirmed one
        // frame later, the caught frame is still here.
        const slots = Array.from({ length: HISTORY }, () => {
            const canvas = document.createElement('canvas');
            return { canvas, ctx: canvas.getContext('2d', { alpha: false }) };
        });
        const thumb = document.createElement('canvas');
        thumb.width = W;
        thumb.height = H;
        // Explicit false keeps the canvas on the GPU; only the tiny thumbnail is read back.
        const tctx = thumb.getContext('2d', { alpha: false, willReadFrequently: false });
        let next = 0, lastPresented = -1, lastTime = -1;

        const reset = () => { det.reset(); lastPresented = -1; lastTime = -1; };
        video.addEventListener('seeking', reset);
        video.addEventListener('emptied', reset);
        monitors.add(m);

        const onFrame = (now, meta) => {
            if (m.blocked) return;
            if (!video.isConnected) {
                monitors.delete(m);
                seen.delete(video);
                return;
            }
            video.requestVideoFrameCallback(onFrame);
            if (!settings.enabled) {
                if (lastTime >= 0) reset();   // start clean when turned back on
                return;
            }
            const w = video.videoWidth, h = video.videoHeight;
            if (!w || !h) return;
            const t0 = performance.now();

            // A loop or a jump: this frame does not follow the last one.
            if (lastTime >= 0 && (meta.mediaTime < lastTime || meta.mediaTime - lastTime > 0.5)) reset();
            if (lastPresented >= 0) m.gaps += Math.max(0, meta.presentedFrames - lastPresented - 1);
            lastPresented = meta.presentedFrames;
            lastTime = meta.mediaTime;

            const slot = slots[next];
            next = (next + 1) % HISTORY;
            if (slot.canvas.width !== w || slot.canvas.height !== h) {
                slot.canvas.width = w;
                slot.canvas.height = h;
            }
            slot.ctx.drawImage(video, 0, 0, w, h);
            tctx.drawImage(slot.canvas, 0, 0, W, H);

            let pixels;
            try {
                pixels = tctx.getImageData(0, 0, W, H).data;
            } catch {
                m.blocked = true;   // cross-origin or DRM video: Chrome hides its pixels
                ui.render();
                return;
            }
            m.frames++;
            m.lastSeen = now;
            const hit = det.push({ pixels, canvas: slot.canvas, time: meta.mediaTime });
            if (hit) keep(m, hit);
            m.busyMs = m.busyMs * 0.95 + (performance.now() - t0) * 0.05;
        };
        video.requestVideoFrameCallback(onFrame);
    }

    function keep(m, hit) {
        const src = m.video.currentSrc;
        const time = hit.run[0].time;
        // Reels loop: the same insert comes back on every pass.
        if (catches.some(c => c.src === src && Math.abs(c.time - time) < 0.02)) return;

        // Copy now: the ring slots are overwritten on the next frames.
        const full = hit.run.map(f => copy(f.canvas, 1));
        const c = {
            time,
            frames: hit.run.map((f, i) => ({ time: f.time, thumb: jpeg(copy(full[i], 0.25)), url: null })),
            before: jpeg(copy(hit.prev.canvas, 0.25)),
            after: jpeg(copy(hit.next.canvas, 0.25)),
            reason: hit.reason,
            score: hit.score,
            video: m.video,
            src,
            page: location.href,
        };
        full.forEach((canvas, i) => canvas.toBlob(b => {
            c.frames[i].url = URL.createObjectURL(b);
            ui.render();
        }, 'image/png'));

        catches.push(c);
        while (catches.length > MAX_CATCHES) {
            catches.shift().frames.forEach(f => f.url && URL.revokeObjectURL(f.url));
        }
        console.info(`[Blink Catcher] caught ${c.frames.length} frame(s) at ${fmt(time)} (${c.reason}, score ${c.score.toFixed(2)})`);
        if (settings.pauseOnCatch) showInVideo(c);
        ui.caught(c);
    }

    function copy(src, scale) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(src.width * scale));
        c.height = Math.max(1, Math.round(src.height * scale));
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return c;
    }

    const jpeg = canvas => canvas.toDataURL('image/jpeg', 0.85);

    // Pause on the caught frame. False when the page no longer shows that video.
    function showInVideo(c) {
        const v = c.video;
        if (!v.isConnected || v.currentSrc !== c.src) return false;
        v.pause();
        v.currentTime = c.time + 0.001;   // +1 ms: land on this frame, not the one before
        return true;
    }

    function stats() {
        const now = performance.now();
        const live = [...monitors].filter(m => m.video.isConnected);
        const active = live.filter(m => !m.blocked && now - m.lastSeen < 1000);
        const missed = live.reduce((s, m) =>
            s + m.gaps + m.video.getVideoPlaybackQuality().droppedVideoFrames - m.dropped0, 0);
        return {
            active: active.length,
            blocked: live.some(m => m.blocked && !m.video.paused),
            frames: live.reduce((s, m) => s + m.frames, 0),
            missed,
            ms: active.length ? Math.max(...active.map(m => m.busyMs)) : 0,
        };
    }

    /* ------------------------------------------------------------ */
    /* On-page UI (shadow DOM, so Instagram's CSS does not leak in) */
    /* ------------------------------------------------------------ */
    const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
* { font: 13px/1.4 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #f2f2f2; }
button { all: unset; cursor: pointer; }
button:focus-visible { outline: 2px solid #7aa7ff; outline-offset: 2px; }
.pill { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; border-radius: 999px;
  background: rgba(18,18,20,.9); box-shadow: 0 4px 18px rgba(0,0,0,.35); font-weight: 600; user-select: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b6b; }
.dot.on { background: #34d17a; box-shadow: 0 0 0 3px rgba(52,209,122,.25); }
.dot.blocked { background: #ff5a5f; }
.count { min-width: 22px; padding: 1px 7px; border-radius: 999px; background: #3a3a3e; text-align: center;
  font-variant-numeric: tabular-nums; font-weight: 700; }
.count.has { background: #ff2e63; }
.pill.ping { animation: ping .9s ease-out; }
@keyframes ping { from { box-shadow: 0 0 0 0 rgba(255,46,99,.85); } to { box-shadow: 0 0 0 18px rgba(255,46,99,0); } }
.pill.off { opacity: .55; }
.panel, .toast { position: absolute; right: 0; bottom: calc(100% + 10px); background: rgba(18,18,20,.95);
  border-radius: 14px; box-shadow: 0 10px 36px rgba(0,0,0,.5); }
.panel { width: 320px; max-height: min(70vh, 640px); overflow: auto; padding: 12px 14px; }
.toast { white-space: nowrap; padding: 8px 12px; cursor: pointer; }
header, footer, .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
header b { font-weight: 700; font-size: 14px; }
.x { width: 24px; height: 24px; text-align: center; border-radius: 6px; color: #aaa; }
.x:hover { background: #2a2a2e; }
.status { margin: 6px 0 10px; color: #b5b5bb; font-size: 12px; }
.row { margin: 8px 0; color: #d6d6da; }
.seg { display: flex; background: #2a2a2e; border-radius: 8px; padding: 2px; }
.seg button { padding: 3px 9px; border-radius: 6px; color: #c8c8cc; font-size: 12px; }
.seg button.on { background: #f2f2f2; color: #111; }
input[type=checkbox] { accent-color: #ff2e63; width: 16px; height: 16px; margin: 0; }
.switch { position: relative; margin-left: auto; width: 34px; height: 20px; flex: none; }
.switch input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; margin: 0; cursor: pointer; }
.switch span { position: absolute; inset: 0; border-radius: 999px; background: #3a3a3e; transition: background .15s; pointer-events: none; }
.switch span::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #f2f2f2; transition: transform .15s; }
.switch input:checked + span { background: #34d17a; }
.switch input:checked + span::after { transform: translateX(14px); }
.switch input:focus-visible + span { outline: 2px solid #7aa7ff; outline-offset: 2px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 12px 0 8px; }
.grid:empty::before { content: "Nothing caught yet. Play a Reel."; grid-column: 1 / -1; color: #8d8d93;
  font-size: 12px; padding: 14px 0; text-align: center; }
.item { position: relative; display: block; aspect-ratio: 9 / 16; border-radius: 8px; overflow: hidden; background: #000; }
.item img { width: 100%; height: 100%; object-fit: cover; display: block; }
.item span { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 5px; font-size: 11px;
  background: linear-gradient(transparent, rgba(0,0,0,.8)); }
footer { color: #8d8d93; font-size: 12px; }
footer button { color: #ff7a9a; font-size: 12px; }
.viewer { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.88); padding: 16px; }
.box { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 100%; max-height: 100%; }
.big { max-width: min(92vw, 720px); max-height: calc(100vh - 220px); object-fit: contain; border-radius: 8px; background: #000; }
.strip { display: flex; gap: 8px; align-items: flex-end; }
.strip figure { margin: 0; text-align: center; }
.strip img { display: block; height: 72px; border-radius: 4px; }
.strip figure.ctx img { opacity: .55; }
.strip button img { outline: 2px solid transparent; outline-offset: 1px; }
.strip button.on img { outline-color: #ff2e63; }
.strip figcaption { font-size: 11px; color: #a0a0a6; margin-top: 3px; }
.meta { margin: 0; color: #c8c8cc; font-size: 12px; text-align: center; }
.actions { display: flex; gap: 8px; }
.actions button { padding: 7px 12px; border-radius: 8px; background: #2a2a2e; font-weight: 600; }
.actions button:hover { background: #3a3a3e; }
.actions button.primary { background: #ff2e63; }
`;

    function createUI() {
        const host = document.createElement('div');
        host.id = 'blink-catcher';
        host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${CSS}</style>
<div class="toast" hidden></div>
<section class="panel" hidden>
  <header><b>Blink Catcher</b>
    <label class="switch" title="Turn checking on or off"><input type="checkbox" data-set="enabled"><span></span></label>
    <button class="x" data-act="close-panel" title="Close">✕</button></header>
  <p class="status"></p>
  <div class="row"><span>Sensitivity</span><div class="seg" data-set="sensitivity">
    <button data-v="low">Low</button><button data-v="normal">Normal</button><button data-v="high">High</button></div></div>
  <div class="row"><span>Speed</span><div class="seg" data-set="speed">
    <button data-v="1">1×</button><button data-v="0.5">0.5×</button><button data-v="0.25">0.25×</button></div></div>
  <label class="row"><span>Pause on the caught frame</span><input type="checkbox" data-set="pauseOnCatch"></label>
  <div class="grid"></div>
  <footer><span>Click a frame to open it.</span><button data-act="clear">Clear</button></footer>
</section>
<button class="pill" data-act="toggle-panel"><i class="dot"></i>Blink Catcher<span class="count">0</span></button>
<div class="viewer" hidden>
  <div class="box">
    <img class="big" alt="Caught frame">
    <div class="strip"></div>
    <p class="meta"></p>
    <div class="actions">
      <button class="primary" data-act="download">Download PNG</button>
      <button data-act="seek">Show in video</button>
      <button data-act="close-viewer">Close</button>
    </div>
  </div>
</div>`;
        document.documentElement.append(host);

        const $ = s => root.querySelector(s);
        const pill = $('.pill'), dot = $('.dot'), count = $('.count'), toast = $('.toast');
        const panel = $('.panel'), status = $('.status'), grid = $('.grid');
        const toggles = root.querySelectorAll('input[data-set]');
        const viewer = $('.viewer'), big = $('.big'), strip = $('.strip'), meta = $('.meta');
        let view = null;            // { c, i } while the viewer is open
        let toastTimer = 0, statusTimer = 0;

        // Keep Instagram's own click handlers (e.g. "click outside closes the dialog") out of it.
        for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'wheel']) {
            host.addEventListener(type, e => e.stopPropagation());
        }

        root.addEventListener('click', e => {
            const el = e.target.closest('[data-act], [data-v], [data-i], [data-f]');
            if (!el) return;
            if (el.dataset.v !== undefined) return setOption(el.parentElement.dataset.set, el.dataset.v);
            if (el.dataset.i !== undefined) return openViewer(catches[+el.dataset.i]);
            if (el.dataset.f !== undefined) { view.i = +el.dataset.f; return renderViewer(); }
            switch (el.dataset.act) {
                case 'toggle-panel': return togglePanel(panel.hidden);
                case 'close-panel': return togglePanel(false);
                case 'clear':
                    catches.splice(0).forEach(c => c.frames.forEach(f => f.url && URL.revokeObjectURL(f.url)));
                    return render();
                case 'download': return download(view.c, view.i);
                case 'seek':
                    if (showInVideo(view.c)) return closeViewer();
                    meta.textContent = 'This video is no longer on the page.';
                    return;
                case 'close-viewer': return closeViewer();
            }
        });
        toast.addEventListener('click', () => openViewer(catches[catches.length - 1]));
        viewer.addEventListener('click', e => { if (e.target === viewer) closeViewer(); });
        toggles.forEach(t => t.addEventListener('change', () => setOption(t.dataset.set, t.checked)));
        window.addEventListener('keydown', e => {
            if (!view) return;
            if (e.key === 'Escape') closeViewer();
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const n = view.c.frames.length;
                view.i = (view.i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
                renderViewer();
            } else return;
            e.preventDefault();
            e.stopPropagation();
        }, true);

        function setOption(key, value) {
            if (key === 'speed') {
                speed = +value;
                monitors.forEach(m => { m.video.playbackRate = speed; });
            } else {
                settings[key] = value;
                store?.set({ [key]: value });
            }
            render();
        }

        function togglePanel(open) {
            panel.hidden = !open;
            toast.hidden = true;
            clearInterval(statusTimer);
            if (open) statusTimer = setInterval(renderStatus, 500);
            render();
        }

        function openViewer(c) {
            if (!c) return;
            view = { c, i: 0 };
            viewer.hidden = false;
            toast.hidden = true;
            renderViewer();
        }

        function closeViewer() {
            view = null;
            viewer.hidden = true;
        }

        function download(c, i) {
            const f = c.frames[i];
            if (!f.url) return;
            const reel = /\/reels?\/([\w-]+)/.exec(c.page)?.[1] ?? 'video';
            const a = document.createElement('a');
            a.href = f.url;
            a.download = `blink-${reel}-${fmt(f.time).replace(/[:.]/g, '-')}.png`;
            a.click();
        }

        function img(src, alt) {
            const el = new Image();
            el.src = src;
            el.alt = alt;
            return el;
        }

        function figure(child, caption, cls = '') {
            const fig = document.createElement('figure');
            fig.className = cls;
            const cap = document.createElement('figcaption');
            cap.textContent = caption;
            fig.append(child, cap);
            return fig;
        }

        function renderViewer() {
            const { c, i } = view;
            const f = c.frames[i];
            big.src = f.url || f.thumb;
            strip.replaceChildren(
                figure(img(c.before, 'Frame before'), 'before', 'ctx'),
                ...c.frames.map((fr, j) => {
                    const b = document.createElement('button');
                    b.dataset.f = j;
                    b.className = j === i ? 'on' : '';
                    b.append(img(fr.thumb, `Caught frame ${j + 1}`));
                    return figure(b, c.frames.length > 1 ? `caught ${j + 1}` : 'caught');
                }),
                figure(img(c.after, 'Frame after'), 'after', 'ctx'),
            );
            const what = c.reason === 'cut' ? 'its own tiny shot between two cuts' : 'picture jumps and comes back';
            const which = c.frames.length > 1 ? `frame ${i + 1} of ${c.frames.length} (← →)` : '1 frame';
            meta.textContent = `${fmt(f.time)} · ${which} · ${what} · score ${c.score.toFixed(1)}`;
        }

        function renderStatus() {
            if (!settings.enabled) {
                status.textContent = 'Off. Videos are not checked.';
                dot.className = 'dot';
                return;
            }
            const s = stats();
            if (s.blocked && !s.active) {
                status.textContent = 'Chrome blocks the pixels of this video (DRM or cross-origin), so it cannot be checked.';
            } else if (!s.active) {
                status.textContent = s.frames ? `Paused · ${s.frames.toLocaleString()} frames checked.` : 'Waiting for a video to play.';
            } else {
                status.textContent = `Watching ${s.active} video${s.active > 1 ? 's' : ''} · ${s.frames.toLocaleString()} frames · `
                    + `${s.missed} missed · ${s.ms.toFixed(1)} ms/frame`
                    + (s.missed > 0 && speed === 1 ? ' · try 0.5× if frames are missed' : '');
            }
            dot.className = 'dot' + (s.active ? ' on' : s.blocked ? ' blocked' : '');
        }

        function render() {
            count.textContent = catches.length;
            count.classList.toggle('has', catches.length > 0);
            renderStatus();
            for (const seg of root.querySelectorAll('.seg')) {
                const current = String(seg.dataset.set === 'speed' ? speed : settings[seg.dataset.set]);
                for (const b of seg.children) b.classList.toggle('on', b.dataset.v === current);
            }
            toggles.forEach(t => { t.checked = settings[t.dataset.set]; });
            pill.classList.toggle('off', !settings.enabled);
            if (!panel.hidden) {
                grid.replaceChildren(...catches.map((c, i) => {
                    const b = document.createElement('button');
                    b.className = 'item';
                    b.dataset.i = i;
                    const cap = document.createElement('span');
                    cap.textContent = fmt(c.time) + (c.frames.length > 1 ? ` · ${c.frames.length} frames` : '');
                    b.append(img(c.frames[0].thumb, `Caught at ${fmt(c.time)}`), cap);
                    return b;
                }).reverse());
            }
            if (view) renderViewer();
        }

        function caught(c) {
            render();
            pill.classList.remove('ping');
            void pill.offsetWidth;  // restart the animation
            pill.classList.add('ping');
            if (panel.hidden && !view) {
                toast.textContent = `Caught ${c.frames.length > 1 ? `${c.frames.length} frames` : '1 frame'} at ${fmt(c.time)} · open`;
                toast.hidden = false;
                clearTimeout(toastTimer);
                toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
            }
        }

        render();
        return { render, caught };
    }

    const ui = createUI();
    store?.get(settings).then(saved => { Object.assign(settings, saved); ui.render(); });

    // 'play' does not bubble, but the capture phase sees it for every video on the page.
    document.addEventListener('play', e => {
        if (!(e.target instanceof HTMLVideoElement)) return;
        if (speed !== 1) e.target.playbackRate = speed;
        watch(e.target);
        ui.render();
    }, true);
    document.querySelectorAll('video').forEach(v => { if (!v.paused) watch(v); });
})();
