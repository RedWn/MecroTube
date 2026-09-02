import L from 'leaflet';
import type { Stop, TransitLine, TransitData, Locale } from '../lib/types';
import { parseTransitData } from '../lib/storage';
import { dictionaries } from '../i18n/ui';

const DAMASCUS_CENTER: [number, number] = [33.5138, 36.2765];

const BASE_URL = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const API_URL = `${BASE_URL}api/transit`;

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

    void this.loadInitialData();
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
    this.lineLayers = [];
    this.stopMarkers = [];
    this.arrowMarkers = [];

    const interchanges = this.interchangeIds();
    const selected = this.data.lines.find((l) => l.id === this.selectedLineId);

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
    };

    for (const line of this.data.lines) {
      if (line.id === this.selectedLineId) continue;
      drawLine(line);
    }
    if (selected) drawLine(selected);

    const drawnStopIds = new Set<string>();
    for (const stop of this.data.stops) {
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
