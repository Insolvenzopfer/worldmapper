// ── Auth guard ─────────────────────────────────────────────────────────
if (!API.token()) window.location.href = '/index.html';
const ME = API.user();

document.getElementById('currentUser').textContent = '👤 ' + ME.username;
// Icons accessible by all users; Users+CreateMap only for superadmin
document.getElementById('iconsBtn').classList.remove('hidden');
document.getElementById('iconsBtn').addEventListener('click', openIconsModal);
if (ME.is_superadmin) {
  document.getElementById('usersBtn').classList.remove('hidden');
  document.getElementById('usersBtn').addEventListener('click', openUsersModal);
  document.getElementById('logsBtn').classList.remove('hidden');
  document.getElementById('logsBtn').addEventListener('click', () => openAuditModal());
  document.getElementById('createMapBtn').classList.remove('hidden');
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(s) { return String(s ?? '').replace(/'/g, "\\'"); }

// ── Maps ───────────────────────────────────────────────────────────────
let allMaps = [];

async function forceUnlockMap(mapId) {
  if (!confirm('Sperre aufheben?')) return;
  try {
    await API.delete(`/api/maps/${mapId}/lock`);
    await loadMaps();
    showToast('Sperre aufgehoben', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function loadMaps() {
  try {
    allMaps = await API.get('/api/maps');
    renderMaps();
  } catch (e) { showToast(e.message, 'error'); }
}

function renderMaps() {
  const grid = document.getElementById('mapsGrid');
  if (!allMaps.length) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🗺️</div>
      <p>${ME.is_superadmin
        ? 'Noch keine Karten vorhanden. Erstelle deine erste Welt!'
        : 'Dir wurden noch keine Karten zugewiesen.'}</p>
    </div>`;
    return;
  }
  grid.innerHTML = allMaps.map(m => {
    const locked = !!m.locked_by_editor;
    const lockedBy = m.locked_by_name ? escHtml(m.locked_by_name) : '';
    const lockBadge = locked
      ? `<span class="lock-badge">🔒 ${lockedBy ? 'von ' + lockedBy : 'Gesperrt'}</span>`
      : '';
    return `<div class="map-card${locked ? ' map-card-locked' : ''}">
      <div class="map-card-img">
        ${m.image_path
          ? `<img src="${m.thumb_path || m.image_path}" alt="${escHtml(m.name)}" loading="lazy">`
          : '<span class="no-img">🗺️</span>'}
      </div>
      <div class="map-card-body">
        <div class="map-card-title">${escHtml(m.name)} ${lockBadge}</div>
        <div class="map-card-desc">${escHtml(m.description || 'Keine Beschreibung')}</div>
        <div id="stats-${m.id}" style="font-size:11px;color:var(--text-dim);margin-bottom:.4rem"></div>
        <div class="map-card-actions">
          <a href="/map.html?id=${m.id}" class="btn btn-primary btn-sm">🗺️ Öffnen</a>
          <button class="btn btn-ghost btn-sm" onclick="openSettings(${m.id})">⚙️ Einstellungen</button>
          <button class="btn btn-ghost btn-sm" onclick="editMap(${m.id})">✏️</button>
          ${locked && ME.is_superadmin
            ? `<button class="btn btn-ghost btn-sm" style="color:#fca5a5" onclick="forceUnlockMap(${m.id})" title="Sperre aufheben">🔓</button>`
            : ''}
          <button class="btn btn-danger btn-sm" onclick="deleteMap(${m.id},'${escAttr(m.name)}')" style="margin-left:auto">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Create
document.getElementById('createMapBtn').addEventListener('click', () => {
  document.getElementById('mapId').value    = '';
  document.getElementById('mapName').value  = '';
  document.getElementById('mapDesc').value  = '';
  document.getElementById('mapModalTitle').textContent = 'Neue Karte erstellen';
  openModal('mapModal');
});

// Edit
function editMap(id) {
  const m = allMaps.find(x => x.id === id);
  if (!m) return;
  document.getElementById('mapId').value    = m.id;
  document.getElementById('mapName').value  = m.name;
  document.getElementById('mapDesc').value  = m.description || '';
  document.getElementById('mapModalTitle').textContent = 'Karte bearbeiten';
  openModal('mapModal');
}

document.getElementById('mapForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id   = document.getElementById('mapId').value;
  const body = {
    name:        document.getElementById('mapName').value,
    description: document.getElementById('mapDesc').value
  };
  // Preserve scale fields if map already exists
  if (id) {
    const existing = allMaps.find(m => m.id === +id);
    if (existing) {
      body.map_scale_label      = existing.map_scale_label      ?? null;
      body.map_miles_width      = existing.map_miles_width      ?? null;
      body.travel_miles_per_day = existing.travel_miles_per_day ?? 24;
      body.travel_hours_per_day = existing.travel_hours_per_day ?? 8;
    }
  }
  try {
    if (id) await API.put(`/api/maps/${id}`, body);
    else     await API.post('/api/maps', body);
    closeModal('mapModal');
    await loadMaps();
    showToast(id ? 'Karte aktualisiert' : 'Karte erstellt', 'success');
  } catch (e) { showToast(e.message, 'error'); }
});

async function deleteMap(id, name) {
  if (!confirm(`Karte „${name}" wirklich löschen?\nAlle Gruppen, POIs, Routen und Regionen werden entfernt.`)) return;
  try { await API.delete(`/api/maps/${id}`); await loadMaps(); showToast('Karte gelöscht'); }
  catch (e) { showToast(e.message, 'error'); }
}

// ── Settings modal ──────────────────────────────────────────────────────
let settingsMapId = null;

async function openSettings(id) {
  settingsMapId = id;
  const m = allMaps.find(x => x.id === id);
  document.getElementById('settingsTitle').textContent = `⚙️ ${m.name}`;
  document.getElementById('settingsMapId').value = id;

  // Image preview
  const prev = document.getElementById('currentImagePreview');
  prev.innerHTML = m.image_path
    ? `<img src="${m.image_path}" alt="Kartenbild">`
    : '<p style="padding:.7rem;color:var(--text-dim);font-size:13px">Noch kein Bild hochgeladen</p>';

  // Map share link
  document.getElementById('shareUrlMap').value = `${location.origin}/map.html?t=${m.share_token}`;

  // Scale & travel fields
  document.getElementById('mapScaleLabel').value  = m.map_scale_label  || '';
  document.getElementById('mapMilesWidth').value  = m.map_miles_width  != null ? m.map_miles_width  : '';
  document.getElementById('mapMilesPerDay').value = m.travel_miles_per_day != null ? m.travel_miles_per_day : 24;
  document.getElementById('mapHoursPerDay').value = m.travel_hours_per_day != null ? m.travel_hours_per_day : 8;
  document.getElementById('scaleMsg').style.display = 'none';

  // Reset group links placeholder
  document.getElementById('groupShareLinks').innerHTML =
    '<p class="hint" style="color:var(--text-dim)">Lädt…</p>';

  // Activate first tab
  document.querySelectorAll('#settingsModal .tab-btn')[0].click();
  openModal('settingsModal');

  // Load in background
  loadGroupShareLinks(id);
  loadEditors(id);
}

async function loadGroupShareLinks(mapId) {
  try {
    const r    = await fetch(`/api/maps/${mapId}/data`, {
      headers: { Authorization: `Bearer ${API.token()}` }
    });
    const data = await r.json();
    const gs   = data.groups || [];
    const el   = document.getElementById('groupShareLinks');
    if (!gs.length) { el.innerHTML = '<p class="hint">Noch keine Gruppen angelegt.</p>'; return; }
    el.innerHTML = gs.map(g => `
      <div style="margin-bottom:.8rem">
        <div style="display:flex;align-items:center;gap:.45rem;margin-bottom:.3rem">
          <span style="width:10px;height:10px;border-radius:50%;background:${g.color};display:inline-block;flex-shrink:0"></span>
          <strong style="font-size:13px">${escHtml(g.name)}</strong>
        </div>
        <div class="share-url-box">
          <input type="text" value="${location.origin}/map.html?t=${g.share_token}" readonly id="gsl${g.id}">
          <button class="btn btn-primary btn-sm" onclick="copyUrl('gsl${g.id}')">Kopieren</button>
        </div>
      </div>`).join('');
  } catch {}
}

function copyUrl(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  navigator.clipboard.writeText(el.value)
    .then(() => showToast('Link kopiert!', 'success'))
    .catch(() => { el.select(); document.execCommand('copy'); showToast('Link kopiert!', 'success'); });
}

// Backup download
async function downloadBackup() {
  try {
    const res = await fetch(`/api/maps/${settingsMapId}/backup`, {
      headers: { Authorization: `Bearer ${API.token()}` }
    });
    if (!res.ok) throw new Error('Backup fehlgeschlagen');
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') || '';
    const name = cd.match(/filename="([^"]+)"/)?.[1] || 'backup.json';
    const a    = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    URL.revokeObjectURL(a.href);
    showToast('Backup heruntergeladen', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// Save scale & travel settings
async function saveMapScale() {
  const m = allMaps.find(x => x.id === settingsMapId);
  if (!m) return;
  try {
    await API.put(`/api/maps/${settingsMapId}`, {
      name:                 m.name,
      description:          m.description || '',
      map_scale_label:      document.getElementById('mapScaleLabel').value.trim() || null,
      map_miles_width:      parseFloat(document.getElementById('mapMilesWidth').value) || null,
      travel_miles_per_day: parseFloat(document.getElementById('mapMilesPerDay').value) || 24,
      travel_hours_per_day: parseFloat(document.getElementById('mapHoursPerDay').value) || 8
    });
    await loadMaps();  // refresh allMaps so values are current
    const msg = document.getElementById('scaleMsg');
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 2500);
  } catch (e) { showToast(e.message, 'error'); }
}

// Image upload
async function uploadImage() {
  const file = document.getElementById('imageUpload').files[0];
  if (!file) return;
  const prog = document.getElementById('uploadProgress');
  const fill = document.getElementById('progressFill');
  const txt  = document.getElementById('progressText');
  prog.classList.remove('hidden');
  try {
    const result = await API.upload(
      `/api/maps/${settingsMapId}/image`, file,
      p => { fill.style.width = Math.round(p * 100) + '%'; txt.textContent = Math.round(p * 100) + '%'; }
    );
    document.getElementById('currentImagePreview').innerHTML = `<img src="${result.image_path}">`;
    await loadMaps();
    showToast('Bild hochgeladen!', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  finally { prog.classList.add('hidden'); }
}

// ── Admins ──────────────────────────────────────────────────────────────
async function loadEditors(mapId) {
  try {
    const [admins, users] = await Promise.all([
      API.get(`/api/maps/${mapId}/admins`),
      ME.is_superadmin ? API.get('/api/users') : Promise.resolve([])
    ]);
    const mapOwnerId = allMaps.find(m => m.id === mapId)?.owner_id;

    document.getElementById('editorsList').innerHTML =
      admins.map(a => `
        <div class="admin-row">
          <span>👤 ${escHtml(a.username)}</span>
          ${a.id !== mapOwnerId
            ? `<button class="btn btn-danger btn-sm" onclick="removeAdmin(${mapId},${a.id})">Entfernen</button>`
            : '<span style="color:var(--text-dim);font-size:12px">Eigentümer</span>'}
        </div>`).join('') || '<p style="color:var(--text-dim);font-size:13px">Keine weiteren Admins</p>';

    const adminIds = new Set(admins.map(a => a.id));
    const sel      = document.getElementById('addEditorSelect');
    sel.innerHTML  = '<option value="">Benutzer wählen…</option>' +
      users.filter(u => !adminIds.has(u.id) && u.id !== mapOwnerId)
           .map(u => `<option value="${u.id}">${escHtml(u.username)}</option>`).join('');
  } catch {}
}

async function addEditor() {
  const uid = document.getElementById('addEditorSelect').value;
  if (!uid) return;
  try {
    await API.post(`/api/maps/${settingsMapId}/admins`, { user_id: +uid });
    await loadEditors(settingsMapId);
    showToast('Editor hinzugefügt', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function removeEditor(mapId, userId) {
  try {
    await API.delete(`/api/maps/${mapId}/admins/${userId}`);
    await loadEditors(mapId);
    showToast('Editor entfernt');
  } catch (e) { showToast(e.message, 'error'); }
}

// Settings tab switching
document.querySelectorAll('#settingsModal .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#settingsModal .tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#settingsModal .tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── User management (superadmin) ────────────────────────────────────────
async function openUsersModal() {
  await loadUsers();
  openModal('usersModal');
}

async function loadUsers() {
  try {
    const users = await API.get('/api/users');
    document.getElementById('usersList').innerHTML =
      users.map(u => `
        <div class="user-row">
          <span>
            👤 ${escHtml(u.username)}
            ${u.is_superadmin
              ? '<strong style="font-size:11px;color:var(--primary-h);margin-left:.3rem">(Super-Admin)</strong>'
              : ''}
          </span>
          <div style="display:flex;gap:.4rem">
            ${/* Super-Admin darf fremde PW via Admin-Weg setzen, aber NICHT sein eigenes
                 (er würde sonst die Bestätigung des alten Passworts umgehen) */
              u.id !== ME.id || !u.is_superadmin
                ? `<button class="btn btn-ghost btn-sm"
                     onclick="openAdminPwModal(${u.id},'${escAttr(u.username)}')">🔒 PW</button>`
                : ''}
            ${!u.is_superadmin
              ? `<button class="btn btn-danger btn-sm"
                   onclick="deleteUser(${u.id},'${escAttr(u.username)}')">🗑</button>`
              : ''}
          </div>
        </div>`).join('') || '<p style="color:var(--text-dim)">Keine Benutzer</p>';
  } catch {}
}

async function deleteUser(id, name) {
  if (!confirm(`Benutzer „${name}" wirklich löschen?`)) return;
  try { await API.delete(`/api/users/${id}`); await loadUsers(); showToast('Benutzer gelöscht'); }
  catch (e) { showToast(e.message, 'error'); }
}

document.getElementById('createUserForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await API.post('/api/users', {
      username: document.getElementById('newUsername').value,
      password: document.getElementById('newPassword').value
    });
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    await loadUsers();
    showToast('Benutzer erstellt', 'success');
  } catch (ex) { showToast(ex.message, 'error'); }
});

// ── Change own password ──────────────────────────────────────────────────
function openChangePasswordModal() {
  document.getElementById('curPw').value  = '';
  document.getElementById('newPw').value  = '';
  document.getElementById('newPw2').value = '';
  document.getElementById('changePwErr').classList.add('hidden');
  openModal('changePwModal');
}

document.getElementById('changePwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const cur = document.getElementById('curPw').value;
  const nw  = document.getElementById('newPw').value;
  const nw2 = document.getElementById('newPw2').value;
  const err = document.getElementById('changePwErr');
  err.classList.add('hidden');

  if (nw !== nw2) {
    err.textContent = 'Die neuen Passwörter stimmen nicht überein.';
    err.classList.remove('hidden'); return;
  }
  if (nw.length < 4) {
    err.textContent = 'Neues Passwort muss mindestens 4 Zeichen haben.';
    err.classList.remove('hidden'); return;
  }
  try {
    await API.post('/api/auth/change-password', { current_password: cur, new_password: nw });
    closeModal('changePwModal');
    showToast('Passwort erfolgreich geändert', 'success');
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

// ── Admin sets user password ─────────────────────────────────────────────
function openAdminPwModal(userId, username) {
  document.getElementById('adminPwUserId').value = userId;
  document.getElementById('adminPwTitle').textContent = `Passwort für „${username}" setzen`;
  document.getElementById('adminNewPw').value = '';
  document.getElementById('adminPwErr').classList.add('hidden');
  openModal('adminPwModal');
}

document.getElementById('adminPwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const uid = document.getElementById('adminPwUserId').value;
  const pw  = document.getElementById('adminNewPw').value;
  const err = document.getElementById('adminPwErr');
  err.classList.add('hidden');
  try {
    await API.put(`/api/users/${uid}/password`, { password: pw });
    closeModal('adminPwModal');
    showToast('Passwort gesetzt', 'success');
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

// ── Custom POI Icons ──────────────────────────────────────────────────────
let allIcons = [];

async function openIconsModal() {
  await loadIcons();
  openModal('iconsModal');
}

async function loadIcons() {
  try {
    allIcons = await API.get('/api/icons');
    renderIconsList();
  } catch (e) { showToast(e.message, 'error'); }
}

function isIconUrl(v) { return v && (v.startsWith('http') || v.startsWith('/') || v.startsWith('data:')); }

function iconPreviewHtml(url, name) {
  if (isIconUrl(url)) return `<img src="${escHtml(url)}" alt="${escHtml(name)}" onerror="this.style.opacity='.3'" style="width:36px;height:36px;object-fit:contain;border-radius:4px">`;
  return `<span style="font-size:26px;line-height:1">${escHtml(url)}</span>`;
}

/** Display name: strip "username_" prefix for non-superadmin view */
function iconDisplayName(icon) {
  if (ME.is_superadmin || !icon.owner_id) return escHtml(icon.name);
  // Remove own prefix for display
  const prefix = ME.username + '_';
  return escHtml(icon.name.startsWith(prefix) ? icon.name.slice(prefix.length) : icon.name);
}

function renderIconsList() {
  const el = document.getElementById('iconsList');
  if (!allIcons.length) {
    el.innerHTML = '<p style="color:var(--text-dim);font-size:13px">Noch keine Icons.</p>';
    return;
  }

  // Group: global first, then own
  const global = allIcons.filter(i => !i.owner_id);
  const own    = allIcons.filter(i =>  i.owner_id);

  let html = '';
  if (global.length) {
    html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin-bottom:.3rem">Globale Icons (Admin)</div>`;
    html += global.map(icon => iconRow(icon, !ME.is_superadmin)).join('');
  }
  if (own.length) {
    html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin:.6rem 0 .3rem">Meine Icons</div>`;
    html += own.map(icon => iconRow(icon, false)).join('');
  }
  el.innerHTML = html;
}

function iconRow(icon, readOnly) {
  return `<div class="icon-manage-item" id="icon-row-${icon.id}">
    <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:var(--border);border-radius:4px;flex-shrink:0">
      ${iconPreviewHtml(icon.image_url, icon.name)}
    </div>
    <div class="icon-manage-info">
      <span class="icon-manage-name">${iconDisplayName(icon)}</span>
      <span class="icon-manage-url" title="${escHtml(icon.image_url)}">${escHtml(icon.image_url.length > 45 ? icon.image_url.slice(0,45)+'…' : icon.image_url)}</span>
    </div>
    <div style="display:flex;gap:.3rem;flex-shrink:0">
      ${readOnly ? '' : `<button class="btn btn-ghost btn-sm" onclick="editIcon(${icon.id})">✏️</button>
      <button class="btn btn-danger btn-sm" onclick="deleteIcon(${icon.id})">🗑</button>`}
    </div>
  </div>`;
}

async function createIcon() {
  const name = document.getElementById('newIconName').value.trim();
  const url  = document.getElementById('newIconUrl').value.trim();
  if (!name || !url) { showToast('Name und Emoji/URL erforderlich', 'error'); return; }
  try {
    await API.post('/api/icons', { name, image_url: url });
    document.getElementById('newIconName').value = '';
    document.getElementById('newIconUrl').value  = '';
    document.getElementById('newIconPreview').innerHTML = '';
    await loadIcons();
    showToast('Icon hinzugefügt', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

document.getElementById('newIconUrl')?.addEventListener('input', function() {
  const v = this.value.trim();
  const prev = document.getElementById('newIconPreview');
  if (!prev) return;
  if (!v) { prev.innerHTML = ''; return; }
  if (isIconUrl(v)) {
    prev.innerHTML = `<img src="${escHtml(v)}" style="max-width:34px;max-height:34px;object-fit:contain" onerror="this.style.opacity='.2'">`;
  } else {
    prev.innerHTML = `<span style="font-size:22px;line-height:1">${escHtml(v)}</span>`;
  }
});

function editIcon(id) {
  const icon = allIcons.find(x => x.id === id);
  if (!icon) return;
  const row  = document.getElementById('icon-row-' + id);
  const dname = ME.is_superadmin ? icon.name : icon.name.replace(new RegExp('^' + ME.username + '_'), '');
  row.innerHTML = `
    <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:var(--border);border-radius:4px;flex-shrink:0">
      ${iconPreviewHtml(icon.image_url, icon.name)}
    </div>
    <div style="flex:1;display:flex;flex-direction:column;gap:.3rem">
      <input type="text" value="${escHtml(dname)}" id="edit-name-${id}" placeholder="Name">
      <input type="text" value="${escHtml(icon.image_url)}" id="edit-url-${id}" placeholder="URL oder Emoji">
    </div>
    <div style="display:flex;gap:.3rem;flex-shrink:0">
      <button class="btn btn-primary btn-sm" onclick="saveIcon(${id})">✓</button>
      <button class="btn btn-ghost btn-sm" onclick="loadIcons()">✕</button>
    </div>`;
}

async function saveIcon(id) {
  const name = document.getElementById('edit-name-' + id)?.value.trim();
  const url  = document.getElementById('edit-url-'  + id)?.value.trim();
  if (!name || !url) return;
  try {
    await API.put(`/api/icons/${id}`, { name, image_url: url });
    await loadIcons();
    showToast('Icon gespeichert', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteIcon(id) {
  if (!confirm('Icon löschen?')) return;
  try {
    await API.delete(`/api/icons/${id}`);
    await loadIcons();
    showToast('Icon gelöscht');
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Map stats (file size + live viewers) ─────────────────────────────────
async function loadMapStats() {
  for (const m of allMaps) {
    try {
      const stats = await fetch(`/api/maps/${m.id}/stats`, {
        headers: { Authorization: `Bearer ${API.token()}` }
      }).then(r => r.json());
      const el = document.getElementById(`stats-${m.id}`);
      if (!el) continue;
      const parts = [];
      if (stats.viewers  > 0) parts.push(`👁 ${stats.viewers} Betrachter`);
      if (stats.editors  > 0) parts.push(`✏ ${stats.editors} Editor(en)`);
      if (stats.fileSize)     parts.push(formatBytes(stats.fileSize));
      el.textContent = parts.join(' · ');
    } catch {}
  }
}

function formatBytes(b) {
  if (b > 1048576) return (b/1048576).toFixed(1) + ' MB';
  if (b > 1024)    return (b/1024).toFixed(0) + ' KB';
  return b + ' B';
}

// ── Init ──────────────────────────────────────────────────────────────────

// ── Changelog ─────────────────────────────────────────────────────────────
let _changelogQuill = null;
let _changelogHtml  = '';

async function openChangelog() {
  // Load from server
  try {
    const r = await fetch('/api/changelog');
    const d = await r.json();
    _changelogHtml = d.html || '';
  } catch { _changelogHtml = ''; }

  const el = document.getElementById('changelogDisplay');
  if (el) {
    el.innerHTML = _changelogHtml
      ? (typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(_changelogHtml) : _changelogHtml)
      : '<p style="color:var(--text-dim)">Noch kein Changelog eingetragen.</p>';
  }

  // Show edit button for superadmin
  const editBtn = document.getElementById('editChangelogBtn');
  if (editBtn) editBtn.classList.toggle('hidden', !ME.is_superadmin);

  // Make sure edit panel is hidden
  document.getElementById('changelogEdit')?.classList.add('hidden');
  document.getElementById('changelogDisplay')?.classList.remove('hidden');

  openModal('changelogModal');
}

function startChangelogEdit() {
  document.getElementById('changelogDisplay')?.classList.add('hidden');
  document.getElementById('changelogEdit')?.classList.remove('hidden');

  if (!_changelogQuill) {
    const container = document.getElementById('changelogEditorContainer');
    if (!container || typeof Quill === 'undefined') return;
    _changelogQuill = new Quill(container, {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ header: [1,2,3,false] }],
          ['bold','italic','underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link'],
          ['clean']
        ]
      }
    });
  }
  _changelogQuill.clipboard.dangerouslyPasteHTML(_changelogHtml || '');
}

function cancelChangelogEdit() {
  document.getElementById('changelogEdit')?.classList.add('hidden');
  document.getElementById('changelogDisplay')?.classList.remove('hidden');
}

async function saveChangelog() {
  if (!_changelogQuill) return;
  const html = _changelogQuill.root.innerHTML;
  const clean = html === '<p><br></p>' ? '' : html;
  try {
    await API.put('/api/changelog', { html: clean });
    _changelogHtml = clean;
    const el = document.getElementById('changelogDisplay');
    if (el) el.innerHTML = clean || '<p style="color:var(--text-dim)">Leer.</p>';
    cancelChangelogEdit();
    showToast('Changelog gespeichert', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}


// ── Audit Log ─────────────────────────────────────────────────────────────
let _auditPage = 0, _auditTimer = null;
const AUDIT_LIMIT = 100;

function _auditDebounce() {
  clearTimeout(_auditTimer);
  _auditTimer = setTimeout(() => loadAuditLog(0), 350);
}

async function openAuditModal() {
  openModal('auditModal');
  await loadAuditLog(0);
}

async function loadAuditLog(offset = 0) {
  _auditPage = offset;
  const q = document.getElementById('auditSearch')?.value.trim() || '';
  const url = `/api/audit-log?limit=${AUDIT_LIMIT}&offset=${offset}${q ? '&search=' + encodeURIComponent(q) : ''}`;
  try {
    const d = await API.get(url.replace('/api/audit-log', 'audit-log').replace('audit-log', '/api/audit-log'));
    renderAuditRows(d.rows);
    renderAuditPager(d.total, offset);
  } catch (e) { showToast(e.message, 'error'); }
}

function renderAuditRows(rows) {
  const tbody = document.getElementById('auditBody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:1.5rem">Keine Einträge</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const dt = new Date(r.created_at).toLocaleString('de');
    const actionCls = r.action.startsWith('DELETE') ? 'color:#fca5a5'
                    : r.action.startsWith('LOGIN')   ? 'color:#86efac'
                    : '';
    return `<tr>
      <td style="white-space:nowrap;color:var(--text-dim)">${dt}</td>
      <td><strong>${escHtml(r.username||'')}</strong></td>
      <td style="font-family:monospace;font-size:11px;color:var(--text-dim)">${escHtml(r.ip||'')}</td>
      <td><span style="font-size:11px;font-family:monospace;${actionCls}">${escHtml(r.action||'')}</span></td>
      <td style="color:var(--text-dim)">${escHtml(r.detail||'')}</td>
    </tr>`;
  }).join('');
}

function renderAuditPager(total, offset) {
  const pager = document.getElementById('auditPager');
  if (!pager) return;
  const page  = Math.floor(offset / AUDIT_LIMIT) + 1;
  const pages = Math.ceil(total / AUDIT_LIMIT);
  pager.innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="loadAuditLog(${Math.max(0, offset - AUDIT_LIMIT)})"
      ${offset === 0 ? 'disabled' : ''}>&#8592;</button>
    <span>Seite ${page} / ${pages} &middot; ${total} Einträge</span>
    <button class="btn btn-ghost btn-sm" onclick="loadAuditLog(${offset + AUDIT_LIMIT})"
      ${offset + AUDIT_LIMIT >= total ? 'disabled' : ''}>&#8594;</button>`;
}

async function exportAuditCsv() {
  try {
    const d = await API.get('/api/audit-log?limit=10000&offset=0');
    const header = 'Zeit,Benutzer,IP,Aktion,Detail';
    const rows   = d.rows.map(r =>
      [r.created_at, r.username, r.ip, r.action, r.detail]
      .map(v => '"' + String(v||'').replace(/"/g,'""') + '"').join(',')
    );
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'audit_log_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { showToast(e.message, 'error'); }
}


loadMaps()
  .then(() => { if (ME.is_superadmin || true) loadMapStats(); });
