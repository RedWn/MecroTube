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

    void this.loadInitialData();
  }

  /** Accuracy of the fix currently shown on the map (meters). */
  private locationAccuracyM = Infinity;
  private locationWatchId: number | null = null;
  private locateBtn: HTMLButtonElement | null = null;
  /** When true, the next accepted fix recenters the map (button was pressed). */
  private panToNextFix = false;

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
