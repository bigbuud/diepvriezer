const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const DATA_DIR = '/data';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'diepvriezer.db'));
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    naam TEXT NOT NULL,
    categorie TEXT NOT NULL,
    vriezer INTEGER NOT NULL DEFAULT 1,
    glutenvrij INTEGER NOT NULL DEFAULT 0,
    hoeveelheid TEXT,
    eenheid TEXT,
    datum_ingevroren TEXT,
    notities TEXT,
    foto TEXT,
    toegevoegd_op TEXT DEFAULT (date('now'))
  );
`);
// Migration: add foto column if not exists
try { db.exec('ALTER TABLE items ADD COLUMN foto TEXT'); } catch(e) {}

// ── Auth ──────────────────────────────────────────────────────────
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASS = process.env.APP_PASSWORD || 'admin';

app.use(express.json({ limit: '4mb' }));
// Persist session secret so container restarts don't invalidate cookies
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
let SESSION_SECRET;
try {
  SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} catch {
  SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SESSION_SECRET);
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
    secure: false,   // HTTP (no HTTPS on local network)
    httpOnly: true
  }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Niet ingelogd' });
}

// ── Auth routes ───────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { gebruiker, wachtwoord } = req.body;
  if (gebruiker === APP_USER && wachtwoord === APP_PASS) {
    req.session.user = gebruiker;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Onjuiste gegevens' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ ok: !!(req.session && req.session.user) });
});

// ── Items API ─────────────────────────────────────────────────────
app.get('/api/items', requireAuth, (req, res) => {
  const { vriezer, categorie, zoek, glutenvrij, sorteer } = req.query;
  let sql = 'SELECT * FROM items WHERE 1=1';
  const params = [];

  if (vriezer) { sql += ' AND vriezer = ?'; params.push(parseInt(vriezer)); }
  if (categorie) { sql += ' AND categorie = ?'; params.push(categorie); }
  if (glutenvrij === '1') { sql += ' AND glutenvrij = 1'; }
  if (zoek) { sql += ' AND (naam LIKE ? OR notities LIKE ?)'; params.push(`%${zoek}%`, `%${zoek}%`); }

  const orderMap = {
    naam: 'naam ASC',
    datum: 'datum_ingevroren DESC',
    categorie: 'categorie ASC, naam ASC',
    vriezer: 'vriezer ASC, naam ASC'
  };
  sql += ' ORDER BY ' + (orderMap[sorteer] || 'toegevoegd_op DESC');

  res.json(db.prepare(sql).all(...params));
});

app.get('/api/items/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(item);
});

app.post('/api/items', requireAuth, (req, res) => {
  const { naam, categorie, vriezer, glutenvrij, hoeveelheid, eenheid, datum_ingevroren, notities, foto } = req.body;
  if (!naam || !categorie) return res.status(400).json({ error: 'Naam en categorie zijn verplicht' });
  const r = db.prepare(`
    INSERT INTO items (naam, categorie, vriezer, glutenvrij, hoeveelheid, eenheid, datum_ingevroren, notities, foto)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(naam, categorie, vriezer||1, glutenvrij?1:0, hoeveelheid||null, eenheid||null, datum_ingevroren||null, notities||null, foto||null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/items/:id', requireAuth, (req, res) => {
  const { naam, categorie, vriezer, glutenvrij, hoeveelheid, eenheid, datum_ingevroren, notities, foto } = req.body;
  db.prepare(`
    UPDATE items SET naam=?, categorie=?, vriezer=?, glutenvrij=?, hoeveelheid=?, eenheid=?, datum_ingevroren=?, notities=?, foto=?
    WHERE id=?
  `).run(naam, categorie, vriezer||1, glutenvrij?1:0, hoeveelheid||null, eenheid||null, datum_ingevroren||null, notities||null, foto||null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/statistieken', requireAuth, (req, res) => {
  const totaal   = db.prepare('SELECT COUNT(*) as c FROM items').get().c;
  const vriezer1 = db.prepare('SELECT COUNT(*) as c FROM items WHERE vriezer = 1').get().c;
  const vriezer2 = db.prepare('SELECT COUNT(*) as c FROM items WHERE vriezer = 2').get().c;
  const gv       = db.prepare('SELECT COUNT(*) as c FROM items WHERE glutenvrij = 1').get().c;
  res.json({ totaal, vriezer1, vriezer2, gv });
});

app.listen(PORT, '127.0.0.1', () => console.log(`Diepvriezer API op poort ${PORT}`));
