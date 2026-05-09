const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const sizeOf = require('image-size');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const genToken = (len = 8) =>
  Array.from(crypto.randomBytes(len)).map(b => CHARS[b % CHARS.length]).join('');

const str = (v, max = 255) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, def = 0) => (isFinite(+v) ? +v : def);
const bool = (v) => v === true || v === 'true';
const arr = (v) => Array.isArray(v) ? v : [];

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static('/app/uploads'));

const storage = multer.diskStorage({
  destination: '/app/uploads',
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// FÜGE DIESE ZEILE HINZU:
const memoryUpload = multer({ storage: multer.memoryStorage() });

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

const canManage = async (userId, mapId) => {
  const r = await pool.query(
    `SELECT 1 FROM maps WHERE id=$1 AND owner_id=$2
     UNION SELECT 1 FROM map_admins WHERE map_id=$1 AND user_id=$2
     UNION SELECT 1 FROM users WHERE id=$2 AND is_superadmin=true`,
    [mapId, userId]);
  return r.rows.length > 0;
};

const emit = (mapId, event, data) => io.to(`map:${mapId}`).emit(event, data);
const emitWaypoints = async (mapId, routeId) => {
  const all = await pool.query(
    'SELECT * FROM route_waypoints WHERE route_id=$1 ORDER BY order_index, id', [routeId]);
  emit(mapId, 'waypoints:updated', { route_id: routeId, waypoints: all.rows });
  return all.rows;
};

// ── AUTH ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!str(username) || !str(password)) return res.status(400).json({ error: 'Felder fehlen' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1', [str(username, 100)]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    const token = jwt.sign(
      { id: user.id, username: user.username, is_superadmin: user.is_superadmin },
      JWT_SECRET, { expiresIn: '30d' });
    await auditLog(req, 'LOGIN', `Benutzer angemeldet`);
    res.json({ token, user: { id: user.id, username: user.username, is_superadmin: user.is_superadmin } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || str(new_password).length < 4)
    return res.status(400).json({ error: 'Bitte aktuelles + neues Passwort angeben (min. 4 Zeichen)' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (!(await bcrypt.compare(current_password, r.rows[0].password_hash)))
      return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',
      [await bcrypt.hash(new_password, 10), req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const r = await pool.query('SELECT id,username,email,is_superadmin FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

// ── FONTS ──────────────────────────────────────────────────────────────
const fs = require('fs'); // Sicherstellen, dass fs importiert ist

// Finde den ersten Pfad, der wirklich existiert
const FONT_PATH = '/app/frontend/public/css/fonts';

// Statische Auslieferung
app.use('/css/fonts', express.static(FONT_PATH));

app.get('/api/fonts', auth, (req, res) => {
  console.log("Versuche Fonts zu lesen aus:", FONT_PATH);
  
  if (!fs.existsSync(FONT_PATH)) {
    console.error("Font-Ordner existiert nicht!");
    return res.json([]);
  }
  
  try {
    const files = fs.readdirSync(FONT_PATH);
    const fonts = files.filter(f => {
      const low = f.toLowerCase();
      return low.endsWith('.ttf') || low.endsWith('.otf');
    });
    res.json(fonts);
  } catch (err) {
    console.error("Fehler beim Lesen des Verzeichnisses:", err);
    res.status(500).json({ error: "Fehler beim Lesen der Schriften" });
  }
});

// ── USERS ──────────────────────────────────────────────────────────────
app.get('/api/users', auth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Forbidden' });
  const r = await pool.query('SELECT id,username,email,is_superadmin,created_at FROM users ORDER BY created_at');
  res.json(r.rows);
});

app.post('/api/users', auth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Forbidden' });
  const { username, password, email } = req.body;
  if (!str(username) || !password || str(password).length < 4)
    return res.status(400).json({ error: 'Username und Passwort (min. 4 Zeichen) erforderlich' });
  try {
    const r = await pool.query(
      'INSERT INTO users (username,password_hash,email) VALUES ($1,$2,$3) RETURNING id,username,email,is_superadmin,created_at',
      [str(username, 100), await bcrypt.hash(password, 10), email ? str(email, 255) : null]);
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Benutzername bereits vergeben' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id/password', auth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Forbidden' });
  const { password } = req.body;
  if (!password || str(password).length < 4) return res.status(400).json({ error: 'Passwort min. 4 Zeichen' });
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 10), +req.params.id]);
  res.json({ success: true });
});

app.delete('/api/users/:id', auth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM users WHERE id=$1 AND is_superadmin=false', [+req.params.id]);
  res.json({ success: true });
});

// ── SHARE TOKEN RESOLUTION ─────────────────────────────────────────────
app.get('/api/share/:token', async (req, res) => {
  const t = str(req.params.token, 20);
  let r = await pool.query('SELECT id,name,share_token FROM maps WHERE share_token=$1', [t]);
  if (r.rows[0]) return res.json({ type: 'map', map_id: r.rows[0].id, name: r.rows[0].name });
  r = await pool.query(
    `SELECT g.id AS group_id, g.name AS group_name, g.map_id, m.name AS map_name
     FROM groups g JOIN maps m ON g.map_id=m.id WHERE g.share_token=$1`, [t]);
  if (r.rows[0]) return res.json({ type: 'group', ...r.rows[0] });
  res.status(404).json({ error: 'Not found' });
});

// ── MAPS ───────────────────────────────────────────────────────────────
app.get('/api/maps', auth, async (req, res) => {
  let q, p;
  if (req.user.is_superadmin) {
    q = `SELECT m.*, u.username AS owner_name, lu.username AS locked_by_name FROM maps m LEFT JOIN users u ON m.owner_id=u.id LEFT JOIN users lu ON m.locked_by_editor=lu.id ORDER BY m.created_at DESC`;
    p = [];
  } else {
    q = `SELECT DISTINCT m.*, u.username AS owner_name, lu.username AS locked_by_name FROM maps m
         LEFT JOIN users u ON m.owner_id=u.id
         LEFT JOIN users lu ON m.locked_by_editor=lu.id
         LEFT JOIN map_admins ma ON m.id=ma.map_id
         WHERE m.owner_id=$1 OR ma.user_id=$1 ORDER BY m.created_at DESC`;
    p = [req.user.id];
  }
  res.json((await pool.query(q, p)).rows);
});

app.post('/api/maps', auth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Nur Super-Admins können Karten erstellen' });
  const { name, description } = req.body;
  if (!str(name)) return res.status(400).json({ error: 'Name erforderlich' });
  const r = await pool.query(
    'INSERT INTO maps (name,description,owner_id,share_token) VALUES ($1,$2,$3,$4) RETURNING *',
    [str(name), str(description, 1000), req.user.id, genToken()]);
  res.json(r.rows[0]);
});

app.put('/api/maps/:id', auth, async (req, res) => {
  if (!(await canManage(req.user.id, +req.params.id))) return res.status(403).json({ error: 'Forbidden' });

  // 1. Hier muss default_settings mit aufgenommen werden
  const { 
    name, description, map_scale_label, map_miles_width, 
    travel_miles_per_day, travel_hours_per_day, default_settings 
  } = req.body;

  try {
    const r = await pool.query(
      `UPDATE maps SET 
        name=$1, 
        description=$2, 
        map_scale_label=$3, 
        map_miles_width=$4,
        travel_miles_per_day=$5, 
        travel_hours_per_day=$6, 
        default_settings=$7 
       WHERE id=$8 RETURNING *`,
      [
        str(name), 
        str(description, 1000),
        map_scale_label ? str(map_scale_label, 255) : null,
        map_miles_width != null ? +map_miles_width : null,
        travel_miles_per_day != null ? +travel_miles_per_day : 24,
        travel_hours_per_day != null ? +travel_hours_per_day : 8,
        default_settings ? JSON.stringify(default_settings) : null, // WICHTIG: Als String für Postgres
        +req.params.id
      ]
    );
    
    emit(+req.params.id, 'map:updated', r.rows[0]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Fehler beim Speichern der Map:", err);
    res.status(500).json({ error: 'Speicherfehler' });
  }
});

app.delete('/api/maps/:id', auth, async (req, res) => {
  if (!(await canManage(req.user.id, +req.params.id))) return res.status(403).json({ error: 'Forbidden' });
  await auditLog(req, 'DELETE_MAP', `Karte ${req.params.id} gelöscht`);
  await pool.query('DELETE FROM maps WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

app.post('/api/maps/:id/image', auth, upload.single('image'), async (req, res) => {
  if (!(await canManage(req.user.id, +req.params.id))) return res.status(403).json({ error: 'Forbidden' });
  const imagePath = `/uploads/${req.file.filename}`;
  let w = 2000, h = 2000, thumbPath = null;

  try {
    const d = sizeOf(`/app/uploads/${req.file.filename}`);
    w = d.width; h = d.height;
  } catch { }

  // Convert to WebP + generate thumbnail using sharp if available
  let finalPath = imagePath, finalThumb = null;
  try {
    const sharp = require('sharp');
    const base = req.file.filename.replace(/\.[^.]+$/, '');
    const webpName = base + '.webp';
    const thumbName = 'thumb_' + base + '.webp';

    // Convert full image to WebP
    await sharp(`/app/uploads/${req.file.filename}`)
      .webp({ quality: 85 })
      .toFile(`/app/uploads/${webpName}`);

    // Generate thumbnail (400px wide WebP)
    await sharp(`/app/uploads/${req.file.filename}`)
      .resize(400, null, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(`/app/uploads/${thumbName}`);

    // Re-read dimensions from WebP
    try { const d2 = sizeOf(`/app/uploads/${webpName}`); w = d2.width; h = d2.height; } catch { }

    // Remove original if different filename
    if (webpName !== req.file.filename) {
      try { require('fs').unlinkSync(`/app/uploads/${req.file.filename}`); } catch { }
    }
    finalPath = `/uploads/${webpName}`;
    finalThumb = `/uploads/${thumbName}`;
  } catch { /* sharp not available – skip */ }

  await pool.query(
    'UPDATE maps SET image_path=$1,image_width=$2,image_height=$3,thumb_path=$4 WHERE id=$5',
    [finalPath, w, h, finalThumb, +req.params.id]);
  const r = await pool.query('SELECT * FROM maps WHERE id=$1', [+req.params.id]);
  emit(+req.params.id, 'map:updated', r.rows[0]);
  res.json(r.rows[0]);
});

// Full map data
app.get('/api/maps/:id/data', async (req, res) => {
  const mapId = +req.params.id;
  try {
    const shareToken = req.headers['x-share-token'];
    const groupToken = req.headers['x-group-token'];
    const authHeader = req.headers.authorization;
    let isAdmin = false, limitToGroupId = null;

    if (authHeader) {
      try {
        const u = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        isAdmin = await canManage(u.id, mapId);
      } catch { }
    }

    if (!isAdmin) {
      if (groupToken) {
        const gr = await pool.query('SELECT id FROM groups WHERE share_token=$1 AND map_id=$2', [groupToken, mapId]);
        if (!gr.rows[0]) return res.status(403).json({ error: 'Ungültiger Gruppen-Link' });
        limitToGroupId = gr.rows[0].id;
      } else if (shareToken) {
        const mr = await pool.query('SELECT id FROM maps WHERE id=$1 AND share_token=$2', [mapId, shareToken]);
        if (!mr.rows[0]) return res.status(403).json({ error: 'Ungültiger Map-Link' });
      } else {
        return res.status(403).json({ error: 'Zugriff verweigert' });
      }
    }

    const [map, groups, pois, routes, waypoints, regions, fog] = await Promise.all([
      pool.query('SELECT * FROM maps WHERE id=$1', [mapId]),
      pool.query('SELECT * FROM groups WHERE map_id=$1 ORDER BY order_index,id', [mapId]),
      pool.query('SELECT * FROM pois WHERE map_id=$1', [mapId]),
      pool.query('SELECT * FROM routes WHERE map_id=$1', [mapId]),
      pool.query(`SELECT rw.* FROM route_waypoints rw JOIN routes r ON rw.route_id=r.id
                  WHERE r.map_id=$1 ORDER BY rw.route_id, rw.order_index, rw.id`, [mapId]),
      pool.query('SELECT * FROM regions WHERE map_id=$1', [mapId]),
      pool.query('SELECT * FROM fog_areas WHERE map_id=$1 ORDER BY group_id, id', [mapId])
    ]);

    // Filter items for group-link viewers
    const filterVis = (items) => {
      if (isAdmin) return items; // admin sees all
      return items.filter(x => {
        if (x.visibility === 'hidden') return false;  // hidden: never for viewers
        if (x.visibility === 'public') return true;   // public: always
        if (limitToGroupId === null) return true;      // map-link: all non-hidden groups
        return x.group_id === limitToGroupId;          // group-link: only own group
      });
    };

    const filteredGroups = limitToGroupId !== null
      ? groups.rows.filter(g => g.id === limitToGroupId)
      : (isAdmin ? groups.rows : groups.rows.filter(g => g.visible));

    const filteredPois = filterVis(pois.rows);
    const filteredRoutes = routes.rows.filter(r => {
      if (isAdmin) return true;
      if (r.visibility === 'hidden') return false;
      if (r.visibility === 'public') return true;  // global routes always visible
      return limitToGroupId === null || r.group_id === limitToGroupId;
    });
    const routeIds = new Set(filteredRoutes.map(r => r.id));
    const filteredFog = limitToGroupId !== null
      ? fog.rows.filter(f => f.group_id === limitToGroupId) : fog.rows;

    res.json({
      map: map.rows[0], groups: filteredGroups,
      pois: filteredPois, routes: filteredRoutes,
      waypoints: waypoints.rows.filter(w => routeIds.has(w.route_id)),
      regions: filterVis(regions.rows),
      fog_areas: filteredFog,
      is_admin: isAdmin, limit_group_id: limitToGroupId
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backup
app.get('/api/maps/:id/backup', auth, async (req, res) => {
  if (!(await canManage(req.user.id, +req.params.id))) return res.status(403).json({ error: 'Forbidden' });
  const mid = +req.params.id;
  const [map, groups, pois, routes, waypoints, regions, fog] = await Promise.all([
    pool.query('SELECT * FROM maps WHERE id=$1', [mid]),
    pool.query('SELECT * FROM groups WHERE map_id=$1 ORDER BY order_index', [mid]),
    pool.query('SELECT * FROM pois WHERE map_id=$1', [mid]),
    pool.query('SELECT * FROM routes WHERE map_id=$1', [mid]),
    pool.query(`SELECT rw.* FROM route_waypoints rw JOIN routes r ON rw.route_id=r.id
                WHERE r.map_id=$1 ORDER BY rw.route_id,rw.order_index`, [mid]),
    pool.query('SELECT * FROM regions WHERE map_id=$1', [mid]),
    pool.query('SELECT * FROM fog_areas WHERE map_id=$1 ORDER BY group_id, id', [mid])
  ]);
  const safeName = (map.rows[0]?.name || 'map').replace(/[^a-z0-9]/gi, '_');
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="worldmap_${safeName}_${date}.json"`);
  res.json({
    version: '2.1', exported_at: new Date().toISOString(),
    map: map.rows[0], groups: groups.rows, pois: pois.rows,
    routes: routes.rows, waypoints: waypoints.rows, regions: regions.rows, fog_areas: fog.rows
  });
});

// Backup-restore
app.post('/api/maps/:id/restore', auth, memoryUpload.single('backup'), async (req, res) => {
  const mid = +req.params.id;

  if (!(await canManage(req.user.id, mid))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei empfangen.' });
  }

  const client = await pool.connect();
  try {
    const data = JSON.parse(req.file.buffer.toString());
    await client.query('BEGIN');

    // 1. Bestehende Daten löschen (Reihenfolge wegen Foreign Keys!)
    await client.query('DELETE FROM fog_areas WHERE map_id = $1', [mid]);
    await client.query('DELETE FROM regions WHERE map_id = $1', [mid]);
    await client.query('DELETE FROM route_waypoints WHERE route_id IN (SELECT id FROM routes WHERE map_id = $1)', [mid]);
    await client.query('DELETE FROM routes WHERE map_id = $1', [mid]);
    await client.query('DELETE FROM pois WHERE map_id = $1', [mid]);
    await client.query('DELETE FROM groups WHERE map_id = $1', [mid]);

    // 2. Map-Metadaten (Anpassung an init.sql: kein 'config'-Feld)
// 2. Map-Metadaten (Inklusive default_settings)
    if (data.map) {
      await client.query(
        `UPDATE maps SET 
          name=$1, 
          description=$2, 
          map_scale_label=$3, 
          map_miles_width=$4, 
          travel_miles_per_day=$5, 
          travel_hours_per_day=$6,
          default_settings=$7 
         WHERE id=$8`,
        [
          str(data.map.name), 
          str(data.map.description, 1000),
          data.map.map_scale_label, 
          data.map.map_miles_width,
          data.map.travel_miles_per_day || 24, 
          data.map.travel_hours_per_day || 8,
          // Wenn default_settings im Backup existiert, als JSON speichern, sonst null
          data.map.default_settings ? JSON.stringify(data.map.default_settings) : null,
          mid
        ]
      );
    }

    // 3. Gruppen (mit JSONB für external_links)
    for (const g of data.groups) {
      await client.query(
        `INSERT INTO groups (id, map_id, name, color, visible, fog_of_war_enabled, order_index, external_links, share_token) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [g.id, mid, str(g.name), g.color, bool(g.visible), bool(g.fog_of_war_enabled), g.order_index, JSON.stringify(g.external_links || []), g.share_token]
      );
    }

    // 4. POIs (lat/lng statt x/y laut init.sql)
    for (const p of data.pois) {
      await client.query(
        `INSERT INTO pois (id, map_id, group_id, name, description, lat, lng, icon, color, bg_transparent, links, visibility) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [p.id, mid, p.group_id, str(p.name), str(p.description), num(p.lat), num(p.lng), p.icon, p.color, !!p.bg_transparent, JSON.stringify(p.links || []), p.visibility]
      );
    }

    // 5. Routes
    for (const r of data.routes) {
      await client.query(
        `INSERT INTO routes (id, map_id, group_id, name, description, color, weight, line_style, smooth, visibility) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [r.id, mid, r.group_id, str(r.name), str(r.description), r.color, r.weight, r.line_style, bool(r.smooth), r.visibility]
      );
    }

    // 6. Waypoints (lat/lng statt x/y)
    for (const w of data.waypoints) {
      await client.query(
        `INSERT INTO route_waypoints (id, route_id, lat, lng, title, info, order_index) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [w.id, w.route_id, num(w.lat), num(w.lng), str(w.title), str(w.info), w.order_index]
      );
    }

    // 7. Regions (coordinates statt path)
    for (const reg of data.regions) {
      await client.query(
        `INSERT INTO regions (id, map_id, group_id, name, description, coordinates, color, fill_opacity, stroke_opacity, visibility) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [reg.id, mid, reg.group_id, str(reg.name), str(reg.description), JSON.stringify(reg.coordinates || []), reg.color, reg.fill_opacity, reg.stroke_opacity, reg.visibility]
      );
    }

    // 8. Fog Areas (coordinates statt path)
    for (const f of data.fog_areas) {
      await client.query(
        `INSERT INTO fog_areas (id, map_id, group_id, name, coordinates) VALUES ($1, $2, $3, $4, $5)`,
        [f.id, mid, f.group_id, str(f.name), JSON.stringify(f.coordinates || [])]
      );
    }

    // 9. SEQUENZEN UPDATEN (Damit IDs nach dem Import weiterlaufen)
    const tables = ['groups', 'pois', 'routes', 'route_waypoints', 'regions', 'fog_areas'];
    for (const table of tables) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Restore erfolgreich' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Restore Error:', err);
    res.status(500).json({ error: 'Fehler beim Einspielen des Backups: ' + err.message });
  } finally {
    client.release();
  }
});

// Map admins
app.get('/api/maps/:id/admins', auth, async (req, res) => {
  if (!(await canManage(req.user.id, +req.params.id))) return res.status(403).json({ error: 'Forbidden' });
  const r = await pool.query(
    'SELECT u.id,u.username FROM users u JOIN map_admins ma ON u.id=ma.user_id WHERE ma.map_id=$1',
    [+req.params.id]);
  res.json(r.rows);
});

app.post('/api/maps/:id/admins', auth, async (req, res) => {
  if (!(await canManage(req.user.id, +req.params.id))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('INSERT INTO map_admins (map_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [+req.params.id, +req.body.user_id]);
  res.json({ success: true });
});

app.delete('/api/maps/:id/admins/:uid', auth, async (req, res) => {
  if (!(await canManage(req.user.id, +req.params.id))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM map_admins WHERE map_id=$1 AND user_id=$2', [+req.params.id, +req.params.uid]);
  res.json({ success: true });
});

// ── GROUPS ─────────────────────────────────────────────────────────────
app.post('/api/maps/:mid/groups', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { name, color, fog_of_war_enabled, external_links } = req.body;
  if (!str(name)) return res.status(400).json({ error: 'Name erforderlich' });
  const r = await pool.query(
    'INSERT INTO groups (map_id,name,color,fog_of_war_enabled,external_links,share_token) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [mid, str(name), str(color || '#3b82f6', 50), bool(fog_of_war_enabled),
      JSON.stringify(arr(external_links)), genToken()]);
  emit(mid, 'group:created', r.rows[0]);
  res.json(r.rows[0]);
});

app.put('/api/maps/:mid/groups/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { name, color, visible, fog_of_war_enabled, external_links } = req.body;
  const r = await pool.query(
    'UPDATE groups SET name=$1,color=$2,visible=$3,fog_of_war_enabled=$4,external_links=$5 WHERE id=$6 AND map_id=$7 RETURNING *',
    [str(name), str(color || '#3b82f6', 50), bool(visible !== false),
    bool(fog_of_war_enabled), JSON.stringify(arr(external_links)), +req.params.id, mid]);
  emit(mid, 'group:updated', r.rows[0]);
  res.json(r.rows[0]);
});

app.delete('/api/maps/:mid/groups/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM groups WHERE id=$1 AND map_id=$2', [+req.params.id, mid]);
  emit(mid, 'group:deleted', { id: +req.params.id });
  res.json({ success: true });
});

// ── POIS ───────────────────────────────────────────────────────────────
const visCheck = v => ['public', 'group', 'hidden'].includes(v) ? v : 'group';

app.post('/api/maps/:mid/pois', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { group_id, name, description, lat, lng, icon, color, links, visibility, bg_transparent } = req.body;
  const r = await pool.query(
    `INSERT INTO pois (map_id,group_id,name,description,lat,lng,icon,color,links,visibility,bg_transparent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [mid, group_id ? +group_id : null, str(name), str(description, 2000),
      num(lat), num(lng), str(icon || 'circle', 50), str(color || '#3b82f6', 50),
      JSON.stringify(arr(links)), visCheck(visibility), !!bg_transparent]);
  await auditLog(req, 'CREATE_POI', `POI '${req.body.name}' in Karte ${req.params.mid}`);
  emit(mid, 'poi:created', r.rows[0]);
  res.json(r.rows[0]);
});

app.put('/api/maps/:mid/pois/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { group_id, name, description, lat, lng, icon, color, links, visibility, bg_transparent } = req.body;
  const r = await pool.query(
    `UPDATE pois SET group_id=$1,name=$2,description=$3,lat=$4,lng=$5,icon=$6,color=$7,links=$8,visibility=$9,bg_transparent=$10
     WHERE id=$11 AND map_id=$12 RETURNING *`,
    [group_id ? +group_id : null, str(name), str(description, 2000),
    num(lat), num(lng), str(icon || 'circle', 50), str(color || '#3b82f6', 50),
    JSON.stringify(arr(links)), visCheck(visibility), !!bg_transparent, +req.params.id, mid]);
  emit(mid, 'poi:updated', r.rows[0]);
  res.json(r.rows[0]);
});

app.delete('/api/maps/:mid/pois/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM pois WHERE id=$1 AND map_id=$2', [+req.params.id, mid]);
  await auditLog(req, 'DELETE_POI', `POI ${req.params.id} in Karte ${req.params.mid}`);
  emit(mid, 'poi:deleted', { id: +req.params.id });
  res.json({ success: true });
});

// ── ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/maps/:mid/routes', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { group_id, name, description, color, weight, line_style, smooth, visibility } = req.body;
  if (!str(name)) return res.status(400).json({ error: 'Name erforderlich' });
  const vis = ['public', 'group', 'hidden'].includes(visibility) ? visibility : 'group';
  const gid = (vis === 'group' && group_id) ? +group_id : null;
  const r = await pool.query(
    `INSERT INTO routes (map_id,group_id,name,description,color,weight,line_style,smooth,visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [mid, gid, str(name), str(description, 2000),
      str(color || '#ef4444', 50), num(weight, 3),
      ['solid', 'dashed', 'dotted'].includes(line_style) ? line_style : 'solid',
      bool(smooth !== false), vis]);
  emit(mid, 'route:created', { ...r.rows[0], waypoints: [] });
  res.json(r.rows[0]);
});

app.put('/api/maps/:mid/routes/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { group_id, name, description, color, weight, line_style, smooth, visibility } = req.body;
  const vis = ['public', 'group', 'hidden'].includes(visibility) ? visibility : 'group';
  const gid = (vis === 'group' && group_id) ? +group_id : null;
  const r = await pool.query(
    `UPDATE routes SET group_id=$1,name=$2,description=$3,color=$4,weight=$5,line_style=$6,smooth=$7,visibility=$8
     WHERE id=$9 AND map_id=$10 RETURNING *`,
    [gid, str(name), str(description, 2000),
      str(color || '#ef4444', 50), num(weight, 3),
      ['solid', 'dashed', 'dotted'].includes(line_style) ? line_style : 'solid',
      bool(smooth !== false), vis, +req.params.id, mid]);
  const wps = await pool.query('SELECT * FROM route_waypoints WHERE route_id=$1 ORDER BY order_index,id', [+req.params.id]);
  emit(mid, 'route:updated', { ...r.rows[0], waypoints: wps.rows });
  res.json(r.rows[0]);
});

app.delete('/api/maps/:mid/routes/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM routes WHERE id=$1 AND map_id=$2', [+req.params.id, mid]);
  emit(mid, 'route:deleted', { id: +req.params.id });
  res.json({ success: true });
});

// WAYPOINTS – FIX: use MAX(order_index)+1 so new waypoints always go at end
app.post('/api/maps/:mid/routes/:rid/waypoints', auth, async (req, res) => {
  const mid = +req.params.mid, rid = +req.params.rid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { lat, lng, title, info, order_index } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // If a specific order_index is requested, use it (fractional = insert before)
    let targetIdx;
    if (order_index !== undefined && order_index !== null) {
      targetIdx = +order_index;
    } else {
      const r = await client.query('SELECT COALESCE(MAX(order_index),-1)+1 AS nxt FROM route_waypoints WHERE route_id=$1', [rid]);
      targetIdx = r.rows[0].nxt;
    }
    await client.query(
      'INSERT INTO route_waypoints (route_id,lat,lng,title,info,order_index) VALUES ($1,$2,$3,$4,$5,$6)',
      [rid, num(lat), num(lng), str(title || '', 255), str(info || '', 2000), targetIdx]);
    // Renumber all waypoints sequentially to clean up fractional indices
    const all = await client.query('SELECT id FROM route_waypoints WHERE route_id=$1 ORDER BY order_index, id', [rid]);
    for (let i = 0; i < all.rows.length; i++) {
      await client.query('UPDATE route_waypoints SET order_index=$1 WHERE id=$2', [i, all.rows[i].id]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  const rows = await emitWaypoints(mid, rid);
  res.json(rows[rows.length - 1]);
});

app.put('/api/maps/:mid/routes/:rid/waypoints/:wid', auth, async (req, res) => {
  const mid = +req.params.mid, rid = +req.params.rid, wid = +req.params.wid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  // Preserve the existing order_index – do NOT let client change it via this endpoint
  const cur = await pool.query('SELECT order_index FROM route_waypoints WHERE id=$1 AND route_id=$2', [wid, rid]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'Waypoint not found' });
  await pool.query(
    'UPDATE route_waypoints SET lat=$1,lng=$2,title=$3,info=$4 WHERE id=$5 AND route_id=$6',
    [num(req.body.lat), num(req.body.lng), str(req.body.title || '', 255), str(req.body.info || '', 2000), wid, rid]);
  await emitWaypoints(mid, rid);
  res.json({ success: true });
});

app.delete('/api/maps/:mid/routes/:rid/waypoints/:wid', auth, async (req, res) => {
  const mid = +req.params.mid, rid = +req.params.rid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM route_waypoints WHERE id=$1 AND route_id=$2', [+req.params.wid, rid]);
  // Re-number remaining waypoints to keep sequential order
  const remaining = await pool.query('SELECT id FROM route_waypoints WHERE route_id=$1 ORDER BY order_index,id', [rid]);
  for (let i = 0; i < remaining.rows.length; i++) {
    await pool.query('UPDATE route_waypoints SET order_index=$1 WHERE id=$2', [i, remaining.rows[i].id]);
  }
  await emitWaypoints(mid, rid);
  res.json({ success: true });
});

// Bulk replace waypoints
app.put('/api/maps/:mid/routes/:rid/waypoints', auth, async (req, res) => {
  const mid = +req.params.mid, rid = +req.params.rid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const wps = arr(req.body.waypoints);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM route_waypoints WHERE route_id=$1', [rid]);
    for (let i = 0; i < wps.length; i++) {
      const w = wps[i];
      await client.query(
        'INSERT INTO route_waypoints (route_id,lat,lng,title,info,order_index) VALUES ($1,$2,$3,$4,$5,$6)',
        [rid, num(w.lat), num(w.lng), str(w.title || '', 255), str(w.info || '', 2000), i]);
    }
    await client.query('COMMIT');
    const rows = await emitWaypoints(mid, rid);
    res.json(rows);
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ── REGIONS ─────────────────────────────────────────────────────────────
app.post('/api/maps/:mid/regions', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { group_id, name, description, coordinates, color, fill_opacity, stroke_opacity, visibility } = req.body;
  const r = await pool.query(
    `INSERT INTO regions (map_id,group_id,name,description,coordinates,color,fill_opacity,stroke_opacity,visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [mid, group_id ? +group_id : null, str(name), str(description, 2000),
      JSON.stringify(arr(coordinates)), str(color || '#22c55e', 50),
      num(fill_opacity, 0.2), num(stroke_opacity, 0.8), visCheck(visibility)]);
  emit(mid, 'region:created', r.rows[0]);
  res.json(r.rows[0]);
});

app.put('/api/maps/:mid/regions/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { group_id, name, description, coordinates, color, fill_opacity, stroke_opacity, visibility } = req.body;
  const r = await pool.query(
    `UPDATE regions SET group_id=$1,name=$2,description=$3,coordinates=$4,color=$5,fill_opacity=$6,stroke_opacity=$7,visibility=$8
     WHERE id=$9 AND map_id=$10 RETURNING *`,
    [group_id ? +group_id : null, str(name), str(description, 2000),
    JSON.stringify(arr(coordinates)), str(color || '#22c55e', 50),
    num(fill_opacity, 0.2), num(stroke_opacity, 0.8), visCheck(visibility),
    +req.params.id, mid]);
  emit(mid, 'region:updated', r.rows[0]);
  res.json(r.rows[0]);
});

app.delete('/api/maps/:mid/regions/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM regions WHERE id=$1 AND map_id=$2', [+req.params.id, mid]);
  emit(mid, 'region:deleted', { id: +req.params.id });
  res.json({ success: true });
});

// ── FOG AREAS (polygon-based revealed zones per group) ───────────────────
// List all fog areas for a group
app.get('/api/maps/:mid/fog/:gid/areas', async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM fog_areas WHERE map_id=$1 AND group_id=$2 ORDER BY id',
    [+req.params.mid, +req.params.gid]);
  res.json(r.rows);
});

// Create a new fog area
app.post('/api/maps/:mid/fog/:gid/areas', auth, async (req, res) => {
  const mid = +req.params.mid, gid = +req.params.gid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const { name, coordinates } = req.body;
  const coords = arr(coordinates).map(p => ({ lat: num(p.lat ?? p[0]), lng: num(p.lng ?? p[1]) }));
  if (coords.length < 3) return res.status(400).json({ error: 'Mindestens 3 Punkte erforderlich' });
  const r = await pool.query(
    'INSERT INTO fog_areas (map_id, group_id, name, coordinates) VALUES ($1,$2,$3,$4) RETURNING *',
    [mid, gid, str(name || 'Bereich', 255), JSON.stringify(coords)]);
  emit(mid, 'fog:area:created', r.rows[0]);
  res.json(r.rows[0]);
});

// Delete a fog area
app.delete('/api/maps/:mid/fog/areas/:id', auth, async (req, res) => {
  const mid = +req.params.mid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  const r = await pool.query(
    'DELETE FROM fog_areas WHERE id=$1 AND map_id=$2 RETURNING group_id', [+req.params.id, mid]);
  if (r.rows[0]) emit(mid, 'fog:area:deleted', { id: +req.params.id, group_id: r.rows[0].group_id });
  res.json({ success: true });
});

// Delete all fog areas for a group
app.delete('/api/maps/:mid/fog/:gid/areas', auth, async (req, res) => {
  const mid = +req.params.mid, gid = +req.params.gid;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM fog_areas WHERE map_id=$1 AND group_id=$2', [mid, gid]);
  emit(mid, 'fog:group:cleared', { group_id: gid });
  res.json({ success: true });
});

// ── SOCKET.IO ────────────────────────────────────────────────────────────
async function getRoomSize(mapId) {
  const sockets = await io.in(`map:${mapId}`).fetchSockets();
  return sockets.length;
}

io.on('connection', socket => {
  socket.on('join:map', async ({ mapId, isEditor }) => {
    socket.join(`map:${mapId}`);
    socket._mapId = mapId;
    socket._isEditor = !!isEditor;
    const count = await getRoomSize(mapId);
    io.to(`map:${mapId}`).emit('viewers:update', { count });
  });
  socket.on('leave:map', async ({ mapId }) => {
    socket.leave(`map:${mapId}`);
    const count = await getRoomSize(mapId);
    io.to(`map:${mapId}`).emit('viewers:update', { count });
  });
  socket.on('disconnect', async () => {
    const mapId = socket._mapId;
    if (!mapId) return;
    // Give a tick for the socket to leave the room
    setTimeout(async () => {
      const count = await getRoomSize(mapId);
      io.to(`map:${mapId}`).emit('viewers:update', { count });
    }, 100);
  });
  // Ping/highlight relay: editor pings a feature, all viewers get it
  socket.on('feature:ping', (data) => {
    const mapId = socket._mapId;
    if (mapId) io.to(`map:${mapId}`).emit('feature:ping', data);
  });
});


// ── MAP LOCKING (editor can lock map, admin warned, editor notified) ──────
// Map live stats (viewers/editors from socket rooms + file size)
app.get('/api/maps/:id/stats', async (req, res) => {
  const mid = +req.params.id;
  try {
    const mapR = await pool.query('SELECT image_path, thumb_path FROM maps WHERE id=$1', [mid]);
    const m = mapR.rows[0];
    let fileSize = null;
    if (m?.image_path) {
      try {
        const fs = require('fs');
        const fp = '/app' + m.image_path;
        const st = fs.statSync(fp);
        fileSize = st.size;
      } catch { }
    }
    // Socket room viewer count
    const sockets = await io.in(`map:${mid}`).fetchSockets();
    const editors = sockets.filter(s => s._isEditor).length;
    const viewers = sockets.filter(s => !s._isEditor).length;
    res.json({ viewers, editors, fileSize });
  } catch (e) { res.json({ viewers: 0, editors: 0, fileSize: null }); }
});

app.get('/api/maps/:id/lock', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT m.locked_by_editor, m.locked_at, u.username AS locked_by_name
     FROM maps m LEFT JOIN users u ON m.locked_by_editor=u.id WHERE m.id=$1`, [+req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows[0]);
});

app.post('/api/maps/:id/lock', auth, async (req, res) => {
  const mid = +req.params.id;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  // Only non-superadmin editors can lock
  if (req.user.is_superadmin) return res.status(400).json({ error: 'Superadmins cannot lock maps' });
  await pool.query(
    'UPDATE maps SET locked_by_editor=$1, locked_at=NOW() WHERE id=$2',
    [req.user.id, mid]);
  emit(mid, 'map:locked', { locked_by: req.user.id, locked_by_name: req.user.username, locked_at: new Date() });
  res.json({ success: true });
});

app.delete('/api/maps/:id/lock', auth, async (req, res) => {
  const mid = +req.params.id;
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('UPDATE maps SET locked_by_editor=NULL, locked_at=NULL WHERE id=$1', [mid]);
  emit(mid, 'map:unlocked', {});
  res.json({ success: true });
});

app.post('/api/maps/:id/admin-peek', auth, async (req, res) => {
  const mid = +req.params.id;
  // Admin notifies editor they are peeking at the locked map
  if (!(await canManage(req.user.id, mid))) return res.status(403).json({ error: 'Forbidden' });
  emit(mid, 'map:admin-peek', { admin_name: req.user.username, at: new Date() });
  res.json({ success: true });
});

// ── CUSTOM POI ICONS (global=superadmin, scoped=editors) ─────────────────
app.get('/api/icons', async (req, res) => {
  // Public: return all icons so everyone can see custom map markers
  const r = await pool.query('SELECT * FROM custom_poi_icons ORDER BY owner_id NULLS FIRST, sort_order, id');
  res.json(r.rows);
});

app.post('/api/icons', auth, async (req, res) => {
  const { name, image_url, sort_order } = req.body;
  if (!str(name) || !str(image_url)) return res.status(400).json({ error: 'Name und URL erforderlich' });
  // Superadmin: global (owner_id=NULL), others: scoped to their user
  const ownerId = req.user.is_superadmin ? null : req.user.id;
  const storedName = req.user.is_superadmin
    ? str(name, 255)
    : str(req.user.username + '_' + name, 255);
  const r = await pool.query(
    'INSERT INTO custom_poi_icons (owner_id, name, image_url, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
    [ownerId, storedName, str(image_url, 1000), num(sort_order, 0)]);
  res.json(r.rows[0]);
});

app.put('/api/icons/:id', auth, async (req, res) => {
  const { name, image_url, sort_order } = req.body;
  const iconId = +req.params.id;

  const iconRes = await pool.query('SELECT * FROM custom_poi_icons WHERE id=$1', [iconId]);
  const icon = iconRes.rows[0];

  if (!icon) return res.status(404).json({ error: 'Not found' });

  // Berechtigung prüfen: Admin darf alles, User nur eigene
  if (!req.user.is_superadmin && icon.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  let storedName;
  if (icon.owner_id === null) {
    // Globales Icon bleibt global (nur Admin kommt hierhin)
    storedName = str(name, 255);
  } else {
    // User-Icon: Wir müssen den richtigen Präfix finden. 
    // Wenn ein Admin editiert, nutzen wir den Namen des ursprünglichen Besitzers.
    // Dazu müssten wir den Owner-Namen laden, ODER wir behalten die Logik bei:
    const ownerRes = await pool.query('SELECT username FROM users WHERE id=$1', [icon.owner_id]);
    const ownerName = ownerRes.rows[0]?.username || 'user';

    // Falls der Name schon den Präfix hat, nicht doppelt hinzufügen
    const prefix = ownerName + '_';
    storedName = name.startsWith(prefix) ? str(name, 255) : str(prefix + name, 255);
  }

  const r = await pool.query(
    'UPDATE custom_poi_icons SET name=$1, image_url=$2, sort_order=$3 WHERE id=$4 RETURNING *',
    [storedName, str(image_url, 1000), num(sort_order, 0), iconId]
  );
  res.json(r.rows[0]);
});

app.delete('/api/icons/:id', auth, async (req, res) => {
  const icon = (await pool.query('SELECT * FROM custom_poi_icons WHERE id=$1', [+req.params.id])).rows[0];
  if (!icon) return res.status(404).json({ error: 'Not found' });
  if (!req.user.is_superadmin && icon.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM custom_poi_icons WHERE id=$1', [+req.params.id]);
  res.json({ success: true });
});

// ── AUDIT LOGGING ────────────────────────────────────────────────────────
// Logs to PostgreSQL audit_log table; X-Forwarded-For for Traefik-behind setups
async function auditLog(req, action, detail = '') {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || 'unknown';
  const username = req.user?.username || 'anonymous';
  try {
    await pool.query(
      'INSERT INTO audit_log (username, ip, action, detail) VALUES ($1,$2,$3,$4)',
      [username, ip, action, detail]);
  } catch { /* non-fatal */ }
}


// ── CHANGELOG ────────────────────────────────────────────────────────────
const CHANGELOG_PATH = '/app/changelog.html';
const fsMod = require('fs');

app.get('/api/changelog', (req, res) => {
  try {
    const html = fsMod.existsSync(CHANGELOG_PATH) ? fsMod.readFileSync(CHANGELOG_PATH, 'utf8') : '';
    res.json({ html });
  } catch { res.json({ html: '' }); }
});

app.put('/api/changelog', auth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Forbidden' });
  const html = req.body.html || '';
  try {
    fsMod.writeFileSync(CHANGELOG_PATH, html, 'utf8');
    await auditLog(req, 'UPDATE_CHANGELOG', 'Changelog aktualisiert');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── AUDIT LOG VIEWER ─────────────────────────────────────────────────────
app.get('/api/audit-log', auth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'Forbidden' });
  const { search = '', limit = 200, offset = 0 } = req.query;
  const lim = Math.min(+limit || 200, 500);
  const off = +offset || 0;
  let rows, total;
  if (search.trim()) {
    const s = `%${search.trim()}%`;
    rows = (await pool.query(
      `SELECT * FROM audit_log WHERE username ILIKE $1 OR action ILIKE $1 OR detail ILIKE $1 OR ip ILIKE $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [s, lim, off])).rows;
    total = +(await pool.query(
      `SELECT COUNT(*) FROM audit_log WHERE username ILIKE $1 OR action ILIKE $1 OR detail ILIKE $1 OR ip ILIKE $1`, [s]
    )).rows[0].count;
  } else {
    rows = (await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2', [lim, off])).rows;
    total = +(await pool.query('SELECT COUNT(*) FROM audit_log')).rows[0].count;
  }
  res.json({ rows, total });
});

// ── STARTUP ──────────────────────────────────────────────────────────────
const waitForDB = async () => {
  for (let i = 0; i < 30; i++) {
    try { await pool.query('SELECT 1'); console.log('✓ DB connected'); return; }
    catch { console.log(`  DB not ready (${i + 1}/30)…`); await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('Database timeout');
};

waitForDB().then(() => server.listen(PORT, () => console.log(`✓ Server on :${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
