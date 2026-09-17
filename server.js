const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');

// Multer: memory storage, max 20MB raw (sharp will compress it down)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
db.exec(`
  CREATE TABLE IF NOT EXISTS boodschappen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    naam TEXT NOT NULL,
    categorie TEXT,
    hoeveelheid TEXT,
    bron TEXT DEFAULT 'handmatig',
    gekocht INTEGER NOT NULL DEFAULT 0,
    toegevoegd_op TEXT DEFAULT (date('now'))
  );
`);
// Migrations (safe to re-run — ignore "duplicate column" errors)
try { db.exec('ALTER TABLE items ADD COLUMN foto TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE items ADD COLUMN houdbaar_tot TEXT'); } catch(e) {}

// ── Houdbaarheid: standaard bewaartijd per categorie (maanden in de vriezer) ──
const SHELF_LIFE_MAANDEN = {
  vlees: 6, vis: 4, groenten: 10, fruit: 10, snacks: 6,
  soepen: 3, brood: 3, maaltijden: 3, zuivel: 4, ijs: 6, overige: 6
};

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Adds computed vervaldatum + dagen_resterend to an item.
// Explicit houdbaar_tot always wins; otherwise derive from datum_ingevroren + categorie default.
function verrijkItem(item) {
  let vervaldatum = item.houdbaar_tot || null;
  if (!vervaldatum && item.datum_ingevroren) {
    const maanden = SHELF_LIFE_MAANDEN[item.categorie] ?? SHELF_LIFE_MAANDEN.overige;
    vervaldatum = addMonths(item.datum_ingevroren, maanden);
  }
  let dagen_resterend = null;
  if (vervaldatum) {
    const vandaag = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');
    const vd = new Date(vervaldatum + 'T00:00:00');
    dagen_resterend = Math.round((vd - vandaag) / 86400000);
  }
  return { ...item, vervaldatum, dagen_resterend, houdbaar_tot_automatisch: !item.houdbaar_tot };
}

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

// Sessions are stored in the same SQLite DB (on the persistent /data volume)
// instead of the default in-memory store, so logins survive container restarts.
class SQLiteSessionStore extends session.Store {
  constructor(dbHandle) {
    super();
    this.db = dbHandle;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      )
    `);
    this._get = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this._set = this.db.prepare(`
      INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this._del = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._purge = this.db.prepare('DELETE FROM sessions WHERE expires < ?');
    setInterval(() => { try { this._purge.run(Date.now()); } catch {} }, 24 * 60 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 90 * 24 * 60 * 60 * 1000;
      this._set.run(sid, JSON.stringify(sess), expires);
      cb && cb();
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this._del.run(sid); cb && cb(); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

app.use(session({
  store: new SQLiteSessionStore(db),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // extend the session on every request, so active use never expires
  cookie: {
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
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

// ── Photo upload ─────────────────────────────────────────────
app.post('/api/upload-photo', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Geen foto ontvangen' });
    // Resize to max 800px, convert to JPEG quality 75 — sharp is very memory-efficient
    const resized = await sharp(req.file.buffer)
      .rotate()               // auto-correct EXIF orientation (common on Android)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    const base64 = 'data:image/jpeg;base64,' + resized.toString('base64');
    res.json({ ok: true, foto: base64 });
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: 'Foto verwerken mislukt' });
  }
});

// ── Items API ─────────────────────────────────────────────────────
app.get('/api/items', requireAuth, (req, res) => {
  const { vriezer, categorie, zoek, glutenvrij, sorteer, verloopt_binnen } = req.query;
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

  let items = db.prepare(sql).all(...params).map(verrijkItem);

  if (verloopt_binnen) {
    const dagen = parseInt(verloopt_binnen);
    items = items.filter(i => i.dagen_resterend !== null && i.dagen_resterend <= dagen);
  }
  if (sorteer === 'houdbaarheid') {
    items.sort((a, b) => {
      if (a.dagen_resterend === null) return 1;
      if (b.dagen_resterend === null) return -1;
      return a.dagen_resterend - b.dagen_resterend;
    });
  }

  res.json(items);
});

app.get('/api/items/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(verrijkItem(item));
});

app.post('/api/items', requireAuth, (req, res) => {
  const { naam, categorie, vriezer, glutenvrij, hoeveelheid, eenheid, datum_ingevroren, notities, foto, houdbaar_tot } = req.body;
  if (!naam || !categorie) return res.status(400).json({ error: 'Naam en categorie zijn verplicht' });
  const r = db.prepare(`
    INSERT INTO items (naam, categorie, vriezer, glutenvrij, hoeveelheid, eenheid, datum_ingevroren, notities, foto, houdbaar_tot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(naam, categorie, vriezer||1, glutenvrij?1:0, hoeveelheid||null, eenheid||null, datum_ingevroren||null, notities||null, foto||null, houdbaar_tot||null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/items/:id', requireAuth, (req, res) => {
  const { naam, categorie, vriezer, glutenvrij, hoeveelheid, eenheid, datum_ingevroren, notities, foto, houdbaar_tot } = req.body;
  db.prepare(`
    UPDATE items SET naam=?, categorie=?, vriezer=?, glutenvrij=?, hoeveelheid=?, eenheid=?, datum_ingevroren=?, notities=?, foto=?, houdbaar_tot=?
    WHERE id=?
  `).run(naam, categorie, vriezer||1, glutenvrij?1:0, hoeveelheid||null, eenheid||null, datum_ingevroren||null, notities||null, foto||null, houdbaar_tot||null, req.params.id);
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
  const bijnaVerlopen = db.prepare('SELECT * FROM items').all()
    .map(verrijkItem)
    .filter(i => i.dagen_resterend !== null && i.dagen_resterend <= 14).length;
  const boodschappenOpen = db.prepare('SELECT COUNT(*) as c FROM boodschappen WHERE gekocht = 0').get().c;
  res.json({ totaal, vriezer1, vriezer2, gv, bijnaVerlopen, boodschappenOpen });
});

// ── Boodschappenlijst API ────────────────────────────────────────
app.get('/api/boodschappen', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM boodschappen ORDER BY gekocht ASC, toegevoegd_op DESC, id DESC').all();
  res.json(rows);
});

app.post('/api/boodschappen', requireAuth, (req, res) => {
  const { naam, categorie, hoeveelheid, bron } = req.body;
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  const r = db.prepare(`
    INSERT INTO boodschappen (naam, categorie, hoeveelheid, bron)
    VALUES (?, ?, ?, ?)
  `).run(naam, categorie||null, hoeveelheid||null, bron||'handmatig');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/boodschappen/:id', requireAuth, (req, res) => {
  const { gekocht } = req.body;
  db.prepare('UPDATE boodschappen SET gekocht=? WHERE id=?').run(gekocht ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/boodschappen/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM boodschappen WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => console.log(`Diepvriezer API op poort ${PORT}`));
