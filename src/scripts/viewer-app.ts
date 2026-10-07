import L from 'leaflet';
import type { Stop, TransitLine, TransitData, Locale } from '../lib/types';
import { parseTransitData } from '../lib/storage';
import { TRANSIT_API_URL } from '../lib/api';
import { dictionaries } from '../i18n/ui';

const DAMASCUS_CENTER: [number, number] = [33.5138, 36.2765];
/** At or above this zoom, line names are drawn along the lines themselves. */
const LINE_LABEL_MIN_ZOOM = 15;

const API_URL = TRANSIT_API_URL;

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

/** Read-only transit map viewer. No editing, no saving. */
export class DamascusTransitViewer {
  private map: L.Map;
  private data: TransitData = { stops: [], lines: [] };
  private locale: Locale;
  private t: (key: keyof typeof dictionaries['en']) => string;

  private selectedLineId: string | null = null;

  private lineLayers: L.Polyline[] = [];
  private stopMarkers: L.CircleMarker[] = [];
  private arrowMarkers: L.Marker[] = [];
  private lineLabelMarkers: L.Marker[] = [];
  private locationDot: L.CircleMarker | null = null;
  private locationAccuracy: L.Circle | null = null;

  private sidebarEl: HTMLElement;

  constructor(opts: { mapEl: HTMLElement; sidebarEl: HTMLElement; locale: Locale }) {
    this.locale = opts.locale;
    this.t = (key) => dictionaries[this.locale][key] ?? dictionaries.en[key];
    this.sidebarEl = opts.sidebarEl;

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
    }).setView(DAMASCUS_CENTER, 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    this.map.on('click', () => this.selectLine(null));
    // Zoom-dependent labels (line names along the route when zoomed in).
    this.map.on('zoomend', () => this.renderMap());

    this.startLocationTracking();
    this.addPlaceSearch();
    this.addClearPinsButton();

    void this.loadInitialData();
  }

  /** Accuracy of the fix currently shown on the map (meters). */
  private locationAccuracyM = Infinity;
  private locationWatchId: number | null = null;
  private locateBtn: HTMLButtonElement | null = null;
  /** When true, the next accepted fix recenters the map (button was pressed). */
  private panToNextFix = false;

  private placePins: L.Marker[] = [];
  private clearPinsBtn: HTMLButtonElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchResultsEl: HTMLDivElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchAbort: AbortController | null = null;

  /**
   * Show the user's current location as a large blue dot (Google-Maps style).
   * Early fixes are often coarse (cell tower / WiFi-based); we accept every
   * fix at first so the dot appears quickly, then only move it when a fix is
   * at least as accurate as what's on screen. This lets the dot converge on
   * the best GPS fix instead of jumping around on noisy readings.
   */
  private startLocationTracking() {
    if (!('geolocation' in navigator)) return;

    this.restartWatch();
    // Browsers throttle geolocation in background tabs; restart the watch
    // when the page becomes visible again so accuracy recovers quickly.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.restartWatch();
    });

    this.addLocateButton();
  }

  /** Drop the current watch and request fresh fixes from scratch. */
  private restartWatch() {
    if (this.locationWatchId !== null) navigator.geolocation.clearWatch(this.locationWatchId);
    // Accept the next fix even if it's coarser than what's on screen: the
    // dot re-converges onto the freshest data instead of being pinned to a
    // possibly stale position.
    this.locationAccuracyM = Infinity;
    this.locationWatchId = navigator.geolocation.watchPosition(
      (pos) => this.handleFix(pos),
      (err) => {
        this.locateBtn?.classList.remove('loading');
        console.warn('Geolocation unavailable', err);
      },
      {
        enableHighAccuracy: true, // use GPS, not just WiFi/cell
        maximumAge: 0, // never accept a cached fix
        timeout: 30_000, // give the GPS chip time to lock on
      },
    );
  }

  private handleFix(pos: GeolocationPosition) {
    const accuracy = pos.coords.accuracy;
    // Ignore fixes that are no better than what we already show,
    // unless the previous fix has gone stale (user actually moved).
    if (this.locationDot && accuracy > this.locationAccuracyM * 1.2) return;

    this.locationAccuracyM = accuracy;
    const latlng: [number, number] = [pos.coords.latitude, pos.coords.longitude];
    if (!this.locationDot) {
      // Accuracy ring underneath.
      this.locationAccuracy = L.circle(latlng, {
        radius: accuracy,
        color: 'transparent',
        fillColor: '#2f6bd8',
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(this.map);
      // Large blue dot with a white ring.
      this.locationDot = L.circleMarker(latlng, {
        radius: 11,
        color: '#fff',
        weight: 3.5,
        fillColor: '#2f6bd8',
        fillOpacity: 1,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.locationDot.setLatLng(latlng);
      this.locationAccuracy!.setLatLng(latlng);
      this.locationAccuracy!.setRadius(accuracy);
    }

    this.locateBtn?.classList.remove('loading');
    if (this.panToNextFix) {
      this.panToNextFix = false;
      this.map.setView(latlng, Math.max(this.map.getZoom(), 15));
    }
  }

  /** Floating button that refreshes the location fix and pans the map to it. */
  private addLocateButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'locate-btn';
    btn.title = this.t('locate');
    btn.setAttribute('aria-label', this.t('locate'));
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<circle cx="12" cy="12" r="3.2"/>' +
      '<circle cx="12" cy="12" r="7.4"/>' +
      '<line x1="12" y1="1.4" x2="12" y2="4.4"/>' +
      '<line x1="12" y1="19.6" x2="12" y2="22.6"/>' +
      '<line x1="1.4" y1="12" x2="4.4" y2="12"/>' +
      '<line x1="19.6" y1="12" x2="22.6" y2="12"/>' +
      '</svg>';
    btn.addEventListener('click', () => {
      btn.classList.add('loading');
      this.panToNextFix = true;
      this.restartWatch();
    });
    this.map.getContainer().appendChild(btn);
    this.locateBtn = btn;
  }

  /**
   * Floating search box (top of map): look up a place by name via Nominatim
   * and drop a pin on it. Pins are local-only — never sent to the server —
   * and are removed by clicking them.
   */
  private addPlaceSearch() {
    const box = document.createElement('div');
    box.className = 'place-search';

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'place-search-input';
    input.placeholder = this.t('searchPlace');
    input.setAttribute('aria-label', this.t('searchPlace'));

    const results = document.createElement('div');
    results.className = 'place-search-results';
    results.hidden = true;

    box.append(input, results);
    this.map.getContainer().appendChild(box);
    this.searchInput = input;
    this.searchResultsEl = results;

    input.addEventListener('input', () => {
      this.closeSearchResults();
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      const query = input.value.trim();
      if (query.length < 3) return;
      this.searchTimer = setTimeout(() => void this.searchPlaces(query), 350);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeSearchResults();
      if (e.key === 'Enter') {
        const first = results.querySelector<HTMLButtonElement>('button');
        if (first) {
          e.preventDefault();
          first.click();
        }
      }
    });
    document.addEventListener('click', (e) => {
      if (!box.contains(e.target as Node)) this.closeSearchResults();
    });
  }

  /** Floating trash button that removes all pins; shown only while pins exist. */
  private addClearPinsButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'locate-btn clear-pins-btn';
    btn.title = this.t('clearPins');
    btn.setAttribute('aria-label', this.t('clearPins'));
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 7h16"/>' +
      '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' +
      '<path d="M6.5 7l.9 12.1A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9L17.5 7"/>' +
      '<path d="M10 11v6M14 11v6"/>' +
      '</svg>';
    btn.hidden = true;
    btn.addEventListener('click', () => {
      for (const pin of this.placePins) pin.remove();
      this.placePins = [];
      this.updateClearPinsBtn();
    });
    this.map.getContainer().appendChild(btn);
    this.clearPinsBtn = btn;
  }

  private updateClearPinsBtn() {
    if (this.clearPinsBtn) this.clearPinsBtn.hidden = this.placePins.length === 0;
  }

  private async searchPlaces(query: string) {
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    // OSM Nominatim geocoder: no API key, CORS-enabled, biased (not limited)
    // toward the Damascus area so local results rank first.
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '6',
      viewbox: '36.0,33.3,36.6,33.8',
      'accept-language': this.locale,
    });
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal: abort.signal });
      if (!res.ok) throw new Error(`geocoding failed: ${res.status}`);
      const rows = (await res.json()) as Array<{ lat: string; lon: string; name?: string; display_name: string }>;
      if (abort.signal.aborted) return;
      this.renderSearchResults(
        rows.map((r) => {
          const parts = r.display_name.split(',').map((s) => s.trim());
          return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), primary: r.name || parts[0], secondary: parts.slice(1).join(', ') };
        }),
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn('Place search failed', err);
      this.renderSearchResults([]);
    }
  }

  private renderSearchResults(items: { lat: number; lng: number; primary: string; secondary: string }[]) {
    const results = this.searchResultsEl;
    if (!results) return;
    results.innerHTML = '';
    results.hidden = false;
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'place-search-empty';
      empty.textContent = this.t('noResults');
      results.appendChild(empty);
      return;
    }
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'place-search-item';
      const name = document.createElement('span');
      name.className = 'place-search-item-name';
      name.textContent = item.primary;
      const detail = document.createElement('span');
      detail.className = 'place-search-item-detail';
      detail.textContent = item.secondary;
      btn.append(name, detail);
      btn.addEventListener('click', () => this.dropPlacePin(item));
      results.appendChild(btn);
    }
  }

  private closeSearchResults() {
    if (this.searchResultsEl) this.searchResultsEl.hidden = true;
  }

  private dropPlacePin(item: { lat: number; lng: number; primary: string; secondary: string }) {
    const marker = L.marker([item.lat, item.lng], {
      icon: L.divIcon({
        className: 'place-pin',
        html: '<svg width="26" height="36" viewBox="0 0 24 34"><path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 7.6 8.6 17.7 10 19.4a.9.9 0 0 0 1 0c1.4-1.7 10-11.8 10-19.4C22.5 6.2 17.8 1.5 12 1.5z" fill="#d64545" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="4.4" fill="#fff"/></svg>',
        iconSize: [26, 36],
        iconAnchor: [13, 34],
      }),
    }).addTo(this.map);
    marker.bindTooltip(item.primary, { direction: 'top', offset: [0, -32] });
    // Clicking a pin removes it (it only lives in this browser session).
    marker.on('click', (ev: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(ev);
      marker.remove();
      this.placePins = this.placePins.filter((p) => p !== marker);
      this.updateClearPinsBtn();
    });
    this.placePins.push(marker);
    this.updateClearPinsBtn();

    this.closeSearchResults();
    if (this.searchInput) this.searchInput.value = item.primary;
    this.map.setView([item.lat, item.lng], Math.max(this.map.getZoom(), 15));
  }

  private async loadInitialData() {
    this.data = await loadFromServer();
    this.renderAll();
  }

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
      for (const id of line.stopIds) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  }

  private renderAll() {
    this.renderMap();
    this.renderSidebar();
  }

  private renderMap() {
    for (const layer of this.lineLayers) layer.remove();
    for (const marker of this.stopMarkers) marker.remove();
    for (const arrow of this.arrowMarkers) arrow.remove();
    for (const label of this.lineLabelMarkers) label.remove();
    this.lineLayers = [];
    this.stopMarkers = [];
    this.arrowMarkers = [];
    this.lineLabelMarkers = [];

    const interchanges = this.interchangeIds();
    const selected = this.data.lines.find((l) => l.id === this.selectedLineId);

    // In view mode, selecting a line hides all other lines.
    const visibleLines = selected ? [selected] : this.data.lines;
    const visibleStopIds = new Set(visibleLines.flatMap((l) => l.stopIds));

    const drawLine = (line: TransitLine) => {
      const stops = this.stopsForLine(line);
      if (stops.length < 2) return;
      const latlngs: [number, number][] = stops.map((s) => [s.lat, s.lng]);
      if (line.loop) latlngs.push(latlngs[0]);
      const polyline = L.polyline(latlngs, {
        color: line.color,
        weight: line.id === this.selectedLineId ? 14 : 8,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(this.map);
      polyline.on('click', (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev);
        this.selectLine(line.id);
      });
      this.lineLayers.push(polyline);
      if (line.id === this.selectedLineId) this.addLineArrows(latlngs);
      if (this.map.getZoom() >= LINE_LABEL_MIN_ZOOM) this.addLineNameLabels(line, stops);
    };

    for (const line of visibleLines) {
      if (line.id === this.selectedLineId) continue;
      drawLine(line);
    }
    if (selected) drawLine(selected);

    const drawnStopIds = new Set<string>();
    for (const stop of this.data.stops) {
      if (!visibleStopIds.has(stop.id)) continue;
      if (drawnStopIds.has(stop.id)) continue;
      drawnStopIds.add(stop.id);
      const isInterchange = interchanges.has(stop.id);
      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius: isInterchange ? 8 : 5,
        color: '#111',
        weight: isInterchange ? 2.5 : 2,
        fillColor: '#fff',
        fillOpacity: 1,
      }).addTo(this.map);

      const isOnSelectedLine = selected
        ? this.stopsForLine(selected).some((s) => s.id === stop.id)
        : false;
      if (isOnSelectedLine) {
        marker.bindTooltip(this.stopName(stop), {
          permanent: true,
          direction: 'right',
          offset: [8, 0],
          className: 'stop-label',
        });
      }

      this.stopMarkers.push(marker);
    }
  }

  /**
   * Draw the line's name repeatedly along its path (one label per segment,
   * at each segment's midpoint) so the name stays visible while panning
   * around when zoomed in and the stop labels are off-screen.
   */
  private addLineNameLabels(line: TransitLine, stops: Stop[]) {
    const name = this.lineName(line);
    if (!name) return;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const mid: [number, number] = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
      const icon = L.divIcon({
        className: 'line-name-label',
        html: `<span class="line-name-label-inner" style="background:${line.color}">${name}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      const label = L.marker(mid, { icon, interactive: false });
      label.addTo(this.map);
      this.lineLabelMarkers.push(label);
    }
  }

  private addLineArrows(latlngs: [number, number][]) {
    for (let i = 0; i < latlngs.length - 1; i++) {
      const a = latlngs[i];
      const b = latlngs[i + 1];
      const deg = this.bearing(a, b);
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const icon = L.divIcon({
        className: 'line-arrow',
        html: `<span class="line-arrow-inner" style="transform: rotate(${deg}deg)"></span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const arrow = L.marker(mid, { icon, interactive: false });
      arrow.addTo(this.map);
      this.arrowMarkers.push(arrow);
    }
  }

  private bearing(a: [number, number], b: [number, number]): number {
    const rad = (d: number) => (d * Math.PI) / 180;
    const deg = (r: number) => (r * 180) / Math.PI;
    const lat1 = rad(a[0]);
    const lat2 = rad(b[0]);
    const dLng = rad(b[1] - a[1]);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  private selectLine(lineId: string | null) {
    this.selectedLineId = this.selectedLineId === lineId ? null : lineId;
    this.renderAll();
  }

  private renderSidebar() {
    this.sidebarEl.innerHTML = '';
    for (const line of this.data.lines) {
      const li = document.createElement('li');
      li.className = 'line-item' + (line.id === this.selectedLineId ? ' selected' : '');

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = line.color;

      const name = document.createElement('span');
      name.className = 'line-item-name';
      name.textContent = this.lineName(line);

      const count = document.createElement('span');
      count.className = 'line-item-count';
      count.textContent = `${line.stopIds.length} ${this.t(line.stopIds.length === 1 ? 'stop' : 'stops')}`;

      li.append(swatch, name, count);
      li.addEventListener('click', () => this.selectLine(line.id));
      this.sidebarEl.appendChild(li);
    }
  }
}
