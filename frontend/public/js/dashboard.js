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
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
          ${locked && ME.is_superadmin
        ? `<button class="btn btn-ghost btn-sm" style="color:#fca5a5" onclick="forceUnlockMap(${m.id})" title="Sperre aufheben">🔓</button>`
        : ''}
          <button class="btn btn-danger btn-sm" onclick="deleteMap(${m.id},'${escAttr(m.name)}')" style="margin-left:auto">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Create - Ersetzt den alten Block
document.getElementById('createMapBtn').addEventListener('click', async () => {
  const name = prompt("Name der neuen Karte:");
  // Wenn abgebrochen wird oder der Name leer ist, nichts tun
  if (!name || name.trim() === "") return;

  try {
    // 1. Karte mit Minimaldaten im Backend anlegen
    const newMap = await API.post('/api/maps', { 
      name: name.trim(), 
      description: '' 
    });

    // 2. Kartenliste im Dashboard aktualisieren, damit die neue Karte erscheint
    await loadMaps();

    // 3. Sofort die neuen Einstellungen öffnen, um Standardwerte anzupassen
    openSettings(newMap.id);
    
    showToast('Karte erfolgreich erstellt', 'success');
  } catch (e) {
    console.error(e);
    showToast('Fehler beim Erstellen der Karte: ' + e.message, 'error');
  }
});

// Edit
function editMap(id) {
  const m = allMaps.find(x => x.id === id);
  if (!m) return;
  document.getElementById('mapId').value = m.id;
  document.getElementById('mapName').value = m.name;
  document.getElementById('mapDesc').value = m.description || '';
  document.getElementById('mapModalTitle').textContent = 'Karte bearbeiten';
  openModal('mapModal');
}

document.getElementById('mapForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('mapId').value;
  const body = {
    name: document.getElementById('mapName').value,
    description: document.getElementById('mapDesc').value
  };
  // Preserve scale fields if map already exists
  if (id) {
    const existing = allMaps.find(m => m.id === +id);
    if (existing) {
      body.map_scale_label = existing.map_scale_label ?? null;
      body.map_miles_width = existing.map_miles_width ?? null;
      body.travel_miles_per_day = existing.travel_miles_per_day ?? 24;
      body.travel_hours_per_day = existing.travel_hours_per_day ?? 8;
    }
  }
  try {
    if (id) await API.put(`/api/maps/${id}`, body);
    else await API.post('/api/maps', body);
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
  await loadFontList(); // Schriften laden

  document.getElementById('setMapName').value = m.name;
  document.getElementById('setMapDesc').value = m.description || '';
  
  // JSON Standardwerte laden
  const ds = m.default_settings || {};
    document.getElementById('defFogOpacity').value = ds.fog_opacity ?? 70;
    document.getElementById('val-fog').textContent = ds.fog_opacity ?? 70;
    document.getElementById('defFontMain').value = ds.label_font || '';
    document.getElementById('defPoiLabelSize').value = parseInt(ds.poi_label_size) || 22;
    document.getElementById('defPoiColor').value = ds.poi_label_color || '#e2e8f0';
    document.getElementById('defFontRegion').value = ds.region_font || '';
    document.getElementById('defRegionLabelSize').value = parseInt(ds.region_label_size) || 32;
    document.getElementById('defRegionColor').value = ds.region_label_color || '#e2e8f0';
    document.getElementById('defPoiBorder').value = ds.poi_border_color || '#bcbcbc';
    document.getElementById('defPingDur').value = ds.ping_duration || 5;
    document.getElementById('defRegionWidth').value = parseInt(ds.region_label_width) || 210;

    updateFontPreview('poi');
    updateFontPreview('region');

    document.getElementById('settingsTitle').textContent = `⚙️ ${m.name}`;
    document.getElementById('settingsMapId').value = id;

// --- NEU/KORRIGIERT: POI REGELR POSITIONIEREN ---
  const minVal = ds.poi_min_size || 25;
  const sizeVal = ds.poi_size || 30;
  const maxVal = ds.poi_max_size || 80;

  // 1. Schieberegler auf die richtigen Positionen setzen
  document.getElementById('defPoiMin').value = minVal;
  document.getElementById('defPoiSize').value = sizeVal;
  document.getElementById('defPoiMax').value = maxVal;

  // 2. Die Zahlen-Anzeige daneben aktualisieren
  document.getElementById('val-poiMin').textContent = minVal;
  document.getElementById('val-poiSize').textContent = sizeVal;
  document.getElementById('val-poiMax').textContent = maxVal;

  // Image preview
  const prev = document.getElementById('currentImagePreview');
  prev.innerHTML = m.image_path
    ? `<img src="${m.image_path}" alt="Kartenbild">`
    : '<p style="padding:.7rem;color:var(--text-dim);font-size:13px">Noch kein Bild hochgeladen</p>';

  // Map share link
  document.getElementById('shareUrlMap').value = `${location.origin}/map.html?t=${m.share_token}`;

  // Scale & travel fields
  document.getElementById('mapScaleLabel').value = m.map_scale_label || '';
  document.getElementById('mapMilesWidth').value = m.map_miles_width != null ? m.map_miles_width : '';
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

function updatePoiSliders(source) {
  const minEl = document.getElementById('defPoiMin');
  const sizeEl = document.getElementById('defPoiSize');
  const maxEl = document.getElementById('defPoiMax');

  let minV = parseInt(minEl.value);
  let sizeV = parseInt(sizeEl.value);
  let maxV = parseInt(maxEl.value);

  // LOGIK-KETTE
  if (source === 'max') {
    // Wenn Max kleiner als Standard wird -> schiebe Standard mit
    if (maxV < sizeV) {
      sizeEl.value = maxV;
      sizeV = maxV; // Wert für die nächste Prüfung aktualisieren
    }
    // Wenn der (neue) Standardwert kleiner als Min wird -> schiebe Min mit
    if (sizeV < minV) {
      minEl.value = sizeV;
    }
  }

  if (source === 'size') {
    if (sizeV < minV) minEl.value = sizeV;
    if (sizeV > maxV) maxEl.value = sizeV;
  }

  if (source === 'min') {
    if (minV > sizeV) {
      sizeEl.value = minV;
      sizeV = minV;
    }
    if (sizeV > maxV) {
      maxEl.value = sizeV;
    }
  }

  // Anzeige-Texte aktualisieren
  document.getElementById('val-poiMin').textContent = minEl.value;
  document.getElementById('val-poiSize').textContent = sizeEl.value;
  document.getElementById('val-poiMax').textContent = maxEl.value;
  
  if(typeof updateFontPreview === 'function') updateFontPreview('poi');
}

async function saveGeneralSettings() {
    // Sammeln der Daten aus den neuen Feldern
    const ds = {
        label_font: document.getElementById('defFontMain').value,
        fog_opacity: parseInt(document.getElementById('defFogOpacity').value),
        poi_label_size: document.getElementById('defPoiLabelSize').value + 'px',
        poi_label_color: document.getElementById('defPoiColor').value,
        region_font: document.getElementById('defFontRegion').value,
        region_label_size: document.getElementById('defRegionLabelSize').value + 'px',
        region_label_color: document.getElementById('defRegionColor').value,
        region_label_width: document.getElementById('defRegionWidth').value + 'px',
        poi_size: parseInt(document.getElementById('defPoiSize').value),
        poi_min_size: parseInt(document.getElementById('defPoiMin').value),
        poi_max_size: parseInt(document.getElementById('defPoiMax').value),
        poi_border_color: document.getElementById('defPoiBorder').value,
        ping_duration: parseInt(document.getElementById('defPingDur').value)
    };

    console.log("Sende folgende Einstellungen:", ds); // Zum Testen in der Web-Konsole

    try {
        await API.put(`/api/maps/${settingsMapId}`, {
            name: document.getElementById('setMapName').value,
            description: document.getElementById('setMapDesc').value,
            default_settings: ds // Dieses Feld muss im Body sein
        });
        showToast('Einstellungen gespeichert', 'success');
        loadMaps(); // Dashboard neu laden
    } catch(e) { 
        showToast(e.message, 'error'); 
    }
}

async function loadGroupShareLinks(mapId) {
  try {
    const r = await fetch(`/api/maps/${mapId}/data`, {
      headers: { Authorization: `Bearer ${API.token()}` }
    });
    const data = await r.json();
    const gs = data.groups || [];
    const el = document.getElementById('groupShareLinks');
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
  } catch { }
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
    const cd = res.headers.get('Content-Disposition') || '';
    const name = cd.match(/filename="([^"]+)"/)?.[1] || 'backup.json';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    URL.revokeObjectURL(a.href);
    showToast('Backup heruntergeladen', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// Backup Upload
async function handleRestore(input) {
  const file = input.files[0];
  if (!file) return;

  if (!confirm("Möchtest du das Backup wirklich einspielen? Bestehende Daten werden überschrieben!")) {
    input.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('backup', file);

  try {
    const res = await fetch(`/api/maps/${settingsMapId}/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API.token()}` },
      body: formData // Wichtig: Bei FormData keinen Content-Type Header manuell setzen!
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.message || 'Restore fehlgeschlagen');
    }

    showToast('Backup erfolgreich eingespielt. Seite wird neu geladen...', 'success');
    setTimeout(() => location.reload(), 2000);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    input.value = ''; // Input zurücksetzen
  }
}

// Save scale & travel settings
async function saveMapScale() {
  const m = allMaps.find(x => x.id === settingsMapId);
  if (!m) return;
  try {
    await API.put(`/api/maps/${settingsMapId}`, {
      name: m.name,
      description: m.description || '',
      map_scale_label: document.getElementById('mapScaleLabel').value.trim() || null,
      map_miles_width: parseFloat(document.getElementById('mapMilesWidth').value) || null,
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
  const txt = document.getElementById('progressText');
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

// ── Fonts ──────────────────────────────────────────────────────────────

async function loadFontList() {
  try {
    const fonts = await API.get('/api/fonts');
    const selects = ['defFontMain', 'defFontRegion'];
    
    selects.forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '<option value="">Standard-Systemschrift</option>' + 
        fonts.map(f => `<option value="${f}">${f.replace(/\.(ttf|otf)$/i, '')}</option>`).join('');
    });
  } catch (e) {
    console.error("Fonts konnten nicht geladen werden", e);
  }
}

function updateFontPreview(type) {
    const isPoi = type === 'poi';
    const fontFile = document.getElementById(isPoi ? 'defFontMain' : 'defFontRegion').value;
    const size = document.getElementById(isPoi ? 'defPoiLabelSize' : 'defRegionLabelSize').value;
    const color = document.getElementById(isPoi ? 'defPoiColor' : 'defRegionColor').value;
    const previewContainer = document.getElementById(isPoi ? 'fontPreviewPoi' : 'fontPreviewRegion');

    if (!previewContainer) return;

    // Ziel-Element für den Text (bei Region das innere Div, bei POI das Container selbst)
    const textTarget = isPoi ? previewContainer : previewContainer.querySelector('.region-preview-text');

    if (fontFile) {
        const fontName = fontFile.split('.')[0];
        if (!document.getElementById('style-' + fontName)) {
            const newStyle = document.createElement('style');
            newStyle.id = 'style-' + fontName;
            newStyle.textContent = `@font-face { font-family: "${fontName}"; src: url("/css/fonts/${fontFile}"); }`;
            document.head.appendChild(newStyle);
        }
        textTarget.style.fontFamily = `"${fontName}"`;
    } else {
        textTarget.style.fontFamily = 'inherit';
    }

    textTarget.style.fontSize = size + 'px';
    textTarget.style.color = color;
    
    // Optional: Vorschau-Breite an den Regler anpassen (falls gewünscht)
    if (!isPoi) {
        const regWidth = document.getElementById('defRegionWidth').value || 210;
        previewContainer.style.maxWidth = regWidth + 'px';
    }
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
          ? `<button class="btn btn-danger btn-sm" onclick="removeEditor(${mapId},${a.id})">Entfernen</button>`
          : '<span style="color:var(--text-dim);font-size:12px">Eigentümer</span>'}
        </div>`).join('') || '<p style="color:var(--text-dim);font-size:13px">Keine weiteren Admins</p>';

    const adminIds = new Set(admins.map(a => a.id));
    const sel = document.getElementById('addEditorSelect');
    sel.innerHTML = '<option value="">Benutzer wählen…</option>' +
      users.filter(u => !adminIds.has(u.id) && u.id !== mapOwnerId)
        .map(u => `<option value="${u.id}">${escHtml(u.username)}</option>`).join('');
  } catch { }
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
  } catch { }
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
  document.getElementById('curPw').value = '';
  document.getElementById('newPw').value = '';
  document.getElementById('newPw2').value = '';
  document.getElementById('changePwErr').classList.add('hidden');
  openModal('changePwModal');
}

document.getElementById('changePwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const cur = document.getElementById('curPw').value;
  const nw = document.getElementById('newPw').value;
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
  const pw = document.getElementById('adminNewPw').value;
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

  // 1. Globale Icons (owner_id ist NULL)
  const global = allIcons.filter(i => !i.owner_id);

  // 2. Eigene Icons (gehören dem aktuell eingeloggten User ME.id)
  const own = allIcons.filter(i => i.owner_id === ME.id);

  // 3. Icons von anderen (nur für Super-Admins sichtbar)
  const others = allIcons.filter(i => i.owner_id !== null && i.owner_id !== ME.id);

  let html = '';

  // Globale Icons anzeigen (für alle)
  if (global.length) {
    html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin-bottom:.3rem">Globale Icons (Admin)</div>`;
    // Nur Super-Admin darf globale Icons bearbeiten
    html += global.map(icon => iconRow(icon, !ME.is_superadmin)).join('');
  }

  // Eigene Icons anzeigen
  if (own.length) {
    html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin:.6rem 0 .3rem">Meine Icons</div>`;
    html += own.map(icon => iconRow(icon, false)).join('');
  }

  // Icons von anderen Usern (NUR für Super-Admin sichtbar)
  if (ME.is_superadmin && others.length) {
    html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin:.6rem 0 .3rem">Icons anderer User (Admin-Ansicht)</div>`;
    html += others.map(icon => iconRow(icon, false)).join('');
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
      <span class="icon-manage-url" title="${escHtml(icon.image_url)}">${escHtml(icon.image_url.length > 45 ? icon.image_url.slice(0, 45) + '…' : icon.image_url)}</span>
    </div>
    <div style="display:flex;gap:.3rem;flex-shrink:0">
      ${readOnly ? '' : `<button class="btn btn-ghost btn-sm" onclick="editIcon(${icon.id})">✏️</button>
      <button class="btn btn-danger btn-sm" onclick="deleteIcon(${icon.id})">🗑</button>`}
    </div>
  </div>`;
}

async function createIcon() {
  const name = document.getElementById('newIconName').value.trim();
  const url = document.getElementById('newIconUrl').value.trim();
  if (!name || !url) { showToast('Name und Emoji/URL erforderlich', 'error'); return; }
  try {
    await API.post('/api/icons', { name, image_url: url });
    document.getElementById('newIconName').value = '';
    document.getElementById('newIconUrl').value = '';
    document.getElementById('newIconPreview').innerHTML = '';
    await loadIcons();
    showToast('Icon hinzugefügt', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

document.getElementById('newIconUrl')?.addEventListener('input', function () {
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
  const row = document.getElementById('icon-row-' + id);
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
  const url = document.getElementById('edit-url-' + id)?.value.trim();
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
      if (stats.viewers > 0) parts.push(`👁 ${stats.viewers} Betrachter`);
      if (stats.editors > 0) parts.push(`✏ ${stats.editors} Editor(en)`);
      if (stats.fileSize) parts.push(formatBytes(stats.fileSize));
      el.textContent = parts.join(' · ');
    } catch { }
  }
}

function formatBytes(b) {
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

// ── Init ──────────────────────────────────────────────────────────────────

// ── Changelog ─────────────────────────────────────────────────────────────
let _changelogQuill = null;
let _changelogHtml = '';

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
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline'],
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
      : r.action.startsWith('LOGIN') ? 'color:#86efac'
        : '';
    return `<tr>
      <td style="white-space:nowrap;color:var(--text-dim)">${dt}</td>
      <td><strong>${escHtml(r.username || '')}</strong></td>
      <td style="font-family:monospace;font-size:11px;color:var(--text-dim)">${escHtml(r.ip || '')}</td>
      <td><span style="font-size:11px;font-family:monospace;${actionCls}">${escHtml(r.action || '')}</span></td>
      <td style="color:var(--text-dim)">${escHtml(r.detail || '')}</td>
    </tr>`;
  }).join('');
}

function renderAuditPager(total, offset) {
  const pager = document.getElementById('auditPager');
  if (!pager) return;
  const page = Math.floor(offset / AUDIT_LIMIT) + 1;
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
    const rows = d.rows.map(r =>
      [r.created_at, r.username, r.ip, r.action, r.detail]
        .map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')
    );
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'audit_log_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { showToast(e.message, 'error'); }
}


loadMaps()
  .then(() => { if (ME.is_superadmin || true) loadMapStats(); });
