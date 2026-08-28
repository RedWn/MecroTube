import L from 'leaflet';
import type { Stop, TransitLine, TransitData, Locale } from '../lib/types';
import { exportDataAsJson, parseTransitData, mergeTransitData } from '../lib/storage';
import { dictionaries } from '../i18n/ui';

const DAMASCUS_CENTER: [number, number] = [33.5138, 36.2765];
const LINE_COLORS = ['#0019A8', '#DA291C', '#00782A', '#F4A900', '#7B2D8E', '#00A6A6', '#E85D75', '#5C4033'];

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

export class DamascusTransitApp {
  private map: L.Map;
  private data: TransitData;
  private locale: Locale;
  private t: (key: keyof typeof dictionaries['en']) => string;

  private selectedLineId: string | null = null;
  private addingStops = false;

  private lineLayers = new Map<string, L.Polyline>();
  private stopMarkers = new Map<string, L.CircleMarker>();
  private dragTarget: { marker: L.CircleMarker; stop: Stop; startPoint: L.Point; moved: boolean } | null = null;

  private sidebarEl: HTMLElement;
  private editorEl: HTMLElement;
  private addLineBtn: HTMLButtonElement;
  private exportBtn: HTMLButtonElement;
  private importBtn: HTMLButtonElement;
  private importInput: HTMLInputElement;

  constructor(opts: {
    mapEl: HTMLElement;
    sidebarEl: HTMLElement;
    editorEl: HTMLElement;
    addLineBtn: HTMLButtonElement;
    exportBtn: HTMLButtonElement;
    importBtn: HTMLButtonElement;
    importInput: HTMLInputElement;
    locale: Locale;
  }) {
    this.locale = opts.locale;
    this.t = (key) => dictionaries[this.locale][key] ?? dictionaries.en[key];
    this.sidebarEl = opts.sidebarEl;
    this.editorEl = opts.editorEl;
    this.addLineBtn = opts.addLineBtn;
    this.exportBtn = opts.exportBtn;
    this.importBtn = opts.importBtn;
    this.importInput = opts.importInput;

    this.data = { stops: [], lines: [] };
    void this.loadInitialData();

    this.map = L.map(opts.mapEl, {
      zoomControl: true,
    }).setView(DAMASCUS_CENTER, 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => this.handleMapClick(e));
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (!this.dragTarget) return;
      // Only start visibly moving the marker once the pointer has traveled
      // past a small threshold; otherwise a plain click gets misread as a
      // drag and the marker's own 'click' handler never fires (see mouseup).
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
      if (!moved) {
        // Plain click, no movement: let the marker's native 'click' event
        // (fired right after this mouseup) handle it via handleStopClick.
        return;
      }
      stop.lat = e.latlng.lat;
      stop.lng = e.latlng.lng;
      this.save();
      this.renderMap();
    });

    this.addLineBtn.addEventListener('click', () => this.createLine());
    this.exportBtn.addEventListener('click', () => this.handleExport());
    this.importBtn.addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => this.handleImport());

    this.renderAll();
  }

  private async loadInitialData() {
    this.data = await loadFromServer();
    this.renderAll();
  }

  private save() {
    saveToServer(this.data);
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
    this.renderEditor();
  }

  private renderMap() {
    for (const layer of this.lineLayers.values()) layer.remove();
    for (const marker of this.stopMarkers.values()) marker.remove();
    this.lineLayers.clear();
    this.stopMarkers.clear();

    const interchanges = this.interchangeIds();

    for (const line of this.data.lines) {
      if (this.selectedLineId && line.id !== this.selectedLineId) continue;
      const stops = this.stopsForLine(line);
      if (stops.length < 2) continue;
      const latlngs: [number, number][] = stops.map((s) => [s.lat, s.lng]);
      if (line.loop) latlngs.push(latlngs[0]);
      const polyline = L.polyline(latlngs, {
        color: line.color,
        weight: 8,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(this.map);
      polyline.on('click', () => this.selectLine(line.id));
      this.lineLayers.set(line.id, polyline);
    }

    // draw stop markers on top
    const drawnStopIds = new Set<string>();
    for (const line of this.data.lines) {
      if (this.selectedLineId && line.id !== this.selectedLineId) continue;
      for (const stop of this.stopsForLine(line)) {
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

        if (this.selectedLineId) {
          marker.bindTooltip(this.stopName(stop), {
            permanent: true,
            direction: 'right',
            offset: [8, 0],
            className: 'stop-label',
          });
        }

        marker.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          this.handleStopClick(stop.id);
        });

        // Leaflet CircleMarker doesn't support dragging out of the box; use manual drag for edit mode.
        if (this.selectedLineId && this.addingStops) {
          marker.on('mousedown', (ev: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(ev);
            this.dragTarget = { marker, stop, startPoint: this.map.latLngToLayerPoint(ev.latlng), moved: false };
            this.map.dragging.disable();
          });
        }

        this.stopMarkers.set(stop.id, marker);
      }
    }
  }

  private handleMapClick(e: L.LeafletMouseEvent) {
    if (!this.selectedLineId) return;
    if (!this.addingStops) {
      // Clicking the map background (not a stop) while viewing a line
      // deselects it and shows all lines again.
      this.selectLine(null);
      return;
    }
    const line = this.data.lines.find((l) => l.id === this.selectedLineId);
    if (!line) return;

    const nameEn = window.prompt(this.t('stopNamePrompt'));
    if (nameEn === null) return;
    const nameAr = window.prompt(this.t('stopNamePromptAr')) ?? '';

    const stop: Stop = {
      id: uid('stop'),
      nameEn: nameEn.trim() || 'Stop',
      nameAr: nameAr.trim(),
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
      // Always append: this lets a stop be added more than once to the same
      // line (e.g. a branch or figure-8 route revisiting a stop). Removing a
      // stop is done from the stops list in the editor, which operates on a
      // specific position rather than on the stop id.
      line.stopIds.push(stopId);
      this.save();
      this.renderAll();
    }
  }

  private selectLine(lineId: string | null) {
    this.selectedLineId = lineId;
    this.addingStops = false;
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
    this.renderAll();
  }

  private deleteLine(lineId: string) {
    if (!window.confirm(this.t('deleteConfirm'))) return;
    this.data.lines = this.data.lines.filter((l) => l.id !== lineId);
    if (this.selectedLineId === lineId) this.selectedLineId = null;
    this.save();
    this.renderAll();
  }

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

  private handleImport() {
    const file = this.importInput.files?.[0];
    this.importInput.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        window.alert(this.t('importInvalid'));
        return;
      }
      const data = parseTransitData(parsed);
      if (!data) {
        window.alert(this.t('importInvalid'));
        return;
      }
      if (!window.confirm(this.t('importConfirm'))) return;
      this.data = mergeTransitData(this.data, data);
      this.save();
      this.renderAll();
      window.alert(this.t('importSuccess'));
    };
    reader.onerror = () => {
      window.alert(this.t('importInvalid'));
    };
    reader.readAsText(file);
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
      li.addEventListener('click', () => this.selectLine(line.id === this.selectedLineId ? null : line.id));
      this.sidebarEl.appendChild(li);
    }
  }

  private renderEditor() {
    this.editorEl.innerHTML = '';
    const line = this.data.lines.find((l) => l.id === this.selectedLineId);
    if (!line) {
      this.editorEl.hidden = true;
      return;
    }
    this.editorEl.hidden = false;

    const form = document.createElement('div');
    form.className = 'editor-form';

    // Name (English)
    const nameEnLabel = document.createElement('label');
    nameEnLabel.textContent = this.t('lineName');
    const nameEnInput = document.createElement('input');
    nameEnInput.type = 'text';
    nameEnInput.value = line.nameEn;
    nameEnInput.addEventListener('input', () => {
      line.nameEn = nameEnInput.value;
      this.save();
      this.renderSidebar();
    });
    nameEnLabel.appendChild(nameEnInput);

    // Name (Arabic)
    const nameArLabel = document.createElement('label');
    nameArLabel.textContent = this.t('lineNameAr');
    const nameArInput = document.createElement('input');
    nameArInput.type = 'text';
    nameArInput.dir = 'rtl';
    nameArInput.value = line.nameAr;
    nameArInput.addEventListener('input', () => {
      line.nameAr = nameArInput.value;
      this.save();
      this.renderSidebar();
    });
    nameArLabel.appendChild(nameArInput);

    // Color
    const colorLabel = document.createElement('label');
    colorLabel.textContent = this.t('lineColor');
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = line.color;
    colorInput.addEventListener('input', () => {
      line.color = colorInput.value;
      this.save();
      this.renderMap();
      this.renderSidebar();
    });
    colorLabel.appendChild(colorInput);

    // Loop
    const loopLabel = document.createElement('label');
    loopLabel.className = 'checkbox-label';
    const loopInput = document.createElement('input');
    loopInput.type = 'checkbox';
    loopInput.checked = line.loop;
    loopInput.addEventListener('change', () => {
      line.loop = loopInput.checked;
      this.save();
      this.renderMap();
    });
    loopLabel.append(loopInput, document.createTextNode(this.t('loopLine')));

    form.append(nameEnLabel, nameArLabel, colorLabel, loopLabel);

    // Add stop toggle
    const editToggle = document.createElement('button');
    editToggle.className = 'btn btn-primary';
    editToggle.textContent = this.addingStops ? this.t('doneEditing') : this.t('editStops');
    editToggle.addEventListener('click', () => {
      this.addingStops = !this.addingStops;
      this.renderAll();
    });

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = this.t('addStopHint');
    hint.hidden = !this.addingStops;

    // Stops list
    const stopsList = document.createElement('ul');
    stopsList.className = 'stops-list';
    const stops = this.stopsForLine(line);
    if (stops.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = this.t('noStops');
      stopsList.appendChild(empty);
    }
    stops.forEach((stop, index) => {
      const row = document.createElement('li');
      row.className = 'stop-row';

      const label = document.createElement('span');
      label.className = 'stop-row-name';
      label.textContent = `${index + 1}. ${this.stopName(stop)}`;

      const upBtn = document.createElement('button');
      upBtn.className = 'icon-btn';
      upBtn.textContent = '↑';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => {
        [line.stopIds[index - 1], line.stopIds[index]] = [line.stopIds[index], line.stopIds[index - 1]];
        this.save();
        this.renderAll();
      });

      const downBtn = document.createElement('button');
      downBtn.className = 'icon-btn';
      downBtn.textContent = '↓';
      downBtn.disabled = index === stops.length - 1;
      downBtn.addEventListener('click', () => {
        [line.stopIds[index + 1], line.stopIds[index]] = [line.stopIds[index], line.stopIds[index + 1]];
        this.save();
        this.renderAll();
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn';
      renameBtn.textContent = '✎';
      renameBtn.title = this.t('renameStop');
      renameBtn.addEventListener('click', () => {
        const nameEn = window.prompt(this.t('stopNamePrompt'), stop.nameEn);
        if (nameEn === null) return;
        const nameAr = window.prompt(this.t('stopNamePromptAr'), stop.nameAr) ?? stop.nameAr;
        stop.nameEn = nameEn.trim() || stop.nameEn;
        stop.nameAr = nameAr.trim();
        this.save();
        this.renderAll();
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'icon-btn remove';
      removeBtn.textContent = '✕';
      removeBtn.title = this.t('removeStop');
      removeBtn.addEventListener('click', () => {
        line.stopIds.splice(index, 1);
        this.save();
        this.renderAll();
      });

      row.append(label, upBtn, downBtn, renameBtn, removeBtn);
      stopsList.appendChild(row);
    });

    const deleteLineBtn = document.createElement('button');
    deleteLineBtn.className = 'btn btn-danger';
    deleteLineBtn.textContent = this.t('delete');
    deleteLineBtn.addEventListener('click', () => this.deleteLine(line.id));

    this.editorEl.append(form, editToggle, hint, stopsList, deleteLineBtn);
  }
}
