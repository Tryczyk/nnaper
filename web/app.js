// Zabezpieczenie przed bledem Chromium net::ERR_CACHE_OPERATION_NOT_SUPPORTED na zapytaniach HTTP Range (PMTiles)
(function () {
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    if (typeof input === 'string') {
      url = input;
    } else if (input && typeof input.url === 'string') {
      url = input.url;
    }
    if (url && (url.includes('.pmtiles') || url.includes('/osm_data/'))) {
      init = init ? Object.assign({}, init) : {};
      init.cache = 'no-store';
    }
    return originalFetch.call(this, input, init);
  };

  if (window.pmtiles && window.pmtiles.FetchSource) {
    const origGetBytes = window.pmtiles.FetchSource.prototype.getBytes;
    if (origGetBytes) {
      window.pmtiles.FetchSource.prototype.getBytes = async function (offset, length, signal, etag) {
        const headers = new Headers(this.customHeaders);
        headers.set('Range', `bytes=${offset}-${offset + length - 1}`);
        if (etag) {
          headers.set('If-Match', etag);
        }
        const res = await fetch(this.url, {
          headers,
          signal,
          credentials: this.credentials,
          cache: 'no-store'
        });
        if (res.status === 416) {
          return origGetBytes.call(this, offset, length, signal, etag);
        }
        if (!res.ok) {
          throw new Error(`Blad pobierania PMTiles: HTTP ${res.status} ${res.statusText}`);
        }
        const data = await res.arrayBuffer();
        return {
          data,
          etag: res.headers.get('ETag') || undefined,
          cacheControl: res.headers.get('Cache-Control') || undefined,
          expires: res.headers.get('Expires') || undefined
        };
      };
    }
  }
})();

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const apiBaseUrl = (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const photonUrl = (window.NNAPER_CONFIG?.PHOTON_URL || `${apiBaseUrl}/api/geocode`).replace(/\/$/, '');
const photonBbox = window.NNAPER_CONFIG?.PHOTON_BBOX || '14.1,53.9,19.9,55.9';
const photonSearchLimit = window.NNAPER_CONFIG?.PHOTON_SEARCH_LIMIT || 50;
const TRACK_TILES_URL = `${apiBaseUrl}/api/track/{z}/{x}/{y}.pbf`;
const trackMonthLayers = new Map();
const trackLayerIds = new Set(['GPS / Ślad trasy']);
window.trackMonthLayers = trackMonthLayers;

const map = new maplibregl.Map({
  container: 'map',
  center: [18.6466, 54.3520],
  zoom: 13,
  minZoom: 1,
  maxZoom: 18,
  pitch: 0,
  bearing: 0,
  maxPitch: 60,
  fadeDuration: 0,
  attributionControl: false,
  style: MAP_STYLE
});
window.mapInstance = map;
window.map = map;

if (typeof window.registerInfrastructureMapIcons === 'function') {
  window.registerInfrastructureMapIcons(map);
}

class MapPaletteControl {
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    // 1. Przycisk Rysowania po mapie (nad paletką)
    const btnDraw = document.createElement('button');
    btnDraw.type = 'button';
    btnDraw.id = 'btn-map-draw-control';
    btnDraw.className = 'map-custom-ctrl-btn';
    btnDraw.title = 'Rysowanie po mapie (obszary, ścieżki, pomiary)';
    btnDraw.setAttribute('aria-label', 'Rysowanie po mapie');
    btnDraw.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6.5l5.5-2.5 5 2.5 5-2.5v12l-5 2.5-5-2.5L3 18V6.5z"/>
      <path d="M8.5 4v11.5"/>
      <path d="M13.5 6.5V18"/>
      <path d="M12 14l-1.5 3.5 3.5-1.5 6.5-6.5a1.414 1.414 0 0 0-2-2L12 14z" fill="currentColor" fill-opacity="0.18"/>
      <path d="M17 9l2 2"/>
    </svg>`;
    btnDraw.onclick = () => {
      if (typeof window.toggleDrawingStudio === 'function') {
        window.toggleDrawingStudio();
      }
    };
    this._container.appendChild(btnDraw);

    // 2. Przycisk Paletki kolorów
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-map-palette-control';
    btn.className = 'map-custom-ctrl-btn';
    btn.title = 'Studio stylów i kolorów mapy';
    btn.setAttribute('aria-label', 'Studio stylów i kolorów mapy');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
    </svg>`;
    btn.onclick = () => {
      if (window.LayerManager && typeof window.LayerManager.openStyleStudio === 'function') {
        window.LayerManager.openStyleStudio();
      }
    };
    this._container.appendChild(btn);
    return this._container;
  }
  onRemove() {
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._map = undefined;
  }
}

const paletteControl = new MapPaletteControl();
map.addControl(paletteControl, 'bottom-right');

const navControl = new maplibregl.NavigationControl({ showCompass: true });
map.addControl(navControl, 'bottom-right');

// Dynamiczna skala mapy (ScaleControl)
const scaleControl = new maplibregl.ScaleControl({
  maxWidth: 120,
  unit: 'metric'
});
map.addControl(scaleControl, 'bottom-left');
window.scaleControl = scaleControl;

map.on('error', (e) => {
  if (e?.error?.name === 'AbortError' || e?.error?.message === 'AbortError' || e?.status === 0) {
    return;
  }
  console.warn('MapLibre error:', e);
});


/* ------------------- FILTR CZASU & JEDYNY PRZEŁĄCZNIK ŚLADU GPS ------------------- */
const MONTH_NAMES = {
  "01": "Styczeń", "02": "Luty", "03": "Marzec", "04": "Kwiecień",
  "05": "Maj", "06": "Czerwiec", "07": "Lipiec", "08": "Sierpień",
  "09": "Wrzesień", "10": "Październik", "11": "Listopad", "12": "Grudzień"
};

let gpsMasterCheckbox = null;
let gpsMasterDesiredState = null;
let allGpsDayCheckboxes = [];
let allGpsYearCheckboxes = [];
const dayNodesRegistry = new Map();
window.dayNodesRegistry = dayNodesRegistry;
window.allGpsYearCheckboxes = allGpsYearCheckboxes;

function syncGpsMasterCheckbox() {
  if (!gpsMasterCheckbox) return;
  const days = Array.from(dayNodesRegistry.values());
  if (days.length === 0) {
    gpsMasterCheckbox.checked = false;
    gpsMasterCheckbox.indeterminate = false;
    return;
  }
  const fullyCheckedCount = days.filter(d => d.dayHeader.checkbox.checked && !d.dayHeader.checkbox.indeterminate).length;
  const hasAnyActive = days.some(d => d.dayHeader.checkbox.checked || d.dayHeader.checkbox.indeterminate);
  gpsMasterCheckbox.checked = (fullyCheckedCount === days.length);
  gpsMasterCheckbox.indeterminate = !gpsMasterCheckbox.checked && hasAnyActive;
}

function createFilterTreeNode(title, checked = true, collapsed = true) {
  const header = document.createElement('div');
  header.className = 'node-header';
  header.style.padding = '3px 6px';

  const label = document.createElement('div');
  label.className = 'node-label';
  label.style.fontSize = '11.5px';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const text = document.createElement('span');
  text.innerText = title;

  label.appendChild(checkbox);
  label.appendChild(text);

  const arrow = document.createElement('span');
  arrow.className = collapsed ? 'arrow collapsed' : 'arrow';
  arrow.innerHTML = '&#9660;';

  header.appendChild(label);
  header.appendChild(arrow);

  return { element: header, checkbox, arrow };
}

function bindFilterCollapse(nodeObj, childrenBox) {
  nodeObj.element.addEventListener('click', (e) => {
    if (e.target === nodeObj.checkbox) return;
    childrenBox.classList.toggle('collapsed');
    nodeObj.arrow.classList.toggle('collapsed');
  });
}

function syncFilterCheckbox(parentCheckbox, childCheckboxes) {
  const checked = childCheckboxes.filter(c => c.checked).length;
  parentCheckbox.checked = checked === childCheckboxes.length;
  parentCheckbox.indeterminate = checked > 0 && checked < childCheckboxes.length;
}

function getActiveFiltersForMonth(monthKey) {
  const activeDays = [];
  const activeHours = [];
  const activeMinutes = [];
  const activeSeconds = [];

  const daysForMonth = Array.from(dayNodesRegistry.values()).filter(d => d.monthKey === monthKey);

  daysForMonth.forEach(dayItem => {
    const dayCb = dayItem.dayHeader.checkbox;
    if (!dayCb.checked && !dayCb.indeterminate) {
      return;
    }
    if (dayCb.checked && !dayCb.indeterminate) {
      activeDays.push(dayItem.dateStr);
      return;
    }
    // Dzień jest indeterminate (częściowo zaznaczony)
    if (dayItem.isLoaded) {
      dayItem.hours.forEach(hourObj => {
        const hCb = hourObj.hourHeader.checkbox;
        const hVal = (dayItem.dateStr === 'None' || hourObj.hour === 'None') ? 'None' : `${dayItem.dateStr}T${hourObj.hour}`;
        if (!hCb.checked && !hCb.indeterminate) return;
        if (hCb.checked && !hCb.indeterminate) {
          activeHours.push(hVal);
          return;
        }
        hourObj.minutes.forEach(minObj => {
          const mCb = minObj.minuteHeader.checkbox;
          const mVal = (hVal === 'None' || minObj.minute === 'None') ? 'None' : `${dayItem.dateStr}T${hourObj.hour}:${minObj.minute}`;
          if (!mCb.checked && !mCb.indeterminate) return;
          if (mCb.checked && !mCb.indeterminate) {
            activeMinutes.push(mVal);
            return;
          }
          minObj.seconds.forEach(secObj => {
            if (secObj.secCheckbox.checked) {
              activeSeconds.push(secObj.value);
            }
          });
        });
      });
    } else {
      if (dayCb.checked) activeDays.push(dayItem.dateStr);
    }
  });

  return { activeDays, activeHours, activeMinutes, activeSeconds };
}

function updateTrackFilters() {
  trackMonthLayers.forEach(({ layerId, lineLayerId }, key) => {
    const hasCircle = !!map.getLayer(layerId);
    const hasLine = !!lineLayerId && !!map.getLayer(lineLayerId);
    if (!hasCircle && !hasLine) return;

    const { activeDays, activeHours, activeMinutes, activeSeconds } = getActiveFiltersForMonth(key);
    const conditions = [];
    if (activeDays.length > 0) {
      conditions.push(['match', ['get', 'day'], activeDays, true, false]);
    }
    if (activeHours.length > 0) {
      conditions.push(['match', ['get', 'h'], activeHours, true, false]);
    }
    if (activeMinutes.length > 0) {
      conditions.push(['match', ['get', 'm'], activeMinutes, true, false]);
    }
    if (activeSeconds.length > 0) {
      const minutesFromSeconds = Array.from(new Set(activeSeconds.map(s => s.substring(0, 16))));
      conditions.push([
        'any',
        ['match', ['get', 's'], activeSeconds, true, false],
        ['match', ['get', 'm'], minutesFromSeconds, true, false]
      ]);
    }

    if (conditions.length > 0) {
      const activeFilter = conditions.length === 1 ? conditions[0] : ['any', ...conditions];

      if (currentTrackMode === 'osm') {
        if (hasLine) {
          map.setLayoutProperty(lineLayerId, 'visibility', 'visible');
          map.setFilter(lineLayerId, activeFilter);
          map.setPaintProperty(lineLayerId, 'line-color', trackBaseColor);
          map.setPaintProperty(lineLayerId, 'line-width', [
            'interpolate', ['linear'], ['zoom'],
            8, 1.8,
            12, 2.5,
            15, 3.2,
            18, 4.0
          ]);
          map.setPaintProperty(lineLayerId, 'line-opacity', 0.92);
        }
        if (hasCircle) {
          map.setLayoutProperty(layerId, 'visibility', 'none');
          map.setFilter(layerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
        }
      } else {
        if (hasLine) {
          map.setLayoutProperty(lineLayerId, 'visibility', 'none');
          map.setFilter(lineLayerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
        }
        if (hasCircle) {
          map.setLayoutProperty(layerId, 'visibility', 'visible');
          map.setFilter(layerId, activeFilter);
          map.setPaintProperty(layerId, 'circle-opacity', 1.0);
          map.setPaintProperty(layerId, 'circle-stroke-opacity', 1.0);
          const curRadius = map.getPaintProperty(layerId, 'circle-radius') || 4.5;
          map.setPaintProperty(layerId, 'circle-radius', curRadius);
          map.setPaintProperty(layerId, 'circle-color', trackBaseColor);
          map.setPaintProperty(layerId, 'circle-stroke-color', trackBaseColor);
        }
      }
    } else {
      if (hasCircle) {
        map.setLayoutProperty(layerId, 'visibility', 'none');
        map.setFilter(layerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
      }
      if (hasLine) {
        map.setLayoutProperty(lineLayerId, 'visibility', 'none');
        map.setFilter(lineLayerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
      }
    }
  });
}

function applyTrackDateFilter(dayCheckboxes, isEverythingActive) {
  if (!isEverythingActive) {
    trackMonthLayers.forEach(({ layerId, lineLayerId }) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'none');
        map.setFilter(layerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
      }
      if (lineLayerId && map.getLayer(lineLayerId)) {
        map.setLayoutProperty(lineLayerId, 'visibility', 'none');
        map.setFilter(lineLayerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
      }
    });
    return;
  }
  updateTrackFilters();
}
window.updateTrackFilters = updateTrackFilters;
window.syncGpsMasterCheckbox = syncGpsMasterCheckbox;

// Jednorazowe zresetowanie konfiguracji kolorów do wartości domyślnych
if (localStorage.getItem('nnaper_reset_colors_v2') !== 'true') {
  localStorage.removeItem('nnaper_layer_customizations');
  localStorage.removeItem('nnaper_track_color');
  localStorage.removeItem('nnaper_offroad_color');
  localStorage.removeItem('nnaper_show_offroad');
  localStorage.setItem('nnaper_reset_colors_v2', 'true');
}

window.resetAllCustomizations = function () {
  localStorage.removeItem('nnaper_layer_customizations');
  localStorage.removeItem('nnaper_track_color');
  localStorage.removeItem('nnaper_offroad_color');
  localStorage.removeItem('nnaper_show_offroad');
  localStorage.setItem('nnaper_reset_colors_v2', 'true');
  window.location.reload();
};

let currentTrackMode = localStorage.getItem('nnaper_track_mode');
if (!currentTrackMode || !['raw', 'snapped', 'osm'].includes(currentTrackMode)) {
  currentTrackMode = (localStorage.getItem('nnaper_snap_roads') === 'true') ? 'snapped' : 'raw';
}
let isSnapRoadsEnabled = (currentTrackMode === 'snapped');
let trackBaseColor = localStorage.getItem('nnaper_track_color') || '#06b6d4'; // domyślny cyjan

function updateTrackColors() {
  trackLayerIds.forEach(layerId => {
    if (map.getLayer(layerId)) {
      if (layerId.endsWith('/ linie')) {
        map.setPaintProperty(layerId, 'line-color', trackBaseColor);
      } else {
        map.setPaintProperty(layerId, 'circle-color', trackBaseColor);
        map.setPaintProperty(layerId, 'circle-stroke-color', trackBaseColor);
      }
    }
  });
  if (map.getLayer('osm-traversed-roads-layer')) {
    map.setPaintProperty('osm-traversed-roads-layer', 'line-color', trackBaseColor);
  }
}

// Czyszczenie ewentualnych starych wpisów po dawnej warstwie w pamięci przeglądarki
try {
  const rawCustom = localStorage.getItem('nnaper_layer_customizations');
  if (rawCustom) {
    const parsed = JSON.parse(rawCustom);
    if (parsed.layers && parsed.layers['GPS / Zaznaczone drogi OSM']) {
      delete parsed.layers['GPS / Zaznaczone drogi OSM'];
      localStorage.setItem('nnaper_layer_customizations', JSON.stringify(parsed));
    }
  }
} catch (e) { }

function syncTrackModeUI() {
  document.querySelectorAll('#select-track-mode').forEach(sel => {
    sel.value = currentTrackMode;
  });
  const isSnapped = (currentTrackMode === 'snapped');
  document.querySelectorAll('#btn-toggle-snap-roads').forEach(btn => {
    btn.classList.toggle('active', isSnapped);
    btn.setAttribute('aria-pressed', isSnapped ? 'true' : 'false');
  });
  const chk = document.getElementById('layer-snap-roads-toggle');
  if (chk) {
    chk.checked = isSnapped;
  }
}
window.syncTrackModeUI = syncTrackModeUI;
window.syncSnapButtonsUI = syncTrackModeUI;

function setupSnapButtons() {
  syncTrackModeUI();
  document.querySelectorAll('#select-track-mode').forEach(sel => {
    sel.onchange = (e) => {
      window.setTrackMode(e.target.value);
    };
  });
  document.querySelectorAll('#btn-toggle-snap-roads').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const current = (currentTrackMode === 'snapped');
      window.setTrackMode(current ? 'raw' : 'snapped');
    };
  });
}

window.setTrackMode = function (mode) {
  if (!['raw', 'snapped', 'osm'].includes(mode)) mode = 'raw';
  currentTrackMode = mode;
  isSnapRoadsEnabled = (mode === 'snapped' || mode === 'osm');
  localStorage.setItem('nnaper_track_mode', mode);
  localStorage.setItem('nnaper_snap_roads', mode === 'snapped' ? 'true' : 'false');
  syncTrackModeUI();
  updateTrackTilesSource();
};

window.setSnapRoadsEnabled = function (bool) {
  window.setTrackMode(bool ? 'snapped' : 'raw');
};

let trackTilesVersion = Date.now();

function buildTrackTilesUrl(days) {
  const token = (typeof window.getAuthToken === 'function') ? window.getAuthToken() : '';
  const profileId = (typeof window.getActiveProfileId === 'function') ? window.getActiveProfileId() : '';
  let url = `${TRACK_TILES_URL}?days=${encodeURIComponent(days)}&mode=${currentTrackMode}&token=${encodeURIComponent(token)}&v=${trackTilesVersion}`;
  if (profileId) {
    url += `&profile_id=${encodeURIComponent(profileId)}`;
  }
  if (currentTrackMode === 'snapped') {
    url += '&snapped=true';
  }
  return url;
}

function updateTrackTilesSource(force = false) {
  if (force) {
    trackTilesVersion = Date.now();
  }
  const baseSrc = map.getSource('gps-track');
  const baseTiles = [buildTrackTilesUrl('__none__')];
  if (baseSrc && typeof baseSrc.setTiles === 'function') {
    baseSrc.setTiles(baseTiles);
  }

  trackMonthLayers.forEach(({ layerId, days }, key) => {
    const suffix = key.replaceAll('-', '_');
    const sourceId = `gps-track-${suffix}`;
    const src = map.getSource(sourceId);
    const newTiles = [buildTrackTilesUrl(days.join(','))];
    if (src && typeof src.setTiles === 'function') {
      src.setTiles(newTiles);
    }
  });

  updateTrackFilters();
}

function forceRefreshTrackTiles() {
  updateTrackTilesSource(true);
}
window.forceRefreshTrackTiles = forceRefreshTrackTiles;
window.updateTrackTilesSource = updateTrackTilesSource;

function updateTrackPaintProperty(property, value) {
  if (property === 'circle-color' || property === 'circle-stroke-color' || property === 'line-color') {
    if (typeof value === 'string' && value.startsWith('#')) {
      trackBaseColor = value;
      localStorage.setItem('nnaper_track_color', trackBaseColor);
    }
    updateTrackColors();
    return;
  }
  trackLayerIds.forEach(layerId => {
    if (!map.getLayer(layerId)) return;
    const isLine = layerId.endsWith('/ linie');
    try {
      if (property === 'circle-radius') {
        if (isLine) {
          map.setPaintProperty(layerId, 'line-width', value);
        } else {
          map.setPaintProperty(layerId, 'circle-radius', value);
        }
      } else if (property === 'circle-stroke-width' || property === 'circle-stroke-color') {
        if (!isLine) {
          map.setPaintProperty(layerId, property, value);
        }
      } else if (property === 'line-width') {
        if (isLine) {
          map.setPaintProperty(layerId, 'line-width', value);
        }
      } else {
        map.setPaintProperty(layerId, property, value);
      }
    } catch (e) {
      console.warn('Nie udało się ustawić właściwości warstwy:', layerId, property, e);
    }
  });
}
window.updateTrackPaintProperty = updateTrackPaintProperty;
window.bindGpsMasterCheckbox = (cb) => {
  gpsMasterCheckbox = cb;
  if (!gpsMasterCheckbox) return;

  gpsMasterCheckbox.addEventListener('change', () => {
    const isChecked = gpsMasterCheckbox.checked;
    gpsMasterCheckbox.indeterminate = false;
    gpsMasterDesiredState = isChecked;

    // 1. Zaznacz/odznacz wszystkie dni i ich załadowane dzieci
    dayNodesRegistry.forEach(dayItem => {
      dayItem.dayHeader.checkbox.checked = isChecked;
      dayItem.dayHeader.checkbox.indeterminate = false;
      if (dayItem.isLoaded) {
        dayItem.hours.forEach(h => {
          h.hourHeader.checkbox.checked = isChecked;
          h.hourHeader.checkbox.indeterminate = false;
          h.minutes.forEach(m => {
            m.minuteHeader.checkbox.checked = isChecked;
            m.minuteHeader.checkbox.indeterminate = false;
            m.seconds.forEach(s => { s.secCheckbox.checked = isChecked; });
          });
        });
      }
    });

    // 2. Zaznacz/odznacz nagłówki lat i miesięcy w drzewku dat
    allGpsYearCheckboxes.forEach(c => {
      c.checked = isChecked;
      c.indeterminate = false;
    });

    const timeHolder = document.querySelector('.time-filter-section');
    if (timeHolder) {
      timeHolder.querySelectorAll('.node-header input[type="checkbox"]').forEach(c => {
        c.checked = isChecked;
        c.indeterminate = false;
      });
    }

    // 3. Zastosuj filtr widoczności śladu GPS na mapie
    updateTrackFilters();
  });

  syncGpsMasterCheckbox();
};

function addTrackMonthLayers(months) {
  months.forEach(({ key, days }) => {
    if (trackMonthLayers.has(key)) return;

    const suffix = key.replaceAll('-', '_');
    const sourceId = `gps-track-${suffix}`;
    const layerId = `GPS / Ślad trasy / ${key}`;
    const lineLayerId = `GPS / Ślad trasy / ${key} / linie`;

    map.addSource(sourceId, {
      type: 'vector',
      tiles: [buildTrackTilesUrl(days.join(','))],
      minzoom: 0,
      maxzoom: 18
    });

    // Warstwa dociągniętych linii dróg OSM (tryb Zaznaczone ścieżki OSM)
    map.addLayer({
      id: lineLayerId,
      source: sourceId,
      'source-layer': 'gps-track',
      type: 'line',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
        'visibility': (currentTrackMode === 'osm') ? 'visible' : 'none'
      },
      paint: {
        'line-color': trackBaseColor,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          8, 1.8,
          12, 2.5,
          15, 3.2,
          18, 4.0
        ],
        'line-opacity': 0.92
      }
    });

    // Warstwa punktów GPS (surowe / snapnięte)
    map.addLayer({
      id: layerId,
      source: sourceId,
      'source-layer': 'gps-track',
      type: 'circle',
      layout: {
        'visibility': (currentTrackMode !== 'osm') ? 'visible' : 'none'
      },
      paint: {
        'circle-color': trackBaseColor,
        'circle-radius': 4.5,
        'circle-stroke-width': 0,
        'circle-stroke-color': trackBaseColor,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    });

    trackMonthLayers.set(key, { layerId, lineLayerId, days });
    trackLayerIds.add(layerId);
    trackLayerIds.add(lineLayerId);
  });
}

function syncMinuteCheckbox(minObj) {
  const checked = minObj.seconds.filter(s => s.secCheckbox.checked).length;
  const total = minObj.seconds.length;
  minObj.minuteHeader.checkbox.checked = (checked === total);
  minObj.minuteHeader.checkbox.indeterminate = (checked > 0 && checked < total);
}

function syncHourCheckbox(hourObj) {
  const allSecs = [];
  hourObj.minutes.forEach(m => allSecs.push(...m.seconds));
  const checked = allSecs.filter(s => s.secCheckbox.checked).length;
  const total = allSecs.length;
  hourObj.hourHeader.checkbox.checked = (checked === total);
  hourObj.hourHeader.checkbox.indeterminate = (checked > 0 && checked < total);
}

function syncDayCheckbox(dayItem) {
  if (!dayItem.isLoaded) return;
  const allSecs = [];
  dayItem.hours.forEach(h => h.minutes.forEach(m => allSecs.push(...m.seconds)));
  if (allSecs.length === 0) return;
  const checked = allSecs.filter(s => s.secCheckbox.checked).length;
  const total = allSecs.length;
  dayItem.dayHeader.checkbox.checked = (checked === total);
  dayItem.dayHeader.checkbox.indeterminate = (checked > 0 && checked < total);
}

async function expandDayNode(dayItem, monthHeader, yearHeader, monthDayCheckboxes, yearDayCheckboxes) {
  if (dayItem.isLoaded) return;
  dayItem.isLoaded = true;
  dayItem.dayChildren.innerHTML = '<div style="color:#64748b;font-size:11px;padding:2px 8px;">Ładowanie...</div>';

  try {
    const token = (typeof window.getAuthToken === 'function') ? window.getAuthToken() : '';
    const profileId = (typeof window.getActiveProfileId === 'function') ? window.getActiveProfileId() : '';
    let url = `${apiBaseUrl}/api/time-tree?day=${encodeURIComponent(dayItem.dateStr)}`;
    if (token) url += `&token=${encodeURIComponent(token)}`;
    if (profileId && profileId !== 'undefined' && profileId !== 'null') {
      url += `&profile_id=${encodeURIComponent(profileId)}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error('Błąd API');
    const data = await res.json();
    dayItem.dayChildren.innerHTML = '';

    const hours = Object.keys(data).sort((a, b) => {
      if (a === 'None') return 1;
      if (b === 'None') return -1;
      return b.localeCompare(a);
    });

    if (hours.length === 0) {
      dayItem.dayChildren.innerHTML = '<div style="color:#64748b;font-size:11px;padding:2px 8px;">Brak danych czasowych.</div>';
      return;
    }

    const dayChecked = dayItem.dayHeader.checkbox.checked;

    hours.forEach(hour => {
      const isHourNone = (hour === 'None' || dayItem.dateStr === 'None');
      const hourTitle = isHourNone ? 'Godzina: None' : `Godzina: ${hour}:00`;
      const hourHeader = createFilterTreeNode(hourTitle, dayChecked, true);
      const hourChildren = document.createElement('div');
      hourChildren.className = 'node-children collapsed';
      hourChildren.style.marginLeft = '8px';
      bindFilterCollapse(hourHeader, hourChildren);

      const hourObj = {
        hour,
        hourHeader,
        hourChildren,
        minutes: []
      };
      dayItem.hours.push(hourObj);

      const minutes = Object.keys(data[hour]).sort((a, b) => {
        if (a === 'None') return 1;
        if (b === 'None') return -1;
        return b.localeCompare(a);
      });

      minutes.forEach(minute => {
        const isMinNone = (isHourNone || minute === 'None');
        const minuteTitle = isMinNone ? 'Minuta: None' : `Minuta: ${hour}:${minute}`;
        const minuteHeader = createFilterTreeNode(minuteTitle, dayChecked, true);
        const minuteChildren = document.createElement('div');
        minuteChildren.className = 'node-children collapsed';
        minuteChildren.style.marginLeft = '8px';
        bindFilterCollapse(minuteHeader, minuteChildren);

        const minuteObj = {
          minute,
          minuteHeader,
          minuteChildren,
          seconds: []
        };
        hourObj.minutes.push(minuteObj);

        const seconds = data[hour][minute].slice().sort((a, b) => {
          if (a === 'None') return 1;
          if (b === 'None') return -1;
          return b.localeCompare(a);
        });

        seconds.forEach(second => {
          const isSecNone = (isMinNone || second === 'None');
          const secValue = isSecNone ? 'None' : `${dayItem.dateStr}T${hour}:${minute}:${second}`;
          const leaf = document.createElement('div');
          leaf.className = 'leaf-item';
          leaf.style.padding = '2px 4px';

          const secCheckbox = document.createElement('input');
          secCheckbox.type = 'checkbox';
          secCheckbox.checked = dayChecked;
          secCheckbox.value = secValue;
          secCheckbox.style.accentColor = '#38bdf8';
          secCheckbox.style.marginRight = '6px';
          secCheckbox.style.cursor = 'pointer';

          const secLabel = document.createElement('span');
          secLabel.innerText = isSecNone ? 'Sekunda: None' : `Sekunda: ${second}`;

          leaf.appendChild(secCheckbox);
          leaf.appendChild(secLabel);
          minuteChildren.appendChild(leaf);

          const secObj = { second, secCheckbox, value: secValue };
          minuteObj.seconds.push(secObj);

          secCheckbox.addEventListener('change', () => {
            syncMinuteCheckbox(minuteObj);
            syncHourCheckbox(hourObj);
            syncDayCheckbox(dayItem);
            syncFilterCheckbox(monthHeader.checkbox, monthDayCheckboxes);
            syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
            syncGpsMasterCheckbox();
            updateTrackFilters();
          });
        });

        minuteHeader.checkbox.addEventListener('change', () => {
          const isChk = minuteHeader.checkbox.checked;
          minuteHeader.checkbox.indeterminate = false;
          minuteObj.seconds.forEach(s => { s.secCheckbox.checked = isChk; });
          syncHourCheckbox(hourObj);
          syncDayCheckbox(dayItem);
          syncFilterCheckbox(monthHeader.checkbox, monthDayCheckboxes);
          syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
          syncGpsMasterCheckbox();
          updateTrackFilters();
        });

        const minNode = document.createElement('div');
        minNode.className = 'tree-node';
        minNode.appendChild(minuteHeader.element);
        minNode.appendChild(minuteChildren);
        hourChildren.appendChild(minNode);
      });

      hourHeader.checkbox.addEventListener('change', () => {
        const isChk = hourHeader.checkbox.checked;
        hourHeader.checkbox.indeterminate = false;
        hourObj.minutes.forEach(m => {
          m.minuteHeader.checkbox.checked = isChk;
          m.minuteHeader.checkbox.indeterminate = false;
          m.seconds.forEach(s => { s.secCheckbox.checked = isChk; });
        });
        syncDayCheckbox(dayItem);
        syncFilterCheckbox(monthHeader.checkbox, monthDayCheckboxes);
        syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
        syncGpsMasterCheckbox();
        updateTrackFilters();
      });

      const hNode = document.createElement('div');
      hNode.className = 'tree-node';
      hNode.appendChild(hourHeader.element);
      hNode.appendChild(hourChildren);
      dayItem.dayChildren.appendChild(hNode);
    });

  } catch (err) {
    dayItem.dayChildren.innerHTML = '<div style="color:#ef4444;font-size:11px;padding:2px 8px;">Błąd pobierania czasu.</div>';
  }
}

async function buildInlineTimeFilter(container) {
  const token = (typeof window.getAuthToken === 'function') ? window.getAuthToken() : '';
  if (!token) {
    container.innerHTML = '<span style="color:#94a3b8;font-size:11px;">Zaloguj się w prawym panelu, aby zobaczyć swoje trasy.</span>';
    trackMonthLayers.forEach(({ layerId, lineLayerId }) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
      if (lineLayerId && map.getLayer(lineLayerId)) map.setLayoutProperty(lineLayerId, 'visibility', 'none');
    });
    return;
  }
  try {
    const profileId = (typeof window.getActiveProfileId === 'function') ? window.getActiveProfileId() : '';
    let url = `${apiBaseUrl}/api/dates-tree`;
    const qParams = [];
    if (token) qParams.push(`token=${encodeURIComponent(token)}`);
    if (profileId && profileId !== 'undefined' && profileId !== 'null') {
      qParams.push(`profile_id=${encodeURIComponent(profileId)}`);
    }
    if (qParams.length > 0) {
      url += '?' + qParams.join('&');
    }
    const fetchCtrl = new AbortController();
    const fetchTimeout = setTimeout(() => fetchCtrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { signal: fetchCtrl.signal });
    } finally {
      clearTimeout(fetchTimeout);
    }
    if (!res.ok) throw new Error('Błąd API');
    const data = await res.json();

    if (!data || Object.keys(data).length === 0) {
      container.innerHTML = '<span style="color:#64748b;font-size:11px;">Brak zarejestrowanych tras dla tego profilu w bazie danych.</span>';
      trackMonthLayers.forEach(({ layerId, lineLayerId }) => {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
        if (lineLayerId && map.getLayer(lineLayerId)) map.setLayoutProperty(lineLayerId, 'visibility', 'none');
      });
      return;
    }

      const months = [];
      Object.keys(data).forEach(year => {
        Object.keys(data[year]).forEach(month => {
          const isNone = year === 'None' || month === 'None';
          months.push({
            key: isNone ? 'None-None' : `${year}-${month}`,
            days: data[year][month].map(day => (isNone || day === 'None') ? 'None' : `${year}-${month}-${day}`)
          });
        });
      });
      addTrackMonthLayers(months);

      container.innerHTML = '';
      dayNodesRegistry.clear();
      allGpsDayCheckboxes = [];
      allGpsYearCheckboxes = [];

      const sortedYears = Object.keys(data).sort((a, b) => {
        if (a === 'None') return 1;
        if (b === 'None') return -1;
        return b.localeCompare(a);
      });

      sortedYears.forEach(year => {
        const yearNode = document.createElement('div');
        yearNode.className = 'tree-node';
        const yearTitle = (year === 'None') ? 'Rok: None' : `Rok: ${year}`;
        const yearHeader = createFilterTreeNode(yearTitle, false, true);
        const yearChildren = document.createElement('div');
        yearChildren.className = 'node-children collapsed';
        yearChildren.style.marginLeft = '8px';
        bindFilterCollapse(yearHeader, yearChildren);

        allGpsYearCheckboxes.push(yearHeader.checkbox);
        const yearDayCheckboxes = [];

        const sortedMonths = Object.keys(data[year]).sort((a, b) => {
          if (a === 'None') return 1;
          if (b === 'None') return -1;
          return b.localeCompare(a);
        });

        sortedMonths.forEach(month => {
          const monthNode = document.createElement('div');
          monthNode.className = 'tree-node';
          const monthName = MONTH_NAMES[month] || month;
          const monthTitle = (month === 'None') ? 'Miesiąc: None' : `Miesiąc: ${monthName} (${month})`;
          const monthHeader = createFilterTreeNode(monthTitle, false, true);
          const monthChildren = document.createElement('div');
          monthChildren.className = 'node-children collapsed';
          monthChildren.style.marginLeft = '8px';
          bindFilterCollapse(monthHeader, monthChildren);

          const monthDayCheckboxes = [];

          const sortedDays = data[year][month].slice().sort((a, b) => {
            if (a === 'None') return 1;
            if (b === 'None') return -1;
            return b.localeCompare(a);
          });

          sortedDays.forEach(day => {
            const isNone = year === 'None' || month === 'None' || day === 'None';
            const dateStr = isNone ? 'None' : `${year}-${month}-${day}`;
            const dayTitle = (day === 'None') ? 'Dzień: None' : `Dzień: ${day}`;
            const dayHeader = createFilterTreeNode(dayTitle, false, true);

            const btnDeleteDay = document.createElement('button');
            btnDeleteDay.className = 'btn-day-delete';
            btnDeleteDay.type = 'button';
            btnDeleteDay.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
            btnDeleteDay.title = `Trwale usuń wszystkie punkty z dnia ${dateStr}`;
            btnDeleteDay.addEventListener('click', async (e) => {
              e.stopPropagation();
              const profileName = (typeof window.getActiveProfileName === 'function') ? window.getActiveProfileName() : 'aktywnego profilu';
              const confirmDay = window.confirm(
                `Czy na pewno chcesz bezpowrotnie usunąć WSZYSTKIE punkty GPS z dnia ${dateStr} dla profilu "${profileName}"?\n\n` +
                `Tej operacji nie można cofnąć.`
              );
              if (!confirmDay) return;

              btnDeleteDay.disabled = true;
              btnDeleteDay.innerText = '...';

              try {
                const token = (typeof window.getAuthToken === 'function') ? window.getAuthToken() : '';
                const profileId = (typeof window.getActiveProfileId === 'function') ? window.getActiveProfileId() : '';
                const profParam = profileId ? `&profile_id=${encodeURIComponent(profileId)}` : '';
                const res = await fetch(`${apiBaseUrl}/api/epochs/day?day=${encodeURIComponent(dateStr)}&token=${encodeURIComponent(token)}${profParam}`, {
                  method: 'DELETE'
                });
                if (!res.ok) {
                  const errJson = await res.json().catch(() => ({}));
                  throw new Error(errJson.detail || errJson.error || 'Błąd usuwania punktów z dnia');
                }
                const resData = await res.json();

                clearSatelliteLayers();

                window.dispatchEvent(new CustomEvent('nnaper_epochs_deleted', { detail: { day: dateStr } }));

                forceRefreshTrackTiles();
                autoBuildTree();

                alert(`Trwale usunięto ${resData.deleted_count || 0} punktów z dnia ${dateStr}.`);
              } catch (err) {
                alert(`Nie udało się usunąć dnia: ${err.message}`);
                btnDeleteDay.disabled = false;
                btnDeleteDay.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
              }
            });
            dayHeader.element.insertBefore(btnDeleteDay, dayHeader.arrow);

            const dayChildren = document.createElement('div');
            dayChildren.className = 'node-children collapsed';
            dayChildren.style.marginLeft = '8px';
            bindFilterCollapse(dayHeader, dayChildren);

            const dayNode = document.createElement('div');
            dayNode.className = 'tree-node';
            dayNode.appendChild(dayHeader.element);
            dayNode.appendChild(dayChildren);
            monthChildren.appendChild(dayNode);

            const dayItem = {
              dateStr,
              monthKey: isNone ? 'None-None' : `${year}-${month}`,
              dayHeader,
              dayChildren,
              isLoaded: false,
              hours: []
            };
            dayNodesRegistry.set(dateStr, dayItem);
            monthDayCheckboxes.push(dayHeader.checkbox);
            yearDayCheckboxes.push(dayHeader.checkbox);
            allGpsDayCheckboxes.push(dayHeader.checkbox);

            // Leniwe pobieranie godzin/minut/sekund przy pierwszym kliknięciu strzałki rozwijania
            dayHeader.arrow.addEventListener('click', () => {
              expandDayNode(dayItem, monthHeader, yearHeader, monthDayCheckboxes, yearDayCheckboxes);
            });
            dayHeader.element.addEventListener('click', (e) => {
              if (e.target !== dayHeader.checkbox) {
                expandDayNode(dayItem, monthHeader, yearHeader, monthDayCheckboxes, yearDayCheckboxes);
              }
            });

            dayHeader.checkbox.addEventListener('change', () => {
              const isChecked = dayHeader.checkbox.checked;
              dayHeader.checkbox.indeterminate = false;
              if (dayItem.isLoaded) {
                dayItem.hours.forEach(h => {
                  h.hourHeader.checkbox.checked = isChecked;
                  h.hourHeader.checkbox.indeterminate = false;
                  h.minutes.forEach(m => {
                    m.minuteHeader.checkbox.checked = isChecked;
                    m.minuteHeader.checkbox.indeterminate = false;
                    m.seconds.forEach(s => { s.secCheckbox.checked = isChecked; });
                  });
                });
              }
              syncFilterCheckbox(monthHeader.checkbox, monthDayCheckboxes);
              syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
              syncGpsMasterCheckbox();
              updateTrackFilters();
            });
          });

          monthHeader.checkbox.addEventListener('change', () => {
            const isChecked = monthHeader.checkbox.checked;
            monthHeader.checkbox.indeterminate = false;
            monthDayCheckboxes.forEach(cb => {
              cb.checked = isChecked;
              cb.indeterminate = false;
            });
            // Aktualizuj załadowane dni
            monthDayCheckboxes.forEach(cb => {
              const dayItem = Array.from(dayNodesRegistry.values()).find(d => d.dayHeader.checkbox === cb);
              if (dayItem && dayItem.isLoaded) {
                dayItem.hours.forEach(h => {
                  h.hourHeader.checkbox.checked = isChecked;
                  h.hourHeader.checkbox.indeterminate = false;
                  h.minutes.forEach(m => {
                    m.minuteHeader.checkbox.checked = isChecked;
                    m.minuteHeader.checkbox.indeterminate = false;
                    m.seconds.forEach(s => { s.secCheckbox.checked = isChecked; });
                  });
                });
              }
            });
            syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
            syncGpsMasterCheckbox();
            updateTrackFilters();
          });

          monthNode.appendChild(monthHeader.element);
          monthNode.appendChild(monthChildren);
          yearChildren.appendChild(monthNode);
        });

        yearHeader.checkbox.addEventListener('change', () => {
          const isChecked = yearHeader.checkbox.checked;
          yearHeader.checkbox.indeterminate = false;
          yearDayCheckboxes.forEach(cb => {
            cb.checked = isChecked;
            cb.indeterminate = false;
          });
          yearChildren.querySelectorAll('.node-header input[type="checkbox"]').forEach(cb => {
            cb.checked = isChecked;
            cb.indeterminate = false;
          });
          // Aktualizuj załadowane dni
          yearDayCheckboxes.forEach(cb => {
            const dayItem = Array.from(dayNodesRegistry.values()).find(d => d.dayHeader.checkbox === cb);
            if (dayItem && dayItem.isLoaded) {
              dayItem.hours.forEach(h => {
                h.hourHeader.checkbox.checked = isChecked;
                h.hourHeader.checkbox.indeterminate = false;
                h.minutes.forEach(m => {
                  m.minuteHeader.checkbox.checked = isChecked;
                  m.minuteHeader.checkbox.indeterminate = false;
                  m.seconds.forEach(s => { s.secCheckbox.checked = isChecked; });
                });
              });
            }
          });
          syncGpsMasterCheckbox();
          updateTrackFilters();
        });

        yearNode.appendChild(yearHeader.element);
        yearNode.appendChild(yearChildren);
        container.appendChild(yearNode);
      });

      if (gpsMasterDesiredState !== null) {
        dayNodesRegistry.forEach(d => {
          d.dayHeader.checkbox.checked = gpsMasterDesiredState;
          d.dayHeader.checkbox.indeterminate = false;
        });
        allGpsYearCheckboxes.forEach(c => { c.checked = gpsMasterDesiredState; c.indeterminate = false; });
        container.querySelectorAll('.node-header input[type="checkbox"]').forEach(c => {
          c.checked = gpsMasterDesiredState;
          c.indeterminate = false;
        });
        syncGpsMasterCheckbox();
        updateTrackFilters();
      } else {
        syncGpsMasterCheckbox();
        updateTrackFilters();
      }

    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      container.innerHTML = `<span style="color:#ef4444;font-size:11px;">${isTimeout ? 'Przekroczono limit czasu połączenia z serwerem.' : 'Brak połączenia z API dat.'}</span>`;
    }
  }

/* ------------------- GENEROWANIE DRZEWKA WARSTW ------------------- */
function autoBuildTree() {
    if (window.LayerManager) {
      window.LayerManager.applyCustomizationsToMap(map);
      window.LayerManager.buildLayerTree(map, 'tree-container', { onRenderGps: buildInlineTimeFilter });
      window.LayerManager.setup3DControls(map, { resetPitchOnMap3D: true });
      window.LayerManager.setupSync(map, 'tree-container');
      setupSnapButtons();
    }
  }
  window.autoBuildTree = autoBuildTree;

  window.addEventListener('nnaper_auth_changed', () => {
    try {
      trackMonthLayers.forEach(({ layerId, lineLayerId }, key) => {
        if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        const suffix = key.replaceAll('-', '_');
        const sourceId = `gps-track-${suffix}`;
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      });
      trackMonthLayers.clear();
      trackLayerIds.clear();
      dayNodesRegistry.clear();
      allGpsDayCheckboxes.length = 0;
      allGpsYearCheckboxes.length = 0;

      autoBuildTree();
      updateTrackTilesSource();
    } catch (e) {
      console.error('Błąd podczas odświeżania po zmianie logowania:', e);
    }
  });

  window.addEventListener('nnaper_profile_changed', () => {
    try {
      trackMonthLayers.forEach(({ layerId, lineLayerId, fillLayerId, sourceId }) => {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (lineLayerId && map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
        if (fillLayerId && map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
        if (sourceId && map.getSource(sourceId)) map.removeSource(sourceId);
      });
      trackMonthLayers.clear();
      trackLayerIds.clear();
      dayNodesRegistry.clear();
      allGpsDayCheckboxes.length = 0;
      allGpsYearCheckboxes.length = 0;

      autoBuildTree();
      updateTrackTilesSource();
    } catch (e) {
      console.error('Błąd podczas odświeżania po zmianie profilu:', e);
    }
  });

  /* ------------------- INTERFEJS OKNA ------------------- */
  const menuEl = document.getElementById('menu');
  const btnToggleMenu = document.getElementById('btn-toggle-menu');
  const btnBackLocation = document.getElementById('btn-back-location');
  const btnCloseLocation = document.getElementById('btn-close-location');
  const menuTitle = menuEl.querySelector('.menu-header h3');
  const menuBody = menuEl.querySelector('.menu-body');
  const layerMenuBodyHTML = menuBody.innerHTML;
  const layerMenuTitle = menuTitle.innerText;
  let previousSearchCamera = null;
  btnBackLocation.style.display = 'none';
  btnCloseLocation.style.display = 'none';

  function restoreLayerMenu() {
    menuTitle.innerText = layerMenuTitle;
    menuBody.innerHTML = layerMenuBodyHTML;
    btnBackLocation.style.display = 'none';
    btnCloseLocation.style.display = 'none';
    autoBuildTree();
  }

  function collapseMenu() {
    menuEl.classList.add('collapsed');
    if (btnToggleMenu) {
      btnToggleMenu.setAttribute('title', 'Rozwiń wybierak warstw');
      btnToggleMenu.setAttribute('aria-label', 'Rozwiń wybierak warstw');
    }
  }

  function expandMenu() {
    menuEl.classList.remove('collapsed');
    if (btnToggleMenu) {
      btnToggleMenu.setAttribute('title', 'Zwiń wybierak warstw');
      btnToggleMenu.setAttribute('aria-label', 'Zwiń wybierak warstw');
    }
  }

  function toggleMenu() {
    if (menuEl.classList.contains('collapsed')) {
      expandMenu();
    } else {
      collapseMenu();
    }
  }

  if (btnToggleMenu) {
    btnToggleMenu.addEventListener('click', toggleMenu);
  }
  collapseMenu();
  setupSnapButtons();
  window.collapseMenu = collapseMenu;
  window.expandMenu = expandMenu;
  window.toggleMenu = toggleMenu;

  /* ------------------- PRAWY PANEL (NAWIGACJA I TRASY) ------------------- */
  const menuRightEl = document.getElementById('menu-right');
  const btnToggleMenuRight = document.getElementById('btn-toggle-menu-right');

  function collapseRightMenu() {
    if (!menuRightEl) return;
    menuRightEl.classList.add('collapsed');
    if (btnToggleMenuRight) {
      btnToggleMenuRight.setAttribute('title', 'Rozwiń panel tras');
      btnToggleMenuRight.setAttribute('aria-label', 'Rozwiń panel tras');
    }
  }

  function expandRightMenu() {
    if (!menuRightEl) return;
    menuRightEl.classList.remove('collapsed');
    if (btnToggleMenuRight) {
      btnToggleMenuRight.setAttribute('title', 'Zwiń panel tras');
      btnToggleMenuRight.setAttribute('aria-label', 'Zwiń panel tras');
    }
  }

  function toggleRightMenu() {
    if (!menuRightEl) return;
    if (menuRightEl.classList.contains('collapsed')) {
      expandRightMenu();
    } else {
      collapseRightMenu();
    }
  }

  if (btnToggleMenuRight) {
    btnToggleMenuRight.addEventListener('click', toggleRightMenu);
  }
  collapseRightMenu();
  window.collapseRightMenu = collapseRightMenu;
  window.expandRightMenu = expandRightMenu;

  /* ------------------- PRZEŁĄCZNIKI 3D (MAPA 3D & BUDYNKI 3D) ------------------- */
  const BUILDINGS_3D_LAYER_ID = 'Budynki/Bryły 3D';

  function set3DMap(enabled) {
    if (window.LayerManager) {
      window.LayerManager.set3DMap(map, enabled, true);
    }
  }

  function set3DBuildings(enabled) {
    if (window.LayerManager) {
      window.LayerManager.set3DBuildings(map, enabled);
    }
  }

  function apply3DBuildingsVisibility() {
    const cfg = window.LayerManager ? window.LayerManager.getStoredConfig() : {};
    const isEnabled = !!cfg.settings3D?.buildings3D;
    try {
      if (map.getLayer(BUILDINGS_3D_LAYER_ID)) {
        const targetVis = isEnabled ? 'visible' : 'none';
        if (map.getLayoutProperty(BUILDINGS_3D_LAYER_ID, 'visibility') !== targetVis) {
          map.setLayoutProperty(BUILDINGS_3D_LAYER_ID, 'visibility', targetVis);
        }
      }
    } catch (err) { }
  }

  map.on('styledata', apply3DBuildingsVisibility);

  window.set3DMap = set3DMap;
  window.set3DBuildings = set3DBuildings;

  function closeLocation(restoreCamera) {
    restoreLayerMenu();
    if (searchMarker) {
      searchMarker.remove();
      searchMarker = null;
    }
    if (restoreCamera && previousSearchCamera) {
      map.easeTo(previousSearchCamera);
    }
    previousSearchCamera = null;
    searchInput.value = '';
    searchCompleted = false;
    searchResults = [];
    suggestionsBox.innerHTML = '';
    suggestionsBox.style.display = 'none';
  }

  window.restoreOriginalSearchLocation = () => closeLocation(true);

  btnBackLocation.addEventListener('click', () => closeLocation(true));
  btnCloseLocation.addEventListener('click', () => closeLocation(false));

  /* ------------------- WIZUALIZACJA SATELITÓW ------------------- */
  let activeSatelliteContext = null;
  let currentSatMode = 'local';

  function ensureSatelliteLayers() {
    if (!map) return;
    if (!map.getSource('satellites-lines-source')) {
      map.addSource('satellites-lines-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }
    if (!map.getSource('satellites-points-source')) {
      map.addSource('satellites-points-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }
    if (!map.getLayer('playback-sat-lines')) {
      map.addLayer({
        id: 'playback-sat-lines',
        source: 'satellites-lines-source',
        type: 'line',
        paint: {
          'line-color': '#f59e0b',
          'line-width': 2.0,
          'line-dasharray': [3, 2]
        }
      });
    }
    if (!map.getLayer('playback-sat-points')) {
      map.addLayer({
        id: 'playback-sat-points',
        source: 'satellites-points-source',
        type: 'circle',
        paint: {
          'circle-color': '#f59e0b',
          'circle-radius': 5.5,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff'
        }
      });
    }
    if (!map.getLayer('playback-sat-labels')) {
      map.addLayer({
        id: 'playback-sat-labels',
        source: 'satellites-points-source',
        type: 'symbol',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-font': ['Open Sans Bold']
        },
        paint: {
          'text-color': '#fef08a',
          'text-halo-color': '#020617',
          'text-halo-width': 2
        }
      });
    }
  }
  window.ensureSatelliteLayers = ensureSatelliteLayers;

  function clearSatelliteLayers() {
    activeSatelliteContext = null;
    ensureSatelliteLayers();
    const satLines = map.getSource('satellites-lines-source');
    if (satLines) satLines.setData({ type: 'FeatureCollection', features: [] });
    const satPoints = map.getSource('satellites-points-source');
    if (satPoints) satPoints.setData({ type: 'FeatureCollection', features: [] });
  }

  function computeSubSatellitePoint(userLon, userLat, azimuthDeg, elevationDeg) {
    const R_E = 6371.0;
    const H_SAT = 20200.0;
    const R_SAT = R_E + H_SAT;

    const elRad = (Math.max(0.1, elevationDeg) * Math.PI) / 180.0;
    const azRad = (azimuthDeg * Math.PI) / 180.0;
    const latRad = (userLat * Math.PI) / 180.0;
    const lonRad = (userLon * Math.PI) / 180.0;

    const cosArg = (R_E / R_SAT) * Math.cos(elRad);
    const alpha = Math.acos(Math.min(1.0, Math.max(-1.0, cosArg)));
    const gamma = alpha - elRad;

    const sinLat2 = Math.sin(latRad) * Math.cos(gamma) + Math.cos(latRad) * Math.sin(gamma) * Math.cos(azRad);
    const lat2 = Math.asin(Math.min(1.0, Math.max(-1.0, sinLat2)));

    const y = Math.sin(azRad) * Math.sin(gamma) * Math.cos(latRad);
    const x = Math.cos(gamma) - Math.sin(latRad) * Math.sin(lat2);
    const lon2 = lonRad + Math.atan2(y, x);

    let satLat = (lat2 * 180.0) / Math.PI;
    let satLon = (lon2 * 180.0) / Math.PI;
    satLon = ((satLon + 540.0) % 360.0) - 180.0;

    return { lon: satLon, lat: satLat };
  }

  function renderSatelliteRays() {
    if (!activeSatelliteContext) return;
    ensureSatelliteLayers();
    const { pointLon, pointLat, satellitesList } = activeSatelliteContext;

    const lineFeatures = [];
    const pointFeatures = [];
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([pointLon, pointLat]);

    const RAY_DISTANCE_DEG_LOCAL = 0.045;

    satellitesList.forEach(sat => {
      if (sat.azimuth === null || sat.azimuth === undefined) return;
      let satLon, satLat, label;

      if (currentSatMode === 'local') {
        const azRad = (sat.azimuth * Math.PI) / 180.0;
        const el = sat.elevation !== null && sat.elevation !== undefined ? sat.elevation : 45;
        const dist = RAY_DISTANCE_DEG_LOCAL * Math.cos((el * Math.PI) / 180.0);
        satLon = pointLon + dist * Math.sin(azRad) * 1.5;
        satLat = pointLat + dist * Math.cos(azRad);
        label = `PRN ${sat.prn}\n(${sat.elevation || 0}°)`;
      } else {
        const sub = computeSubSatellitePoint(pointLon, pointLat, sat.azimuth, sat.elevation || 0);
        satLon = sub.lon;
        satLat = sub.lat;
        label = `PRN ${sat.prn} (Sub-Sat)\nEl: ${sat.elevation || 0}°`;
      }

      bounds.extend([satLon, satLat]);

      lineFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[pointLon, pointLat], [satLon, satLat]]
        },
        properties: { prn: sat.prn, elevation: sat.elevation }
      });

      pointFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [satLon, satLat]
        },
        properties: { label, prn: sat.prn }
      });
    });

    const satLines = map.getSource('satellites-lines-source');
    if (satLines) satLines.setData({ type: 'FeatureCollection', features: lineFeatures });

    const satPoints = map.getSource('satellites-points-source');
    if (satPoints) satPoints.setData({ type: 'FeatureCollection', features: pointFeatures });

    if (currentSatMode === 'subpoint' && lineFeatures.length > 0) {
      map.fitBounds(bounds, { padding: 80, maxZoom: 6, duration: 1000 });
    } else if (currentSatMode === 'local') {
      map.easeTo({ center: [pointLon, pointLat], zoom: 13, duration: 800 });
    }
  }

  // Panel szczegolow punktu GPS zostal trwale usuniety
  window.loadPointFullDetails = () => {};

  /* ------------------- INICJALIZACJA ------------------- */
  map.on('load', () => {
    // Ślad GPS
    map.addSource('gps-track', {
      type: 'vector',
      tiles: [buildTrackTilesUrl('__none__')],
      minzoom: 0,
      maxzoom: 18
    });

    map.addLayer({
      id: 'GPS / Ślad trasy',
      source: 'gps-track',
      'source-layer': 'gps-track',
      type: 'circle',
      layout: { visibility: 'none' },
      paint: {
        'circle-color': trackBaseColor,
        'circle-radius': 4.5,
        'circle-stroke-width': 0,
        'circle-stroke-color': trackBaseColor,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    });

    autoBuildTree();
  });

  /* ------------------- WYSZUKIWARKA MIEJSC I GEODECODROWANIE ------------------- */
  const searchInput = document.getElementById('search-input');
  const suggestionsBox = document.getElementById('search-suggestions');
  let searchMarker = null;
  let searchTimeout = null;
  let searchRequestId = 0;
  let searchAbortController = null;
  let searchResults = [];
  let highlightedSearchIndex = -1;
  let searchCompleted = false;

  if (searchInput) {
    try {
      const stored = localStorage.getItem('nnaper_user');
      const uName = stored ? (JSON.parse(stored)?.username || '') : '';
      setTimeout(() => {
        if (uName && searchInput.value && searchInput.value.trim() === uName.trim()) {
          searchInput.value = '';
        }
      }, 100);
    } catch (e) {}
  }

  function getPolishPlaceLabel(value) {
    if (!value) return value;
    return String(value)
      .replace(/\bPomeranian Voivodeship\b/gi, 'Pomorskie')
      .replace(/\bPomeranian Province\b/gi, 'Pomorskie')
      .replace(/\bwojewództwo pomorskie\b/gi, 'Pomorskie')
      .replace(/\bPoland\b/gi, 'Polska');
  }

  function parsePhotonFeature(feature) {
    const properties = feature.properties || {};
    const coordinates = feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const addressParts = [
      properties.street && `${properties.street}${properties.housenumber ? ` ${properties.housenumber}` : ''}`,
      properties.city || properties.town || properties.village,
      getPolishPlaceLabel(properties.state),
      getPolishPlaceLabel(properties.country)
    ].filter(Boolean);

    return {
      ...properties,
      state: getPolishPlaceLabel(properties.state),
      country: getPolishPlaceLabel(properties.country),
      name: properties.name || '',
      display_name: [properties.name, ...addressParts]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join(', '),
      lon: coordinates[0],
      lat: coordinates[1],
      address: {
        road: properties.street,
        house_number: properties.housenumber,
        city: properties.city || properties.town || properties.village,
        state: getPolishPlaceLabel(properties.state),
        country: getPolishPlaceLabel(properties.country),
        postcode: properties.postcode
      }
    };
  }

  async function fetchGeocodeFeatures(query, signal) {
    const primaryUrl = `${photonUrl}/api/?q=${encodeURIComponent(query)}&limit=${photonSearchLimit}&bbox=${photonBbox}`;
    try {
      const resp = await fetch(primaryUrl, { signal });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.features) && data.features.length > 0) return data.features;
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }

    const localUrl = `${apiBaseUrl}/api/geocode/api/?q=${encodeURIComponent(query)}&limit=${photonSearchLimit}&bbox=${photonBbox}`;
    if (primaryUrl !== localUrl) {
      try {
        const resp = await fetch(localUrl, { signal });
        if (resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data.features)) return data.features;
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    return [];
  }

  function renderSearchResults(results) {
    suggestionsBox.innerHTML = '';
    searchResults = results.slice(0, 6);
    highlightedSearchIndex = -1;

    searchResults.forEach((place, index) => {
      const div = document.createElement('div');
      div.className = 'suggestion-item';
      div.innerText = place.display_name;
      div.addEventListener('click', () => selectPlace(place));
      div.addEventListener('mouseenter', () => {
        highlightedSearchIndex = index;
        updateHighlightedSearchResult();
      });
      suggestionsBox.appendChild(div);
    });

    suggestionsBox.style.display = searchResults.length ? 'block' : 'none';
  }

  function updateHighlightedSearchResult() {
    [...suggestionsBox.children].forEach((item, index) => {
      item.classList.toggle('active', index === highlightedSearchIndex);
    });
  }

  searchInput.addEventListener('focus', () => {
    if (searchCompleted) {
      searchInput.select();
      searchCompleted = false;
    } else if (searchResults.length > 0 && searchInput.value.trim().length >= 1) {
      suggestionsBox.style.display = 'block';
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!searchResults.length) return;
      e.preventDefault();
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      highlightedSearchIndex = (highlightedSearchIndex + direction + searchResults.length) % searchResults.length;
      updateHighlightedSearchResult();
      suggestionsBox.children[highlightedSearchIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSearchSubmit();
    } else if (e.key === 'Escape') {
      suggestionsBox.style.display = 'none';
    }
  });

  searchInput.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (text && typeof window.parseGoogleMapsRouteUrl === 'function') {
      const coords = window.parseGoogleMapsRouteUrl(text);
      if (coords && coords.length >= 2) {
        e.preventDefault();
        searchInput.value = '';
        suggestionsBox.style.display = 'none';
        window.loadRouteFromGoogleMapsUrl(text);
      }
    }
  });

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const requestId = ++searchRequestId;
    if (searchAbortController) searchAbortController.abort();
    const query = e.target.value.trim();

    if (query.length < 1) {
      searchResults = [];
      highlightedSearchIndex = -1;
      suggestionsBox.style.display = 'none';
      suggestionsBox.innerHTML = '';
      return;
    }

    if (typeof window.parseGoogleMapsRouteUrl === 'function') {
      const coords = window.parseGoogleMapsRouteUrl(query);
      if (coords && coords.length >= 2) {
        suggestionsBox.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        div.style.color = '#38bdf8';
        div.style.fontWeight = 'bold';
        div.innerText = `Wczytaj trasę z linku Google Maps (${coords.length} punktów)`;
        div.addEventListener('click', () => {
          searchInput.value = '';
          suggestionsBox.style.display = 'none';
          window.loadRouteFromGoogleMapsUrl(query);
        });
        suggestionsBox.appendChild(div);
        suggestionsBox.style.display = 'block';
        return;
      }
    }

    searchTimeout = setTimeout(async () => {
      try {
        const currentQuery = searchInput.value.trim();
        if (currentQuery.length < 1) {
          searchResults = [];
          suggestionsBox.style.display = 'none';
          suggestionsBox.innerHTML = '';
          return;
        }

        searchAbortController = new AbortController();
        const searchAbortTimer = setTimeout(() => searchAbortController.abort(), 3500);
        const rawFeatures = await fetchGeocodeFeatures(currentQuery, searchAbortController.signal);
        clearTimeout(searchAbortTimer);

        if (requestId !== searchRequestId) return;

        const uniqueResults = new Map();
        (Array.isArray(rawFeatures) ? rawFeatures : []).forEach(feature => {
          const place = parsePhotonFeature(feature);
          if (place) {
            const key = `${place.osm_type || ''}/${place.osm_id || ''}/${place.lat}/${place.lon}`;
            uniqueResults.set(key, place);
          }
        });

        const exactQueryParts = currentQuery.toLocaleLowerCase('pl-PL').split(/\s+/).filter(Boolean);
        const filteredResults = [...uniqueResults.values()].filter(place => {
          const isPl = !place.countrycode || String(place.countrycode || place.country_code || '').toLocaleUpperCase('pl-PL') === 'PL';
          const isPom = !place.state || /pomorsk|pomeranian/i.test(String(place.state));
          const hasQuery = exactQueryParts.every(part => place.display_name.toLocaleLowerCase('pl-PL').includes(part));
          return isPl && isPom && hasQuery;
        });

        const finalResults = filteredResults.length > 0 ? filteredResults : [...uniqueResults.values()];

        if (finalResults.length === 0) {
          searchResults = [];
          suggestionsBox.style.display = 'none';
          return;
        }

        renderSearchResults(finalResults);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Błąd wyszukiwania miejsca:', err);
      }
    }, 250);
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('search-container')?.contains(e.target)) {
      suggestionsBox.style.display = 'none';
      searchCompleted = Boolean(searchInput.value.trim());
    }
  });

  /* Obsługa wyszukiwania lub wyboru najlepszej opcji po wciśnięciu Enter lub lupki */
  async function handleSearchSubmit() {
    const query = searchInput.value.trim();
    if (!query) {
      searchInput.focus();
      return;
    }

    if (typeof window.parseGoogleMapsRouteUrl === 'function') {
      const coords = window.parseGoogleMapsRouteUrl(query);
      if (coords && coords.length >= 2) {
        searchInput.value = '';
        suggestionsBox.style.display = 'none';
        window.loadRouteFromGoogleMapsUrl(query);
        return;
      }
    }

    // 1. Jeśli podpowiedzi są już załadowane, wybierz zaznaczoną lub pierwszą najlepszą
    if (searchResults && searchResults.length > 0) {
      const chosenIndex = highlightedSearchIndex >= 0 ? highlightedSearchIndex : 0;
      selectPlace(searchResults[chosenIndex]);
      return;
    }

    // 2. Jeśli podpowiedzi jeszcze nie ma w buforze, pobierz bezpośrednio z API geocodera
    try {
      if (btnSearchSubmit) btnSearchSubmit.style.opacity = '0.6';
      clearTimeout(searchTimeout);
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), 3500);
      const rawFeatures = await fetchGeocodeFeatures(query, abortCtrl.signal);
      clearTimeout(timer);

      if (rawFeatures && rawFeatures.length > 0) {
        const parsed = rawFeatures.map(parsePhotonFeature).filter(Boolean);
        if (parsed.length > 0) {
          selectPlace(parsed[0]);
          return;
        }
      }
    } catch (err) {
      console.warn('Błąd bezpośredniego wyszukiwania:', err);
    } finally {
      if (btnSearchSubmit) btnSearchSubmit.style.opacity = '1';
    }
  }

  /* Przycisk po lewej: Planowanie trasy (deseczka z klipsem i listą) - synchronizacja stanu aktywności */
  const btnSearchOpenPlanner = document.getElementById('btn-search-open-planner');
  if (btnSearchOpenPlanner) {
    const updatePlannerBtnState = () => {
      const panel = document.getElementById('route-planner-panel');
      if (panel && panel.classList.contains('active')) {
        btnSearchOpenPlanner.classList.add('active');
      } else {
        btnSearchOpenPlanner.classList.remove('active');
      }
    };
    const observer = new MutationObserver(updatePlannerBtnState);
    const panelEl = document.getElementById('route-planner-panel');
    if (panelEl) observer.observe(panelEl, { attributes: true, attributeFilter: ['class'] });
  }

  /* Przycisk po prawej: Lupka wyszukiwania działająca zamiast Entera */
  const btnSearchSubmit = document.getElementById('btn-search-submit');
  if (btnSearchSubmit && searchInput) {
    btnSearchSubmit.addEventListener('click', (e) => {
      e.preventDefault();
      handleSearchSubmit();
    });
  }

  function selectPlace(place) {
    searchInput.value = place.display_name;
    suggestionsBox.style.display = 'none';
    searchCompleted = true;

    const lon = parseFloat(place.lon);
    const lat = parseFloat(place.lat);

    if (!previousSearchCamera) {
      previousSearchCamera = {
        center: map.getCenter().toArray(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        duration: 1200
      };
    }

    map.flyTo({
      center: [lon, lat],
      zoom: 16,
      duration: 1200
    });

    if (searchMarker) {
      searchMarker.setLngLat([lon, lat]);
    } else {
      searchMarker = new maplibregl.Marker({ color: '#f59e0b' })
        .setLngLat([lon, lat])
        .addTo(map);
    }

    displayPlaceDetails(place);
  }

  function displayPlaceDetails(place) {
    const addr = place.address || {};
    const street = addr.road || addr.street || addr.pedestrian;
    const streetAddress = street && `${street}${addr.house_number ? ` ${addr.house_number}` : ''}`;
    const locationName = streetAddress || place.name || place.display_name;
    const city = addr.city || addr.town || addr.village || addr.municipality;
    const details = [
      ['Miejscowość', city],
      ['Województwo', addr.state || addr.province],
      ['Państwo', addr.country],
      ['Kod pocztowy', addr.postcode],
      ['Szerokość', place.lat],
      ['Długość', place.lon],
      ['Typ obiektu', place.type || place.osm_value],
      ['OSM ID', place.osm_id]
    ].filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false;
      return !/^(brak|nieznany|unknown|n\/a)$/i.test(String(value).trim());
    });

    menuTitle.innerText = locationName;
    menuBody.innerHTML = '';
    btnBackLocation.style.display = '';
    btnCloseLocation.style.display = '';
    const table = document.createElement('table');
    table.className = 'kv-table';
    details.forEach(([label, value]) => {
      const row = table.insertRow();
      row.insertCell().innerText = label;
      row.insertCell().innerText = String(value);
    });
    menuBody.appendChild(table);
    const routeButton = document.createElement('button');
    routeButton.className = 'route-action-btn';
    routeButton.innerText = 'Wyznacz trasę';
    routeButton.addEventListener('click', () => {
      localStorage.setItem('nnaper-route-destination', JSON.stringify(place));
      menuEl.classList.add('route-planner-open');
      window.dispatchEvent(new CustomEvent('nnaper-route-destination-selected', { detail: place }));
    });
    menuBody.appendChild(routeButton);
    expandMenu();
  }
