// WebAuthn polyfill
if (!window.PublicKeyCredential) {
  window.PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    isConditionalMediationAvailable: async () => false
  };
}

// ── URL params ─────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const SHARE_T = params.get('t');

// ── Constants ──────────────────────────────────────────────────────────
// POI icons loaded from poi_icons.json (grouped)
let POI_ICONS_GROUPED = {};
let POI_ICONS = {};  // flat lookup

async function loadPoiIcons() {
  try {
    const r = await fetch('/js/poi_icons.json');
    const data = await r.json();

    POI_ICONS_GROUPED = data;
    POI_ICONS = {};

    // Wir iterieren über die Kategorien (z.B. "settlements")
    for (const category of Object.values(POI_ICONS_GROUPED)) {
      if (category.icons) {
        // Nur die Icons in das flache POI_ICONS Objekt kopieren
        Object.assign(POI_ICONS, category.icons);
      }
    }
  } catch (e) {
    console.error("Fehler beim Laden der Icons:", e);
    // Minimaler Fallback
    POI_ICONS = { circle: '⬤', star: '⭐', note: '📌', castle: '🏰', city: '🏙', danger: '☠' };
    POI_ICONS_GROUPED = {
      'base': {
        label: 'Basis',
        icons: { ...POI_ICONS }
      }
    };
  }
}

let _customIcons = [];       // loaded from /api/icons
let _poiSortMode = 'default';
let _pickModeActive = false;

// ── Global user settings (persisted to localStorage) ─────────────────
const _SETTINGS_KEY = 'wm_settings';
let _settings = (() => {
  try { return JSON.parse(localStorage.getItem(_SETTINGS_KEY) || '{}'); } catch { return {}; }
})();
function _saveSetting(key, val) { _settings[key] = val; localStorage.setItem(_SETTINGS_KEY, JSON.stringify(_settings)); }
function _getSetting(key, def) { return _settings[key] !== undefined ? _settings[key] : def; }

let _poiMarkerSize = _getSetting('poiSize', 26);   // px, 25-60
let _showPoiLabels = _getSetting('poiLabels', false);
let _showRegLabels = _getSetting('regLabels', false);
let _lastPingTime = 0;  // for viewer 10s cooldown
let _fogDensity = _getSetting('fogDensity', 0.5);  // editors default 50%
const DASH_STYLE = { solid: null, dashed: '12 8', dotted: '3 9' };

// ── State ──────────────────────────────────────────────────────────────
let leafletMap, mapData, isAdmin = false, limitGroupId = null;

// Per-group layer state
// groupId → { visible, poi, route, region, fog, _savedSubs,
//              poiLayer, routeLayer, regionLayer }
let layerState = {};

// Special layers for public/hidden visibility items
const PUB = 'public', HID = 'hidden';
let globalLayers = null;  // { poi, route, region, state }
let hiddenLayers = null;  // { poi, route, region, state }  (admin only)

let poiLayers = {}; // poiId    → {marker, bucket:'group'|'public'|'hidden', groupId}
let routeLayers = {}; // routeId  → {polyline, wpMarkers:[], bucket, groupId, waypoints:[]}
let regionLayers = {}; // regionId → {poly, bucket, groupId}

let fogCanvas = null;
let fogBrush = null;
let regionEditor = null;
let regionEditorSaveFn = null;  // called on Enter when editing vertices

const authToken = localStorage.getItem('wm_token');
const socket = io();

// ── HTML helpers ────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// ── Init ───────────────────────────────────────────────────────────────
async function init() {
  let mapId = null, groupToken = null, mapToken = null;

  if (SHARE_T) {
    try {
      const info = await fetch(`/api/share/${SHARE_T}`).then(r => r.json());
      if (info.type === 'group') {
        mapId = info.map_id; groupToken = SHARE_T;
        document.getElementById('mapTitle').textContent = info.map_name + ' – ' + info.group_name;
      } else if (info.type === 'map') {
        mapId = info.map_id; mapToken = SHARE_T;
      } else { alert('Ungültiger Link.'); return; }
    } catch { alert('Ungültiger Link.'); return; }
  } else {
    mapId = +params.get('id');
    if (!mapId) { alert('Kein Zugriff.'); return; }
  }

  const headers = {};
  if (authToken && !SHARE_T) headers['Authorization'] = `Bearer ${authToken}`;
  if (groupToken) headers['X-Group-Token'] = groupToken;
  if (mapToken) headers['X-Share-Token'] = mapToken;

  try {
    const r = await fetch(`/api/maps/${mapId}/data`, { headers });
    mapData = await r.json();
    if (!r.ok) throw new Error(mapData.error);
  } catch (e) { alert(`Fehler: ${e.message}`); return; }

  isAdmin = mapData.is_admin;
  limitGroupId = mapData.limit_group_id;

  if (!SHARE_T) document.getElementById('backBtn').style.display = '';
  document.getElementById('mapTitle').textContent = mapData.map.name;
  if (isAdmin) document.getElementById('toggleEditorBtn').classList.remove('hidden');

  initLeaflet(mapData.map);
  initSpecialLayers();

  mapData.groups.forEach(g => {
    layerState[g.id] = {
      visible: g.visible, poi: true, route: true, region: true,
      fog: g.fog_of_war_enabled, _savedSubs: null,
      poiLayer: L.layerGroup(),
      routeLayer: L.layerGroup(),
      regionLayer: L.layerGroup()
    };
    if (g.visible) {
      layerState[g.id].poiLayer.addTo(leafletMap);
      layerState[g.id].routeLayer.addTo(leafletMap);
      layerState[g.id].regionLayer.addTo(leafletMap);
    }
  });

  // Load POI icon groups + custom icons FIRST
  await loadPoiIcons();
  try { _customIcons = await API.get('/api/icons'); } catch { }
  initFogCanvas();
  renderSidebar();
  renderAllFeatures();
  joinSocket(mapData.map.id);
  if (isAdmin) setupEditor();
  initScaleBar(mapData.map);
  initMeasureTool(mapData.map);
  if (authToken) initLockFeature(mapData.map.id);
  initSettingsMenu();
  // Apply saved settings
  if (_showPoiLabels) _renderPoiLabels();
  if (_showRegLabels) _renderRegionLabels();
  if (isAdmin && fogCanvas && _fogDensity !== 1.0) fogCanvas.setOpacity(_fogDensity);
}

// ── Pick mode: transparent overlay captures all clicks before Leaflet layers ─
let _pickOverlay = null;

function enablePickMode() {
  _pickModeActive = true;
  if (_pickOverlay) return;
  // Insert a full-size transparent div above all panes (z-index 699, below popups at 700)
  // This absorbs mousedown/click so Leaflet's vector/marker layers never see it.
  const overlay = document.createElement('div');
  overlay.id = 'pickModeOverlay';
  overlay.style.cssText =
    'position:absolute;inset:0;z-index:699;cursor:crosshair;background:transparent;';
  leafletMap.getContainer().appendChild(overlay);
  _pickOverlay = overlay;
}

function disablePickMode() {
  _pickModeActive = false;
  if (_pickOverlay) { _pickOverlay.remove(); _pickOverlay = null; }
  leafletMap.getContainer().style.cursor = '';
}

// ── Leaflet ────────────────────────────────────────────────────────────
function initLeaflet(map) {
  const W = map.image_width || 2000, H = map.image_height || 2000;
  leafletMap = L.map('map', { crs: L.CRS.Simple, minZoom: -3, maxZoom: 4, zoomSnap: 0.5 });
  const bounds = [[0, 0], [H, W]];
  if (map.image_path) {
    L.imageOverlay(map.image_path, bounds).addTo(leafletMap);
  } else {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>`
      + `<rect width='${W}' height='${H}' fill='#0d1117'/>`
      + `<text x='50%' y='50%' fill='#3b4261' font-size='24' text-anchor='middle' dominant-baseline='middle'>`
      + `Kein Kartenbild – Einstellungen öffnen</text></svg>`;
    L.imageOverlay('data:image/svg+xml,' + encodeURIComponent(svg), bounds).addTo(leafletMap);
  }
  leafletMap.fitBounds(bounds);
  leafletMap.setMaxBounds([[-H * .3, -W * .3], [H * 1.3, W * 1.3]]);
  // Track mouse position for 'p' key ping
  leafletMap.on('mousemove', e => { _lastMouseLatLng = e.latlng; });

  // Custom pane for routes to ensure they are rendered above regions (overlayPane has zIndex 400)
  leafletMap.createPane('routesPane');
  leafletMap.getPane('routesPane').style.zIndex = 410;
}
let _lastMouseLatLng = null;

// ── Special layers (public / hidden visibility) ────────────────────────
function initSpecialLayers() {
  globalLayers = {
    poiLayer: L.layerGroup().addTo(leafletMap),
    routeLayer: L.layerGroup().addTo(leafletMap),
    regionLayer: L.layerGroup().addTo(leafletMap),
    state: { visible: true, poi: true, route: true, region: true, _savedSubs: null }
  };
  hiddenLayers = {
    poiLayer: isAdmin ? L.layerGroup().addTo(leafletMap) : L.layerGroup(),
    routeLayer: isAdmin ? L.layerGroup().addTo(leafletMap) : L.layerGroup(),
    regionLayer: isAdmin ? L.layerGroup().addTo(leafletMap) : L.layerGroup(),
    state: { visible: isAdmin, poi: true, route: true, region: true, _savedSubs: null }
  };
}

function bucketsFor(item) {
  if (item.visibility === 'public') return { bucket: PUB, layers: globalLayers };
  if (item.visibility === 'hidden') return { bucket: HID, layers: hiddenLayers };
  const ls = layerState[item.group_id];
  return ls ? { bucket: 'group', layers: ls } : null;
}

// ── Fog canvas ─────────────────────────────────────────────────────────
function initFogCanvas() {
  fogCanvas = new FogCanvas(leafletMap, 'viewer');  // always black; opacity controls visibility

  // Default opacity: editors see 50%, viewers see 100%
  const _defOpacity = isAdmin ? (_getSetting('fogDensity', 0.5)) : 1.0;
  fogCanvas.setOpacity(_defOpacity);
  // Group fog areas by group_id and load into canvas
  const areasByGroup = {};
  (mapData.fog_areas || []).forEach(fa => {
    const coords = Array.isArray(fa.coordinates) ? fa.coordinates
      : (typeof fa.coordinates === 'string' ? JSON.parse(fa.coordinates) : []);
    if (!areasByGroup[fa.group_id]) areasByGroup[fa.group_id] = [];
    areasByGroup[fa.group_id].push(coords);
  });

  mapData.groups.forEach(g => {
    if (g.fog_of_war_enabled) {
      fogCanvas.setGroupAreas(g.id, areasByGroup[g.id] || []);
      const ls = layerState[g.id];
      fogCanvas.setGroupVisible(g.id, !!(ls && ls.fog && ls.visible));
    }
  });

  if (isAdmin) fogBrush = new FogBrush(leafletMap, fogCanvas, saveFogArea);
}

// ── Sidebar ─────────────────────────────────────────────────────────────
function renderSidebar() {
  let html = '';

  // Per-group entries
  html += mapData.groups.map(g => {
    const ls = layerState[g.id] || {};
    const links = Array.isArray(g.external_links) ? g.external_links : [];
    const hasFog = g.fog_of_war_enabled;
    return `
    <div class="group-item" id="gitem-${g.id}">
      <div class="group-item-header" onclick="toggleGroupCollapse(${g.id})">
        <span class="group-dot" style="background:${g.color}"></span>
        <span class="group-name">${escHtml(g.name)}</span>
        <button class="toggle ${ls.visible ? 'on' : ''} toggle-vis"
          data-gid="${g.id}" data-type="visible"
          onclick="event.stopPropagation();toggleLayer(${g.id},'visible',this)"
          title="Gruppe sichtbar"></button>
        <span class="group-arrow" id="garrow-${g.id}">▼</span>
      </div>
      <div class="group-layers" id="glayers-${g.id}">
        <div class="layer-row">
          <span>📍 POIs</span>
          <button class="toggle ${ls.poi ? 'on' : ''}" data-gid="${g.id}" data-type="poi"
            onclick="toggleLayer(${g.id},'poi',this)"></button>
        </div>
        <div class="layer-row">
          <span>🛤 Routen</span>
          <button class="toggle ${ls.route ? 'on' : ''}" data-gid="${g.id}" data-type="route"
            onclick="toggleLayer(${g.id},'route',this)"></button>
        </div>
        <div class="layer-row">
          <span>🏔 Regionen</span>
          <button class="toggle ${ls.region ? 'on' : ''}" data-gid="${g.id}" data-type="region"
            onclick="toggleLayer(${g.id},'region',this)"></button>
        </div>
        ${hasFog ? `<div class="layer-row">
          <span>🌫 Nebel</span>
          ${isAdmin
          ? `<button class="toggle ${ls.fog ? 'on' : ''}" data-gid="${g.id}" data-type="fog"
                onclick="toggleLayer(${g.id},'fog',this)"></button>`
          : `<span style="font-size:11px;color:var(--text-dim)">🔒</span>`}
        </div>` : ''}
        ${links.map(l => `<a href="${l.url}" target="_blank" class="group-link-item">→ ${escHtml(l.label || l.url)}</a>`).join('')}
      </div>
    </div>`;
  }).join('');

  // "Alle Gruppen" (public) entry
  const gs = globalLayers.state;
  html += `
  <div class="group-item" id="gitem-pub" style="border-top:1px solid var(--border);margin-top:.4rem;padding-top:.1rem">
    <div class="group-item-header" onclick="toggleGroupCollapse('pub')">
      <span class="group-dot" style="background:#a78bfa"></span>
      <span class="group-name">🌍 Alle Gruppen</span>
      <button class="toggle ${gs.visible ? 'on' : ''} toggle-vis"
        onclick="event.stopPropagation();toggleSpecialLayer('global','visible',this)"
        title="Sichtbar"></button>
      <span class="group-arrow" id="garrow-pub">▼</span>
    </div>
    <div class="group-layers" id="glayers-pub">
      <div class="layer-row"><span>📍 POIs</span>
        <button class="toggle ${gs.poi ? 'on' : ''}" onclick="toggleSpecialLayer('global','poi',this)"></button></div>
      <div class="layer-row"><span>🛤 Routen</span>
        <button class="toggle ${gs.route ? 'on' : ''}" onclick="toggleSpecialLayer('global','route',this)"></button></div>
      <div class="layer-row"><span>🏔 Regionen</span>
        <button class="toggle ${gs.region ? 'on' : ''}" onclick="toggleSpecialLayer('global','region',this)"></button></div>
    </div>
  </div>`;

  // "Versteckt" (admin only)
  if (isAdmin) {
    const hs = hiddenLayers.state;
    html += `
    <div class="group-item" id="gitem-hid">
      <div class="group-item-header" onclick="toggleGroupCollapse('hid')">
        <span class="group-dot" style="background:#6b7280"></span>
        <span class="group-name">🔒 Versteckt</span>
        <button class="toggle ${hs.visible ? 'on' : ''} toggle-vis"
          onclick="event.stopPropagation();toggleSpecialLayer('hidden','visible',this)"
          title="Sichtbar"></button>
        <span class="group-arrow" id="garrow-hid">▼</span>
      </div>
      <div class="group-layers" id="glayers-hid">
        <div class="layer-row"><span>📍 POIs</span>
          <button class="toggle ${hs.poi ? 'on' : ''}" onclick="toggleSpecialLayer('hidden','poi',this)"></button></div>
        <div class="layer-row"><span>🛤 Routen</span>
          <button class="toggle ${hs.route ? 'on' : ''}" onclick="toggleSpecialLayer('hidden','route',this)"></button></div>
        <div class="layer-row"><span>🏔 Regionen</span>
          <button class="toggle ${hs.region ? 'on' : ''}" onclick="toggleSpecialLayer('hidden','region',this)"></button></div>
      </div>
    </div>`;
  }

  document.getElementById('groupList').innerHTML = html;
}

function toggleGroupCollapse(gid) {
  const el = document.getElementById('glayers-' + gid);
  const ar = document.getElementById('garrow-' + gid);
  if (!el) return;
  el.classList.toggle('hidden');
  if (ar) ar.textContent = el.classList.contains('hidden') ? '▶' : '▼';
}

/**
 * Toggle for per-group layers.
 * visible OFF → save sub-states, turn all off.
 * visible ON  → restore saved sub-states (or all on).
 * sub ON       → auto-enable visible if needed.
 */
function toggleLayer(groupId, type, btn) {
  const ls = layerState[groupId];
  if (!ls) return;

  const newVal = !ls[type];
  ls[type] = newVal;
  btn.classList.toggle('on', newVal);

  if (type === 'visible') {
    if (!newVal) {
      // Save current sub-states then turn everything off
      ls._savedSubs = { poi: ls.poi, route: ls.route, region: ls.region, fog: ls.fog };
      _setGroupSubs(groupId, false);
    } else {
      // Restore or default to all on
      const saved = ls._savedSubs;
      ls._savedSubs = null;
      _setGroupSubs(groupId, true, saved);
    }
  } else {
    // Sub-toggle
    const layerKey = type + 'Layer';
    const lay = ls[layerKey];
    if (lay) newVal ? leafletMap.addLayer(lay) : leafletMap.removeLayer(lay);
    if (type === 'fog') {
      fogCanvas?.setGroupVisible(groupId, newVal && ls.visible);
    }
    // If turning ON while invisible → auto-enable visible
    if (newVal && !ls.visible) {
      ls.visible = true;
      const vBtn = document.querySelector(`[data-gid="${groupId}"][data-type="visible"]`);
      if (vBtn) vBtn.classList.add('on');
    }
    // Sync visible OFF: if all subs are now off, turn visible off too
    _syncVisibleBtn(groupId);
  }

  if (_showPoiLabels && (type === 'visible' || type === 'poi')) _renderPoiLabels();
  if (_showRegLabels && (type === 'visible' || type === 'region')) _renderRegionLabels();
}

/** Set all sub-layers for a group on or off, optionally restoring from savedSubs */
function _setGroupSubs(groupId, on, savedSubs = null) {
  const ls = layerState[groupId];
  if (!ls) return;
  ['poi', 'route', 'region'].forEach(t => {
    const val = on ? (savedSubs ? !!savedSubs[t] : true) : false;
    ls[t] = val;
    const lay = ls[t + 'Layer'];
    if (lay) (val && ls.visible) ? leafletMap.addLayer(lay) : leafletMap.removeLayer(lay);
    const btn = document.querySelector(`[data-gid="${groupId}"][data-type="${t}"]`);
    if (btn) btn.classList.toggle('on', val);
  });
  const fogVal = on ? (savedSubs ? !!savedSubs.fog : ls.fog) : false;
  ls.fog = fogVal;
  fogCanvas?.setGroupVisible(groupId, fogVal && ls.visible);
  const fogBtn = document.querySelector(`[data-gid="${groupId}"][data-type="fog"]`);
  if (fogBtn) fogBtn.classList.toggle('on', fogVal);
}

/** If all sub-layers are off, also turn visible indicator off (but don't remove anything extra) */
function _syncVisibleBtn(groupId) {
  const ls = layerState[groupId];
  if (!ls) return;
  const anyOn = ls.poi || ls.route || ls.region || ls.fog;
  if (!anyOn && ls.visible) {
    ls.visible = false;
    const vBtn = document.querySelector(`[data-gid="${groupId}"][data-type="visible"]`);
    if (vBtn) vBtn.classList.remove('on');
  }
}

/** Toggle for public/hidden special layers – mirrors group cascade logic */
function toggleSpecialLayer(which, type, btn) {
  const layers = which === 'global' ? globalLayers : hiddenLayers;
  const st = layers.state;
  const newVal = !st[type];
  st[type] = newVal;
  btn.classList.toggle('on', newVal);

  if (type === 'visible') {
    if (!newVal) {
      // Save sub-states and turn everything off
      st._savedSubs = { poi: st.poi, route: st.route, region: st.region };
      ['poi', 'route', 'region'].forEach(t => {
        st[t] = false;
        leafletMap.removeLayer(layers[t + 'Layer']);
      });
    } else {
      // Restore saved sub-states (or default all on)
      const saved = st._savedSubs;
      st._savedSubs = null;
      ['poi', 'route', 'region'].forEach(t => {
        const val = saved ? !!saved[t] : true;
        st[t] = val;
        val ? leafletMap.addLayer(layers[t + 'Layer'])
          : leafletMap.removeLayer(layers[t + 'Layer']);
      });
    }
    _syncSpecialBtns(which, st);
  } else {
    const lay = layers[type + 'Layer'];
    (newVal && st.visible) ? leafletMap.addLayer(lay) : leafletMap.removeLayer(lay);

    // Sub turned ON but group invisible → auto-enable visible
    if (newVal && !st.visible) {
      st.visible = true;
      _syncSpecialBtns(which, st);
    }
    // All subs now OFF → auto-disable visible indicator
    if (!st.poi && !st.route && !st.region && st.visible) {
      st.visible = false;
      _syncSpecialBtns(which, st);
    }
  }

  if (_showPoiLabels && (type === 'visible' || type === 'poi')) _renderPoiLabels();
  if (_showRegLabels && (type === 'visible' || type === 'region')) _renderRegionLabels();
}

/** Update all toggle buttons for a special layer group from state */
function _syncSpecialBtns(which, st) {
  const id = which === 'global' ? 'gitem-pub' : 'gitem-hid';
  const gitem = document.getElementById(id);
  if (!gitem) return;
  gitem.querySelectorAll('.toggle').forEach(b => {
    const oc = b.getAttribute('onclick') || '';
    if (oc.includes("'visible'")) b.classList.toggle('on', !!st.visible);
    else if (oc.includes("'poi'")) b.classList.toggle('on', !!st.poi);
    else if (oc.includes("'route'")) b.classList.toggle('on', !!st.route);
    else if (oc.includes("'region'")) b.classList.toggle('on', !!st.region);
  });
}

// ── Features ───────────────────────────────────────────────────────────
function renderAllFeatures() {
  mapData.pois.forEach(addPoi);
  const wpMap = {};
  (mapData.waypoints || []).forEach(w => {
    if (!wpMap[w.route_id]) wpMap[w.route_id] = [];
    wpMap[w.route_id].push(w);
  });
  mapData.routes.forEach(r => addRoute(r, wpMap[r.id] || []));
  mapData.regions.forEach(addRegion);
}

// ── POIs ───────────────────────────────────────────────────────────────
function makePoiIcon(color, iconKey, transparent) {
  const s = _poiMarkerSize;          // current size from settings
  const tip = Math.round(s * 0.35);   // triangle tip height
  const tot = s + tip;                // total height including tip
  const half = Math.round(s / 2);

  const bordColor = transparent ? color : '#bcbcbc';
  const fillColor = transparent ? 'transparent' : color;

  // Custom icon?
  const custId = +iconKey;
  const customIcon = !isNaN(custId) && _customIcons.find(ic => ic.id === custId);
  let innerHtml;
  if (customIcon) {
    const _isUrl = customIcon.image_url.startsWith('http') || customIcon.image_url.startsWith('/');
    innerHtml = _isUrl
      ? `<img src="${escHtml(customIcon.image_url)}" style="width:${s - 8}px;height:${s - 8}px;object-fit:contain" onerror="this.style.opacity='.2'">`
      : `<span style="font-size:${Math.round(s * 0.65)}px;line-height:1">${escHtml(customIcon.image_url)}</span>`;
  } else {
    const sym = POI_ICONS[iconKey] || '⬤';
    innerHtml = `<span style="font-size:${Math.round(s * 0.5)}px;line-height:1">${sym}</span>`;
  }

  // SVG pin: circle on top, triangle tip pointing down
  // The tip point is the anchor
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${tot}" viewBox="0 0 ${s} ${tot}" preserveAspectRatio="xMidYMid meet">
  <path 
    d="M ${half}, 1.5
       C ${s - 1}, 1.5, ${s - 1}, ${s * 0.6}, ${s - 1}, ${half + 2}
       C ${s - 1}, ${half + 6}, ${half + tip}, ${s - 2}, ${half}, ${tot - 1.5}
       C ${half - tip}, ${s - 2}, 1, ${half + 6}, 1, ${half + 2}
       C 1, ${s * 0.6}, 1, 1.5, ${half}, 1.5
       Z" 
    fill="${fillColor}" 
    fill-opacity="${transparent ? 0 : 0.5}" 
    stroke="${bordColor}" 
    stroke-width="2"
    stroke-linejoin="round"
  />
</svg>`;

  // Overlay the icon symbol centered in the circle
  const html = `<div style="position:relative;width:${s}px;height:${tot}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))">
    ${svg}
    <div style="position:absolute;top:0;left:0;width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;pointer-events:none">
      ${innerHtml}
    </div>
  </div>`;

  return L.divIcon({
    html,
    iconSize: [s, tot],
    iconAnchor: [half, tot],  // anchor at tip
    popupAnchor: [0, -tot],    // popup above tip
    className: ''
  });
}

/** Rebuild all POI markers (called when size/labels change) */
function rebuildAllPois() {
  mapData.pois.forEach(p => { removePoi(p.id); addPoi(p); });
  if (_showPoiLabels) _renderPoiLabels();
  else _removePoiLabels();
}

function addPoi(poi) {
  const b = bucketsFor(poi);
  if (!b) return;

  const links = Array.isArray(poi.links) ? poi.links : [];
  const pingBtn = isAdmin
    ? `<button class="btn btn-ghost btn-sm" onclick="pingFeature('poi',${poi.id})" title="Hervorheben & Betrachter hinlenken">📡 Ping</button>`
    : '';
  const adminBtns = isAdmin ? `
    <div class="popup-admin-actions">
      ${pingBtn}
      <button class="btn btn-ghost btn-sm" onclick="openEditPoi(${poi.id})">✏ Bearbeiten</button>
      <button class="btn btn-ghost btn-sm" onclick="rePickPoiPos(${poi.id})">📍 Position ändern</button>
      <button class="btn btn-danger btn-sm" onclick="deletePoi(${poi.id})">🗑</button>
    </div>` : '';
  const popup = `<div class="popup-content">
    <h4>${POI_ICONS[poi.icon] || '●'} ${escHtml(poi.name)}</h4>
    ${poi.description ? `<div class="popup-desc">${sanitizeDesc(poi.description)}</div>` : ''}
    ${links.length ? `<div class="popup-links">${links.map(l =>
    `<a href="${l.url}" target="_blank">${escHtml(l.label || l.url)}</a>`).join('')}</div>` : ''}
    ${adminBtns}
  </div>`;
  const marker = L.marker([+poi.lat, +poi.lng], {
    icon: makePoiIcon(poi.color, poi.icon, poi.bg_transparent)
  }).bindPopup(popup, { maxWidth: 270 });

  b.layers.poiLayer.addLayer(marker);
  poiLayers[poi.id] = { marker, bucket: b.bucket, groupId: poi.group_id };
}

function removePoi(id) {
  const e = poiLayers[id];
  if (!e) return;
  const lay = e.bucket === PUB ? globalLayers.poiLayer
    : e.bucket === HID ? hiddenLayers.poiLayer
      : layerState[e.groupId]?.poiLayer;
  lay?.removeLayer(e.marker);
  delete poiLayers[id];
}

async function deletePoi(id) {
  if (!confirm('POI löschen?')) return;
  leafletMap.closePopup();
  try { await API.delete(`/api/maps/${mapData.map.id}/pois/${id}`); }
  catch (e) { showToast(e.message, 'error'); }
}

function rePickPoiPos(id) {
  leafletMap.closePopup();
  const p = mapData.pois.find(x => x.id === id);
  if (!p) return;
  enablePickMode();
  showModeIndicator('📍 Klick auf Karte für neue Position · ESC abbrechen');
  leafletMap.once('click', async ev => {
    disablePickMode(); hideModeIndicator();
    try {
      await API.put(`/api/maps/${mapData.map.id}/pois/${id}`, {
        ...p, lat: ev.latlng.lat, lng: ev.latlng.lng,
        links: Array.isArray(p.links) ? p.links : []
      });
      showToast('Position aktualisiert', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  });
}

// ── Routes (Catmull-Rom smooth) ─────────────────────────────────────────
function catmullRom(pts, segs = 16) {
  const v = pts.filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));
  if (v.length < 3) return v;
  const p = [v[0], ...v, v[v.length - 1]];
  const out = [];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    for (let t = 0; t <= segs; t++) {
      const u = t / segs, u2 = u * u, u3 = u2 * u;
      const lat = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3);
      const lng = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3);
      if (isFinite(lat) && isFinite(lng)) out.push([lat, lng]);
    }
  }
  return out.length ? out : v;
}

function makePosIcon(color) {
  return L.divIcon({
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};` +
      `border:3px solid #fff;box-shadow:0 0 0 3px ${color}55"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9], className: ''
  });
}
function makeWpIcon(color, isLast) {
  if (isLast) return makePosIcon(color);
  return L.divIcon({
    html: `<div style="width:9px;height:9px;border-radius:50%;background:${color};` +
      `border:1.5px solid rgba(255,255,255,.8)"></div>`,
    iconSize: [9, 9], iconAnchor: [4, 4], className: ''
  });
}

function addRoute(route, waypoints) {
  // Routes use bucketsFor to support visibility=public/hidden like POIs
  const b = bucketsFor({ group_id: route.group_id, visibility: route.visibility || 'group' });
  if (!b || !waypoints.length) return;

  const coords = waypoints.map(w => [parseFloat(w.lat), parseFloat(w.lng)])
    .filter(c => isFinite(c[0]) && isFinite(c[1]));
  if (!coords.length) return;

  const display = (route.smooth !== false && coords.length >= 3) ? catmullRom(coords) : coords;
  const polyline = L.polyline(display, {
    color: route.color, weight: route.weight || 3, opacity: .9,
    dashArray: DASH_STYLE[route.line_style || 'solid'] || null,
    pane: 'routesPane'
  });

  const rPopup = `<div class="popup-content">
    <h4>🛤 ${escHtml(route.name)}</h4>
    ${route.description ? `<p>${escHtml(route.description)}</p>` : ''}
    ${isAdmin ? `<div class="popup-admin-actions">
      <button class="btn btn-ghost btn-sm" onclick="pingFeature('route',${route.id})">📡 Ping</button>
      <button class="btn btn-ghost btn-sm" onclick="openEditRoute(${route.id})">✏</button>
      <button class="btn btn-danger btn-sm" onclick="deleteRoute(${route.id})">🗑</button>
    </div>` : ''}
  </div>`;
  polyline.bindPopup(rPopup);
  b.layers.routeLayer.addLayer(polyline);

  const wpMarkers = [];
  waypoints.forEach((wp, idx) => {
    const isLast = idx === waypoints.length - 1;
    const lat = parseFloat(wp.lat), lng = parseFloat(wp.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;

    const adminWpBtns = isAdmin ? `
      <div class="popup-admin-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditWaypoint(${route.id},${wp.id})">✏ Info</button>
        <button class="btn btn-ghost btn-sm" onclick="rePickWaypointPos(${route.id},${wp.id})">📍 Position</button>
        <button class="btn btn-ghost btn-sm" onclick="insertWaypointAfter(${route.id},${wp.id},${wp.order_index})">➕ Vorher einfügen</button>
        <button class="btn btn-danger btn-sm" onclick="deleteWaypoint(${route.id},${wp.id})">🗑</button>
      </div>` : '';
    const wpPopup = `<div class="popup-content">
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:.25rem;text-transform:uppercase;letter-spacing:.05em">🛤 ${escHtml(route.name)}</div>
      ${wp.title ? `<h4>📌 ${escHtml(wp.title)}</h4>` : `<h4>${isLast ? '📍 Aktueller Standort' : `Wegpunkt ${idx + 1}`}</h4>`}
      ${wp.info ? `<p>${escHtml(wp.info)}</p>` : ''}
      ${adminWpBtns}
    </div>`;
    const m = L.marker([lat, lng], { icon: makeWpIcon(route.color, isLast) })
      .bindPopup(wpPopup, { maxWidth: 250 });
    b.layers.routeLayer.addLayer(m);
    wpMarkers.push(m);
  });

  routeLayers[route.id] = { polyline, wpMarkers, bucket: b.bucket, groupId: route.group_id, waypoints: [...waypoints] };
}

function removeRoute(id) {
  const e = routeLayers[id];
  if (!e) return;
  const lay = e.bucket === PUB ? globalLayers.routeLayer
    : e.bucket === HID ? hiddenLayers.routeLayer
      : layerState[e.groupId]?.routeLayer;
  if (lay) {
    lay.removeLayer(e.polyline);
    e.wpMarkers.forEach(m => lay.removeLayer(m));
  }
  delete routeLayers[id];
}

async function deleteRoute(id) {
  if (!confirm('Route löschen?')) return;
  leafletMap.closePopup();
  try { await API.delete(`/api/maps/${mapData.map.id}/routes/${id}`); }
  catch (e) { showToast(e.message, 'error'); }
}

/** Re-pick waypoint position from map popup */
function rePickWaypointPos(routeId, wpId) {
  leafletMap.closePopup();
  const wp = mapData.waypoints.find(w => w.id === wpId);
  if (!wp) return;
  enablePickMode();
  showModeIndicator('📍 Klick auf Karte für neue Wegpunkt-Position · ESC abbrechen');
  leafletMap.once('click', async ev => {
    disablePickMode(); hideModeIndicator();
    try {
      await API.put(`/api/maps/${mapData.map.id}/routes/${routeId}/waypoints/${wpId}`, {
        lat: ev.latlng.lat, lng: ev.latlng.lng,
        title: wp.title || '', info: wp.info || '',
        order_index: wp.order_index  // preserve order!
      });
      showToast('Position aktualisiert', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  });
}

// ── Regions ─────────────────────────────────────────────────────────────
function normalizeCoords(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    if (Array.isArray(c)) return [parseFloat(c[0]), parseFloat(c[1])];
    if (c?.lat != null) return [parseFloat(c.lat), parseFloat(c.lng)];
    return null;
  }).filter(c => c && isFinite(c[0]) && isFinite(c[1]));
}

function addRegion(region) {
  const b = bucketsFor(region);
  if (!b) return;
  const coords = normalizeCoords(region.coordinates);
  if (!coords.length) return;

  const poly = L.polygon(coords, {
    color: region.color, fillColor: region.color,
    fillOpacity: parseFloat(region.fill_opacity) || .2,
    opacity: parseFloat(region.stroke_opacity) || .8, weight: 2
  });
  const adminBtns = isAdmin ? `
    <div class="popup-admin-actions">
      <button class="btn btn-ghost btn-sm" onclick="pingFeature('region',${region.id})">📡 Ping</button>
      <button class="btn btn-ghost btn-sm" onclick="openEditRegion(${region.id})">✏ Info</button>
      <button class="btn btn-ghost btn-sm" onclick="editRegionVertices(${region.id})">🔷 Form</button>
      <button class="btn btn-ghost btn-sm" onclick="bringRegionToFront(${region.id})" title="Nach vorne">⬆</button>
      <button class="btn btn-ghost btn-sm" onclick="sendRegionToBack(${region.id})" title="Nach hinten">⬇</button>
      <button class="btn btn-danger btn-sm" onclick="deleteRegion(${region.id})">🗑</button>
    </div>` : '';
  poly.bindPopup(`<div class="popup-content">
    <h4>🏔 ${escHtml(region.name)}</h4>
    ${region.description ? `<div class="popup-desc">${sanitizeDesc(region.description)}</div>` : ''}
    ${adminBtns}
  </div>`);

  const baseFill = parseFloat(region.fill_opacity) || .2;
  poly.on('mouseover', () => poly.setStyle({ fillOpacity: Math.min(baseFill + 0.1, 0.9) }));
  poly.on('mouseout', () => poly.setStyle({ fillOpacity: baseFill }));

  b.layers.regionLayer.addLayer(poly);
  regionLayers[region.id] = { poly, bucket: b.bucket, groupId: region.group_id };
}

function removeRegion(id) {
  const e = regionLayers[id];
  if (!e) return;
  const lay = e.bucket === PUB ? globalLayers.regionLayer
    : e.bucket === HID ? hiddenLayers.regionLayer
      : layerState[e.groupId]?.regionLayer;
  lay?.removeLayer(e.poly);
  delete regionLayers[id];
}

async function deleteRegion(id) {
  if (!confirm('Region löschen?')) return;
  leafletMap.closePopup();
  try { await API.delete(`/api/maps/${mapData.map.id}/regions/${id}`); }
  catch (e) { showToast(e.message, 'error'); }
}

// ── Socket.io ──────────────────────────────────────────────────────────
function joinSocket(mapId) {
  socket.emit('join:map', { mapId, isEditor: isAdmin });

  socket.on('viewers:update', ({ count }) => {
    const el = document.getElementById('viewerCount');
    if (el) el.textContent = count > 1 ? ` 👁 ${count}` : '';
  });
  // Ensure fog stays visible for viewers after any group toggle
  if (!isAdmin) {
    const origToggle = window.toggleLayer;
    window.toggleLayer = function (groupId, type, btn) {
      if (type === 'fog') return; // viewers cannot toggle fog
      origToggle(groupId, type, btn);
      // After any toggle, re-apply fog for fog-enabled groups
      mapData.groups.filter(g => g.fog_of_war_enabled).forEach(g => {
        fogCanvas?.setGroupVisible(g.id, true);
      });
    };
  }

  socket.on('group:created', g => {
    if (mapData.groups.find(x => x.id === g.id)) return;
    mapData.groups.push(g);
    layerState[g.id] = {
      visible: true, poi: true, route: true, region: true, fog: g.fog_of_war_enabled,
      _savedSubs: null,
      poiLayer: L.layerGroup().addTo(leafletMap),
      routeLayer: L.layerGroup().addTo(leafletMap),
      regionLayer: L.layerGroup().addTo(leafletMap)
    };
    if (g.fog_of_war_enabled) { fogCanvas.data[g.id] = []; }
    renderSidebar(); refreshEditorContent();
  });
  socket.on('group:updated', g => {
    const i = mapData.groups.findIndex(x => x.id === g.id);
    if (i >= 0) mapData.groups[i] = g;
    renderSidebar(); refreshEditorContent();
  });
  socket.on('group:deleted', ({ id }) => {
    mapData.groups = mapData.groups.filter(x => x.id !== id);
    const ls = layerState[id];
    if (ls) {
      leafletMap.removeLayer(ls.poiLayer);
      leafletMap.removeLayer(ls.routeLayer);
      leafletMap.removeLayer(ls.regionLayer);
    }
    delete layerState[id];
    renderSidebar(); refreshEditorContent();
  });

  socket.on('poi:created', p => { if (!mapData.pois.find(x => x.id === p.id)) { mapData.pois.push(p); addPoi(p); if (_showPoiLabels) _renderPoiLabels(); refreshEditorContent(); } });
  socket.on('poi:updated', p => { mapData.pois = mapData.pois.map(x => x.id === p.id ? p : x); removePoi(p.id); addPoi(p); if (_showPoiLabels) _renderPoiLabels(); refreshEditorContent(); });
  socket.on('poi:deleted', ({ id }) => { mapData.pois = mapData.pois.filter(x => x.id !== id); removePoi(id); if (_showPoiLabels) _renderPoiLabels(); refreshEditorContent(); });

  socket.on('route:created', r => {
    if (!mapData.routes.find(x => x.id === r.id)) { mapData.routes.push(r); addRoute(r, r.waypoints || []); refreshEditorContent(); }
  });
  socket.on('route:updated', r => {
    mapData.routes = mapData.routes.map(x => x.id === r.id ? r : x);
    const wps = r.waypoints || mapData.waypoints.filter(w => w.route_id === r.id);
    removeRoute(r.id); addRoute(r, wps); refreshEditorContent();
  });
  socket.on('route:deleted', ({ id }) => { mapData.routes = mapData.routes.filter(x => x.id !== id); removeRoute(id); refreshEditorContent(); });
  socket.on('waypoints:updated', ({ route_id, waypoints }) => {
    mapData.waypoints = mapData.waypoints.filter(w => w.route_id !== route_id).concat(waypoints);
    const route = mapData.routes.find(r => r.id === route_id);
    if (route) { removeRoute(route_id); addRoute(route, waypoints); }
    refreshEditorContent();
  });

  socket.on('region:created', r => { if (!mapData.regions.find(x => x.id === r.id)) { mapData.regions.push(r); addRegion(r); if (_showRegLabels) _renderRegionLabels(); refreshEditorContent(); } });
  socket.on('region:updated', r => { mapData.regions = mapData.regions.map(x => x.id === r.id ? r : x); removeRegion(r.id); addRegion(r); if (_showRegLabels) _renderRegionLabels(); refreshEditorContent(); });
  socket.on('region:deleted', ({ id }) => { mapData.regions = mapData.regions.filter(x => x.id !== id); removeRegion(id); if (_showRegLabels) _renderRegionLabels(); refreshEditorContent(); });

  socket.on('fog:area:created', (area) => {
    if (!mapData.fog_areas) mapData.fog_areas = [];
    if (!mapData.fog_areas.find(a => a.id === area.id)) {
      mapData.fog_areas.push(area);
      _rebuildGroupFog(area.group_id);
      refreshEditorContent();
    }
  });
  socket.on('fog:area:deleted', ({ id, group_id }) => {
    mapData.fog_areas = (mapData.fog_areas || []).filter(a => a.id !== id);
    _rebuildGroupFog(group_id);
    refreshEditorContent();
  });
  socket.on('fog:group:cleared', ({ group_id }) => {
    mapData.fog_areas = (mapData.fog_areas || []).filter(a => a.group_id !== group_id);
    fogCanvas.clearGroup(group_id);
    refreshEditorContent();
  });
  socket.on('map:updated', m => { mapData.map = m; document.getElementById('mapTitle').textContent = m.name; });

  socket.on('map:locked', data => {
    _mapLockState = data;
    _updateLockUI();
    // If I am the admin (superadmin) and editor just locked: show warning
    const me = API.user();
    if (me && me.is_superadmin) {
      showToast(`🔒 Karte gesperrt von ${data.locked_by_name} – du siehst sie als Betrachter`, 'info');
    }
  });
  socket.on('map:unlocked', () => {
    _mapLockState = null;
    _updateLockUI();
  });
  socket.on('feature:ping', data => {
    if (!data) return;
    if (data.type === 'cursor') {
      _drawPing(data.lat, data.lng);
      if (data.moveView && !isAdmin) {
        leafletMap.flyTo([data.lat, data.lng], leafletMap.getZoom(), { animate: true, duration: 0.7 });
      }
    } else {
      _handleFeaturePing(data);
    }
  });

  socket.on('map:admin-peek', data => {
    // Editor receives this: admin is looking at the locked map
    const me = API.user();
    if (me && !me.is_superadmin) {
      showToast(`👁 ${data.admin_name} schaut gerade auf die gesperrte Karte`, 'info');
    }
  });
}

// ── UI controls ────────────────────────────────────────────────────────
document.getElementById('toggleSidebarBtn').addEventListener('click', () =>
  document.getElementById('mapSidebar').classList.toggle('open'));
document.getElementById('toggleEditorBtn')?.addEventListener('click', () => {
  document.getElementById('editorPanel').classList.toggle('hidden');
  refreshEditorContent();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideModeIndicator(); stopAnyDraw();
    if (_fogPolyCoords?.length) {
      _fogPolyLines?.forEach(l => leafletMap.removeLayer(l));
      _fogPolyCoords = []; _fogPolyLines = [];
      leafletMap.off('click', _onFogPolyClick); leafletMap.off('dblclick', _onFogPolyDblClick);
      fogCanvas?.clearPreview();
    }
    if (_pickModeActive) { disablePickMode(); leafletMap.off('click'); }
    if (_measureActive) stopMeasure();
    if (regionEditor) _destroyRegionEditor();
    leafletMap?.dragging.enable();
  }
  if (e.key === 'Enter') {
    if (drawingMode === 'region' && drawingCoords.length >= 3) { e.preventDefault(); finishRegionDraw(); }
    else if (_fogPolyCoords?.length >= 3) { e.preventDefault(); _finishFogPolygon(); }
    else if (regionEditorSaveFn) { e.preventDefault(); regionEditorSaveFn(); }
  }
});

let modeEl = null;
function showModeIndicator(text) {
  hideModeIndicator();
  modeEl = Object.assign(document.createElement('div'), { className: 'mode-indicator', textContent: text });
  document.body.appendChild(modeEl);
}
function hideModeIndicator() { modeEl?.remove(); modeEl = null; }

// ── Drawing state ──────────────────────────────────────────────────────
let drawingMode = null, drawingCoords = [], tempLines = [];

function stopAnyDraw() {
  if (drawingMode) disablePickMode();  // re-enable interactions
  drawingMode = null; drawingCoords = [];
  tempLines.forEach(l => leafletMap?.removeLayer(l)); tempLines = [];
  leafletMap?.off('click', _drawClick);
  leafletMap?.off('dblclick', _drawDblClick);
}

function _drawClick(e) {
  L.DomEvent.stopPropagation(e);  // prevent region popups during draw
  drawingCoords.push([e.latlng.lat, e.latlng.lng]);
  if (drawingCoords.length >= 2) {
    const line = L.polyline(drawingCoords.slice(-2),
      { color: '#fbbf24', weight: 3, dashArray: '8,5', opacity: 1.0 }).addTo(leafletMap);
    tempLines.push(line);
  }
}
function _drawDblClick(e) {
  L.DomEvent.stopPropagation(e);
  if (drawingMode === 'region' && drawingCoords.length >= 3) finishRegionDraw();
}

// ── Fog save (polygon-based) ───────────────────────────────────────────
async function saveFogArea(groupId, coords) {
  try {
    const area = await API.post(
      `/api/maps/${mapData.map.id}/fog/${groupId}/areas`,
      { name: 'Bereich', coordinates: coords }
    );
    // Update local state immediately
    if (!mapData.fog_areas) mapData.fog_areas = [];
    mapData.fog_areas.push(area);
    // Rebuild group areas from all stored areas
    _rebuildGroupFog(groupId);
    refreshEditorContent();
    showToast('Nebelbereich gespeichert', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

function _rebuildGroupFog(groupId) {
  const areas = (mapData.fog_areas || [])
    .filter(fa => fa.group_id === groupId)
    .map(fa => {
      const raw = fa.coordinates;
      return Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    });
  fogCanvas.setGroupAreas(groupId, areas);
}

// ═══════════════════════════════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════════════════════════════
let currentEditorTab = 'groups';

function setupEditor() {
  document.querySelectorAll('.etab').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.etab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentEditorTab = btn.dataset.tab;
      refreshEditorContent();
    })
  );
}

function refreshEditorContent() {
  if (!isAdmin || document.getElementById('editorPanel').classList.contains('hidden')) return;
  const c = document.getElementById('editorContent');
  const builders = { groups: buildGroupsEditor, pois: buildPoisEditor, routes: buildRoutesEditor, regions: buildRegionsEditor, fog: buildFogEditor };
  c.innerHTML = (builders[currentEditorTab] || buildGroupsEditor)();
}

// ── Groups editor ──────────────────────────────────────────────────────
function buildGroupsEditor() {
  const items = mapData.groups.map(g => `
    <div class="editor-item" onclick="openEditGroup(${g.id})">
      <span class="editor-item-dot" style="background:${g.color}"></span>
      <span class="editor-item-name">${escHtml(g.name)}</span>
      ${g.fog_of_war_enabled ? '<span style="font-size:10px;color:var(--text-dim)">🌫</span>' : ''}
      <button class="btn-icon" onclick="event.stopPropagation();deleteGroup(${g.id})">🗑</button>
    </div>`).join('');
  return `<div class="editor-section"><h4>Gruppen (${mapData.groups.length})</h4>
    ${items}
    <button class="btn btn-ghost editor-add-btn" onclick="openEditGroup(null)">+ Gruppe</button>
  </div>`;
}

function openEditGroup(id) {
  const g = id ? mapData.groups.find(x => x.id === id) : null;
  const links = g?.external_links || [];

  // Build share URL using current hostname (works behind any proxy/port)
  const shareUrl = g?.share_token
    ? `${window.location.origin}/map.html?t=${g.share_token}`
    : null;

  showFeatureModal(g ? 'Gruppe bearbeiten' : 'Neue Gruppe', `
    <form id="fmForm">
      ${shareUrl ? `<div class="form-group" style="background:var(--bg3);border-radius:var(--radius);padding:.6rem .75rem;margin-bottom:.8rem">
        <label style="margin-bottom:.35rem">🔗 Gruppen-Link (Betrachter)</label>
        <div style="display:flex;gap:.5rem">
          <input type="text" id="groupLinkInput" value="${escAttr(shareUrl)}" readonly
            style="font-size:11px;font-family:monospace">
          <button type="button" class="btn btn-ghost btn-sm" style="white-space:nowrap"
            onclick="navigator.clipboard.writeText(document.getElementById('groupLinkInput').value).then(()=>showToast('Link kopiert!','success'))">Kopieren</button>
        </div>
      </div>` : ''}
      <div class="form-group"><label>Name *</label><input id="fmName" value="${escAttr(g?.name || '')}" required></div>
      <div class="form-row">
        <div class="form-group"><label>Farbe</label><input type="color" id="fmColor" value="${g?.color || '#3b82f6'}"></div>
        <div class="form-group"><label>Sichtbar</label>
          <select id="fmVis"><option value="true" ${g?.visible !== false ? 'selected' : ''}>Ja</option><option value="false" ${g?.visible === false ? 'selected' : ''}>Nein</option></select></div>
      </div>
      <div class="form-group"><label>Fog of War</label>
        <select id="fmFog"><option value="false" ${!g?.fog_of_war_enabled ? 'selected' : ''}>Aus</option><option value="true" ${g?.fog_of_war_enabled ? 'selected' : ''}>An</option></select>
      </div>
      <div class="form-group"><label>Externe Links</label>
        <div id="linksList">${links.map((l, i) => linkRow(l.label, l.url, i)).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="addLinkRow()">+ Link</button>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeFeatureModal()">Abbrechen</button>
        <button type="submit" class="btn btn-primary">${g ? 'Speichern' : 'Erstellen'}</button>
      </div>
    </form>`);
  document.getElementById('fmForm').onsubmit = async e => {
    e.preventDefault();
    const body = {
      name: document.getElementById('fmName').value, color: document.getElementById('fmColor').value,
      visible: document.getElementById('fmVis').value === 'true',
      fog_of_war_enabled: document.getElementById('fmFog').value === 'true', external_links: gatherLinks()
    };
    try {
      if (g) await API.put(`/api/maps/${mapData.map.id}/groups/${g.id}`, body);
      else await API.post(`/api/maps/${mapData.map.id}/groups`, body);
      closeFeatureModal();
    } catch (ex) { showToast(ex.message, 'error'); }
  };
}

async function deleteGroup(id) {
  if (!confirm('Gruppe löschen?')) return;
  try { await API.delete(`/api/maps/${mapData.map.id}/groups/${id}`); }
  catch (e) { showToast(e.message, 'error'); }
}

// ── POI editor ──────────────────────────────────────────────────────────
function buildPoisEditor() {
  const sortedPois = _sortPois([...mapData.pois]);
  const items = sortedPois.map(p => {
    const visCls = { public: 'vis-public', group: 'vis-group', hidden: 'vis-hidden' }[p.visibility] || 'vis-group';
    const visLbl = { public: '🌍', group: '👥', hidden: '🔒' }[p.visibility] || '👥';
    return `<div class="editor-item" onclick="focusPoi(${p.id})"
        onmouseenter="highlightPoi(${p.id})" onmouseleave="unhighlightFeature()">
      <span style="font-size:14px">${_poiIconHtml(p.icon)}</span>
      <span class="editor-item-name">${escHtml(p.name)}</span>
      <span class="vis-badge ${visCls}">${visLbl}</span>
      <button class="btn-icon" title="Bearbeiten" onclick="event.stopPropagation();openEditPoi(${p.id})">✏</button>
      <button class="btn-icon" onclick="event.stopPropagation();deletePoi(${p.id})">🗑</button>
    </div>`;
  }).join('');
  const sortOpts = [
    ['default', 'Standard'], ['alpha', 'A–Z'], ['group', 'Gruppe'],
    ['icon', 'Icon'], ['x', 'Links→Rechts'], ['y', 'Oben→Unten']
  ].map(([v, l]) => `<option value="${v}" ${_poiSortMode === v ? 'selected' : ''}>${l}</option>`).join('');
  return `<div class="editor-section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem">
      <h4>POIs (${mapData.pois.length})</h4>
      <select style="font-size:11px;width:auto;padding:.2rem .4rem" onchange="_poiSortMode=this.value;refreshEditorContent()">
        ${sortOpts}
      </select>
    </div>
    ${items}
    <button class="btn btn-ghost editor-add-btn" onclick="startPlacePoi()">+ POI platzieren</button>
  </div>`;
}

function _sortPois(pois) {
  if (_poiSortMode === 'alpha') return pois.sort((a, b) => a.name.localeCompare(b.name));
  if (_poiSortMode === 'group') return pois.sort((a, b) => (a.group_id || 0) - (b.group_id || 0));
  if (_poiSortMode === 'icon') return pois.sort((a, b) => (a.icon || '').localeCompare(b.icon || ''));
  if (_poiSortMode === 'x') return pois.sort((a, b) => +a.lng - +b.lng);
  if (_poiSortMode === 'y') return pois.sort((a, b) => +b.lat - +a.lat); // higher y = further up
  return pois; // default: insertion order
}

function startPlacePoi() {
  if (!mapData.groups.length) { showToast('Erst eine Gruppe erstellen', 'error'); return; }
  enablePickMode();
  showModeIndicator('📍 Klick auf Karte · ESC abbrechen');
  leafletMap.once('click', e => { disablePickMode(); hideModeIndicator(); showPoiModal(null, e.latlng.lat, e.latlng.lng); });
}

function openEditPoi(id) {
  const p = mapData.pois.find(x => x.id === id);
  if (!p) return;
  leafletMap.closePopup();
  showPoiModal(p, +p.lat, +p.lng);
}

function showPoiModal(p, lat, lng) {
  const links = p?.links || [];
  showFeatureModal(p ? 'POI bearbeiten' : 'Neuer POI', `
    <form id="fmForm">
      <div class="form-group"><label>Name *</label><input id="fmName" value="${escAttr(p?.name || '')}" required></div>
      <div class="form-group"><label>Beschreibung</label><div id="fmDescQuill" class="quill-container"></div></div>
      <div class="form-group"><label>Gruppe / Sichtbarkeit</label>${targetSelect('fmTarget', p?.group_id, p?.visibility ?? 'public')}</div>
      <div class="form-group"><label>Icon</label>${iconGrid(p?.icon)}</div>
      <div class="form-group"><label>Farbe & Hintergrund</label>
        <div class="color-transparent-row">
          <input type="color" id="fmColor" value="${p?.color || '#3b82f6'}"
            style="${p?.bg_transparent ? 'opacity:.35;pointer-events:none' : ''}"
            title="Hintergrundfarbe">
          <div id="fmTransparentSwatch"
            class="transparent-swatch ${p?.bg_transparent ? 'selected' : ''}"
            onclick="toggleTransparentSwatch()"
            title="Transparenter Hintergrund – nur das Icon wird angezeigt"></div>
          <span class="color-hint" id="fmTransparentLabel" style="${p?.bg_transparent ? '' : 'display:none'}">Transparent</span>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Y (lat)</label><input type="number" id="fmLat" value="${lat}" step="0.1"></div>
        <div class="form-group"><label>X (lng)</label><input type="number" id="fmLng" value="${lng}" step="0.1"></div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="pickPosBtn" style="margin-bottom:.6rem">📍 Position auf Karte wählen</button>
      <div class="form-group"><label>Links</label>
        <div id="linksList">${links.map((l, i) => linkRow(l.label, l.url, i)).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="addLinkRow()">+ Link</button>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeFeatureModal()">Abbrechen</button>
        <button type="submit" class="btn btn-primary">${p ? 'Speichern' : 'Erstellen'}</button>
      </div>
    </form>`);

  // Init Quill editor for description
  const _pQuill = initQuill('fmDescQuill', p?.description || '');

  document.getElementById('pickPosBtn').onclick = () => {
    closeFeatureModal();
    enablePickMode();
    showModeIndicator('📍 Klick auf Karte für neue Position · ESC abbrechen');
    leafletMap.once('click', ev => { disablePickMode(); hideModeIndicator(); showPoiModal(p, ev.latlng.lat, ev.latlng.lng); });
  };
  document.getElementById('fmForm').onsubmit = async e => {
    e.preventDefault();
    const { visibility, group_id } = parseTarget('fmTarget');
    const body = {
      group_id, visibility, name: document.getElementById('fmName').value,
      description: getQuillHtml(_pQuill),
      lat: +document.getElementById('fmLat').value, lng: +document.getElementById('fmLng').value,
      icon: document.querySelector('.icon-option.selected')?.dataset.icon || 'circle',
      color: document.getElementById('fmColor').value,
      bg_transparent: document.getElementById('fmTransparentSwatch').classList.contains('selected'),
      links: gatherLinks()
    };
    try {
      if (p) await API.put(`/api/maps/${mapData.map.id}/pois/${p.id}`, body);
      else await API.post(`/api/maps/${mapData.map.id}/pois`, body);
      closeFeatureModal();
    } catch (ex) { showToast(ex.message, 'error'); }
  };
}

function toggleTransparentSwatch() {
  const sw = document.getElementById('fmTransparentSwatch');
  const col = document.getElementById('fmColor');
  const lbl = document.getElementById('fmTransparentLabel');
  if (!sw) return;
  const sel = !sw.classList.contains('selected');
  sw.classList.toggle('selected', sel);
  if (col) { col.style.opacity = sel ? '.35' : '1'; col.style.pointerEvents = sel ? 'none' : ''; }
  if (lbl) lbl.style.display = sel ? '' : 'none';
}

function iconGrid(current = 'circle') {
  // Show currently selected icon
  const custId = +current;
  const selCust = !isNaN(custId) && custId > 0 && _customIcons.find(ic => ic.id === custId);
  let selHtml;
  if (selCust) {
    const isUrl = selCust.image_url.startsWith('http') || selCust.image_url.startsWith('/');
    selHtml = isUrl
      ? `<img src="${escHtml(selCust.image_url)}" style="width:20px;height:20px;object-fit:contain">`
      : `<span style="font-size:18px">${escHtml(selCust.image_url)}</span>`;
  } else {
    selHtml = `<span style="font-size:18px">${POI_ICONS[current] || '⬤'}</span>`;
  }

  // Build grouped sections
  let groupsHtml = '';
  // grpData ist jetzt das Objekt { label: "...", icons: {...} }
  for (const [key, grpData] of Object.entries(POI_ICONS_GROUPED)) {
    const displayLabel = grpData.label || key; // Nutze Label, sonst Key (settlements)
    const iconsMap = grpData.icons || {};      // Die eigentlichen Icons

    const hasSelected = !selCust && Object.keys(iconsMap).includes(current);

    const cells = Object.entries(iconsMap).map(([k, v]) =>
      `<div class="icon-option${k === current ? ' selected' : ''}" data-icon="${k}"
            onclick="selectIcon(this)" title="${k}">${v}</div>`
    ).join('');

    groupsHtml += `<div class="icon-group${hasSelected ? ' open' : ''}">
      <div class="icon-group-label" onclick="this.parentElement.classList.toggle('open')">${escHtml(displayLabel)}</div>
      <div class="icon-group-grid">${cells}</div>
    </div>`;
  }

  // Custom icons section (unverändert)
  if (_customIcons.length) {
    const hasSelected = !!selCust;
    const cells = _customIcons.map(ic => {
      const isUrl = ic.image_url.startsWith('http') || ic.image_url.startsWith('/');
      const inner = isUrl
        ? `<img src="${escHtml(ic.image_url)}" style="width:25px;height:25px;object-fit:contain" onerror="this.style.opacity='.2'">`
        : `<span style="font-size:18px;line-height:1">${escHtml(ic.image_url)}</span>`;
      return `<div class="icon-option${+ic.id === custId ? ' selected' : ''}" data-icon="${ic.id}"
                   onclick="selectIcon(this)" title="${escHtml(ic.name)}" style="padding:.1rem">${inner}</div>`;
    }).join('');
    groupsHtml += `<div class="icon-group${hasSelected ? ' open' : ''}">
      <div class="icon-group-label" onclick="this.parentElement.classList.toggle('open')">Eigene Icons</div>
      <div class="icon-group-grid">${cells}</div>
    </div>`;
  }

  return `<div class="icon-picker">
    <div class="icon-picker-selected" onclick="document.getElementById('iconPickerDropdown')?.classList.toggle('hidden')">
      <span class="icon-picker-preview">${selHtml}</span>
      <span style="font-size:12px;flex:1">${escHtml(selCust?.name || current)}</span>
      <span style="font-size:10px;color:var(--text-dim)">&#x25BC;</span>
    </div>
    <div id="iconPickerDropdown" class="icon-picker-dropdown hidden">
      ${groupsHtml}
    </div>
  </div>`;
}


function selectIcon(el) {
  document.querySelectorAll('.icon-option').forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
  const prev = document.querySelector('.icon-picker-preview');
  const lbl = document.querySelector('.icon-picker-selected span[style*="flex"]');
  if (prev) prev.innerHTML = el.innerHTML;
  if (lbl) lbl.textContent = el.title || el.dataset.icon;
  document.getElementById('iconPickerDropdown')?.classList.add('hidden');
}

// ── Route editor ────────────────────────────────────────────────────────
function buildRoutesEditor() {
  const items = mapData.routes.map(r => {
    const wps = mapData.waypoints.filter(w => w.route_id === r.id);
    const vis = r.visibility || 'group';
    const visCls = { public: 'vis-public', group: 'vis-group', hidden: 'vis-hidden' }[vis] || 'vis-group';
    const visLbl = { public: '🌍', group: '👥', hidden: '🔒' }[vis] || '👥';
    return `<div class="editor-item" onclick="focusRoute(${r.id})"
        onmouseenter="highlightRoute(${r.id})" onmouseleave="unhighlightFeature()">
      <span class="editor-item-dot" style="background:${r.color}"></span>
      <span class="editor-item-name">${escHtml(r.name)} <span style="color:var(--text-dim);font-size:10px">(${wps.length})</span></span>
      <span class="vis-badge ${visCls}">${visLbl}</span>
      <button class="btn-icon" title="Bearbeiten" onclick="event.stopPropagation();openEditRoute(${r.id})">✏</button>
      <button class="btn-icon" onclick="event.stopPropagation();deleteRoute(${r.id})">🗑</button>
    </div>`;
  }).join('');
  return `<div class="editor-section"><h4>Routen (${mapData.routes.length})</h4>
    ${items}
    <button class="btn btn-ghost editor-add-btn" onclick="openEditRoute(null)">+ Route erstellen</button>
  </div>`;
}

function openEditRoute(id) {
  const r = id ? mapData.routes.find(x => x.id === id) : null;
  const wps = id ? mapData.waypoints.filter(w => w.route_id === id).sort((a, b) => a.order_index - b.order_index) : [];

  const wpHtml = wps.map((wp, i) => `
    <div class="waypoint-item">
      <div class="waypoint-idx">${i + 1}</div>
      <div class="waypoint-info">
        <div class="waypoint-title">${wp.title ? escHtml(wp.title) : (i === wps.length - 1 ? '📍 Standort' : `Punkt ${i + 1}`)}</div>
        <div class="waypoint-coords">${parseFloat(wp.lat).toFixed(1)}, ${parseFloat(wp.lng).toFixed(1)}</div>
      </div>
      <button type="button" class="btn-icon" onclick="openEditWaypoint(${r?.id},${wp.id})" title="Bearbeiten">✏</button>
      <button type="button" class="btn-icon" onclick="rePickWaypointPos(${r?.id},${wp.id})" title="Position wählen">📍</button>
      <button type="button" class="btn-icon" onclick="insertWaypointAfter(${r?.id},${wp.id},${wp.order_index})" title="Zwischenpunkt vorher einfügen">➕</button>
      <button type="button" class="btn-icon" onclick="deleteWaypoint(${r?.id},${wp.id})" title="Löschen">🗑</button>
    </div>`).join('');

  showFeatureModal(r ? 'Route bearbeiten' : 'Neue Route', `
    <form id="fmForm">
      <div class="form-group"><label>Name *</label><input id="fmName" value="${escAttr(r?.name || '')}" required></div>
      <div class="form-group"><label>Beschreibung</label><textarea id="fmDesc" rows="2">${escHtml(r?.description || '')}</textarea></div>
      <div class="form-group"><label>Gruppe</label>${targetSelect('fmTarget', r?.group_id, r?.visibility || 'group')}</div>
      <div class="form-row">
        <div class="form-group"><label>Farbe</label><input type="color" id="fmColor" value="${r?.color || '#ef4444'}"></div>
        <div class="form-group"><label>Breite</label><input type="number" id="fmWeight" value="${r?.weight || 3}" min="1" max="12"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Stil</label>
          <select id="fmStyle">
            <option value="solid" ${r?.line_style === 'solid' || !r ? 'selected' : ''}>Durchgezogen</option>
            <option value="dashed" ${r?.line_style === 'dashed' ? 'selected' : ''}>Gestrichelt</option>
            <option value="dotted" ${r?.line_style === 'dotted' ? 'selected' : ''}>Gepunktet</option>
          </select>
        </div>
        <div class="form-group"><label>Gerundet</label>
          <select id="fmSmooth">
            <option value="true" ${r?.smooth !== false ? 'selected' : ''}>Ja</option>
            <option value="false" ${r?.smooth === false ? 'selected' : ''}>Nein</option>
          </select>
        </div>
      </div>
      ${r ? `<div class="form-group">
        <label>Wegpunkte (${wps.length})</label>
        <div class="waypoint-list">${wpHtml}</div>
        <button type="button" class="btn btn-ghost editor-add-btn" id="addWpBtn">+ Wegpunkt auf Karte setzen</button>
      </div>` : ''}
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeFeatureModal()">Abbrechen</button>
        <button type="submit" class="btn btn-primary">${r ? 'Speichern' : 'Erstellen'}</button>
      </div>
    </form>`);

  document.getElementById('addWpBtn')?.addEventListener('click', () => {
    closeFeatureModal();
    enablePickMode();
    showModeIndicator('📍 Klick auf Karte für neuen Wegpunkt · ESC abbrechen');
    leafletMap.once('click', async ev => {
      disablePickMode(); hideModeIndicator();
      // Compute next order_index (max existing + 1)
      const existing = mapData.waypoints.filter(w => w.route_id === r.id);
      const nextIdx = existing.length ? Math.max(...existing.map(w => +w.order_index)) + 1 : 0;
      try {
        await API.post(`/api/maps/${mapData.map.id}/routes/${r.id}/waypoints`, {
          lat: ev.latlng.lat, lng: ev.latlng.lng,
          title: '', info: '', order_index: nextIdx
        });
        showToast('Wegpunkt hinzugefügt', 'success');
      } catch (ex) { showToast(ex.message, 'error'); }
    });
  });

  document.getElementById('fmForm').onsubmit = async e => {
    e.preventDefault();
    const { group_id, visibility } = parseTarget('fmTarget');
    const body = {
      group_id, visibility, name: document.getElementById('fmName').value,
      description: document.getElementById('fmDesc').value,
      color: document.getElementById('fmColor').value,
      weight: +document.getElementById('fmWeight').value,
      line_style: document.getElementById('fmStyle').value,
      smooth: document.getElementById('fmSmooth').value === 'true'
    };
    try {
      if (r) await API.put(`/api/maps/${mapData.map.id}/routes/${r.id}`, body);
      else await API.post(`/api/maps/${mapData.map.id}/routes`, body);
      closeFeatureModal();
    } catch (ex) { showToast(ex.message, 'error'); }
  };
}

function openEditWaypoint(routeId, wpId) {
  const wp = mapData.waypoints.find(w => w.id === wpId);
  if (!wp) return;
  showFeatureModal('Wegpunkt bearbeiten', `
    <form id="fmForm">
      <div class="form-group"><label>Titel</label><input id="wpTitle" value="${escAttr(wp.title || '')}"></div>
      <div class="form-group"><label>Info / Ereignis</label><textarea id="wpInfo" rows="3">${escHtml(wp.info || '')}</textarea></div>
      <p class="hint">Position: ${parseFloat(wp.lat).toFixed(2)}, ${parseFloat(wp.lng).toFixed(2)}
        <button type="button" class="btn btn-ghost btn-sm" id="pickWpBtn" style="margin-left:.5rem">📍 Neu wählen</button>
      </p>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeFeatureModal()">Abbrechen</button>
        <button type="submit" class="btn btn-primary">Speichern</button>
      </div>
    </form>`);

  document.getElementById('pickWpBtn').onclick = () => {
    closeFeatureModal();
    enablePickMode();
    showModeIndicator('📍 Klick auf Karte für neue Position · ESC abbrechen');
    leafletMap.once('click', ev => {
      disablePickMode(); hideModeIndicator();
      const idx = mapData.waypoints.findIndex(w => w.id === wpId);
      if (idx >= 0) mapData.waypoints[idx] = { ...mapData.waypoints[idx], lat: ev.latlng.lat, lng: ev.latlng.lng };
      openEditWaypoint(routeId, wpId);
    });
  };

  document.getElementById('fmForm').onsubmit = async e => {
    e.preventDefault();
    const current = mapData.waypoints.find(w => w.id === wpId); // may have updated lat/lng from pick
    try {
      await API.put(`/api/maps/${mapData.map.id}/routes/${routeId}/waypoints/${wpId}`, {
        lat: +current.lat,
        lng: +current.lng,
        title: document.getElementById('wpTitle').value,
        info: document.getElementById('wpInfo').value,
        order_index: +current.order_index  // preserve exact order!
      });
      closeFeatureModal();
    } catch (ex) { showToast(ex.message, 'error'); }
  };
}

async function deleteWaypoint(routeId, wpId) {
  if (!confirm('Wegpunkt löschen?')) return;
  leafletMap.closePopup();
  try { await API.delete(`/api/maps/${mapData.map.id}/routes/${routeId}/waypoints/${wpId}`); }
  catch (e) { showToast(e.message, 'error'); }
}

function insertWaypointAfter(routeId, afterWpId, afterIdx) {
  closeFeatureModal();
  enablePickMode();
  showModeIndicator('📍 Klick auf Karte für Zwischenpunkt vorher · ESC abbrechen');
  leafletMap.once('click', async ev => {
    disablePickMode(); hideModeIndicator();
    try {
      // Insert BEFORE the selected point: use afterIdx - 0.5
      await API.post(`/api/maps/${mapData.map.id}/routes/${routeId}/waypoints`, {
        lat: ev.latlng.lat, lng: ev.latlng.lng,
        title: '', info: '', order_index: afterIdx - 0.5
      });
      showToast('Zwischenpunkt eingefügt', 'success');
    } catch (ex) { showToast(ex.message, 'error'); }
  });
}

// ── Region editor ───────────────────────────────────────────────────────
function buildRegionsEditor() {
  const items = mapData.regions.map(r => {
    const visCls = { public: 'vis-public', group: 'vis-group', hidden: 'vis-hidden' }[r.visibility] || 'vis-group';
    const visLbl = { public: '🌍', group: '👥', hidden: '🔒' }[r.visibility] || '👥';
    return `<div class="editor-item" onclick="focusRegion(${r.id})"
        onmouseenter="highlightRegion(${r.id})" onmouseleave="unhighlightFeature()">
      <span class="editor-item-dot" style="background:${r.color}"></span>
      <span class="editor-item-name">${escHtml(r.name)}</span>
      <span class="vis-badge ${visCls}">${visLbl}</span>
      <button class="btn-icon" title="Bearbeiten" onclick="event.stopPropagation();openEditRegion(${r.id})">✏</button>
      <button class="btn-icon" onclick="event.stopPropagation();deleteRegion(${r.id})">🗑</button>
    </div>`;
  }).join('');
  return `<div class="editor-section"><h4>Regionen (${mapData.regions.length})</h4>
    ${items}
    <button class="btn btn-ghost editor-add-btn" onclick="startDrawRegion()">+ Region zeichnen</button>
  </div>
  <p class="hint" style="padding:.2rem .4rem;font-size:11px">Zeichnen: Klicken · Enter/Doppelklick fertig · ESC abbrechen</p>`;
}

function startDrawRegion() {
  if (!mapData.groups.length) { showToast('Erst eine Gruppe erstellen', 'error'); return; }
  stopAnyDraw();
  drawingMode = 'region';
  enablePickMode();  // suppress region/poi clicks while drawing
  showModeIndicator('🏔 Punkte klicken · Enter/Doppelklick fertig · ESC abbrechen');
  leafletMap.on('click', _drawClick);
  leafletMap.on('dblclick', _drawDblClick);
}

function finishRegionDraw() {
  const coords = [...drawingCoords];
  stopAnyDraw();
  disablePickMode();
  hideModeIndicator();
  showRegionModal(null, coords);
}

function openEditRegion(id) {
  const r = mapData.regions.find(x => x.id === id);
  if (!r) return;
  leafletMap.closePopup();
  showRegionModal(r, normalizeCoords(r.coordinates));
}

function editRegionVertices(id) {
  const r = mapData.regions.find(x => x.id === id);
  if (!r) return;
  leafletMap.closePopup();
  _destroyRegionEditor();

  let coords = normalizeCoords(r.coordinates);
  regionEditor = new RegionVertexEditor(leafletMap, coords, (c) => { coords = c; });

  showModeIndicator('🔷 Punkte ziehen · Klick auf Mitte: einfügen · Rechtsklick: löschen · Enter oder ✓ zum Speichern');

  const doneBtn = document.createElement('button');
  doneBtn.textContent = '✓ Änderungen speichern';
  doneBtn.className = 'btn btn-primary';
  doneBtn.style.cssText = 'position:absolute;bottom:70px;right:12px;z-index:450;box-shadow:var(--shadow)';
  doneBtn.id = 'regionDoneBtn';
  document.getElementById('map').appendChild(doneBtn);

  const saveFn = async () => {
    const finalCoords = regionEditor.getCoords();
    _destroyRegionEditor();
    hideModeIndicator();
    try {
      await API.put(`/api/maps/${mapData.map.id}/regions/${r.id}`, {
        group_id: r.group_id, name: r.name, description: r.description || '',
        coordinates: finalCoords, color: r.color,
        fill_opacity: r.fill_opacity, stroke_opacity: r.stroke_opacity,
        visibility: r.visibility
      });
      showToast('Region gespeichert', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  };
  doneBtn.onclick = saveFn;
  regionEditorSaveFn = saveFn; // triggered by Enter key
}

function _destroyRegionEditor() {
  regionEditor?.destroy(); regionEditor = null;
  regionEditorSaveFn = null;
  document.getElementById('regionDoneBtn')?.remove();
}

function showRegionModal(r, coords) {
  showFeatureModal(r ? 'Region bearbeiten' : 'Neue Region', `
    <form id="fmForm">
      <div class="form-group"><label>Name *</label><input id="fmName" value="${escAttr(r?.name || '')}" required></div>
      <div class="form-group"><label>Beschreibung</label><div id="fmDescQuill" class="quill-container"></div></div>
      <div class="form-group"><label>Gruppe / Sichtbarkeit</label>${targetSelect('fmTarget', r?.group_id, r?.visibility ?? 'public')}</div>
      <div class="form-row">
        <div class="form-group"><label>Farbe</label><input type="color" id="fmColor" value="${r?.color || '#22c55e'}"></div>
        <div class="form-group"><label>Füllung (0–1)</label><input type="number" id="fmFill" value="${r?.fill_opacity ?? 0.1}" step=".05" min="0" max="1"></div>
      </div>
      <p class="hint">${coords?.length || 0} Punkte · Form über Popup → 🔷 ändern</p>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeFeatureModal()">Abbrechen</button>
        <button type="submit" class="btn btn-primary">${r ? 'Speichern' : 'Erstellen'}</button>
      </div>
    </form>`);
  const _rQuill = initQuill('fmDescQuill', r?.description || '');
  document.getElementById('fmForm').onsubmit = async e => {
    e.preventDefault();
    const { visibility, group_id } = parseTarget('fmTarget');
    const body = {
      group_id, visibility, name: document.getElementById('fmName').value,
      description: getQuillHtml(_rQuill), coordinates: coords,
      color: document.getElementById('fmColor').value,
      fill_opacity: +document.getElementById('fmFill').value, stroke_opacity: .85
    };
    try {
      if (r) await API.put(`/api/maps/${mapData.map.id}/regions/${r.id}`, body);
      else await API.post(`/api/maps/${mapData.map.id}/regions`, body);
      closeFeatureModal();
    } catch (ex) { showToast(ex.message, 'error'); }
  };
}

// ── Fog editor ───────────────────────────────────────────────────────────
function buildFogEditor() {
  const fogGs = mapData.groups.filter(g => g.fog_of_war_enabled);
  if (!fogGs.length) {
    return `<div class="editor-section"><h4>Nebel der Ungewissheit</h4>
      <p class="hint">Aktiviere Fog of War in einer Gruppe um Bereiche zu enthüllen.</p></div>`;
  }
  const items = fogGs.map(g => {
    const areas = (mapData.fog_areas || []).filter(a => a.group_id === g.id);
    const areaList = areas.map((a, i) => `
      <div class="fog-area-item"
        onmouseenter="highlightFogArea(${a.id},${g.id})"
        onmouseleave="unhighlightFogArea()">
        <span class="fog-area-name">${escHtml(a.name || 'Bereich ' + (i + 1))}</span>
        <span style="font-size:10px;color:var(--text-dim)">${_countCoords(a)} Punkte</span>
        <button class="btn-icon" style="color:#fca5a5" onclick="deleteFogArea(${a.id},${g.id})" title="Löschen">🗑</button>
      </div>`).join('');
    return `<div class="fog-group-block">
      <div class="fog-group-header">
        <span class="fog-group-dot" style="background:${g.color}"></span>
        <strong style="font-size:12px">${escHtml(g.name)}</strong>
        <span style="font-size:10px;color:var(--text-dim)">${areas.length} Bereich(e)</span>
      </div>
      ${areaList}
      <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.4rem">
        <button class="btn btn-ghost btn-sm fog-tool-btn" id="fogBrushBtn-${g.id}" onclick="startFogBrush(${g.id})">🖌 Pinsel</button>
        <button class="btn btn-ghost btn-sm fog-tool-btn" id="fogPolyBtn-${g.id}" onclick="startFogPolygon(${g.id})">🔷 Polygon</button>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto;color:#fca5a5;border-color:rgba(239,68,68,.3)" onclick="clearFogGroup(${g.id})">🗑 Alle</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="editor-section">
    <h4>Nebel der Ungewissheit</h4>
    ${items}
  </div>
  <p class="hint" style="padding:.2rem .4rem;font-size:11px">
    Grauer Schleier = Editor · Schwarz = Betrachter<br>
    Alles verdeckt. Bereiche enthüllen mit 🖌 Pinsel (malt Polygon) oder 🔷 Polygon zeichnen.<br>
    Zum Verbergen: 🗑 Bereich löschen.
  </p>`;
}

function _countCoords(area) {
  try { return (Array.isArray(area.coordinates) ? area.coordinates : JSON.parse(area.coordinates || '[]')).length; }
  catch { return 0; }
}

// ── Brush mode ────────────────────────────────────────────────────────
function _setActiveFogBtn(id) {
  document.querySelectorAll('.fog-tool-btn').forEach(b => b.classList.remove('active-tool'));
  if (id) { const b = document.getElementById(id); if (b) b.classList.add('active-tool'); }
}

function startFogBrush(groupId) {
  if (!fogBrush) return;
  _setActiveFogBtn('fogBrushBtn-' + groupId);
  fogCanvas.setGroupVisible(groupId, true);
  fogBrush.start(groupId);
  document.getElementById('fogCtrl')?.remove();
  const ctrl = document.createElement('div');
  ctrl.id = 'fogCtrl';
  ctrl.className = 'fog-controls';
  ctrl.innerHTML = `
    <h5>🖌 Pinsel – Bereich enthüllen</h5>
    <p style="font-size:11px;color:var(--text-dim);margin-bottom:.4rem">Malen → Polygon wird beim Loslassen gespeichert</p>
    <div class="fog-brush-size-display" id="brushLabel">Pinsel: ${fogBrush.pixelR}px</div>
    <div class="form-group"><label>Pinselgröße</label>
      <input type="range" id="brushSlider" min="15" max="300" value="${fogBrush.pixelR}"
        oninput="setBrushSize(+this.value)">
    </div>
    <button class="btn btn-ghost btn-full" onclick="stopFogBrush()">✓ Fertig</button>`;
  document.body.appendChild(ctrl);
}

function setBrushSize(v) {
  fogBrush?.setBrushRadius(v);
  const el = document.getElementById('brushLabel');
  if (el) el.textContent = `Pinsel: ${v}px`;
}

function stopFogBrush() {
  fogBrush?.stop();
  document.getElementById('fogCtrl')?.remove();
  _setActiveFogBtn(null);
}

// ── Polygon draw mode ─────────────────────────────────────────────────
let _fogPolyCoords = [], _fogPolyLines = [], _fogPolyGroupId = null;

function startFogPolygon(groupId) {
  _setActiveFogBtn('fogPolyBtn-' + groupId);
  stopAnyDraw();
  _fogPolyGroupId = groupId;
  _fogPolyCoords = [];
  _fogPolyLines = [];
  fogCanvas.setGroupVisible(groupId, true);
  enablePickMode();
  showModeIndicator('🌫 Nebelbereich zeichnen: Klicken · Enter/Doppelklick fertig · ESC abbrechen');
  leafletMap.on('click', _onFogPolyClick);
  leafletMap.on('dblclick', _onFogPolyDblClick);
}

function _onFogPolyClick(e) {
  _fogPolyCoords.push({ lat: e.latlng.lat, lng: e.latlng.lng });
  if (_fogPolyCoords.length >= 2) {
    const last2 = _fogPolyCoords.slice(-2).map(p => [p.lat, p.lng]);
    const line = L.polyline(last2, { color: 'gold', weight: 2, dashArray: '5,4', opacity: .8 }).addTo(leafletMap);
    _fogPolyLines.push(line);
  }
  if (_fogPolyCoords.length >= 3) fogCanvas.addPreviewArea(_fogPolyGroupId, _fogPolyCoords);
}

function _onFogPolyDblClick(e) { L.DomEvent.stopPropagation(e); _finishFogPolygon(); }

async function _finishFogPolygon() {
  const coords = [..._fogPolyCoords];
  _fogPolyCoords = [];
  _fogPolyLines.forEach(l => leafletMap.removeLayer(l));
  _fogPolyLines = [];
  const gid = _fogPolyGroupId; _fogPolyGroupId = null;
  leafletMap.off('click', _onFogPolyClick);
  leafletMap.off('dblclick', _onFogPolyDblClick);
  disablePickMode(); hideModeIndicator(); fogCanvas.clearPreview();
  _setActiveFogBtn(null);
  if (coords.length < 3) { showToast('Mindestens 3 Punkte erforderlich', 'error'); return; }
  await saveFogArea(gid, coords);
}

async function deleteFogArea(areaId, groupId) {
  if (!confirm('Diesen enthüllten Bereich wieder verbergen?')) return;
  try { await API.delete(`/api/maps/${mapData.map.id}/fog/areas/${areaId}`); }
  catch (e) { showToast(e.message, 'error'); }
}

let _fogHighlightLayer = null;
function highlightFogArea(areaId, groupId) {
  unhighlightFogArea();
  const area = (mapData.fog_areas || []).find(a => a.id === areaId);
  if (!area) return;
  try {
    const raw = area.coordinates;
    const coords = (Array.isArray(raw) ? raw : JSON.parse(raw || '[]'))
      .map(p => [+p.lat, +p.lng]).filter(p => isFinite(p[0]) && isFinite(p[1]));
    if (coords.length < 3) return;
    _fogHighlightLayer = L.polygon(coords, {
      color: '#fbbf24', fillColor: '#fbbf24',
      fillOpacity: 0.25, weight: 2.5, opacity: 0.9,
      dashArray: '6,4'
    }).addTo(leafletMap);
  } catch { }
}
function unhighlightFogArea() {
  if (_fogHighlightLayer) { leafletMap.removeLayer(_fogHighlightLayer); _fogHighlightLayer = null; }
}

async function clearFogGroup(groupId) {
  if (!confirm('Alle enthüllten Bereiche dieser Gruppe entfernen?')) return;
  try {
    await API.delete(`/api/maps/${mapData.map.id}/fog/${groupId}/areas`);
    mapData.fog_areas = (mapData.fog_areas || []).filter(a => a.group_id !== groupId);
    fogCanvas.clearGroup(groupId);
    fogCanvas.setGroupVisible(groupId, true);
    refreshEditorContent();
    showToast('Alle Bereiche gelöscht', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════
// REGION VERTEX EDITOR
// ═══════════════════════════════════════════════════════════════════════
class RegionVertexEditor {
  constructor(map, coords, onChange) {
    this.map = map;
    this.coords = coords.map(c => [...c]);
    this.onChange = onChange;
    this._layers = [];
    this._render();
  }

  _vIcon() {
    return L.divIcon({
      html: '<div style="width:14px;height:14px;border-radius:50%;background:#6366f1;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.6);cursor:move"></div>',
      iconSize: [14, 14], iconAnchor: [7, 7], className: ''
    });
  }
  _mIcon() {
    return L.divIcon({
      html: '<div style="width:9px;height:9px;border-radius:50%;background:#94a3b8;border:1.5px solid #fff;opacity:.85;cursor:pointer"></div>',
      iconSize: [9, 9], iconAnchor: [4, 4], className: ''
    });
  }

  _render() {
    this._layers.forEach(l => this.map.removeLayer(l));
    this._layers = [];

    this._poly = L.polygon(this.coords, {
      color: '#818cf8', weight: 2, fillOpacity: .06, dashArray: '5,5'
    }).addTo(this.map);
    this._layers.push(this._poly);

    this.coords.forEach((c, idx) => {
      const m = L.marker(c, { icon: this._vIcon(), draggable: true, autoPan: false }).addTo(this.map);
      this._layers.push(m);
      m.on('dragstart', () => this.map.dragging.disable());
      m.on('drag', e => {
        this.coords[idx] = [e.latlng.lat, e.latlng.lng];
        this._poly.setLatLngs(this.coords);
        this.onChange(this.coords);
      });
      m.on('dragend', () => { this.map.dragging.enable(); this.onChange(this.coords); });
      m.on('contextmenu', () => {
        if (this.coords.length <= 3) { showToast('Mindestens 3 Punkte erforderlich', 'error'); return; }
        this.coords.splice(idx, 1); this._render(); this.onChange(this.coords);
      });
      m.bindTooltip(`Punkt ${idx + 1} · Rechtsklick löschen`, { permanent: false, opacity: .8 });
    });

    this.coords.forEach((c, idx) => {
      const next = this.coords[(idx + 1) % this.coords.length];
      const mid = [(c[0] + next[0]) / 2, (c[1] + next[1]) / 2];
      const m = L.marker(mid, { icon: this._mIcon() }).addTo(this.map);
      this._layers.push(m);
      m.on('click', () => { this.coords.splice(idx + 1, 0, [...mid]); this._render(); this.onChange(this.coords); });
      m.bindTooltip('Klick: Punkt einfügen', { permanent: false, opacity: .8 });
    });
  }

  getCoords() { return this.coords; }
  destroy() { this._layers.forEach(l => this.map.removeLayer(l)); this._layers = []; this.map.dragging.enable(); }
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED FORM HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Combined group+visibility select → value = "visibility|groupId" */
function targetSelect(selectId, groupId, visibility = 'group') {
  let cur;
  if (visibility === 'public') cur = 'public|';
  else if (visibility === 'hidden') cur = 'hidden|';
  else cur = `group|${groupId || (mapData.groups[0]?.id || '')}`;

  const opts = [
    `<option value="public|" ${cur === 'public|' ? 'selected' : ''}>🌍 Alle Gruppen</option>`,
    ...mapData.groups.map(g => {
      const v = `group|${g.id}`;
      return `<option value="${v}" ${cur === v ? 'selected' : ''}>${escHtml(g.name)}</option>`;
    }),
    `<option value="hidden|" ${cur === 'hidden|' ? 'selected' : ''}>🔒 Versteckt (nur Editor)</option>`
  ];
  return `<select id="${selectId}">${opts.join('')}</select>`;
}

function parseTarget(id) {
  const val = document.getElementById(id)?.value || 'group|';
  const [vis, gid] = val.split('|');
  return { visibility: vis, group_id: gid ? +gid : null };
}

let _li = 0;
function linkRow(label = '', url = '', i) {
  const id = i ?? _li++;
  return `<div id="lr${id}" style="display:grid;grid-template-columns:1fr 1.5fr auto;gap:.4rem;margin-bottom:.32rem">
    <input placeholder="Label" value="${escAttr(label)}" class="ll">
    <input placeholder="https://…" value="${escAttr(url)}" class="lu">
    <button type="button" class="btn-icon" onclick="document.getElementById('lr${id}').remove()">✕</button>
  </div>`;
}
function addLinkRow() { document.getElementById('linksList').insertAdjacentHTML('beforeend', linkRow()); }
function gatherLinks() {
  return [...document.querySelectorAll('#linksList .ll')].map((el, i) => {
    const u = document.querySelectorAll('#linksList .lu')[i]?.value.trim();
    return u ? { label: el.value.trim() || u, url: u } : null;
  }).filter(Boolean);
}

function showFeatureModal(title, body) {
  _li = 0;
  document.getElementById('featureModalTitle').textContent = title;
  document.getElementById('featureModalBody').innerHTML = body;
  openModal('featureModal');
}
function closeFeatureModal() { closeModal('featureModal'); }

/** Sanitize description HTML for safe display in Leaflet popups */
function sanitizeDesc(text) {
  if (!text) return '';
  if (!/[<>]/.test(text)) return escHtml(text);
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(text, {
      ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'u', 'strong', 'em', 'a', 'img', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'span', 'div'],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'style', 'target', 'class', 'width', 'height']
    });
  }
  return text.replace(/<script[^>]*>.*?<\/script>/gi, '').replace(/on\w+="[^"]*"/gi, '');
}

/** Create a Quill WYSIWYG editor inside container element, with image-URL button */
let _activeQuill = null;
function initQuill(containerId, initialHtml) {
  if (typeof Quill === 'undefined') return null;
  const el = document.getElementById(containerId);
  if (!el) return null;

  // Add source-toggle button above the editor
  const wrapper = document.createElement('div');
  el.parentNode.insertBefore(wrapper, el);
  wrapper.appendChild(el);
  const srcBtn = document.createElement('button');
  srcBtn.type = 'button';
  srcBtn.className = 'btn btn-ghost btn-sm';
  srcBtn.style.cssText = 'font-size:11px;margin-bottom:.3rem';
  srcBtn.textContent = '</> Quelltext';
  srcBtn.onclick = () => _toggleQuillSource(q, el, srcBtn);
  wrapper.insertBefore(srcBtn, el);

  const q = new Quill(el, {
    theme: 'snow',
    placeholder: 'Beschreibung eingeben…',
    modules: {
      toolbar: {
        container: [
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link'],
          [{ 'customImg': '🖼' }],
          ['clean']
        ],
        handlers: {
          customImg: () => {
            const url = prompt('Bild-URL eingeben (https://…):');
            if (!url || !url.trim()) return;
            const range = q.getSelection(true);
            // Insert image as HTML via clipboard API
            q.clipboard.dangerouslyPasteHTML(range.index,
              `<img src="${url.trim()}" style="max-width:100%">`);
          }
        }
      }
    }
  });
  if (initialHtml) q.clipboard.dangerouslyPasteHTML(initialHtml || '');
  _activeQuill = q;
  return q;
}
function getQuillHtml(q) {
  if (!q) return '';
  // If source mode is active, read from the textarea instead
  if (q._sourceMode && q._sourceTa) return q._sourceTa.value;
  const html = q.root.innerHTML;
  return (html === '<p><br></p>' || html === '<p></p>') ? '' : html;
}

function _toggleQuillSource(q, editorEl, btn) {
  if (!q) return;
  if (!q._sourceMode) {
    // Switch to source view
    const html = getQuillHtml(q);
    if (!q._sourceTa) {
      q._sourceTa = document.createElement('textarea');
      q._sourceTa.style.cssText = 'width:100%;min-height:100px;font-family:monospace;font-size:12px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:.5rem;resize:vertical';
      editorEl.parentNode.insertBefore(q._sourceTa, editorEl.nextSibling);
    }
    q._sourceTa.value = html;
    editorEl.style.display = 'none';
    q._sourceTa.style.display = 'block';
    q._sourceMode = true;
    btn.textContent = '📝 Editor';
    btn.classList.add('active-tool');
  } else {
    // Switch back to WYSIWYG
    const html = q._sourceTa.value;
    editorEl.style.display = '';
    q._sourceTa.style.display = 'none';
    q._sourceMode = false;
    btn.textContent = '</> Quelltext';
    btn.classList.remove('active-tool');
    q.clipboard.dangerouslyPasteHTML(html);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SCALE BAR
// ═══════════════════════════════════════════════════════════════════════

/**
 * Shows a distance scale at the bottom-centre of the map.
 * Uses map.map_miles_width / image_width to convert map-units → miles.
 * Updates on every zoom change.
 */
function initScaleBar(mapCfg) {
  const bar = document.getElementById('scaleBar');
  if (!bar) return;

  const W = mapCfg.image_width || 2000;
  const milesWidth = parseFloat(mapCfg.map_miles_width) || 0;
  const label = mapCfg.map_scale_label || '';

  // If no scale set, just show the label (or nothing)
  if (!milesWidth && !label) { bar.style.display = 'none'; return; }

  // pixels per map-unit at zoom 0 = 1.  At zoom n = 2^n.
  // So screen-pixels per map-unit = 2^zoom.
  // miles per map-unit = milesWidth / W
  // miles per screen-px = (milesWidth / W) / 2^zoom

  const BAR_PX = 150; // fixed screen-pixel bar length

  function update() {
    if (!milesWidth) {
      bar.innerHTML = `<span class="scale-label">${escHtml(label)}</span>`;
      return;
    }
    const zoom = leafletMap.getZoom();
    const pxPerMapUnit = Math.pow(2, zoom);
    const milesPerMapUnit = milesWidth / W;
    const milesPerPx = milesPerMapUnit / pxPerMapUnit;
    const totalMiles = BAR_PX * milesPerPx;

    let display;
    const totalKm = totalMiles * 1.60934;
    if (totalMiles >= 100) display = Math.round(totalMiles) + ' Meilen (' + Math.round(totalKm) + ' km)';
    else if (totalMiles >= 10) display = Math.round(totalMiles) + ' Meilen (' + Math.round(totalKm) + ' km)';
    else if (totalMiles >= 1) display = totalMiles.toFixed(1) + ' Meilen (' + totalKm.toFixed(1) + ' km)';
    else display = (totalMiles * 5280).toFixed(0) + ' Fuß';

    bar.innerHTML = `
      <div class="scale-bar-line" style="width:${BAR_PX}px"></div>
      <span class="scale-bar-text">${display}</span>
      ${label ? `<span class="scale-bar-label">${escHtml(label)}</span>` : ''}`;
  }

  leafletMap.on('zoom zoomend', update);
  update();
  bar.style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════════════════
// MEASUREMENT TOOL
// ═══════════════════════════════════════════════════════════════════════

let _measureActive = false;
let _measurePts = [];   // [{lat,lng}]
let _measureLayers = [];   // Leaflet layers

/**
 * Distance between two points in map-units (Pythagorean, CRS.Simple).
 */
function _mapDist(a, b) {
  const dlat = b[0] - a[0], dlng = b[1] - a[1];
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

/**
 * Convert map-unit distance to miles using map_miles_width / image_width.
 */
function _toMiles(mapUnits, mapCfg) {
  const W = mapCfg.image_width || 2000;
  const milesWidth = parseFloat(mapCfg.map_miles_width) || 0;
  if (!milesWidth) return null;
  return mapUnits * (milesWidth / W);
}

function initMeasureTool(mapCfg) {
  const btn = document.getElementById('measureBtn');
  if (btn) btn.addEventListener('click', () => {
    _measureActive ? stopMeasure() : startMeasure(mapCfg);
  });
}

function startMeasure(mapCfg) {
  _measureActive = mapCfg;  // store config (truthy = active)
  _measurePts = [];
  document.getElementById('measureBtn')?.classList.add('active-tool');
  enablePickMode();
  leafletMap.getContainer().style.cursor = 'crosshair';
  leafletMap.on('click', _onMeasureClick);
  leafletMap.on('dblclick', _onMeasureDblClick);
  _showMeasurePanel('Klicke auf die Karte um zu messen…', mapCfg);
  showModeIndicator('📏 Klick: Punkt setzen · Doppelklick: beenden · ESC: abbrechen');
}

function _onMeasureClick(e) {
  const cfg = typeof _measureActive === 'object' ? _measureActive : mapData.map;
  _measurePts.push([e.latlng.lat, e.latlng.lng]);
  _redrawMeasure(cfg);
}

function _onMeasureDblClick(e) {
  L.DomEvent.stopPropagation(e);
  stopMeasure();
}

function _redrawMeasure(mapCfg) {
  // Remove old layers
  _measureLayers.forEach(l => leafletMap.removeLayer(l));
  _measureLayers = [];

  const pts = _measurePts;
  if (!pts.length) return;

  // Draw each point
  pts.forEach((pt, i) => {
    const isLast = i === pts.length - 1;
    const icon = L.divIcon({
      html: `<div style="width:${isLast ? 14 : 10}px;height:${isLast ? 14 : 10}px;border-radius:50%;
               background:${isLast ? '#f97316' : '#6366f1'};border:2px solid #fff;
               box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
      iconSize: [isLast ? 14 : 10, isLast ? 14 : 10],
      iconAnchor: [isLast ? 7 : 5, isLast ? 7 : 5],
      className: ''
    });
    const m = L.marker(pt, { icon }).addTo(leafletMap);
    _measureLayers.push(m);
  });

  if (pts.length < 2) return;

  // Polyline
  const line = L.polyline(pts, {
    color: '#f97316', weight: 2.5, opacity: .9, dashArray: '8 5'
  }).addTo(leafletMap);
  _measureLayers.push(line);

  // Calculate total distance
  let totalMapUnits = 0;
  for (let i = 1; i < pts.length; i++) {
    totalMapUnits += _mapDist(pts[i - 1], pts[i]);
  }

  const miles = _toMiles(totalMapUnits, mapCfg);
  const mpd = parseFloat(mapCfg.travel_miles_per_day) || 24;
  const hpd = parseFloat(mapCfg.travel_hours_per_day) || 8;

  let distText, travelText = '';
  if (miles !== null) {
    const km = miles * 1.60934;
    const kmStr = km >= 100 ? Math.round(km) + ' km' : km.toFixed(1) + ' km';
    distText = miles >= 100
      ? Math.round(miles) + ' Meilen (' + kmStr + ')'
      : miles.toFixed(1) + ' Meilen (' + kmStr + ')';
    const days = miles / mpd;
    const hours = miles / (mpd / hpd);
    travelText = days >= 1
      ? `${days.toFixed(1)} Tage (${Math.round(hours)} Stunden) zu Fuß`
      : `${Math.round(hours)} Stunden zu Fuß`;
  } else {
    distText = `${totalMapUnits.toFixed(0)} Karteneinheiten`;
    travelText = '(Kein Maßstab definiert)';
  }

  _showMeasurePanel(`<strong>${distText}</strong><br><span style="color:var(--text-dim);font-size:12px">${travelText}</span><br><span style="color:var(--text-dim);font-size:11px">${pts.length} Punkte · Doppelklick zum Beenden</span>`, mapCfg);
}

function _showMeasurePanel(html, mapCfg) {
  let panel = document.getElementById('measurePanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'measurePanel';
    panel.className = 'measure-panel';
    document.getElementById('map').appendChild(panel);
  }
  panel.innerHTML = `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem">
    <div>${html}</div>
    <button class="btn-icon" onclick="stopMeasure()" title="Messen beenden" style="flex-shrink:0">✕</button>
  </div>`;
}

function stopMeasure() {
  _measureActive = false;
  _measurePts = [];
  _measureLayers.forEach(l => leafletMap.removeLayer(l));
  _measureLayers = [];
  leafletMap.off('click', _onMeasureClick);
  leafletMap.off('dblclick', _onMeasureDblClick);
  disablePickMode();
  document.getElementById('measureBtn')?.classList.remove('active-tool');
  document.getElementById('measurePanel')?.remove();
  hideModeIndicator();
}

// ═══════════════════════════════════════════════════════════════════════
// EDITOR HOVER HIGHLIGHT + PING
// ═══════════════════════════════════════════════════════════════════════
let _highlightLayer = null;
let _pingInterval = null;

function unhighlightFeature() {
  if (_highlightLayer) { leafletMap.removeLayer(_highlightLayer); _highlightLayer = null; }
}

function highlightPoi(id) {
  unhighlightFeature();
  const p = mapData.pois.find(x => x.id === id);
  if (!p) return;
  _highlightLayer = L.circleMarker([+p.lat, +p.lng], {
    radius: 22, color: '#f97316', fillColor: '#f97316',
    fillOpacity: 0.25, weight: 3, opacity: 0.9
  }).addTo(leafletMap);
}

function highlightRoute(id) {
  unhighlightFeature();
  const rl = routeLayers[id];
  if (!rl) return;
  const coords = rl.waypoints.map(w => [+w.lat, +w.lng]).filter(c => isFinite(c[0]) && isFinite(c[1]));
  if (!coords.length) return;
  _highlightLayer = L.polyline(coords, {
    color: '#f97316', weight: 8, opacity: 0.35
  }).addTo(leafletMap);
}

function highlightRegion(id) {
  unhighlightFeature();
  const r = regionLayers[id];
  if (!r) return;
  const latlngs = r.poly.getLatLngs();
  _highlightLayer = L.polygon(latlngs, {
    color: '#f97316', fillColor: '#f97316',
    fillOpacity: 0.25, weight: 3, opacity: 0.9
  }).addTo(leafletMap);
}

/** _poiIconHtml: returns inline HTML for a POI icon (emoji or custom image) */
function _poiIconHtml(iconKey) {
  const custId = +iconKey;
  const ci = !isNaN(custId) && _customIcons.find(ic => ic.id === custId);
  if (ci) {
    const isUrl = ci.image_url.startsWith('http') || ci.image_url.startsWith('/');
    return isUrl
      ? `<img src="${escHtml(ci.image_url)}" style="width:16px;height:16px;object-fit:contain;vertical-align:middle">`
      : escHtml(ci.image_url);
  }
  return POI_ICONS[iconKey] || '⬤';
}

/** Ping a feature: highlight it blinking for 10s, fly viewers to it */
function pingFeature(type, id) {
  const data = { type, id };
  socket.emit('feature:ping', data);  // broadcast to all in room (server relays)
  _handleFeaturePing(data);           // also run locally
}

function _handleFeaturePing(data) {
  const { type, id } = data;
  if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
  if (_highlightLayer) { leafletMap.removeLayer(_highlightLayer); _highlightLayer = null; }

  let center = null, layer = null;

  if (type === 'poi') {
    const p = mapData.pois.find(x => x.id === id);
    if (!p) return;
    center = [+p.lat, +p.lng];
    layer = L.circleMarker(center, { radius: 30, color: '#f97316', fillColor: '#f97316', fillOpacity: 0.4, weight: 4, opacity: 1.0 });
  } else if (type === 'route') {
    const rl = routeLayers[id];
    if (!rl) return;
    const coords = rl.waypoints.map(w => [+w.lat, +w.lng]).filter(c => isFinite(c[0]) && isFinite(c[1]));
    if (!coords.length) return;
    center = coords[Math.floor(coords.length / 2)];
    layer = L.polyline(coords, { color: '#f97316', weight: 10, opacity: 0.6 });
  } else if (type === 'region') {
    const r = regionLayers[id];
    if (!r) return;
    center = r.poly.getBounds().getCenter();
    layer = L.polygon(r.poly.getLatLngs(), { color: '#f97316', fillColor: '#f97316', fillOpacity: 0.35, weight: 4, opacity: 1.0 });
  }
  if (!layer || !center) return;

  if (!leafletMap.getBounds().contains(center)) {
    leafletMap.flyTo(center, leafletMap.getZoom(), { animate: true, duration: 0.8 });
  }

  layer.addTo(leafletMap);
  _highlightLayer = layer;

  let on = true, ticks = 0;
  _pingInterval = setInterval(() => {
    on = !on; ticks++;
    try {
      if (type === 'poi') layer.setStyle({ fillOpacity: on ? 0.5 : 0.1, opacity: on ? 1 : 0.3 });
      else if (type === 'region') layer.setStyle({ fillOpacity: on ? 0.55 : 0.05, opacity: on ? 1 : 0.2 });
      else layer.setStyle({ opacity: on ? 0.7 : 0.1 });
    } catch { }
    if (ticks >= 25) { // ~10s
      clearInterval(_pingInterval); _pingInterval = null;
      leafletMap.removeLayer(layer); _highlightLayer = null;
    }
  }, 400);
}


// ═══════════════════════════════════════════════════════════════════════
// POI LABELS  (Bilbo font, below marker)
// ═══════════════════════════════════════════════════════════════════════
const _poiLabelGroup = L.layerGroup();

function _renderPoiLabels() {
  _poiLabelGroup.clearLayers();
  mapData.pois.forEach(p => {
    if (p.visibility === 'hidden' && !isAdmin) return;
    const e = poiLayers[p.id];
    if (!e || !e.marker) return;
    const lay = e.bucket === PUB ? globalLayers.poiLayer : e.bucket === HID ? hiddenLayers.poiLayer : layerState[e.groupId]?.poiLayer;
    if (!lay || !leafletMap.hasLayer(lay)) return;

    const s = _poiMarkerSize;
    const tip = Math.round(s * 0.35);
    const lbl = L.divIcon({
      html: `<div class="poi-name-label">${escHtml(p.name)}</div>`,
      iconSize: [120, 24], iconAnchor: [60, -2],
      className: ''
    });
    L.marker([+p.lat, +p.lng], { icon: lbl, interactive: false })
      .addTo(_poiLabelGroup);
  });
  if (!leafletMap.hasLayer(_poiLabelGroup)) _poiLabelGroup.addTo(leafletMap);
}

function _removePoiLabels() {
  _poiLabelGroup.clearLayers();
  leafletMap.removeLayer(_poiLabelGroup);
}

// ═══════════════════════════════════════════════════════════════════════
// REGION LABELS  (label_region.webp background, Bilbo font)
// ═══════════════════════════════════════════════════════════════════════
const _regLabelGroup = L.layerGroup();
const _REG_LABEL_URL = 'https://www.9ps.eu/dnd/items/Worldmapper/label_region.webp';
// Image is 616x222px; usable text area: x 115-508, y 31-153
// Text area size: 393 x 122 px  →  ratio ~3.21:1
// We scale the label to ~210px wide on screen
const _REG_LABEL_W = 210;
const _REG_LABEL_H = Math.round(210 * 222 / 616);

function _renderRegionLabels() {
  _regLabelGroup.clearLayers();
  mapData.regions.forEach(region => {
    if (region.visibility === 'hidden' && !isAdmin) return;
    const e = regionLayers[region.id];
    if (!e || !e.poly) return;
    const lay = e.bucket === PUB ? globalLayers.regionLayer : e.bucket === HID ? hiddenLayers.regionLayer : layerState[e.groupId]?.regionLayer;
    if (!lay || !leafletMap.hasLayer(lay)) return;

    try {
      const coords = Array.isArray(region.coordinates) ? region.coordinates
        : JSON.parse(region.coordinates || '[]');
      if (!coords.length) return;
      // Compute centroid
      const lats = coords.map(p => Array.isArray(p) ? +p[0] : +p.lat);
      const lngs = coords.map(p => Array.isArray(p) ? +p[1] : +p.lng);
      const lat = lats.reduce((a, b) => a + b, 0) / lats.length;
      const lng = lngs.reduce((a, b) => a + b, 0) / lngs.length;

      const lbl = L.divIcon({
        html: `<div class="reg-name-label" style="width:${_REG_LABEL_W}px;height:${_REG_LABEL_H}px">
          <img src="${_REG_LABEL_URL}" style="width:100%;height:100%;position:absolute;top:0;left:0">
          <span class="reg-name-text">${escHtml(region.name)}</span>
        </div>`,
        iconSize: [_REG_LABEL_W, _REG_LABEL_H],
        iconAnchor: [_REG_LABEL_W / 2, _REG_LABEL_H / 2],
        className: ''
      });
      L.marker([lat, lng], { icon: lbl, interactive: false })
        .addTo(_regLabelGroup);
    } catch { }
  });
  if (!leafletMap.hasLayer(_regLabelGroup)) _regLabelGroup.addTo(leafletMap);
}

function _removeRegionLabels() {
  _regLabelGroup.clearLayers();
  leafletMap.removeLayer(_regLabelGroup);
}

// ═══════════════════════════════════════════════════════════════════════
// PING  –  expanding circles animation
// ═══════════════════════════════════════════════════════════════════════
let _pingViewerLast = 0;

function _drawPing(lat, lng) {
  const rings = [1, 2, 3].map(i =>
    L.circleMarker([lat, lng], {
      radius: 8, color: '#f97316', fillColor: '#f97316',
      fillOpacity: 0.3, weight: 2.5, opacity: 0.9, className: ''
    }).addTo(leafletMap)
  );
  let frame = 0;
  const anim = setInterval(() => {
    frame++;
    rings.forEach((r, i) => {
      const phase = (frame + i * 6) % 30;
      const t = phase / 30;
      r.setRadius(8 + t * 32);
      r.setStyle({ opacity: 1 - t, fillOpacity: (1 - t) * 0.25 });
    });
    if (frame >= 50) {
      clearInterval(anim);
      rings.forEach(r => leafletMap.removeLayer(r));
    }
  }, 60);
}

function _manualPing(e) {
  const now = Date.now();
  // Viewers: 10s cooldown; editors: always
  if (!isAdmin && now - _pingViewerLast < 10000) {
    showToast('Bitte warte 10 Sekunden zwischen Pings', 'info');
    return;
  }
  if (!isAdmin) _pingViewerLast = now;

  const { lat, lng } = e.latlng;
  _drawPing(lat, lng);

  // Emit ping to others (editors also move viewers)
  const data = { type: 'cursor', lat, lng, moveView: isAdmin };
  socket.emit('feature:ping', data);
}

document.addEventListener('keydown', e => {
  if (e.key === 'p' || e.key === 'P') {
    if (!leafletMap || !_lastMouseLatLng) return;
    if (document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.isContentEditable) return;
    _manualPing({ latlng: _lastMouseLatLng });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SETTINGS BURGER MENU
// ═══════════════════════════════════════════════════════════════════════
function initSettingsMenu() {
  const btn = document.getElementById('settingsMenuBtn');
  const panel = document.getElementById('settingsPanel');
  if (!btn || !panel) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
  });
  document.addEventListener('click', () => panel.classList.add('hidden'));
  panel.addEventListener('click', e => e.stopPropagation());

  // Populate
  panel.innerHTML = `
    <div class="settings-menu-inner">
      <div class="settings-menu-title">Einstellungen</div>

      <div class="settings-row">
        <label class="settings-label">POI-Namen</label>
        <button class="toggle ${_showPoiLabels ? 'on' : ''}" id="poiLabelToggle"
          onclick="togglePoiLabels(this)"></button>
      </div>

      <div class="settings-row">
        <label class="settings-label">Regions-Namen</label>
        <button class="toggle ${_showRegLabels ? 'on' : ''}" id="regLabelToggle"
          onclick="toggleRegLabels(this)"></button>
      </div>

      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:.2rem">
        <label class="settings-label">POI-Größe: <span id="poiSizeVal">${_poiMarkerSize}px</span></label>
        <input type="range" min="25" max="60" step="1" value="${_poiMarkerSize}"
          style="width:100%" oninput="setPoiSize(+this.value)">
      </div>

      ${isAdmin ? `<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:.2rem">
        <label class="settings-label">Nebeldichte: <span id="fogDensityVal">${Math.round(_fogDensity * 100)}%</span></label>
        <input type="range" min="0" max="1" step="0.05" value="${_fogDensity}"
          style="width:100%" oninput="setFogDensity(+this.value)">
      </div>` : ''}
    </div>`;
}

function togglePoiLabels(btn) {
  _showPoiLabels = !_showPoiLabels;
  btn.classList.toggle('on', _showPoiLabels);
  _saveSetting('poiLabels', _showPoiLabels);
  _showPoiLabels ? _renderPoiLabels() : _removePoiLabels();
}

function toggleRegLabels(btn) {
  _showRegLabels = !_showRegLabels;
  btn.classList.toggle('on', _showRegLabels);
  _saveSetting('regLabels', _showRegLabels);
  _showRegLabels ? _renderRegionLabels() : _removeRegionLabels();
}

function setPoiSize(v) {
  _poiMarkerSize = v;
  _saveSetting('poiSize', v);
  document.getElementById('poiSizeVal').textContent = v + 'px';
  rebuildAllPois();
}

function setFogDensity(v) {
  _fogDensity = +v;
  _saveSetting('fogDensity', _fogDensity);
  const lbl = document.getElementById('fogDensityVal');
  if (lbl) lbl.textContent = Math.round(_fogDensity * 100) + '%';
  fogCanvas?.setOpacity(_fogDensity);
}


// ── Focus (fly-to + brief local highlight) ────────────────────────────
function focusPoi(id) {
  const p = mapData.pois.find(x => x.id === id);
  if (!p) return;
  leafletMap.flyTo([+p.lat, +p.lng], leafletMap.getZoom(), { animate: true, duration: 0.5 });
  highlightPoi(id);
  setTimeout(() => { if (_highlightLayer) { leafletMap.removeLayer(_highlightLayer); _highlightLayer = null; } }, 2500);
}

function focusRoute(id) {
  const rl = routeLayers[id];
  if (!rl) return;
  const coords = rl.waypoints.map(w => [+w.lat, +w.lng]).filter(c => isFinite(c[0]) && isFinite(c[1]));
  if (!coords.length) return;
  if (coords.length === 1) leafletMap.flyTo(coords[0], leafletMap.getZoom(), { animate: true, duration: 0.5 });
  else leafletMap.flyToBounds(L.polyline(coords).getBounds(), { animate: true, duration: 0.5 });
  highlightRoute(id);
  setTimeout(() => { if (_highlightLayer) { leafletMap.removeLayer(_highlightLayer); _highlightLayer = null; } }, 2500);
}

function focusRegion(id) {
  const rl = regionLayers[id];
  if (!rl) return;
  leafletMap.flyToBounds(rl.poly.getBounds(), { animate: true, duration: 0.5 });
  highlightRegion(id);
  setTimeout(() => { if (_highlightLayer) { leafletMap.removeLayer(_highlightLayer); _highlightLayer = null; } }, 2500);
}

// ── Region z-order ──────────────────────────────────────────────────────
function bringRegionToFront(id) {
  leafletMap.closePopup();
  const e = regionLayers[id];
  if (e) { e.poly.bringToFront(); showToast('Region nach vorne gebracht'); }
}
function sendRegionToBack(id) {
  leafletMap.closePopup();
  const e = regionLayers[id];
  if (e) { e.poly.bringToBack(); showToast('Region nach hinten verschoben'); }
}

// ── Start ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════
// MAP LOCK FEATURE
// Editors can lock the map; admins are warned and notified.
// ═══════════════════════════════════════════════════════════════════════
let _mapLockState = null;  // null = unlocked, {locked_by, locked_by_name, locked_at}

async function initLockFeature(mapId) {
  try {
    const state = await API.get(`/api/maps/${mapId}/lock`);
    _mapLockState = state.locked_by_editor ? state : null;
  } catch { }
  _updateLockUI();
}

function _updateLockUI() {
  const me = API.user();
  if (!me) return;

  // Remove existing lock bar
  document.getElementById('lockBar')?.remove();

  const locked = !!_mapLockState;

  if (!locked) {
    // Editor: show lock button in topbar
    if (!me.is_superadmin && isAdmin) _showLockButton(false);
    return;
  }

  // Locked state
  const lockedByMe = _mapLockState.locked_by === me.id;

  if (me.is_superadmin) {
    // Admin sees the lock warning bar
    _showAdminLockBar(_mapLockState);
    // Admin opening editor mode loses real edit rights if locked by editor
  } else if (lockedByMe || isAdmin) {
    // Editor who locked it sees unlock button
    _showLockButton(true);
  }
}

function _showLockButton(isLocked) {
  // Add or update lock button next to editor toggle
  let btn = document.getElementById('lockMapBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'lockMapBtn';
    btn.className = 'btn btn-sm';
    document.querySelector('.topbar-right').insertBefore(
      btn, document.getElementById('toggleEditorBtn')
    );
  }
  if (isLocked) {
    btn.className = 'btn btn-sm btn-danger';
    btn.textContent = '🔒 Entsperren';
    btn.onclick = unlockMap;
  } else {
    btn.className = 'btn btn-sm btn-ghost';
    btn.textContent = '🔓 Sperren';
    btn.onclick = lockMap;
  }
}

function _showAdminLockBar(state) {
  const bar = document.createElement('div');
  bar.id = 'lockBar';
  bar.style.cssText = `position:absolute;top:0;left:0;right:0;z-index:510;
    background:rgba(239,68,68,.18);border-bottom:1px solid rgba(239,68,68,.4);
    color:#fca5a5;font-size:13px;padding:.45rem 1rem;display:flex;align-items:center;
    justify-content:space-between;gap:.75rem;`;
  const lockedAt = state.locked_at ? new Date(state.locked_at).toLocaleTimeString('de') : '';
  bar.innerHTML = `
    <span>🔒 Diese Karte wurde von <strong>${escHtml(state.locked_by_name)}</strong> gesperrt${lockedAt ? ' um ' + lockedAt : ''}.
    Du schaust als Betrachter, auch wenn du Admin bist.</span>
    <div style="display:flex;gap:.5rem;flex-shrink:0">
      <button class="btn btn-ghost btn-sm" style="color:#fca5a5;border-color:rgba(239,68,68,.4)"
        onclick="adminPeekMap()">👁 Trotzdem im Editor öffnen</button>
      <button class="btn btn-danger btn-sm" onclick="adminForceUnlock()">🔓 Sperre aufheben</button>
    </div>`;
  // Insert after topbar
  document.querySelector('.map-topbar').after(bar);
}

async function lockMap() {
  const mapId = mapData.map.id;
  const me = API.user();
  if (!confirm('Karte für den Admin sperren?\nDer Admin sieht die Karte dann nur als Betrachter.\nEr wird benachrichtigt, wenn er die Karte im Editor öffnet.')) return;
  try {
    await API.post(`/api/maps/${mapId}/lock`, {});
    showToast('Karte gesperrt 🔒', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function unlockMap() {
  if (!confirm('Karte entsperren?')) return;
  try {
    await API.delete(`/api/maps/${mapData.map.id}/lock`);
    showToast('Karte entsperrt 🔓', 'success');
    document.getElementById('lockMapBtn')?.remove();
  } catch (e) { showToast(e.message, 'error'); }
}

async function adminPeekMap() {
  // Admin wants to peek anyway – notify editor and force-enter editor mode
  const me = API.user();
  if (!me?.is_superadmin) return;
  const confirmed = confirm(
    `Achtung: Diese Karte ist vom Editor gesperrt.\n` +
    `${_mapLockState?.locked_by_name || 'Der Editor'} wird benachrichtigt, dass du die Karte im Editor anschaust.\n\nTrotzdem öffnen?`
  );
  if (!confirmed) return;
  try {
    // Notify editor via server
    await API.post(`/api/maps/${mapData.map.id}/admin-peek`, {});
    // Open editor panel normally
    document.getElementById('lockBar')?.remove();
    document.getElementById('toggleEditorBtn')?.classList.remove('hidden');
    document.getElementById('editorPanel')?.classList.remove('hidden');
    refreshEditorContent();
    showToast('Editor geöffnet – Editor wurde benachrichtigt', 'info');
  } catch (e) { showToast(e.message, 'error'); }
}

async function adminForceUnlock() {
  if (!confirm('Sperre aufheben? Der Editor wird dabei nicht benachrichtigt.')) return;
  try {
    await API.delete(`/api/maps/${mapData.map.id}/lock`);
    showToast('Sperre aufgehoben', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

init();