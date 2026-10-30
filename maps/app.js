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

function getLayerColor(layer) {
  if (!layer || !layer.paint) return '#94a3b8';
  const c = layer.paint['fill-color'] || layer.paint['line-color'] || layer.paint['circle-color'] || layer.paint['fill-extrusion-color'] || layer.paint['text-color'];
  return (typeof c === 'string' && c.startsWith('#')) ? c : '#94a3b8';
}

function getLayerStrokeColor(layer) {
  if (!layer || !layer.paint) return getLayerColor(layer);
  const c = layer.paint['circle-stroke-color'];
  return (typeof c === 'string' && c.startsWith('#')) ? c : getLayerColor(layer);
}

function updateLineDashArray(layerId, isDashed, dashLen, gapLen) {
  if (!map.getLayer(layerId)) return;
  if (isDashed) {
    map.setPaintProperty(layerId, 'line-dasharray', [parseFloat(dashLen), parseFloat(gapLen)]);
  } else {
    map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
  }
}

function createDashControls(targetLayerId, initialDashed = false) {
  const box = document.createElement('div');
  box.className = 'control-row';
  box.style.borderTop = '1px dotted #334155';
  box.style.paddingTop = '4px';

  const checkLabel = document.createElement('label');
  checkLabel.style.display = 'flex';
  checkLabel.style.alignItems = 'center';
  checkLabel.style.gap = '4px';
  checkLabel.style.cursor = 'pointer';

  const dashCheck = document.createElement('input');
  dashCheck.type = 'checkbox';
  dashCheck.checked = initialDashed;
  dashCheck.style.accentColor = '#38bdf8';

  const checkText = document.createElement('span');
  checkText.innerText = 'Przerywana:';

  checkLabel.appendChild(dashCheck);
  checkLabel.appendChild(checkText);
  box.appendChild(checkLabel);

  const inputsHolder = document.createElement('div');
  inputsHolder.style.display = initialDashed ? 'flex' : 'none';
  inputsHolder.style.alignItems = 'center';
  inputsHolder.style.gap = '4px';

  const lDash = document.createElement('span'); lDash.innerText = 'L:';
  const inDash = document.createElement('input');
  inDash.type = 'range'; inDash.min = '0.5'; inDash.max = '15'; inDash.step = '0.5'; inDash.value = '3';

  const lGap = document.createElement('span'); lGap.innerText = 'P:';
  const inGap = document.createElement('input');
  inGap.type = 'range'; inGap.min = '0.5'; inGap.max = '15'; inGap.step = '0.5'; inGap.value = '2';

  const apply = () => {
    updateLineDashArray(targetLayerId, dashCheck.checked, inDash.value, inGap.value);
  };

  dashCheck.addEventListener('change', () => {
    inputsHolder.style.display = dashCheck.checked ? 'flex' : 'none';
    apply();
  });
  inDash.addEventListener('input', apply);
  inGap.addEventListener('input', apply);

  inputsHolder.appendChild(lDash); inputsHolder.appendChild(inDash);
  inputsHolder.appendChild(lGap); inputsHolder.appendChild(inGap);
  box.appendChild(inputsHolder);

  return box;
}

/* ------------------- FILTR CZASU & JEDYNY PRZEŁĄCZNIK ŚLADU GPS ------------------- */
const MONTH_NAMES = {
  "01": "Styczeń", "02": "Luty", "03": "Marzec", "04": "Kwiecień",
  "05": "Maj", "06": "Czerwiec", "07": "Lipiec", "08": "Sierpień",
  "09": "Wrzesień", "10": "Październik", "11": "Listopad", "12": "Grudzień"
};

let gpsMasterCheckbox = null;
let allGpsDayCheckboxes = [];
let allGpsYearCheckboxes = [];

function syncGpsMasterCheckbox() {
  if (!gpsMasterCheckbox || allGpsDayCheckboxes.length === 0) return;
  const checkedCount = allGpsDayCheckboxes.filter(c => c.checked).length;
  const total = allGpsDayCheckboxes.length;
  gpsMasterCheckbox.checked = checkedCount === total;
  gpsMasterCheckbox.indeterminate = checkedCount > 0 && checkedCount < total;
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

function setTrackLayerVisibility(visibleDays) {
  trackMonthLayers.forEach(({ layerId, days }) => {
    if (map.getLayer(layerId)) {
      const activeDays = days.filter(day => visibleDays.has(day));
      if (activeDays.length > 0) {
        map.setLayoutProperty(layerId, 'visibility', 'visible');
        map.setFilter(layerId, [
          'match',
          ['get', 'day'],
          activeDays,
          true,
          false
        ]);
      } else {
        map.setLayoutProperty(layerId, 'visibility', 'none');
        map.setFilter(layerId, ['==', ['get', 'day'], '__NO_DAY_ACTIVE__']);
      }
    }
  });
}

function applyTrackDateFilter(dayCheckboxes, isEverythingActive) {
  if (!isEverythingActive) {
    setTrackLayerVisibility(new Set());
    return;
  }

  const selectedDays = dayCheckboxes.filter(c => c.checked).map(c => c.value);
  setTrackLayerVisibility(new Set(selectedDays));
}

function buildTrackTilesUrl(days) {
  return `${TRACK_TILES_URL}?days=${encodeURIComponent(days)}`;
}

function updateTrackPaintProperty(property, value) {
  trackLayerIds.forEach(layerId => {
    if (map.getLayer(layerId)) map.setPaintProperty(layerId, property, value);
  });
}
window.updateTrackPaintProperty = updateTrackPaintProperty;
window.bindGpsMasterCheckbox = (cb) => { gpsMasterCheckbox = cb; };

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
    map.addLayer({
      id: layerId,
      source: sourceId,
      'source-layer': 'gps-track',
      type: 'circle',
      layout: { visibility: 'none' },
      paint: {
        'circle-color': '#06b6d4',
        'circle-radius': 4.5,
        'circle-stroke-width': 0,
        'circle-stroke-color': '#06b6d4',
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    });

    map.on('click', layerId, (e) => {
      if (!e.features || !e.features.length) return;
      const feat = e.features[0];
      const epochId = feat.properties?.epoch_id;
      if (epochId) {
        loadPointFullDetails(epochId);
      }
    });

    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });

    trackMonthLayers.set(key, { layerId, days });
    trackLayerIds.add(layerId);
  });
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
        months.push({
          key: `${year}-${month}`,
          days: data[year][month].map(day => `${year}-${month}-${day}`)
        });
      });
    });
    addTrackMonthLayers(months);

    container.innerHTML = '';
    allGpsDayCheckboxes = [];
    allGpsYearCheckboxes = [];

    Object.keys(data).sort().reverse().forEach(year => {
      const yearNode = document.createElement('div');
      yearNode.className = 'tree-node';
      const yearHeader = createFilterTreeNode(`Rok: ${year}`, false, true);
      const yearChildren = document.createElement('div');
      yearChildren.className = 'node-children collapsed';
      yearChildren.style.marginLeft = '8px';
      bindFilterCollapse(yearHeader, yearChildren);

      allGpsYearCheckboxes.push(yearHeader.checkbox);
      const yearDayCheckboxes = [];

      Object.keys(data[year]).sort().reverse().forEach(month => {
        const monthNode = document.createElement('div');
        monthNode.className = 'tree-node';
        const monthName = MONTH_NAMES[month] || month;
        const monthHeader = createFilterTreeNode(`Miesiąc: ${monthName} (${month})`, false, true);
        const monthChildren = document.createElement('div');
        monthChildren.className = 'node-children collapsed';
        monthChildren.style.marginLeft = '8px';
        bindFilterCollapse(monthHeader, monthChildren);

        const monthDayCheckboxes = [];

        data[year][month].sort().reverse().forEach(day => {
          const dateStr = `${year}-${month}-${day}`;
          const leaf = document.createElement('div');
          leaf.className = 'leaf-item';
          leaf.style.padding = '2px 4px';

          const dayCheckbox = document.createElement('input');
          dayCheckbox.type = 'checkbox';
          dayCheckbox.checked = false;
          dayCheckbox.value = dateStr;
          dayCheckbox.style.accentColor = '#38bdf8';
          dayCheckbox.style.marginRight = '6px';
          dayCheckbox.style.cursor = 'pointer';

          monthDayCheckboxes.push(dayCheckbox);
          yearDayCheckboxes.push(dayCheckbox);
          allGpsDayCheckboxes.push(dayCheckbox);

          dayCheckbox.addEventListener('change', () => {
            syncFilterCheckbox(monthHeader.checkbox, monthDayCheckboxes);
            syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
            syncGpsMasterCheckbox();
            applyTrackDateFilter(allGpsDayCheckboxes, allGpsDayCheckboxes.some(c => c.checked));
          });

          const dayLabel = document.createElement('span');
          dayLabel.innerText = `Dzień: ${day}`;




















          leaf.appendChild(dayCheckbox);
          leaf.appendChild(dayLabel);
          monthChildren.appendChild(leaf);
        });

        monthHeader.checkbox.addEventListener('change', () => {
          const isChecked = monthHeader.checkbox.checked;
          monthHeader.checkbox.indeterminate = false;
          monthDayCheckboxes.forEach(cb => { cb.checked = isChecked; });
          syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
          syncGpsMasterCheckbox();
          applyTrackDateFilter(allGpsDayCheckboxes, allGpsDayCheckboxes.some(c => c.checked));
        });

        monthNode.appendChild(monthHeader.element);
        monthNode.appendChild(monthChildren);
        yearChildren.appendChild(monthNode);
      });

      yearHeader.checkbox.addEventListener('change', () => {
        const isChecked = yearHeader.checkbox.checked;
        yearHeader.checkbox.indeterminate = false;
        yearDayCheckboxes.forEach(cb => { cb.checked = isChecked; });
        yearChildren.querySelectorAll('.node-header input[type="checkbox"]').forEach(cb => {
          cb.checked = isChecked;
          cb.indeterminate = false;
        });
        syncGpsMasterCheckbox();
        applyTrackDateFilter(allGpsDayCheckboxes, allGpsDayCheckboxes.some(c => c.checked));
      });

      yearNode.appendChild(yearHeader.element);
      yearNode.appendChild(yearChildren);
      container.appendChild(yearNode);
    });

    syncGpsMasterCheckbox();
    applyTrackDateFilter(allGpsDayCheckboxes, false);

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

function clearSatelliteLayers() {
  activeSatelliteContext = null;
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
          <tr><td>Współrzędne</td><td>${Number(e.latitude).toFixed(6)}, ${Number(e.longitude).toFixed(6)}</td></tr>
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
  // Ślad GPS
  map.addSource('gps-track', {
    type: 'vector',
    tiles: [buildTrackTilesUrl('none')],
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
      'circle-color': '#06b6d4',
      'circle-radius': 4.5,
      'circle-stroke-width': 0,
      'circle-stroke-color': '#06b6d4',
      'circle-pitch-alignment': 'map',
      'circle-pitch-scale': 'viewport'
    }
  });

  map.on('click', 'GPS / Ślad trasy', (e) => {
    if (!e.features || !e.features.length) return;
    const feat = e.features[0];
    const epochId = feat.properties?.epoch_id;
    if (epochId) {
      loadPointFullDetails(epochId);
    }
  });

  map.on('mouseenter', 'GPS / Ślad trasy', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'GPS / Ślad trasy', () => {
    map.getCanvas().style.cursor = '';
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
