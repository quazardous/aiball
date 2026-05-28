// POC server for ticket #531 — observe what tmux/psmux capture-pane
// emits at the end of styled output and what xterm.js does with it.
//
// No deps beyond Node stdlib. Reads MUX_CMD from env (default 'tmux'),
// PORT (default 7777), TARGET (default 'cursor-poc' — the session name
// created by sample.sh).

const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const MUX = process.env.MUX_CMD || 'tmux';
const PORT = Number(process.env.PORT || 7777);
const TARGET = process.env.TARGET || 'cursor-poc';

function captureText(cb) {
    const child = spawn(MUX, ['capture-pane', '-e', '-p', '-t', TARGET], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errs = [];
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => errs.push(b));
    child.on('error', (e) => cb({ error: `spawn ${MUX}: ${e.message}` }));
    child.on('close', (code) => {
        if (code !== 0) {
            const stderr = Buffer.concat(errs).toString('utf8').trim();
            cb({ error: `capture-pane exited ${code}${stderr ? `: ${stderr}` : ''}` });
            return;
        }
        cb({ text: Buffer.concat(chunks).toString('utf8') });
    });
}

function captureCursor(cb) {
    const child = spawn(
        MUX,
        ['display-message', '-p', '-t', TARGET, '#{cursor_x},#{cursor_y}'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks = [];
    child.stdout.on('data', (b) => chunks.push(b));
    child.on('error', (e) => cb({ error: `spawn ${MUX}: ${e.message}` }));
    child.on('close', (code) => {
        if (code !== 0) return cb({ error: `display-message exited ${code}` });
        const out = Buffer.concat(chunks).toString('utf8').trim();
        const m = /^(\d+),(\d+)$/.exec(out);
        if (!m) return cb({ error: `unrecognised display-message output: ${out}` });
        cb({ cursor: { x: Number(m[1]), y: Number(m[2]) } });
    });
}

const REPRO_HTML_PATH = join(__dirname, 'repro.html');

const server = http.createServer((req, res) => {
    if (req.url === '/repro' || req.url === '/' || req.url === '/repro.html') {
        if (!existsSync(REPRO_HTML_PATH)) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            return res.end(`repro.html missing at ${REPRO_HTML_PATH}`);
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(REPRO_HTML_PATH));
    }
    if (req.url === '/capture') {
        return captureText((r) => {
            if (r.error) {
                res.writeHead(500, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: r.error }));
            }
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(r.text);
        });
    }
    if (req.url === '/cursor') {
        return captureCursor((r) => {
            res.writeHead(r.error ? 500 : 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
        });
    }
    if (req.url === '/tail') {
        // Convenience: hex dump of the last 256 bytes of capture-pane for
        // visual inspection without curl + od.
        return captureText((r) => {
            if (r.error) {
                res.writeHead(500, { 'content-type': 'application/json' });
                return res.end(JSON.stringify(r));
            }
            const buf = Buffer.from(r.text, 'utf8');
            const tail = buf.subarray(Math.max(0, buf.length - 256));
            const hex = Array.from(tail).map((b) => b.toString(16).padStart(2, '0')).join(' ');
            const pretty = tail.toString('utf8').replace(/\x1b/g, '\\x1b').replace(/\n/g, '\\n\n');
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(`# last ${tail.length} bytes of capture-pane -e -p\n\n[hex]\n${hex}\n\n[pretty]\n${pretty}\n`);
        });
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('try /repro, /capture, /cursor, /tail');
});

server.listen(PORT, () => {
    console.log(`POC #531 listening on http://localhost:${PORT}`);
    console.log(`  MUX_CMD=${MUX}  TARGET=${TARGET}`);
    console.log('  open /repro in a real browser');
    // Quick liveness probe — fail loudly if the mux isn't even reachable.
    const probe = spawnSync(MUX, ['has-session', '-t', TARGET], { stdio: 'ignore' });
    if (probe.status !== 0) {
        console.warn(`  WARN: ${MUX} has-session -t ${TARGET} → exit ${probe.status}. Run ./sample.sh first.`);
    }
});
