import L from 'leaflet';
import type { Stop, TransitLine, TransitData, Locale } from '../lib/types';
import { exportDataAsJson, parseTransitData, mergeTransitData } from '../lib/storage';
import { dictionaries } from '../i18n/ui';
import { snapToRoads, smoothPath, type LatLng } from '../lib/routing';

const DAMASCUS_CENTER: [number, number] = [33.5138, 36.2765];

/** Route colours drawn from printed transit-diagram conventions. */
const LINE_COLORS = [
  '#0019A8', '#DA291C', '#00782A', '#F4A900',
  '#7B2D8E', '#00A6A6', '#E85D75', '#A0522D',
];

const BASE_URL = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;
const API_URL = `${BASE_URL}api/transit`;

/**
 * At or above this zoom every stop is drawn. Set to the map's default zoom so
 * the initial view is complete; hiding only kicks in once the user zooms out.
 */
const STOP_ZOOM = 20;
/** Between this and STOP_ZOOM only interchanges are drawn; below it, none. */
const INTERCHANGE_ZOOM = 15;

/** How line geometry between stops is drawn. */
type GeometryMode = 'roads' | 'smooth' | 'straight';
type FilterMode = 'all' | 'loop' | 'interchange';

async function loadFromServer(): Promise<TransitData> {
  try {
    const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${API_URL} failed: ${res.status}`);
    return parseTransitData(await res.json()) ?? { stops: [], lines: [] };
  } catch (err) {
    console.error('Failed to load transit data from server', err);
    return { stops: [], lines: [] };
  }
}

// Saves are queued so rapid edits hit the server in the order they were made.
let saveChain: Promise<unknown> = Promise.resolve();
function saveToServer(data: TransitData): void {
  const body = JSON.stringify(data);
  saveChain = saveChain
    .then(() =>
      fetch(API_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then((res) => {
        if (!res.ok) throw new Error(`PUT ${API_URL} failed: ${res.status}`);
      }),
    )
    .catch((err) => console.error('Failed to save transit data to server', err));
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number) {
  let h: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(h);
    h = setTimeout(() => fn(...args), ms);
  };
}

export interface AppOptions {
  mapEl: HTMLElement;
  sidebarEl: HTMLElement;
  editorEl: HTMLElement;
  addLineBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  importInput: HTMLInputElement;
  locale: Locale;
  searchInput?: HTMLInputElement;
  filterChips?: HTMLElement;
  filterMeta?: HTMLElement;
  geomBtn?: HTMLButtonElement;
  tilesBtn?: HTMLButtonElement;
  themeBtn?: HTMLButtonElement;
  stopDialog?: HTMLDialogElement;
  confirmDialog?: HTMLDialogElement;
  toastRegion?: HTMLElement;
}

export class DamascusTransitApp {
  private map: L.Map;
  private data: TransitData;
  private locale: Locale;
  private t: (key: keyof (typeof dictionaries)['en']) => string;

  private selectedLineId: string | null = null;
  private addingStops = false;

  private query = '';
  private filter: FilterMode = 'all';
  private hiddenLineIds = new Set<string>();
  private geometryMode: GeometryMode = 'straight';

  private lineLayers = new Map<string, L.Polyline>();
  private stopMarkers = new Map<string, L.CircleMarker>();
  private arrowMarkers: L.Marker[] = [];
  private dragTarget: {
    marker: L.CircleMarker;
    stop: Stop;
    startPoint: L.Point;
    moved: boolean;
  } | null = null;

  /** Index of the stop row currently being dragged in the editor list. */
  private dragIndex: number | null = null;

  /** Cancels in-flight routing when geometry changes again before it lands. */
  private routeAbort: AbortController | null = null;
  private routeSeq = 0;

  private el: AppOptions;
  /** Editor inputs are reused across renders so typing never loses focus. */
  private editorRefs: {
    lineId: string;
    nameEn: HTMLInputElement;
    nameAr: HTMLInputElement;
    color: HTMLInputElement;
    loop: HTMLInputElement;
    stopsHost: HTMLElement;
    hint: HTMLParagraphElement;
    toggle: HTMLButtonElement;
    palette: HTMLElement;
  } | null = null;

  constructor(opts: AppOptions) {
    this.el = opts;
    this.locale = opts.locale;
    this.t = (key) => dictionaries[this.locale][key] ?? dictionaries.en[key];

    this.data = { stops: [], lines: [] };
    this.restoreFromUrl();

    this.map = L.map(opts.mapEl, {
      zoomControl: true,
      inertia: true,
      inertiaDeceleration: 2500,
      inertiaMaxSpeed: 2,
      easeLinearity: 0.15,
      scrollWheelZoom: true,
      wheelPxPerZoomLevel: 45,
      zoomSnap: 0.25,
      maxZoom: 19,
      attributionControl: true,
    }).setView(DAMASCUS_CENTER, 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    this.bindMapEvents();
    this.bindControls();

    void this.loadInitialData();
    this.renderAll();
  }

  // ---------------------------------------------------------------- lifecycle

  private async loadInitialData() {
    this.data = await loadFromServer();
    // A line id from the URL is only valid once data has arrived.
    if (this.selectedLineId && !this.data.lines.some((l) => l.id === this.selectedLineId)) {
      this.selectedLineId = null;
    }
    this.renderAll();
  }

  private save() {
    this.cleanupOrphanStops();
    saveToServer(this.data);
  }

  /** Removes stops that are not referenced by any line. */
  private cleanupOrphanStops() {
    const used = new Set(this.data.lines.flatMap((l) => l.stopIds));
    this.data.stops = this.data.stops.filter((s) => used.has(s.id));
  }

  // ------------------------------------------------------------- url + state

  private restoreFromUrl() {
    const p = new URLSearchParams(location.search);
    const line = p.get('line');
    if (line) this.selectedLineId = line;
    const q = p.get('q');
    if (q) this.query = q;
    const f = p.get('filter');
    if (f === 'loop' || f === 'interchange' || f === 'all') this.filter = f;
    const g = p.get('geom');
    if (g === 'roads' || g === 'smooth' || g === 'straight') this.geometryMode = g;
  }

  private syncUrl() {
    const p = new URLSearchParams();
    if (this.selectedLineId) p.set('line', this.selectedLineId);
    if (this.query) p.set('q', this.query);
    if (this.filter !== 'all') p.set('filter', this.filter);
    if (this.geometryMode !== 'straight') p.set('geom', this.geometryMode);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  // ---------------------------------------------------------------- bindings

  private bindMapEvents() {
    this.map.on('click', (e: L.LeafletMouseEvent) => void this.handleMapClick(e));

    // Stop circles become noise once the whole city is in frame, so below a
    // threshold only the routes are drawn. Toggling a class rather than
    // removing markers keeps this free of re-renders (and of re-routing).
    this.map.on('zoomend', () => this.applyZoomDetail());
    this.applyZoomDetail();

    this.map.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (!this.dragTarget) return;
      // Only start visibly moving the marker once the pointer has traveled
      // past a small threshold; otherwise a plain click gets misread as a
      // drag and the marker's own 'click' handler never fires.
      const dist = this.map.latLngToLayerPoint(e.latlng).distanceTo(this.dragTarget.startPoint);
      if (!this.dragTarget.moved && dist < 4) return;
      this.dragTarget.moved = true;
      this.dragTarget.marker.setLatLng(e.latlng);
    });

    this.map.on('mouseup', (e: L.LeafletMouseEvent) => {
      if (!this.dragTarget) return;
      const { stop, moved } = this.dragTarget;
      this.dragTarget = null;
      this.map.dragging.enable();
      if (!moved) return;
      stop.lat = e.latlng.lat;
      stop.lng = e.latlng.lng;
      this.save();
      void this.renderMap();
    });
  }

  /**
   * Sets the map's detail level from the current zoom. Ordinary stops drop out
   * first; interchanges survive one level longer because they carry more
   * information at a glance. Editing always shows everything, since stops
   * cannot be clicked or dragged while hidden.
   */
  private applyZoomDetail() {
    const z = this.map.getZoom();
    const editing = this.addingStops;
    const level = editing || z >= STOP_ZOOM ? 'full' : z >= INTERCHANGE_ZOOM ? 'interchange' : 'lines';
    this.el.mapEl.dataset.detail = level;
  }

  private bindControls() {
    this.el.addLineBtn.addEventListener('click', () => this.createLine());
    this.el.exportBtn.addEventListener('click', () => this.handleExport());
    this.el.importBtn.addEventListener('click', () => this.el.importInput.click());
    this.el.importInput.addEventListener('change', () => void this.handleImport());

    const onSearch = debounce(() => {
      this.query = (this.el.searchInput?.value ?? '').trim();
      this.syncUrl();
      this.renderSidebar();
      void this.renderMap();
    }, 140);
    this.el.searchInput?.addEventListener('input', onSearch);
    if (this.el.searchInput) this.el.searchInput.value = this.query;

    this.el.filterChips?.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
      if (!btn) return;
      this.filter = (btn.dataset.filter as FilterMode) ?? 'all';
      this.syncUrl();
      this.renderFilterChips();
      this.renderSidebar();
      void this.renderMap();
    });

    this.el.geomBtn?.addEventListener('click', () => {
      // Cycles roads → smooth → straight.
      this.geometryMode =
        this.geometryMode === 'roads' ? 'smooth' : this.geometryMode === 'smooth' ? 'straight' : 'roads';
      this.syncUrl();
      this.renderGeomBtn();
      void this.renderMap();
    });

    this.el.tilesBtn?.addEventListener('click', () => {
      const muted = this.el.mapEl.dataset.tiles === 'muted';
      this.el.mapEl.dataset.tiles = muted ? 'plain' : 'muted';
      this.el.tilesBtn?.setAttribute('aria-pressed', String(!muted));
    });

    this.el.themeBtn?.addEventListener('click', () => {
      const root = document.documentElement;
      const current =
        root.dataset.theme ??
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try {
        localStorage.setItem('mt-theme', next);
      } catch {
        /* storage unavailable — theme still applies for this session */
      }
    });

    this.renderFilterChips();
    this.renderGeomBtn();
  }

  // ------------------------------------------------------------------ naming

  private stopName(stop: Stop): string {
    return this.locale === 'ar' ? stop.nameAr || stop.nameEn : stop.nameEn || stop.nameAr;
  }

  private lineName(line: TransitLine): string {
    return this.locale === 'ar' ? line.nameAr || line.nameEn : line.nameEn || line.nameAr;
  }

  private stopsForLine(line: TransitLine): Stop[] {
    return line.stopIds
      .map((id) => this.data.stops.find((s) => s.id === id))
      .filter((s): s is Stop => Boolean(s));
  }

  private interchangeIds(): Set<string> {
    const counts = new Map<string, number>();
    for (const line of this.data.lines) {
      // A stop repeated within one line is not an interchange; count each line once.
      for (const id of new Set(line.stopIds)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  }

  // ----------------------------------------------------------------- filters

  /** Lines passing the current search text and filter chip. */
  private visibleLines(): TransitLine[] {
    const q = this.query.toLowerCase();
    const interchanges = this.interchangeIds();
    return this.data.lines.filter((line) => {
      if (this.hiddenLineIds.has(line.id)) return false;
      if (this.filter === 'loop' && !line.loop) return false;
      if (this.filter === 'interchange' && !line.stopIds.some((id) => interchanges.has(id))) {
        return false;
      }
      if (!q) return true;
      if (line.nameEn.toLowerCase().includes(q) || line.nameAr.toLowerCase().includes(q)) return true;
      // Also match a line by any of its stop names.
      return this.stopsForLine(line).some(
        (s) => s.nameEn.toLowerCase().includes(q) || s.nameAr.toLowerCase().includes(q),
      );
    });
  }

  private renderFilterChips() {
    const chips = this.el.filterChips?.querySelectorAll<HTMLButtonElement>('[data-filter]');
    chips?.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === this.filter)));
  }

  private renderGeomBtn() {
    const btn = this.el.geomBtn;
    if (!btn) return;
    const label =
      this.geometryMode === 'roads'
        ? this.t('followRoads')
        : this.geometryMode === 'smooth'
          ? this.t('smoothCurves')
          : this.t('straightLines');
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(this.geometryMode !== 'straight'));
  }

  // ----------------------------------------------------------------- render

  private renderAll() {
    this.cleanupOrphanStops();
    void this.renderMap();
    this.renderSidebar();
    this.renderEditor();
  }

  /**
   * Resolves the drawn geometry for a line under the current mode. Road
   * snapping is async; smooth and straight are computed locally.
   */
  private async geometryFor(line: TransitLine, signal?: AbortSignal): Promise<LatLng[]> {
    const stops = this.stopsForLine(line);
    const coords: LatLng[] = stops.map((s) => [s.lat, s.lng]);
    if (coords.length < 2) return coords;
    if (this.geometryMode === 'roads') return snapToRoads(stops, line.loop, signal);
    if (this.geometryMode === 'smooth') return smoothPath(coords, line.loop);
    return line.loop ? [...coords, coords[0]] : coords;
  }

  private async renderMap() {
    // Invalidate any routing still in flight from a previous render.
    this.routeAbort?.abort();
    const ctrl = new AbortController();
    this.routeAbort = ctrl;
    const seq = ++this.routeSeq;

    for (const layer of this.lineLayers.values()) layer.remove();
    for (const marker of this.stopMarkers.values()) marker.remove();
    for (const arrow of this.arrowMarkers) arrow.remove();
    this.lineLayers.clear();
    this.stopMarkers.clear();
    this.arrowMarkers = [];

    const interchanges = this.interchangeIds();
    const visible = this.visibleLines();
    const visibleIds = new Set(visible.map((l) => l.id));
    const selected = visible.find((l) => l.id === this.selectedLineId) ?? null;

    // Draw non-selected lines first so the selected route sits on top.
    const order = [...visible.filter((l) => l.id !== this.selectedLineId)];
    if (selected) order.push(selected);

    const geometries = await Promise.all(order.map((l) => this.geometryFor(l, ctrl.signal)));
    // A newer render started while routing resolved; discard this one.
    if (seq !== this.routeSeq) return;

    order.forEach((line, i) => {
      const latlngs = geometries[i];
      if (!latlngs || latlngs.length < 2) return;
      const isSel = line.id === this.selectedLineId;

      // A casing stroke underneath keeps overlapping routes readable.
      const casing = L.polyline(latlngs, {
        color: 'rgba(0,0,0,0.32)',
        weight: isSel ? 13 : 9,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(this.map);
      this.arrowMarkers.push(casing as unknown as L.Marker);

      const polyline = L.polyline(latlngs, {
        color: line.color,
        weight: isSel ? 9 : 6,
        // Dim unselected routes so the focused one reads clearly.
        opacity: selected && !isSel ? 0.45 : 1,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(this.map);

      polyline.on('click', () => this.selectLine(line.id));
      this.lineLayers.set(line.id, polyline);
      if (isSel) this.addLineArrows(latlngs, line.color, line.loop);
    });

    // Only stops belonging to a visible line are drawn.
    const shownStopIds = new Set(visible.flatMap((l) => l.stopIds));
    const selectedStopIds = new Set(selected ? selected.stopIds : []);

    for (const stop of this.data.stops) {
      if (!shownStopIds.has(stop.id)) continue;
      const isInterchange = interchanges.has(stop.id);
      const onSelected = selectedStopIds.has(stop.id);

      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius: isInterchange ? 7 : 5,
        color: '#111',
        weight: isInterchange ? 2.5 : 2,
        fillColor: '#fff',
        // Fade stops that aren't on the focused route.
        opacity: selected && !onSelected ? 0.4 : 1,
        fillOpacity: selected && !onSelected ? 0.5 : 1,
        // Drives which stops the zoom-detail rules keep visible.
        className: isInterchange ? 'stop-dot is-interchange' : 'stop-dot',
      }).addTo(this.map);

      // Names show on hover only. Labelling every stop of the selected line at
      // once crowded the map, which is the thing the redesign is trying to fix.
      marker.bindTooltip(this.stopName(stop), { direction: 'top', className: 'stop-label' });

      marker.on('click', (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev);
        this.handleStopClick(stop.id);
      });

      // Leaflet CircleMarker isn't draggable out of the box; drag manually in edit mode.
      if (selected && onSelected && this.addingStops) {
        marker.on('mousedown', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          this.dragTarget = {
            marker,
            stop,
            startPoint: this.map.latLngToLayerPoint(ev.latlng),
            moved: false,
          };
          this.map.dragging.disable();
        });
      }

      this.stopMarkers.set(stop.id, marker);
    }

    // Edit mode and zoom both gate stop visibility; re-evaluate after a render.
    this.applyZoomDetail();

    if (this.el.filterMeta) {
      this.el.filterMeta.textContent = this.t('showingCount')
        .replace('{shown}', String(visibleIds.size))
        .replace('{total}', String(this.data.lines.length));
    }
  }

  /**
   * Places direction arrows along the drawn path. Each arrow sits exactly on a
   * vertex of the polyline — never on the chord between distant samples, which
   * would cut the corner and float the arrow off a curve — and takes its
   * heading from that vertex's immediate neighbours.
   */
  /**
   * Direction arrows along the route, nudged sideways off the centreline.
   *
   * Where a route doubles back (an out-and-back, or the two halves of a loop)
   * the outbound and return stretches sit almost on top of each other, so
   * centred arrows point at one another and read as an hourglass. Offsetting
   * each arrow to the right of its own direction of travel separates the two
   * flows into parallel lanes. The shift is applied in screen pixels before
   * the rotation, so it stays a constant visual gap at every zoom level.
   */
  private addLineArrows(latlngs: LatLng[], color: string, loop: boolean) {
    if (latlngs.length < 2) return;

    /** Sideways nudge, in CSS pixels, from the centre of the line. */
    const OFFSET_PX = 7;
    const step = Math.max(1, Math.floor(latlngs.length / 14));

    for (let i = step; i < latlngs.length - 1; i += step) {
      const at = latlngs[i];
      const prev = latlngs[i - 1];
      const next = latlngs[i + 1];
      // Local heading across the vertex keeps the arrow tangent to the path.
      if (prev[0] === next[0] && prev[1] === next[1]) continue;
      const deg = this.bearing(prev, next);

      // translateX runs in the rotated frame, so +X is always "right of
      // travel" regardless of which way the segment heads.
      const html =
        `<span class="line-arrow-inner" style="transform: rotate(${deg}deg) translateX(${OFFSET_PX}px); ` +
        `border-bottom-color: ${color}"></span>`;

      const arrow = L.marker(at, {
        icon: L.divIcon({ className: 'line-arrow', html, iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false,
        keyboard: false,
      });
      arrow.addTo(this.map);
      this.arrowMarkers.push(arrow);
    }

    // Terminus arrowhead, kept on the centreline so the endpoint stays exact.
    const end = latlngs[latlngs.length - 1];
    // Look back far enough for a stable heading: the last road vertices are
    // often centimetres apart, which yields a meaningless bearing.
    const back = latlngs[Math.max(0, latlngs.length - 4)];
    if (back[0] !== end[0] || back[1] !== end[1]) {
      const deg = this.bearing(back, end);
      const head = L.marker(end, {
        icon: L.divIcon({
          className: 'line-arrow',
          html: `<span class="line-arrow-inner is-terminus" style="transform: rotate(${deg}deg); border-bottom-color: ${color}"></span>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        }),
        interactive: false,
        keyboard: false,
      });
      head.addTo(this.map);
      this.arrowMarkers.push(head);
    }

    // A loop returns to its origin, so a start dot would sit under the
    // arrowhead; only mark the origin on an open route.
    if (loop) return;
    const start = L.marker(latlngs[0], {
      icon: L.divIcon({
        className: 'line-arrow',
        html: `<span class="line-start-dot" style="background: ${color}"></span>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      interactive: false,
      keyboard: false,
    });
    start.addTo(this.map);
    this.arrowMarkers.push(start);
  }

  /** Compass bearing in degrees from a to b, measured clockwise from north. */
  private bearing(a: LatLng, b: LatLng): number {
    const rad = (d: number) => (d * Math.PI) / 180;
    const deg = (r: number) => (r * 180) / Math.PI;
    const lat1 = rad(a[0]);
    const lat2 = rad(b[0]);
    const dLng = rad(b[1] - a[1]);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  // ------------------------------------------------------------- interaction

  private async handleMapClick(e: L.LeafletMouseEvent) {
    if (!this.selectedLineId) return;
    if (!this.addingStops) {
      this.selectLine(null);
      return;
    }
    const line = this.data.lines.find((l) => l.id === this.selectedLineId);
    if (!line) return;

    const names = await this.askStopName();
    if (!names) return;

    const stop: Stop = {
      id: uid('stop'),
      nameEn: names.en.trim() || 'Stop',
      nameAr: names.ar.trim(),
      lat: e.latlng.lat,
      lng: e.latlng.lng,
    };
    this.data.stops.push(stop);
    line.stopIds.push(stop.id);
    this.save();
    this.renderAll();
  }

  private handleStopClick(stopId: string) {
    if (this.selectedLineId && this.addingStops) {
      const line = this.data.lines.find((l) => l.id === this.selectedLineId);
      if (!line) return;
      // Always append: a stop may appear more than once on a line (a branch
      // or figure-8 revisiting it). Removal works by position, not by id.
      line.stopIds.push(stopId);
      this.save();
      this.renderAll();
    }
  }

  private selectLine(lineId: string | null) {
    this.selectedLineId = lineId;
    this.addingStops = false;
    this.editorRefs = null;
    this.syncUrl();
    this.renderAll();
  }

  private createLine() {
    const line: TransitLine = {
      id: uid('line'),
      nameEn: this.t('newLine'),
      nameAr: '',
      color: LINE_COLORS[this.data.lines.length % LINE_COLORS.length],
      loop: false,
      stopIds: [],
    };
    this.data.lines.push(line);
    this.save();
    this.selectedLineId = line.id;
    this.addingStops = true;
    this.editorRefs = null;
    this.syncUrl();
    this.renderAll();
    this.el.editorEl.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
  }

  private async deleteLine(lineId: string) {
    const ok = await this.confirm(this.t('confirmDeleteTitle'), this.t('deleteConfirm'), this.t('delete'));
    if (!ok) return;

    // Keep a snapshot so the toast can offer an undo.
    const snapshot: TransitData = {
      stops: this.data.stops.map((s) => ({ ...s })),
      lines: this.data.lines.map((l) => ({ ...l, stopIds: [...l.stopIds] })),
    };

    this.data.lines = this.data.lines.filter((l) => l.id !== lineId);
    if (this.selectedLineId === lineId) this.selectedLineId = null;
    this.editorRefs = null;
    this.save();
    this.syncUrl();
    this.renderAll();

    this.toast(this.t('lineDeleted'), 'info', {
      label: this.t('undo'),
      run: () => {
        this.data = snapshot;
        this.save();
        this.renderAll();
      },
    });
  }

  // ------------------------------------------------------------ import/export

  private handleExport() {
    const json = exportDataAsJson(this.data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `transit-data-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private async handleImport() {
    const file = this.el.importInput.files?.[0];
    this.el.importInput.value = '';
    if (!file) return;

    let text: string;
    try {
      text = await file.text();
    } catch {
      this.toast(this.t('importInvalid'), 'error');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.toast(this.t('importInvalid'), 'error');
      return;
    }

    const data = parseTransitData(parsed);
    if (!data) {
      this.toast(this.t('importInvalid'), 'error');
      return;
    }

    const ok = await this.confirm(
      this.t('confirmImportTitle'),
      this.t('importConfirm'),
      this.t('importData'),
    );
    if (!ok) return;

    this.data = mergeTransitData(this.data, data);
    this.save();
    this.renderAll();
    this.toast(this.t('importSuccess'));
  }

  // ------------------------------------------------------------------ dialogs

  /** Collects a stop's bilingual name. Resolves null when cancelled. */
  private askStopName(
    initial?: { en: string; ar: string },
  ): Promise<{ en: string; ar: string } | null> {
    const dlg = this.el.stopDialog;
    const enInput = dlg?.querySelector<HTMLInputElement>('#stop-name-en');
    const arInput = dlg?.querySelector<HTMLInputElement>('#stop-name-ar');
    if (!dlg || !enInput || !arInput || typeof dlg.showModal !== 'function') {
      // No <dialog> support: fall back to the native prompts.
      const en = window.prompt(this.t('stopNamePrompt'), initial?.en ?? '');
      if (en === null) return Promise.resolve(null);
      const ar = window.prompt(this.t('stopNamePromptAr'), initial?.ar ?? '') ?? '';
      return Promise.resolve({ en, ar });
    }

    enInput.value = initial?.en ?? '';
    arInput.value = initial?.ar ?? '';

    return new Promise((resolve) => {
      const done = () => {
        dlg.removeEventListener('close', done);
        resolve(dlg.returnValue === 'save' ? { en: enInput.value, ar: arInput.value } : null);
      };
      dlg.addEventListener('close', done);
      dlg.showModal();
      enInput.focus();
      enInput.select();
    });
  }

  /** Confirmation modal. Falls back to window.confirm where <dialog> is absent. */
  private confirm(title: string, text: string, okLabel: string): Promise<boolean> {
    const dlg = this.el.confirmDialog;
    if (!dlg || typeof dlg.showModal !== 'function') {
      return Promise.resolve(window.confirm(text));
    }
    const titleEl = dlg.querySelector<HTMLElement>('#confirm-dialog-title');
    const textEl = dlg.querySelector<HTMLElement>('#confirm-dialog-text');
    const okBtn = dlg.querySelector<HTMLButtonElement>('#confirm-ok');
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;
    if (okBtn) okBtn.textContent = okLabel;

    return new Promise((resolve) => {
      const done = () => {
        dlg.removeEventListener('close', done);
        resolve(dlg.returnValue === 'ok');
      };
      dlg.addEventListener('close', done);
      dlg.showModal();
      okBtn?.focus();
    });
  }

  /** Transient status message in the polite live region. */
  private toast(message: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }) {
    const host = this.el.toastRegion;
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.kind = kind;
    el.textContent = message;

    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      btn.style.marginInlineStart = '0.6rem';
      btn.style.background = 'transparent';
      btn.style.color = 'inherit';
      btn.style.textDecoration = 'underline';
      btn.style.pointerEvents = 'auto';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        action.run();
        el.remove();
      });
      el.style.pointerEvents = 'auto';
      el.appendChild(btn);
    }

    host.appendChild(el);
    setTimeout(() => el.remove(), action ? 8000 : 3200);
  }

  // ------------------------------------------------------------------ sidebar

  private renderSidebar() {
    const host = this.el.sidebarEl;
    host.textContent = '';
    const visible = this.visibleLines();

    if (this.data.lines.length === 0) {
      host.appendChild(this.emptyState(this.t('noStops')));
      return;
    }
    if (visible.length === 0) {
      const box = this.emptyState(this.t('noMatches'));
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn-secondary btn-sm';
      clear.style.marginTop = '0.6rem';
      clear.textContent = this.t('clearFilters');
      clear.addEventListener('click', () => {
        this.query = '';
        this.filter = 'all';
        if (this.el.searchInput) this.el.searchInput.value = '';
        this.syncUrl();
        this.renderFilterChips();
        this.renderSidebar();
        void this.renderMap();
      });
      box.appendChild(clear);
      host.appendChild(box);
      return;
    }

    for (const line of visible) {
      const li = document.createElement('li');

      // A real <button> so the row is keyboard-operable and announced correctly.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'line-item';
      btn.setAttribute('aria-current', String(line.id === this.selectedLineId));

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = line.color;

      const name = document.createElement('span');
      name.className = 'line-item-name';
      name.textContent = this.lineName(line);

      const count = document.createElement('span');
      count.className = 'line-item-count';
      count.textContent = `${line.stopIds.length} ${this.t(line.stopIds.length === 1 ? 'stop' : 'stops')}`;

      btn.append(swatch, name, count);
      btn.addEventListener('click', () =>
        this.selectLine(line.id === this.selectedLineId ? null : line.id),
      );

      li.appendChild(btn);
      host.appendChild(li);
    }
  }

  private emptyState(text: string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'empty-state';
    const p = document.createElement('p');
    p.style.margin = '0';
    p.textContent = text;
    div.appendChild(p);
    return div;
  }

  // ------------------------------------------------------------------- editor

  /**
   * Builds the editor once per selected line and thereafter only refreshes
   * values and the stops list. Rebuilding on every keystroke would destroy
   * the focused input mid-typing.
   */
  private renderEditor() {
    const host = this.el.editorEl;
    const line = this.data.lines.find((l) => l.id === this.selectedLineId);

    if (!line) {
      host.hidden = true;
      host.textContent = '';
      this.editorRefs = null;
      return;
    }
    host.hidden = false;

    if (!this.editorRefs || this.editorRefs.lineId !== line.id) {
      this.buildEditor(line);
    }
    this.refreshEditor(line);
  }

  private buildEditor(line: TransitLine) {
    const host = this.el.editorEl;
    host.textContent = '';

    const title = document.createElement('h3');
    title.className = 'editor-title';
    title.textContent = this.t('editorTitle');

    const form = document.createElement('div');
    form.className = 'editor-form';

    const mkField = (labelText: string, rtl = false) => {
      const label = document.createElement('label');
      label.className = 'field';
      const span = document.createElement('span');
      span.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (rtl) input.dir = 'rtl';
      label.append(span, input);
      return { label, input };
    };

    const en = mkField(this.t('lineName'));
    const ar = mkField(this.t('lineNameAr'), true);

    en.input.addEventListener('input', () => {
      const l = this.currentLine();
      if (!l) return;
      l.nameEn = en.input.value;
      this.save();
      this.renderSidebar();
    });
    ar.input.addEventListener('input', () => {
      const l = this.currentLine();
      if (!l) return;
      l.nameAr = ar.input.value;
      this.save();
      this.renderSidebar();
    });

    // Colour: swatch presets plus a free picker.
    const colorWrap = document.createElement('div');
    colorWrap.className = 'field';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = this.t('lineColor');
    const colorRow = document.createElement('div');
    colorRow.className = 'color-field';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.setAttribute('aria-label', this.t('lineColor'));

    const palette = document.createElement('div');
    palette.className = 'palette';
    for (const c of LINE_COLORS) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'palette-dot';
      dot.style.background = c;
      dot.dataset.color = c;
      dot.setAttribute('aria-label', c);
      dot.addEventListener('click', () => {
        const l = this.currentLine();
        if (!l) return;
        l.color = c;
        this.save();
        this.refreshEditor(l);
        void this.renderMap();
        this.renderSidebar();
      });
      palette.appendChild(dot);
    }

    colorInput.addEventListener('input', () => {
      const l = this.currentLine();
      if (!l) return;
      l.color = colorInput.value;
      this.save();
      this.renderSidebar();
      void this.renderMap();
    });

    colorRow.append(colorInput, palette);
    colorWrap.append(colorLabel, colorRow);

    const loopLabel = document.createElement('label');
    loopLabel.className = 'checkbox-field';
    const loopInput = document.createElement('input');
    loopInput.type = 'checkbox';
    const loopText = document.createElement('span');
    loopText.textContent = this.t('loopLine');
    loopLabel.append(loopInput, loopText);
    loopInput.addEventListener('change', () => {
      const l = this.currentLine();
      if (!l) return;
      l.loop = loopInput.checked;
      this.save();
      void this.renderMap();
    });

    form.append(en.label, ar.label, colorWrap, loopLabel);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-primary btn-block';
    toggle.addEventListener('click', () => {
      this.addingStops = !this.addingStops;
      this.renderEditor();
      void this.renderMap();
    });

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = this.t('addStopHint');

    const stopsHost = document.createElement('ul');
    stopsHost.className = 'stops-list';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger btn-block';
    del.textContent = this.t('delete');
    del.addEventListener('click', () => void this.deleteLine(line.id));

    host.append(title, form, toggle, hint, stopsHost, del);

    this.editorRefs = {
      lineId: line.id,
      nameEn: en.input,
      nameAr: ar.input,
      color: colorInput,
      loop: loopInput,
      stopsHost,
      hint,
      toggle,
      palette,
    };
  }

  private currentLine(): TransitLine | undefined {
    return this.data.lines.find((l) => l.id === this.selectedLineId);
  }

  /** Syncs editor widgets to the line without rebuilding focused inputs. */
  private refreshEditor(line: TransitLine) {
    const r = this.editorRefs;
    if (!r) return;

    if (document.activeElement !== r.nameEn) r.nameEn.value = line.nameEn;
    if (document.activeElement !== r.nameAr) r.nameAr.value = line.nameAr;
    r.color.value = /^#[0-9a-f]{6}$/i.test(line.color) ? line.color : '#0019a8';
    r.loop.checked = line.loop;

    r.palette.querySelectorAll<HTMLButtonElement>('.palette-dot').forEach((d) =>
      d.setAttribute('aria-pressed', String(d.dataset.color?.toLowerCase() === line.color.toLowerCase())),
    );

    r.toggle.textContent = this.addingStops ? this.t('doneEditing') : this.t('editStops');
    r.toggle.setAttribute('aria-pressed', String(this.addingStops));
    r.hint.hidden = !this.addingStops;

    this.renderStopsList(line, r.stopsHost);
  }

  private renderStopsList(line: TransitLine, host: HTMLElement) {
    host.textContent = '';
    const stops = this.stopsForLine(line);

    if (stops.length === 0) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.style.background = 'none';
      li.style.borderInlineStart = 'none';
      li.textContent = this.t('noStops');
      host.appendChild(li);
      return;
    }

    stops.forEach((stop, index) => {
      const row = document.createElement('li');
      row.className = 'stop-row';
      row.draggable = true;
      row.dataset.index = String(index);

      // The grip is the only reorder control, so it must work by keyboard too:
      // focus it and use the arrow keys (or Alt+arrows) to move the stop.
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'stop-grip';
      grip.textContent = '⠿';
      grip.title = this.t('dragStop');
      grip.setAttribute(
        'aria-label',
        `${this.t('dragStop')}: ${this.stopName(stop)} (${index + 1}/${stops.length})`,
      );
      grip.addEventListener('keydown', (ev) => {
        const key = ev.key;
        if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
        const to = key === 'ArrowUp' ? index - 1 : index + 1;
        if (to < 0 || to >= stops.length) return;
        ev.preventDefault();
        this.moveStop(line, index, to);
        // Keep focus on the moved stop's grip so repeated presses keep working.
        const rows = host.querySelectorAll<HTMLElement>('.stop-row .stop-grip');
        rows[to]?.focus();
      });

      const idx = document.createElement('span');
      idx.className = 'stop-index';
      idx.textContent = String(index + 1);

      const label = document.createElement('span');
      label.className = 'stop-row-name';
      label.textContent = this.stopName(stop);

      const mkIcon = (glyph: string, aria: string, run: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn';
        b.textContent = glyph;
        b.setAttribute('aria-label', `${aria}: ${this.stopName(stop)}`);
        b.addEventListener('click', run);
        return b;
      };

      const rename = mkIcon('✎', this.t('renameStop'), () => {
        void (async () => {
          const names = await this.askStopName({ en: stop.nameEn, ar: stop.nameAr });
          if (!names) return;
          stop.nameEn = names.en.trim() || stop.nameEn;
          stop.nameAr = names.ar.trim();
          this.save();
          this.refreshEditor(line);
          void this.renderMap();
        })();
      });

      const remove = mkIcon('✕', this.t('removeStop'), () => {
        line.stopIds.splice(index, 1);
        this.save();
        this.refreshEditor(line);
        void this.renderMap();
      });
      remove.classList.add('remove');

      row.addEventListener('dragstart', (ev) => {
        this.dragIndex = index;
        row.classList.add('dragging');
        ev.dataTransfer?.setData('text/plain', String(index));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });

      row.addEventListener('dragend', () => {
        this.dragIndex = null;
        host.querySelectorAll('.stop-row').forEach((r) => {
          r.classList.remove('dragging', 'drop-before', 'drop-after');
        });
      });

      row.addEventListener('dragover', (ev) => {
        if (this.dragIndex === null || this.dragIndex === index) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        // Show the insertion edge based on which half the pointer is over.
        const box = row.getBoundingClientRect();
        const after = ev.clientY > box.top + box.height / 2;
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drop-before', 'drop-after');
      });

      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const from = this.dragIndex;
        row.classList.remove('drop-before', 'drop-after');
        if (from === null || from === index) return;
        const box = row.getBoundingClientRect();
        const after = ev.clientY > box.top + box.height / 2;
        let to = after ? index + 1 : index;
        // Removing the source first shifts every later target down by one.
        if (from < to) to -= 1;
        this.moveStop(line, from, to);
      });

      row.append(grip, idx, label, rename, remove);
      host.appendChild(row);
    });
  }

  /** Moves a stop within a line and announces the result for screen readers. */
  private moveStop(line: TransitLine, from: number, to: number) {
    if (from === to) return;
    const ids = line.stopIds;
    if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return;

    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    this.save();
    this.refreshEditor(line);
    void this.renderMap();

    const stop = this.data.stops.find((s) => s.id === moved);
    if (stop) {
      this.announce(
        this.t('stopMoved')
          .replace('{name}', this.stopName(stop))
          .replace('{pos}', String(to + 1))
          .replace('{total}', String(ids.length)),
      );
    }
  }

  /** Posts a message to the polite live region without a visible toast. */
  private announce(message: string) {
    const host = this.el.toastRegion;
    if (!host) return;
    const el = document.createElement('span');
    el.className = 'visually-hidden';
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }
}
