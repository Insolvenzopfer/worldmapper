/**
 * FogCanvas v3 – Polygon-based Fog of War
 * ─────────────────────────────────────────
 * Revealed areas are explicit polygons (like regions).
 * Each polygon is rendered with canvas shadowBlur to produce
 * naturally soft, feathered edges.
 *
 * mode 'editor'  → semi-transparent blue-grey fog (map still visible)
 * mode 'viewer'  → fully opaque black fog
 *
 * Pane: 'fogPane' at z-index 650 (above markers:600, below popups:700)
 */
class FogCanvas {
  constructor(leafletMap, mode = 'viewer') {
    this.map     = leafletMap;
    this.mode    = mode;
    this.areas   = {};    // groupId → [ [{lat,lng}, ...], ... ]  (array of polygons)
    this.visible = new Set();

    // Create dedicated pane above markers but below popups
    if (!leafletMap.getPane('fogPane')) leafletMap.createPane('fogPane');
    const pane = leafletMap.getPane('fogPane');
    pane.style.zIndex       = '650';
    pane.style.pointerEvents = 'none';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;';
    pane.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._bound = () => this.redraw();
    leafletMap.on('move zoom resize viewreset zoomend moveend', this._bound);
    this.redraw();
  }

  setMode(mode) { this.mode = mode; this.redraw(); }

  /** Replace all areas for a group. areas = array of coordinate arrays */
  setGroupAreas(groupId, areas) {
    this.areas[groupId] = (areas || []).map(poly =>
      poly.map(p => ({ lat: +p.lat, lng: +p.lng }))
          .filter(p => isFinite(p.lat) && isFinite(p.lng))
    ).filter(poly => poly.length >= 3);
    this.redraw();
  }

  addArea(groupId, coords) {
    if (!this.areas[groupId]) this.areas[groupId] = [];
    this.areas[groupId].push(
      coords.map(p => ({ lat: +p.lat, lng: +p.lng }))
            .filter(p => isFinite(p.lat) && isFinite(p.lng))
    );
    this.redraw();
  }

  removeArea(groupId, index) {
    if (this.areas[groupId]) {
      this.areas[groupId].splice(index, 1);
      this.redraw();
    }
  }

  clearGroup(groupId) { this.areas[groupId] = []; this.redraw(); }

  setGroupVisible(groupId, visible) {
    visible ? this.visible.add(groupId) : this.visible.delete(groupId);
    this.redraw();
  }

  // ── Internal ─────────────────────────────────────────────────────────

  _resize() {
    const sz = this.map.getSize();
    if (this.canvas.width !== sz.x || this.canvas.height !== sz.y) {
      this.canvas.width  = sz.x;
      this.canvas.height = sz.y;
    }
    const origin = this.map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, origin);
  }

  _toPx(lat, lng) {
    const pt = this.map.latLngToContainerPoint([lat, lng]);
    return [pt.x, pt.y];
  }

  setOpacity(v) { this._opacity = Math.max(0.1, Math.min(1.0, +v)); this.redraw(); }

  _fogColor(alpha) {
    const a = alpha * (this._opacity ?? 1.0);
    if (this.mode === 'viewer') return `rgba(0,0,0,${a.toFixed(2)})`;
    return `rgba(40,45,70,${(a * 0.78).toFixed(2)})`;
  }

  /** Soft feather amount in screen pixels – CONSTANT regardless of zoom */
  _feather() {
    return 18;  // fixed 18px blur → always same visual softness
  }

  redraw() {
    if (this.map._animatingZoom) return;
    this._resize();
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const groups = [...this.visible];
    if (!groups.length) return;

    // ── 1. Full fog base ─────────────────────────────────────────────
    ctx.fillStyle = this._fogColor(1);
    ctx.fillRect(0, 0, W, H);

    // ── 2. Cut soft holes for each revealed polygon ──────────────────
    // We use an offscreen canvas to build the mask so we can
    // apply blur without bleeding into the fog fill itself.
    const mask = document.createElement('canvas');
    mask.width = W; mask.height = H;
    const mctx = mask.getContext('2d');

    for (const gid of groups) {
      for (const poly of (this.areas[gid] || [])) {
        if (poly.length < 3) continue;
        const pts = poly.map(p => this._toPx(p.lat, p.lng));

        // Draw filled polygon on mask
        mctx.beginPath();
        mctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) mctx.lineTo(pts[i][0], pts[i][1]);
        mctx.closePath();
        mctx.fillStyle = 'black';
        mctx.fill();
      }
    }

    // Blur the mask → creates soft feathered edges
    const feather = this._feather();
    mctx.filter = `blur(${feather}px)`;
    // We need to re-draw after setting filter on a separate pass
    const maskBlurred = document.createElement('canvas');
    maskBlurred.width = W; maskBlurred.height = H;
    const bctx = maskBlurred.getContext('2d');
    bctx.filter = `blur(${feather}px)`;
    bctx.drawImage(mask, 0, 0);

    // Use blurred mask to cut holes in fog
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(maskBlurred, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Add a temporary preview polygon (during brush/draw mode) */
  addPreviewArea(groupId, coords) {
    // Temporarily add without saving to state
    this._previewPoly = coords.map(p => ({ lat: +p.lat, lng: +p.lng }));
    this._previewGroup = groupId;
    this._redrawWithPreview();
  }

  clearPreview() {
    this._previewPoly  = null;
    this._previewGroup = null;
    this.redraw();
  }

  _redrawWithPreview() {
    this.redraw();
    if (!this._previewPoly || !this._previewPoly.length) return;
    // Draw preview outline on top
    const ctx = this.ctx;
    const pts  = this._previewPoly.map(p => this._toPx(p.lat, p.lng));
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,200,0,0.85)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,200,0,0.08)';
    ctx.fill();
  }

  destroy() {
    this.map.off('move zoom resize viewreset zoomend moveend', this._bound);
    this.canvas.remove();
  }
}


/**
 * FogBrush – mouse-driven brush that builds a polygon outline.
 *
 * While the user paints, a live preview shows the accumulated shape.
 * On mouseup, the brush path is converted to a smooth polygon using a
 * marching-hull algorithm and saved as a fog_area.
 */
class FogBrush {
  constructor(leafletMap, fogCanvas, onSave) {
    this.map     = leafletMap;
    this.fog     = fogCanvas;
    this.onSave  = onSave;   // async (groupId, coords) => void
    this.active  = false;
    this.groupId = null;
    this.pixelR  = 60;
    this._pts    = [];       // collected {lat,lng} centers
    this._painting = false;
    this.minDistPx = 8;
    this._lastPx   = null;

    this._cursor = document.createElement('div');
    this._cursor.style.cssText =
      'position:absolute;border-radius:50%;pointer-events:none;z-index:751;' +
      'transform:translate(-50%,-50%);display:none;' +
      'border:2px solid rgba(255,200,0,0.9);background:rgba(255,200,0,0.10);' +
      'box-shadow:0 0 0 1px rgba(0,0,0,0.5);';
    leafletMap.getContainer().appendChild(this._cursor);

    this._h = {
      move:  this._onMove.bind(this),
      down:  this._onDown.bind(this),
      up:    this._onUp.bind(this),
      leave: () => { this._cursor.style.display = 'none'; this._painting = false; }
    };
  }

  start(groupId) {
    this.groupId   = groupId;
    this.active    = true;
    this._pts      = [];
    this._painting = false;
    this._lastPx   = null;
    this._updateCursor();
    this.map.dragging.disable();
    this.map.getContainer().style.cursor = 'none';
    const el = this.map.getContainer();
    el.addEventListener('mousemove',  this._h.move);
    el.addEventListener('mousedown',  this._h.down);
    el.addEventListener('mouseup',    this._h.up);
    el.addEventListener('mouseleave', this._h.leave);
  }

  stop() {
    this.active = false; this._painting = false; this._lastPx = null;
    this._cursor.style.display = 'none';
    this.map.dragging.enable();
    this.map.getContainer().style.cursor = '';
    this.fog.clearPreview();
    const el = this.map.getContainer();
    el.removeEventListener('mousemove',  this._h.move);
    el.removeEventListener('mousedown',  this._h.down);
    el.removeEventListener('mouseup',    this._h.up);
    el.removeEventListener('mouseleave', this._h.leave);
  }

  setBrushRadius(px) {
    this.pixelR = Math.max(5, +px);
    this._updateCursor();
  }

  _updateCursor() {
    const d = this.pixelR * 2;
    this._cursor.style.width  = d + 'px';
    this._cursor.style.height = d + 'px';
  }

  _xy(e) {
    const r = this.map.getContainer().getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _mapRadius(cx, cy) {
    const a = this.map.containerPointToLatLng([cx, cy]);
    const b = this.map.containerPointToLatLng([cx + this.pixelR, cy]);
    return Math.abs(b.lng - a.lng);
  }

  _record(cx, cy) {
    if (this._lastPx) {
      const dx = cx - this._lastPx.x, dy = cy - this._lastPx.y;
      if (Math.sqrt(dx*dx + dy*dy) < this.minDistPx) return;
    }
    this._lastPx = { x: cx, y: cy };
    const ll  = this.map.containerPointToLatLng([cx, cy]);
    const rad = this._mapRadius(cx, cy);
    this._pts.push({ lat: ll.lat, lng: ll.lng, r: rad });
    // Update preview
    const poly = this._buildPolygon();
    if (poly.length >= 3) this.fog.addPreviewArea(this.groupId, poly);
  }

  _onMove(e) {
    const [cx, cy] = this._xy(e);
    this._cursor.style.left    = cx + 'px';
    this._cursor.style.top     = cy + 'px';
    this._cursor.style.display = 'block';
    this._updateCursor();
    if (this._painting) this._record(cx, cy);
  }

  _onDown(e) {
    this._painting = true;
    this._lastPx   = null;
    const [cx, cy] = this._xy(e);
    this._record(cx, cy);
  }

  async _onUp() {
    if (!this._painting) return;  // guard: prevent double-fire
    this._painting = false;
    this._lastPx   = null;
    if (this._pts.length === 0) return;

    const poly = this._buildPolygon();
    const pts  = this._pts.slice(); // copy before clearing
    this.fog.clearPreview();
    this._pts = [];   // clear immediately so second call (if any) is a no-op

    if (poly.length >= 3 && this.onSave) {
      await this.onSave(this.groupId, poly);
    }
  }

  /**
   * Build a smooth polygon from accumulated brush circles.
   * Uses an "expanded convex hull" approach:
   * 1. For each circle, sample points around its perimeter
   * 2. Compute convex hull of all sample points
   * This correctly covers all painted area.
   */
  _buildPolygon() {
    if (!this._pts.length) return [];

    // Sample perimeter points for each circle
    const samples = [];
    const N = 12; // points per circle
    this._pts.forEach(({ lat, lng, r }) => {
      for (let i = 0; i < N; i++) {
        const a = (i / N) * 2 * Math.PI;
        // r is in map lng units; approximate lat scaling
        samples.push({ lat: lat + r * Math.sin(a), lng: lng + r * Math.cos(a) });
      }
    });

    if (samples.length === 0) return [];

    // Graham scan convex hull
    const hull = this._convexHull(samples);

    // Smooth the hull with Chaikin's algorithm (2 passes)
    return this._chaikin(this._chaikin(hull));
  }

  _convexHull(pts) {
    if (pts.length <= 2) return pts;
    // Sort by lng then lat
    const sorted = [...pts].sort((a, b) => a.lng !== b.lng ? a.lng - b.lng : a.lat - b.lat);
    const cross = (O, A, B) => (A.lng - O.lng) * (B.lat - O.lat) - (A.lat - O.lat) * (B.lng - O.lng);

    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0)
        lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0)
        upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  /** Chaikin's corner-cutting algorithm for smooth polygon */
  _chaikin(pts) {
    if (pts.length < 3) return pts;
    const out = [];
    const n   = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      out.push({ lat: 0.75 * a.lat + 0.25 * b.lat, lng: 0.75 * a.lng + 0.25 * b.lng });
      out.push({ lat: 0.25 * a.lat + 0.75 * b.lat, lng: 0.25 * a.lng + 0.75 * b.lng });
    }
    return out;
  }
}
