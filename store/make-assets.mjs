// Rebuilds the icons and the store/README images: demo video, screenshots, promo tile, social preview.
// Needs Google Chrome, ffmpeg and rsvg-convert. Run: node store/make-assets.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'store/build');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });

mkdirSync(BUILD, { recursive: true });

/* ------------------------------------------------------------ */
/* Icons                                                        */
/* ------------------------------------------------------------ */
for (const s of ['16', '32', '48', '128']) {
    run('rsvg-convert', ['-w', s, '-h', s, 'icons/icon.svg', '-o', `icons/icon${s}.png`]);
}

/* ------------------------------------------------------------ */
/* Static server (with Range support, so the video can loop)    */
/* ------------------------------------------------------------ */
const server = createServer((req, res) => {
    const file = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT) || !existsSync(file)) return res.writeHead(404).end();
    const body = readFileSync(file);
    const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (!range) return res.writeHead(200, { ...headers, 'Content-Length': body.length }).end(body);
    const start = +range[1], end = range[2] ? +range[2] : body.length - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 })
        .end(body.subarray(start, end + 1));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------ */
/* Headless Chrome over the DevTools protocol                   */
/* ------------------------------------------------------------ */
const profile = mkdtempSync(join(tmpdir(), 'blink-assets-'));
const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

async function connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let id = 0;
    const pending = new Map(), waiters = [];
    ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.id) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? p.fail(new Error(`${p.method}: ${msg.error.message}`)) : p.ok(msg.result);
        } else {
            for (const w of waiters.filter(w => w.method === msg.method)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.ok(msg.params);
            }
        }
    };
    const send = (method, params = {}) => new Promise((ok, fail) => {
        const i = ++id;
        pending.set(i, { ok, fail, method });
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    const once = method => new Promise(ok => waiters.push({ method, ok }));
    return { send, once, close: () => ws.close() };
}

let page;
try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !(existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n')); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = await connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await page.send('Page.enable');

    const evaluate = async expression => {
        const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
    };
    const open = async (path, width, height, { transparent = false } = {}) => {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await page.send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
        const loaded = page.once('Page.loadEventFired');
        await page.send('Page.navigate', { url: `${base}/${path}` });
        await loaded;
        await evaluate('document.fonts.ready.then(() => true)');
    };
    const capture = async file => {
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(file, Buffer.from(data, 'base64'));
        console.log('wrote', file.slice(ROOT.length + 1));
    };

    /* -------- demo video: soft gradients with three hidden frames -------- */
    for (const v of [1, 2, 3]) {
        await open(`store/src/hidden.html?v=${v}`, 540, 960, { transparent: true });
        await capture(join(BUILD, `hidden-${v}.png`));
    }
    run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'gradients=s=540x960:r=30:d=8:nb_colors=3:c0=0x2b1055:c1=0x7597de:c2=0xff8fab:speed=0.02',
        '-i', 'hidden-1.png', '-i', 'hidden-2.png', '-i', 'hidden-3.png',
        '-filter_complex', "[0][1]overlay=enable='eq(n,60)'[a];[a][2]overlay=enable='eq(n,135)'[b];[b][3]overlay=enable='eq(n,195)',format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart', 'demo.mp4'], BUILD);
    run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', 'demo.mp4',
        '-vf', "select='between(n,59,61)'", '-fps_mode', 'passthrough', 'strip-%d.png'], BUILD);
    console.log('wrote store/build/demo.mp4');

    /* -------- screenshots: the extension catches the frames for real -------- */
    await open('store/src/demo.html', 1280, 800);
    const ui = "document.querySelector('#blink-catcher').shadowRoot";
    let caught = 0;
    for (let i = 0; i < 120 && caught < 3; i++) {   // up to 30 s: the video loops if a frame is missed
        await sleep(250);
        caught = +(await evaluate(`${ui}.querySelector('.count').textContent`));
    }
    if (caught < 3) throw new Error(`only ${caught} of 3 hidden frames caught`);
    await evaluate(`(async () => {
        const v = document.querySelector('video');
        v.pause();
        v.currentTime = 1.2;
        await new Promise(ok => v.addEventListener('seeked', ok, { once: true }));
        ${ui}.querySelector('.pill').click();
        return true;
    })()`);
    await sleep(1200);   // status line switches to "Paused", the pill's catch pulse ends
    await capture(join(ROOT, 'store/screenshot-panel.png'));
    await evaluate(`(async () => {
        ${ui}.querySelector('.item[data-i="0"]').click();
        ${ui}.querySelector('[data-act=close-panel]').click();
        await ${ui}.querySelector('.big').decode();
        return true;
    })()`);
    await sleep(300);
    await capture(join(ROOT, 'store/screenshot-viewer.png'));

    /* -------- promo tile and social preview -------- */
    await open('store/src/promo.html', 440, 280);
    await capture(join(ROOT, 'store/promo-440x280.png'));
    await open('store/src/social.html', 1280, 640);
    await capture(join(ROOT, 'store/social-preview.png'));
} finally {
    page?.close();
    chrome.kill();
    server.close();
    rmSync(profile, { recursive: true, force: true });
}
