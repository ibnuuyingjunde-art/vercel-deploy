/**
 * Vercel Deploy Tool — Backend (Node built-in + MongoDB)
 * Statistik & history deploy disimpan di MongoDB Atlas
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

// ── Load .env manually ───────────────────────────────────
function loadEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {
    console.warn('Tidak bisa baca .env:', e.message);
  }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'vercel_deploy_tool';
const COL_DEPLOYS = 'deploys';
const COL_STATS = 'stats';

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI tidak ada di .env');
  process.exit(1);
}

let db = null;
let deploysCol = null;
let statsCol = null;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  deploysCol = db.collection(COL_DEPLOYS);
  statsCol = db.collection(COL_STATS);

  await deploysCol.createIndex({ id: 1 }, { unique: true });
  await deploysCol.createIndex({ ts: -1 });
  await deploysCol.createIndex({ status: 1 });
  await statsCol.createIndex({ key: 1 }, { unique: true });

  await statsCol.updateOne(
    { key: 'global' },
    {
      $setOnInsert: {
        key: 'global',
        totalDeploys: 0,
        successDeploys: 0,
        failedDeploys: 0,
        buildingDeploys: 0,
        lastDeployAt: null,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  console.log(`MongoDB connected → db="${DB_NAME}"`);
}

// ── Helpers ──────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  // prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(__dirname, 'index.html'), (err2, html) => {
        if (err2) return sendJson(res, 404, { ok: false, error: 'Not found' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── API handlers ─────────────────────────────────────────
async function handleHealth(_req, res) {
  try {
    await db.command({ ping: 1 });
    sendJson(res, 200, { ok: true, status: 'ok', mongo: true, time: new Date().toISOString() });
  } catch (e) {
    sendJson(res, 503, { ok: false, error: e.message });
  }
}

async function handleStats(_req, res) {
  try {
    const doc = await statsCol.findOne({ key: 'global' });
    const total = await deploysCol.countDocuments();
    const success = await deploysCol.countDocuments({ status: 'ready' });
    const failed = await deploysCol.countDocuments({ status: { $in: ['err', 'error', 'canceled'] } });
    const building = await deploysCol.countDocuments({ status: 'building' });
    const payload = {
      totalDeploys: total,
      successDeploys: success,
      failedDeploys: failed,
      buildingDeploys: building,
      lastDeployAt: doc?.lastDeployAt || null,
    };
    await statsCol.updateOne(
      { key: 'global' },
      { $set: { ...payload, updatedAt: new Date() } }
    );
    sendJson(res, 200, { ok: true, stats: payload });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handleGetDeploys(req, res, url) {
  try {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '40', 10), 100);
    const list = await deploysCol.find({}).sort({ ts: -1 }).limit(limit).toArray();
    sendJson(res, 200, { ok: true, deploys: list });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handlePostDeploy(req, res) {
  try {
    const body = await readBody(req);
    const { id, name, url, status, ts, projectName, teamSlug } = body;
    if (!id) return sendJson(res, 400, { ok: false, error: 'id wajib diisi' });

    const now = Date.now();
    const doc = {
      id: String(id),
      name: name || projectName || id,
      url: url || null,
      status: status || 'building',
      ts: typeof ts === 'number' ? ts : now,
      teamSlug: teamSlug || null,
      updatedAt: now,
    };

    const existing = await deploysCol.findOne({ id: doc.id });
    const isNew = !existing;

    await deploysCol.updateOne(
      { id: doc.id },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );

    const inc = {};
    if (isNew) {
      inc.totalDeploys = 1;
      if (doc.status === 'ready') inc.successDeploys = 1;
      else if (['err', 'error', 'canceled'].includes(doc.status)) inc.failedDeploys = 1;
      else inc.buildingDeploys = 1;
    }

    const update = { $set: { lastDeployAt: now, updatedAt: new Date() } };
    if (Object.keys(inc).length) update.$inc = inc;
    await statsCol.updateOne({ key: 'global' }, update, { upsert: true });

    sendJson(res, 200, { ok: true, deploy: doc, created: isNew });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handlePatchDeploy(req, res, id) {
  try {
    const body = await readBody(req);
    const { status, url } = body;
    if (!status && url === undefined) {
      return sendJson(res, 400, { ok: false, error: 'status atau url diperlukan' });
    }

    const existing = await deploysCol.findOne({ id });
    if (!existing) return sendJson(res, 404, { ok: false, error: 'Deploy tidak ditemukan' });

    const prev = existing.status;
    const next = status || prev;
    const set = { updatedAt: Date.now() };
    if (status) set.status = status;
    if (url !== undefined) set.url = url;

    await deploysCol.updateOne({ id }, { $set: set });

    if (status && status !== prev) {
      const dec = {};
      const inc = {};
      if (prev === 'ready') dec.successDeploys = -1;
      else if (['err', 'error', 'canceled'].includes(prev)) dec.failedDeploys = -1;
      else dec.buildingDeploys = -1;
      if (next === 'ready') inc.successDeploys = 1;
      else if (['err', 'error', 'canceled'].includes(next)) inc.failedDeploys = 1;
      else inc.buildingDeploys = 1;

      await statsCol.updateOne(
        { key: 'global' },
        {
          $inc: { ...dec, ...inc },
          $set: { updatedAt: new Date(), lastDeployAt: Date.now() },
        }
      );
    }

    const updated = await deploysCol.findOne({ id });
    sendJson(res, 200, { ok: true, deploy: updated });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handleDeleteDeploys(req, res, url) {
  try {
    if (url.searchParams.get('confirm') !== 'yes') {
      return sendJson(res, 400, { ok: false, error: 'Tambahkan ?confirm=yes untuk menghapus semua' });
    }
    await deploysCol.deleteMany({});
    await statsCol.updateOne(
      { key: 'global' },
      {
        $set: {
          totalDeploys: 0,
          successDeploys: 0,
          failedDeploys: 0,
          buildingDeploys: 0,
          lastDeployAt: null,
          updatedAt: new Date(),
        },
      }
    );
    sendJson(res, 200, { ok: true, cleared: true });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

// ── Router ───────────────────────────────────────────────
async function onRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/health' && req.method === 'GET') return handleHealth(req, res);
    if (p === '/api/stats' && req.method === 'GET') return handleStats(req, res);
    if (p === '/api/deploys' && req.method === 'GET') return handleGetDeploys(req, res, url);
    if (p === '/api/deploys' && req.method === 'POST') return handlePostDeploy(req, res);
    if (p === '/api/deploys' && req.method === 'DELETE') return handleDeleteDeploys(req, res, url);

    const m = p.match(/^\/api\/deploys\/([^/]+)$/);
    if (m && req.method === 'PATCH') return handlePatchDeploy(req, res, decodeURIComponent(m[1]));

    // static
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

// ── Start ────────────────────────────────────────────────
async function main() {
  await connectMongo();
  const server = http.createServer(onRequest);
  server.listen(PORT, () => {
    console.log(`Server running → http://localhost:${PORT}`);
    console.log(`Health         → http://localhost:${PORT}/api/health`);
    console.log(`Stats          → http://localhost:${PORT}/api/stats`);
  });
}

main().catch((err) => {
  console.error('Gagal start:', err.message);
  process.exit(1);
});
