const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const apiBaseUrl = (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const photonUrl = (window.NNAPER_CONFIG?.PHOTON_URL || 'https://photon.komoot.io').replace(/\/$/, '');
const photonBbox = window.NNAPER_CONFIG?.PHOTON_BBOX || '14.1,53.9,19.9,55.9';
const photonSearchLimit = window.NNAPER_CONFIG?.PHOTON_SEARCH_LIMIT || 50;
const TRACK_TILES_URL = `${apiBaseUrl}/api/track/{z}/{x}/{y}.pbf`;
const trackMonthLayers = new Map();
const trackLayerIds = new Set(['GPS / Ślad trasy']);

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

const navControl = new maplibregl.NavigationControl({ showCompass: true });
map.addControl(navControl, 'bottom-right');


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
  // Sprawdzenie czy zmienił się aktywny filtr dat/czasu - jeśli tak, czyścimy cache odkrytych dróg
  let currentFilterSig = '';
  trackMonthLayers.forEach((_, key) => {
    const f = getActiveFiltersForMonth(key);
    currentFilterSig += `${key}:${f.activeDays.join(',')}:${f.activeHours.join(',')}:${f.activeMinutes.join(',')}:${f.activeSeconds.join(',')};`;
  });
  if (currentFilterSig !== lastActiveFilterSignature) {
    lastActiveFilterSignature = currentFilterSig;
    traversedRoadsCache.clear();
    const src = map && map.getSource('osm-traversed-roads');
    if (src) {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  }

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
      conditions.push(['match', ['get', 's'], activeSeconds, true, false]);
    }

    if (conditions.length > 0) {
      const activeFilter = conditions.length === 1 ? conditions[0] : ['any', ...conditions];

      if (currentTrackMode === 'osm') {
        if (hasLine) {
          map.setLayoutProperty(lineLayerId, 'visibility', 'none');
        }
        if (hasCircle) {
          map.setLayoutProperty(layerId, 'visibility', 'visible');
          map.setFilter(layerId, activeFilter);
          map.setPaintProperty(layerId, 'circle-opacity', 0.0);
          map.setPaintProperty(layerId, 'circle-stroke-opacity', 0.0);
          map.setPaintProperty(layerId, 'circle-radius', 2.0);
          map.setPaintProperty(layerId, 'circle-color', trackBaseColor);
          map.setPaintProperty(layerId, 'circle-stroke-color', trackBaseColor);
          map.setPaintProperty(layerId, 'circle-stroke-width', 0);
        }
      } else {
        if (hasLine) {
          map.setLayoutProperty(lineLayerId, 'visibility', 'none');
        }
        if (hasCircle) {
          map.setLayoutProperty(layerId, 'visibility', 'visible');
          map.setFilter(layerId, activeFilter);
          map.setPaintProperty(layerId, 'circle-opacity', 1.0);
          map.setPaintProperty(layerId, 'circle-stroke-opacity', 1.0);
          map.setPaintProperty(layerId, 'circle-radius', 4.5);
          map.setPaintProperty(layerId, 'circle-color', trackBaseColor);
          map.setPaintProperty(layerId, 'circle-stroke-color', trackBaseColor);
          map.setPaintProperty(layerId, 'circle-stroke-width', 0);
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

  if (currentTrackMode === 'osm') {
    ensureOsmTraversedRoadsLayer();
    if (map.getLayer('osm-traversed-roads-layer')) {
      map.setLayoutProperty('osm-traversed-roads-layer', 'visibility', 'visible');
    }
    scheduleOsmRoadsUpdate();
    setTimeout(scheduleOsmRoadsUpdate, 200);
    setTimeout(scheduleOsmRoadsUpdate, 600);
  } else {
    clearOsmTraversedRoads();
  }
}

function applyTrackDateFilter(dayCheckboxes, isEverythingActive) {
  if (!isEverythingActive) {
    trackMonthLayers.forEach(({ layerId }) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'none');
        map.setFilter(layerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
      }
    });
    return;
  }
  updateTrackFilters();
}

// Jednorazowe zresetowanie konfiguracji kolorów do wartości domyślnych
if (localStorage.getItem('nnaper_reset_colors_v2') !== 'true') {
  localStorage.removeItem('nnaper_layer_customizations');
  localStorage.removeItem('nnaper_track_color');
  localStorage.removeItem('nnaper_offroad_color');
  localStorage.removeItem('nnaper_show_offroad');
  localStorage.setItem('nnaper_reset_colors_v2', 'true');
}

window.resetAllCustomizations = function() {
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
} catch (e) {}

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

window.setTrackMode = function(mode) {
  if (!['raw', 'snapped', 'osm'].includes(mode)) mode = 'raw';
  currentTrackMode = mode;
  isSnapRoadsEnabled = (mode === 'snapped' || mode === 'osm');
  localStorage.setItem('nnaper_track_mode', mode);
  localStorage.setItem('nnaper_snap_roads', mode === 'snapped' ? 'true' : 'false');
  syncTrackModeUI();
  updateTrackTilesSource();
  if (mode === 'osm') {
    ensureOsmTraversedRoadsLayer();
    if (map.getLayer('osm-traversed-roads-layer')) {
      map.setLayoutProperty('osm-traversed-roads-layer', 'visibility', 'visible');
    }
    scheduleOsmRoadsUpdate();
  } else {
    clearOsmTraversedRoads();
  }
};

/* ------------------- ZAZNACZONE ŚCIEŻKI OSM NA BAZIE PUNKTÓW ------------------- */
let updateOsmRoadsDebounceTimer = null;
const traversedRoadsCache = new Map();
let lastActiveFilterSignature = '';

const ALL_ROAD_LAYER_IDS = [
  'Drogi/Autostrady i ekspresówki',
  'Drogi/Drogi główne',
  'Drogi/Ulice osiedlowe',
  'Drogi/Drogi gruntowe',
  'Ruch alternatywny/Drogi rowerowe',
  'Ruch alternatywny/Chodniki i deptaki'
];

function scheduleOsmRoadsUpdate() {
  if (currentTrackMode !== 'osm') return;
  clearTimeout(updateOsmRoadsDebounceTimer);
  updateOsmRoadsDebounceTimer = setTimeout(updateOsmTraversedRoads, 80);
}

function ensureOsmTraversedRoadsLayer() {
  if (!map) return;
  if (!map.getSource('osm-traversed-roads')) {
    map.addSource('osm-traversed-roads', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }

  if (!map.getLayer('osm-traversed-roads-layer')) {
    let beforeLayer = null;
    const candidatesBefore = [
      'Budynki/Bryły 3D',
      'Granice i Etykiety/Nazwy ulic',
      'Granice i Etykiety/Miejscowości',
      'Punkty POI/Miejsca kultu'
    ];
    for (const id of candidatesBefore) {
      if (map.getLayer(id)) {
        beforeLayer = id;
        break;
      }
    }

    map.addLayer({
      id: 'osm-traversed-roads-layer',
      source: 'osm-traversed-roads',
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
          10, [
            'match', ['get', 'class'],
            ['motorway', 'trunk', 'primary'], 3.6,
            ['secondary', 'tertiary'], 2.8,
            2.0
          ],
          14, [
            'match', ['get', 'class'],
            ['motorway', 'trunk', 'primary'], 5.5,
            ['secondary', 'tertiary'], 4.2,
            3.2
          ],
          17, [
            'match', ['get', 'class'],
            ['motorway', 'trunk', 'primary'], 8.5,
            ['secondary', 'tertiary'], 6.5,
            5.0
          ]
        ],
        'line-opacity': 0.95
      }
    }, beforeLayer);
  }
}

function clearOsmTraversedRoads() {
  if (!map) return;
  traversedRoadsCache.clear();
  const src = map.getSource('osm-traversed-roads');
  if (src) {
    src.setData({ type: 'FeatureCollection', features: [] });
  }
  if (map.getLayer('osm-traversed-roads-layer')) {
    map.setLayoutProperty('osm-traversed-roads-layer', 'visibility', 'none');
  }
}

function pointToSegmentDistMeters(pLon, pLat, lon1, lat1, lon2, lat2) {
  if (typeof pLon !== 'number' || typeof pLat !== 'number' || typeof lon1 !== 'number' || typeof lat1 !== 'number' || typeof lon2 !== 'number' || typeof lat2 !== 'number') {
    return 999999.0;
  }
  const midLatRad = ((pLat + lat1 + lat2) / 3.0) * (Math.PI / 180.0);
  const kx = 111320.0 * Math.cos(midLatRad);
  const ky = 110540.0;

  const dx = (lon2 - lon1) * kx;
  const dy = (lat2 - lat1) * ky;
  const lenSq = dx * dx + dy * dy;

  const px = (pLon - lon1) * kx;
  const py = (pLat - lat1) * ky;

  if (lenSq < 1e-4) {
    return Math.hypot(px, py);
  }

  let t = (px * dx + py * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  const projX = t * dx;
  const projY = t * dy;
  return Math.hypot(px - projX, py - projY);
}

function isSegmentNearPoint(p1, p2, toleranceMeters, tolDeg, grid, cellDeg) {
  const minLon = Math.min(p1[0], p2[0]) - tolDeg;
  const maxLon = Math.max(p1[0], p2[0]) + tolDeg;
  const minLat = Math.min(p1[1], p2[1]) - tolDeg;
  const maxLat = Math.max(p1[1], p2[1]) + tolDeg;

  const gMinX = Math.floor(minLon / cellDeg);
  const gMaxX = Math.floor(maxLon / cellDeg);
  const gMinY = Math.floor(minLat / cellDeg);
  const gMaxY = Math.floor(maxLat / cellDeg);

  for (let gx = gMinX; gx <= gMaxX; gx++) {
    for (let gy = gMinY; gy <= gMaxY; gy++) {
      const cell = grid.get(`${gx}:${gy}`);
      if (!cell) continue;

      for (let k = 0; k < cell.length; k++) {
        const pt = cell[k];
        if (pt[0] < minLon || pt[0] > maxLon || pt[1] < minLat || pt[1] > maxLat) continue;

        if (pointToSegmentDistMeters(pt[0], pt[1], p1[0], p1[1], p2[0], p2[1]) <= toleranceMeters) {
          return true;
        }
      }
    }
  }
  return false;
}

function getMatchedLineKey(lineCoords) {
  const pStart = lineCoords[0];
  const pEnd = lineCoords[lineCoords.length - 1];
  const pMid = lineCoords[Math.floor(lineCoords.length / 2)];
  const r = (v) => Math.round(v * 100000);
  return `${r(pStart[0])}_${r(pStart[1])}_${r(pMid[0])}_${r(pMid[1])}_${r(pEnd[0])}_${r(pEnd[1])}_${lineCoords.length}`;
}

function updateOsmTraversedRoads() {
  if (currentTrackMode !== 'osm' || !map) {
    clearOsmTraversedRoads();
    return;
  }
  ensureOsmTraversedRoadsLayer();
  const src = map.getSource('osm-traversed-roads');
  if (!src) return;

  const activePointLayers = [];
  trackMonthLayers.forEach(({ layerId }) => {
    if (map.getLayer(layerId) && map.getLayoutProperty(layerId, 'visibility') !== 'none') {
      activePointLayers.push(layerId);
    }
  });

  if (activePointLayers.length === 0) {
    traversedRoadsCache.clear();
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const activeRoadLayers = ALL_ROAD_LAYER_IDS.filter(id => {
    return !!map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none';
  });
  if (activeRoadLayers.length === 0) return;

  const renderedPoints = map.queryRenderedFeatures({ layers: activePointLayers });
  if (!renderedPoints || renderedPoints.length === 0) {
    return;
  }

  const renderedRoads = map.queryRenderedFeatures({ layers: activeRoadLayers });
  if (!renderedRoads || renderedRoads.length === 0) {
    return;
  }

  // Budowa przestrzennego indeksu siatkowego (grid) dla punktów w stopniach geograficznych (~200m)
  const CELL_DEG = 0.002;
  const grid = new Map();
  let pointCount = 0;

  for (let i = 0; i < renderedPoints.length; i++) {
    const geom = renderedPoints[i].geometry;
    if (!geom || !geom.coordinates) continue;
    const c = geom.coordinates;
    const lon = c[0];
    const lat = c[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;

    const gx = Math.floor(lon / CELL_DEG);
    const gy = Math.floor(lat / CELL_DEG);
    const cellKey = `${gx}:${gy}`;
    let cell = grid.get(cellKey);
    if (!cell) {
      cell = [];
      grid.set(cellKey, cell);
    }
    cell.push([lon, lat]);
    pointCount++;
  }

  if (pointCount === 0) return;

  const zoom = map.getZoom();
  // Rygorystyczna metryczna tolerancja dopasowania do linii drogi w metrach:
  // Przy dużym zbliżeniu (z>=15) punkty snapowane OSRM leżą dokładnie na osi drogi (tolerancja 12m).
  // Na średnim zbliżeniu (z 12-14) uwzględniamy lekkie uproszczenie wektorowe kafelków (tolerancja 18m).
  // Na małym zbliżeniu (z < 12) tolerancja to 25m.
  const toleranceMeters = (zoom >= 15) ? 12.0 : ((zoom >= 12) ? 18.0 : 25.0);
  const tolDeg = toleranceMeters / 65000.0;
  let newRoadAdded = false;

  for (let r = 0; r < renderedRoads.length; r++) {
    const road = renderedRoads[r];
    const geom = road.geometry;
    if (!geom || !geom.coordinates) continue;

    const lines = (geom.type === 'MultiLineString') ? geom.coordinates : [geom.coordinates];

    for (let l = 0; l < lines.length; l++) {
      const coords = lines[l];
      if (!coords || coords.length < 2) continue;

      let currentLine = null;

      for (let i = 1; i < coords.length; i++) {
        const p1 = coords[i - 1];
        const p2 = coords[i];

        if (isSegmentNearPoint(p1, p2, toleranceMeters, tolDeg, grid, CELL_DEG)) {
          if (!currentLine) {
            currentLine = [p1, p2];
          } else {
            currentLine.push(p2);
          }
        } else {
          if (currentLine && currentLine.length >= 2) {
            const key = getMatchedLineKey(currentLine);
            if (!traversedRoadsCache.has(key)) {
              traversedRoadsCache.set(key, {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: currentLine
                },
                properties: Object.assign({}, road.properties || {})
              });
              newRoadAdded = true;
            }
            currentLine = null;
          }
        }
      }

      if (currentLine && currentLine.length >= 2) {
        const key = getMatchedLineKey(currentLine);
        if (!traversedRoadsCache.has(key)) {
          traversedRoadsCache.set(key, {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: currentLine
            },
            properties: Object.assign({}, road.properties || {})
          });
          newRoadAdded = true;
        }
        currentLine = null;
      }
    }
  }

  if (newRoadAdded) {
    src.setData({
      type: 'FeatureCollection',
      features: Array.from(traversedRoadsCache.values())
    });
  }
}

window.setSnapRoadsEnabled = function(bool) {
  window.setTrackMode(bool ? 'snapped' : 'raw');
};

function buildTrackTilesUrl(days) {
  const modeParam = (currentTrackMode === 'osm') ? 'snapped' : currentTrackMode;
  let url = `${TRACK_TILES_URL}?days=${encodeURIComponent(days)}&mode=${modeParam}`;
  if (currentTrackMode === 'snapped' || currentTrackMode === 'osm') {
    url += '&snapped=true';
  }
  return url;
}

function updateTrackTilesSource() {
  const baseSrc = map.getSource('gps-track');
  if (baseSrc && typeof baseSrc.setTiles === 'function') {
    baseSrc.setTiles([buildTrackTilesUrl('__none__')]);
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
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, property, value);
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

    map.addSource(sourceId, {
      type: 'vector',
      tiles: [buildTrackTilesUrl(days.join(','))],
      minzoom: 0,
      maxzoom: 18
    });

    // Warstwa punktów GPS (surowe / snapnięte / podstawa pod zaznaczone drogi OSM)
    map.addLayer({
      id: layerId,
      source: sourceId,
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

    trackMonthLayers.set(key, { layerId, days });
    trackLayerIds.add(layerId);
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
    const res = await fetch(`${apiBaseUrl}/api/time-tree?day=${encodeURIComponent(dayItem.dateStr)}`);
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
  try {
    const res = await fetch(`${apiBaseUrl}/api/dates-tree`);
    if (!res.ok) throw new Error('Błąd API');
    const data = await res.json();

    if (Object.keys(data).length === 0) {
      container.innerHTML = '<span style="color:#64748b;font-size:11px;">Brak danych czasowych.</span>';
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
    container.innerHTML = `<span style="color:#ef4444;font-size:11px;">Brak połączenia z API dat.</span>`;
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
  } catch (err) {}
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

/* ------------------- POBIERANIE PEŁNYCH DANYCH Z BAZY ------------------- */
const pointPanelEl = document.getElementById('point-panel');
const btnClosePoint = document.getElementById('btn-close-point');

if (btnClosePoint) {
  btnClosePoint.addEventListener('click', () => {
    if (pointPanelEl) pointPanelEl.classList.remove('active');
    clearSatelliteLayers();
  });
}

async function loadPointFullDetails(epochId) {
  collapseMenu();
  collapseRightMenu();
  if (pointPanelEl) pointPanelEl.classList.add('active');

  const content = document.getElementById('pp-content');
  if (content) content.innerHTML = '<div style="color:#94a3b8;">Odpytywanie bazy danych...</div>';

  try {
    const res = await fetch(`${apiBaseUrl}/api/epoch/${epochId}`);
    if (!res.ok) throw new Error('Błąd odpytania serwera');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const e = data;
    const allSatellites = data.satellites || [];

    if (e.longitude && e.latitude) {
      activeSatelliteContext = {
        pointLon: parseFloat(e.longitude),
        pointLat: parseFloat(e.latitude),
        satellitesList: allSatellites
      };
      renderSatelliteRays();
    }

    const formatG = (val) => {
      if (val === null || val === undefined || isNaN(Number(val))) return 'Brak danych';
      const num = Number(val);
      const sign = num > 0 ? '+' : '';
      return `${sign}${num.toFixed(3)} G`;
    };

    const altStr = (e.altitude !== null && e.altitude !== undefined && !isNaN(Number(e.altitude)))
      ? `${Number(e.altitude).toFixed(1)} m`
      : 'Brak danych';

    const spdStr = (e.speed_kmh !== null && e.speed_kmh !== undefined && !isNaN(Number(e.speed_kmh)))
      ? `${Number(e.speed_kmh).toFixed(1)} km/h`
      : '0.0 km/h';

    let snapStatusHtml = '<span style="color:#94a3b8;">Surowy GPS</span>';
    if (e.snapped_latitude !== null && e.snapped_latitude !== undefined) {
      snapStatusHtml = `<span style="color:#10b981;font-weight:600;">Dociągnięty do drogi</span> (${Number(e.snapped_latitude).toFixed(6)}, ${Number(e.snapped_longitude).toFixed(6)})`;
    }

    let html = `
      <div class="sat-mode-switch">
        <span>Tryb wizualizacji satelitów:</span>
        <select id="sel-sat-mode">
          <option value="local" ${currentSatMode === 'local' ? 'selected' : ''}>1. Lokalny / Skyplot (Nieboskłon)</option>
          <option value="subpoint" ${currentSatMode === 'subpoint' ? 'selected' : ''}>2. Model Sferyczny (Orbita MEO 20 200 km)</option>
        </select>
      </div>

      <div class="section-box">
        <h4>Szczegóły Epoki (GPS / Telemetria)</h4>
        <table class="kv-table">
          <tr><td>ID Epoki</td><td>${e.epoch_id}</td></tr>
          <tr><td>Czas pomiaru</td><td>${e.timestamp || 'Brak'}</td></tr>
          <tr><td>Współrzędne GPS</td><td>${Number(e.latitude).toFixed(6)}, ${Number(e.longitude).toFixed(6)}</td></tr>
          <tr><td>Snap do drogi</td><td>${snapStatusHtml}</td></tr>
          <tr><td>Wysokość n.p.m.</td><td>${altStr}</td></tr>
          <tr><td>Prędkość</td><td>${spdStr}</td></tr>
          <tr><td>Przeciążenie X</td><td>${formatG(e.g_x)}</td></tr>
          <tr><td>Przeciążenie Y</td><td>${formatG(e.g_y)}</td></tr>
          <tr><td>Przeciążenie Z</td><td>${formatG(e.g_z)}</td></tr>
        </table>
      </div>

      <div class="section-box">
        <h4>Satelity w zasięgu (${allSatellites.length})</h4>
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
    `;

    if (allSatellites.length > 0) {
      allSatellites.forEach(sat => {
        html += `
          <span class="sat-badge">
            <strong style="color:#38bdf8;">PRN ${sat.prn}:</strong> El: ${sat.elevation}°, Az: ${sat.azimuth}°
          </span>
        `;
      });
    } else {
      html += `<span style="color:#64748b;">Brak wpisów satelitów w tej epoce.</span>`;
    }

    html += `
        </div>
      </div>
    `;

    if (content) content.innerHTML = html;

    const selMode = document.getElementById('sel-sat-mode');
    if (selMode) {
      selMode.addEventListener('change', (e) => {
        currentSatMode = e.target.value;
        renderSatelliteRays();
      });
    }

  } catch (err) {
    if (content) content.innerHTML = `<span style="color:#ef4444;">Błąd pobierania danych: ${err.message}</span>`;
  }
}

/* ------------------- INICJALIZACJA ------------------- */
map.on('load', () => {
  ensureOsmTraversedRoadsLayer();

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

  map.on('moveend', () => {
    if (currentTrackMode === 'osm') {
      scheduleOsmRoadsUpdate();
    }
  });

  map.on('sourcedata', (e) => {
    if (currentTrackMode === 'osm' && e.isSourceLoaded) {
      if (e.sourceId === 'pomorskie-tiles' || (e.sourceId && e.sourceId.startsWith('gps-track'))) {
        scheduleOsmRoadsUpdate();
      }
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

function getPolishPlaceLabel(value) {
  if (!value) return value;
  return String(value)
    .replace(/\bPomeranian Voivodeship\b/gi, 'Pomorskie')
    .replace(/\bPomeranian Province\b/gi, 'Pomorskie')
    .replace(/\bwojewództwo pomorskie\b/gi, 'Pomorskie')
    .replace(/\bPoland\b/gi, 'Polska');
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
    searchInput.value = '';
    suggestionsBox.innerHTML = '';
    suggestionsBox.style.display = 'none';
    searchResults = [];
    highlightedSearchIndex = -1;
    searchCompleted = false;
    restoreLayerMenu();
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!searchResults.length) return;
    e.preventDefault();
    const direction = e.key === 'ArrowDown' ? 1 : -1;
    highlightedSearchIndex = (highlightedSearchIndex + direction + searchResults.length) % searchResults.length;
    updateHighlightedSearchResult();
    suggestionsBox.children[highlightedSearchIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const query = searchInput.value.trim();
    if (typeof window.parseGoogleMapsRouteUrl === 'function') {
      const coords = window.parseGoogleMapsRouteUrl(query);
      if (coords && coords.length >= 2) {
        e.preventDefault();
        searchInput.value = '';
        suggestionsBox.style.display = 'none';
        window.loadRouteFromGoogleMapsUrl(query);
        return;
      }
    }
    if (searchResults.length) {
      e.preventDefault();
      selectPlace(searchResults[highlightedSearchIndex >= 0 ? highlightedSearchIndex : 0]);
    }
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
      div.innerText = `🗺️ Wczytaj trasę z linku Google Maps (${coords.length} punktów)`;
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
      const query = searchInput.value.trim();
      if (query.length < 1) {
        suggestionsBox.style.display = 'none';
        suggestionsBox.innerHTML = '';
        return;
      }

      const url = `${photonUrl}/api/?q=${encodeURIComponent(query)}&limit=${photonSearchLimit}&bbox=${photonBbox}`;
      searchAbortController = new AbortController();
      const searchAbortTimer = setTimeout(() => searchAbortController.abort(), 4000);
      const response = await fetch(url, { signal: searchAbortController.signal });
      clearTimeout(searchAbortTimer);
      if (!response.ok) throw new Error(`Błąd wyszukiwania: ${response.status}`);
      const data = await response.json();
      if (requestId !== searchRequestId) return;
      const uniqueResults = new Map();
      (Array.isArray(data.features) ? data.features : []).forEach(feature => {
        const properties = feature.properties || {};
        const coordinates = feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return;
        const addressParts = [
          properties.street && `${properties.street}${properties.housenumber ? ` ${properties.housenumber}` : ''}`,
          properties.city || properties.town || properties.village,
          getPolishPlaceLabel(properties.state),
          getPolishPlaceLabel(properties.country)
        ].filter(Boolean);

        const place = {
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
        const key = `${place.osm_type || ''}/${place.osm_id || ''}/${place.lat}/${place.lon}`;
        uniqueResults.set(key, place);
      });
      const exactQueryParts = query.toLocaleLowerCase('pl-PL').split(/\s+/).filter(Boolean);
      const results = [...uniqueResults.values()].filter(place =>
        String(place.countrycode || place.country_code || '').toLocaleUpperCase('pl-PL') === 'PL' &&
        /pomorsk|pomeranian/.test(String(place.state || '').toLocaleLowerCase('pl-PL')) &&
        exactQueryParts.every(part => place.display_name.toLocaleLowerCase('pl-PL').includes(part))
      );

      if (results.length === 0) {
        searchResults = [];
        suggestionsBox.style.display = 'none';
        return;
      }

      renderSearchResults(results);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Błąd wyszukiwania miejsca:', err);
    }
  }, 300);
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('search-container').contains(e.target)) {
    suggestionsBox.style.display = 'none';
    searchCompleted = Boolean(searchInput.value.trim());
  }
});

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
