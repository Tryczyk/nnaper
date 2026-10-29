/**
 * playback-inline.js - Zintegrowany moduł Odtwarzacza Trasy (Playback) dla NNAPER
 * Uruchamiany bezpośrednio na głównej mapie (tile_map.html).
 * Wykorzystuje istniejące warstwy, style i mechanizmy 3D z tile_map.html.
 */

(function () {
  'use strict';

  const apiBaseUrl = (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

  let trackData = [];
  let availableDates = [];
  let currentIndex = 0;
  let isPlaying = false;
  let totalDistanceDayKm = 0;

  let virtualTime = 0;
  let lastWallClockTime = 0;
  let animFrameId = null;
  let carMarker = null;
  let isPlaybackActive = false;
  let activeFetchController = null;

  function getMap() {
    if (window.mapInstance && typeof window.mapInstance.getSource === 'function') {
      return window.mapInstance;
    }
    if (typeof map !== 'undefined' && map && typeof map.getSource === 'function') {
      return map;
    }
    if (window.map && typeof window.map.getSource === 'function') {
      return window.map;
    }
    return null;
  }

  // Elementy DOM
  const topBarEl = document.getElementById('playback-top-bar');
  const hudPanelEl = document.getElementById('playback-hud-panel');
  const bottomControlsEl = document.getElementById('playback-bottom-controls');

  const btnOpenPlayback = document.getElementById('btn-open-playback');
  const btnClosePlayback = document.getElementById('btn-close-playback');
  const dateSelect = document.getElementById('playback-date-select');
  const satViewSelect = document.getElementById('playback-sat-view');

  const hudTime = document.getElementById('playback-hud-time');
  const hudSpeed = document.getElementById('playback-hud-speed');
  const hudAltitude = document.getElementById('playback-hud-altitude');
  const hudGx = document.getElementById('playback-hud-gx');
  const hudGy = document.getElementById('playback-hud-gy');
  const hudGz = document.getElementById('playback-hud-gz');
  const hudDist = document.getElementById('playback-hud-dist');
  const hudAvgSpeed = document.getElementById('playback-hud-avg-speed');
  const hudProgressInfo = document.getElementById('playback-hud-progress-info');

  const slider = document.getElementById('playback-timeline-slider');
  const btnPlay = document.getElementById('btn-playback-play');
  const speedMultiplier = document.getElementById('playback-speed-multiplier');
  const chkFollow = document.getElementById('chk-playback-follow');

  function ensureSatelliteLayers() {
    const m = getMap();
    if (!m) return;

    if (!m.getSource('satellites-lines-source')) {
      m.addSource('satellites-lines-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }

    if (!m.getSource('satellites-points-source')) {
      m.addSource('satellites-points-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }

    if (!m.getLayer('playback-sat-lines')) {
      m.addLayer({
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

    if (!m.getLayer('playback-sat-points')) {
      m.addLayer({
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

    if (!m.getLayer('playback-sat-labels')) {
      m.addLayer({
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

  function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  function formatSensorValue(value) {
    if (value === null || value === undefined || value === '' || isNaN(Number(value))) {
      return '--';
    }
    const num = Number(value);
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toFixed(3)} G`;
  }

  function updateSatellitesDisplay(point) {
    const m = getMap();
    if (!m) return;
    const mode = satViewSelect ? satViewSelect.value : 'local';
    const linesSrc = m.getSource('satellites-lines-source');
    const ptsSrc = m.getSource('satellites-points-source');
    if (!linesSrc || !ptsSrc) return;

    if (mode === 'none' || !point || !point.satellites || !point.satellites.length) {
      linesSrc.setData({ type: 'FeatureCollection', features: [] });
      ptsSrc.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const lineFeatures = [];
    const pointFeatures = [];
    const pLon = point.lon;
    const pLat = point.lat;

    point.satellites.forEach(sat => {
      if (sat.azimuth === null || sat.azimuth === undefined) return;
      let sLon, sLat;
      if (mode === 'local') {
        const azRad = (sat.azimuth * Math.PI) / 180.0;
        const el = sat.elevation ?? 45;
        const dist = 0.045 * Math.cos((el * Math.PI) / 180.0);
        sLon = pLon + dist * Math.sin(azRad) * 1.5;
        sLat = pLat + dist * Math.cos(azRad);
      } else {
        const sub = computeSubSatellitePoint(pLon, pLat, sat.azimuth, sat.elevation || 0);
        sLon = sub.lon;
        sLat = sub.lat;
      }

      lineFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[pLon, pLat], [sLon, sLat]] }
      });
      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [sLon, sLat] },
        properties: { label: `PRN ${sat.prn}\n${sat.elevation || 0}°` }
      });
    });

    linesSrc.setData({ type: 'FeatureCollection', features: lineFeatures });
    ptsSrc.setData({ type: 'FeatureCollection', features: pointFeatures });
  }

  function renderCarAt(index, centerCamera = false) {
    const m = getMap();
    if (!trackData[index] || !m) return;
    const pt = trackData[index];

    if (!carMarker) {
      const el = document.createElement('div');
      el.className = 'car-marker';
      el.innerText = '🚗';
      carMarker = new maplibregl.Marker({ element: el }).setLngLat([pt.lon, pt.lat]).addTo(m);
    } else {
      carMarker.setLngLat([pt.lon, pt.lat]);
    }

    const d = new Date(pt.timestamp);
    if (hudTime) hudTime.innerText = isNaN(d.getTime()) ? (pt.timestamp || '--:--:--') : d.toTimeString().split(' ')[0];
    const spd = (pt.speed_kmh !== null && pt.speed_kmh !== undefined && !isNaN(Number(pt.speed_kmh)))
      ? Number(pt.speed_kmh).toFixed(1)
      : '0.0';
    if (hudSpeed) hudSpeed.innerText = `${spd} km/h`;
    if (hudAltitude) {
      hudAltitude.innerText = (pt.altitude === null || pt.altitude === undefined || isNaN(Number(pt.altitude)))
        ? '-- m'
        : `${Number(pt.altitude).toFixed(1)} m`;
    }
    if (hudGx) hudGx.innerText = formatSensorValue(pt.g_x);
    if (hudGy) hudGy.innerText = formatSensorValue(pt.g_y);
    if (hudGz) hudGz.innerText = formatSensorValue(pt.g_z);
    if (hudProgressInfo) hudProgressInfo.innerText = `${index + 1} / ${trackData.length} epok`;
    if (slider) slider.value = index;

    if (centerCamera || (chkFollow && chkFollow.checked)) {
      m.easeTo({ center: [pt.lon, pt.lat], duration: 50 });
    }

    updateSatellitesDisplay(pt);
  }

  async function loadDates() {
    if (!dateSelect) return;
    try {
      if (hudProgressInfo) hudProgressInfo.innerText = 'Pobieranie listy dat...';
      const res = await fetch(`${apiBaseUrl}/api/dates-tree`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tree = await res.json();
      availableDates = [];
      Object.keys(tree).sort().reverse().forEach(y => {
        Object.keys(tree[y]).sort().reverse().forEach(m => {
          tree[y][m].sort().reverse().forEach(d => {
            availableDates.push(`${y}-${m}-${d}`);
          });
        });
      });

      dateSelect.innerHTML = '';
      if (availableDates.length === 0) {
        dateSelect.innerHTML = '<option value="">Brak dostępnych tras</option>';
        if (hudProgressInfo) hudProgressInfo.innerText = 'Brak zarejestrowanych tras w bazie';
        return;
      }

      availableDates.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.innerText = d;
        dateSelect.appendChild(opt);
      });

      const params = new URLSearchParams(window.location.search);
      const urlDay = params.get('day');
      const defaultDay = (urlDay && availableDates.includes(urlDay)) ? urlDay : availableDates[0];

      dateSelect.value = defaultDay;
      await loadTrackForDay(defaultDay);
    } catch (e) {
      console.error('Błąd pobierania dat playback:', e);
      dateSelect.innerHTML = '<option>Błąd pobierania dat</option>';
      if (hudProgressInfo) hudProgressInfo.innerText = `Błąd API: ${e.message}`;
    }
  }

  async function loadTrackForDay(dayStr) {
    if (!dayStr) return;
    pausePlayback();

    if (activeFetchController) {
      activeFetchController.abort();
    }
    activeFetchController = new AbortController();
    const signal = activeFetchController.signal;

    if (hudProgressInfo) hudProgressInfo.innerText = `Ładowanie trasy dla ${dayStr}...`;
    if (btnPlay) btnPlay.disabled = true;

    try {
      const res = await fetch(`${apiBaseUrl}/api/playback-day?day=${encodeURIComponent(dayStr)}`, { signal });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || `HTTP ${res.status}`);
      }
      trackData = await res.json();
      currentIndex = 0;

      if (!trackData || !trackData.length) {
        if (hudProgressInfo) hudProgressInfo.innerText = `0 epok (brak danych dla ${dayStr})`;
        if (hudDist) hudDist.innerText = '0.00 km';
        if (hudAvgSpeed) hudAvgSpeed.innerText = '0.0 km/h';
        if (hudSpeed) hudSpeed.innerText = '0.0 km/h';
        if (hudAltitude) hudAltitude.innerText = '-- m';
        if (hudTime) hudTime.innerText = '--:--:--';
        if (hudGx) hudGx.innerText = '--';
        if (hudGy) hudGy.innerText = '--';
        if (hudGz) hudGz.innerText = '--';
        if (slider) {
          slider.max = 0;
          slider.value = 0;
        }
        if (carMarker) {
          carMarker.remove();
          carMarker = null;
        }
        const m = getMap();
        const linesSrc = m?.getSource('satellites-lines-source');
        const ptsSrc = m?.getSource('satellites-points-source');
        if (linesSrc) linesSrc.setData({ type: 'FeatureCollection', features: [] });
        if (ptsSrc) ptsSrc.setData({ type: 'FeatureCollection', features: [] });
        return;
      }

      totalDistanceDayKm = 0;
      let speedSum = 0;
      for (let i = 0; i < trackData.length; i++) {
        speedSum += (trackData[i].speed_kmh || 0);
        if (i > 0) {
          totalDistanceDayKm += getDistanceKm(trackData[i - 1].lat, trackData[i - 1].lon, trackData[i].lat, trackData[i].lon);
        }
      }
      const avgSpeed = (speedSum / trackData.length).toFixed(1);
      if (hudDist) hudDist.innerText = `${totalDistanceDayKm.toFixed(2)} km`;
      if (hudAvgSpeed) hudAvgSpeed.innerText = `${avgSpeed} km/h`;

      if (slider) {
        slider.max = trackData.length - 1;
        slider.value = 0;
      }

      virtualTime = new Date(trackData[0].timestamp).getTime();

      const m = getMap();
      if (m) {
        m.flyTo({
          center: [trackData[0].lon, trackData[0].lat],
          zoom: 16,
          pitch: 50,
          essential: true
        });
      }

      renderCarAt(0, true);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Szczegóły błędu pobierania trasy playback:', err);
      if (hudProgressInfo) hudProgressInfo.innerText = `Błąd API: ${err.message}`;
    } finally {
      if (btnPlay) btnPlay.disabled = false;
    }
  }

  function playbackLoop(now) {
    if (!isPlaying) return;

    const deltaWallClock = now - lastWallClockTime;
    lastWallClockTime = now;

    const mult = speedMultiplier ? parseFloat(speedMultiplier.value) : 60;
    virtualTime += deltaWallClock * mult;

    let targetIndex = currentIndex;
    while (targetIndex < trackData.length - 1) {
      const nextPtTime = new Date(trackData[targetIndex + 1].timestamp).getTime();
      const currPtTime = new Date(trackData[targetIndex].timestamp).getTime();

      if ((nextPtTime - currPtTime) > (5 * 60 * 1000) && virtualTime < nextPtTime) {
        virtualTime = nextPtTime;
      }

      if (virtualTime >= nextPtTime) {
        targetIndex++;
      } else {
        break;
      }
    }

    if (targetIndex !== currentIndex) {
      currentIndex = targetIndex;
      renderCarAt(currentIndex);
    }

    if (currentIndex >= trackData.length - 1) {
      pausePlayback();
      if (hudProgressInfo) hudProgressInfo.innerText = `Koniec trasy (${trackData.length} epok)`;
      return;
    }

    animFrameId = requestAnimationFrame(playbackLoop);
  }

  function startPlayback() {
    if (!trackData.length) return;
    if (currentIndex >= trackData.length - 1) {
      currentIndex = 0;
      virtualTime = new Date(trackData[0].timestamp).getTime();
      renderCarAt(0, true);
    }
    isPlaying = true;
    lastWallClockTime = performance.now();
    if (btnPlay) btnPlay.innerText = '⏸ Pauza';
    animFrameId = requestAnimationFrame(playbackLoop);
  }

  function pausePlayback() {
    isPlaying = false;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (btnPlay) btnPlay.innerText = '▶ Odtwarzaj';
    if (trackData[currentIndex]) updateSatellitesDisplay(trackData[currentIndex]);
  }

  function openPlaybackMode() {
    if (isPlaybackActive) return;
    isPlaybackActive = true;

    // Zamknięcie innych paneli, aby nie zasłaniały widoku
    if (typeof window.collapseRightMenu === 'function') window.collapseRightMenu();
    const routePlanner = document.getElementById('route-planner-panel');
    if (routePlanner && routePlanner.classList.contains('active')) {
      const btnRouteClose = document.getElementById('btn-route-close');
      if (btnRouteClose) btnRouteClose.click();
    }
    const pointPanel = document.getElementById('point-panel');
    if (pointPanel) pointPanel.classList.remove('active');

    document.body.classList.add('playback-mode');
    if (topBarEl) topBarEl.style.display = 'flex';
    if (hudPanelEl) hudPanelEl.style.display = 'flex';
    if (bottomControlsEl) bottomControlsEl.style.display = 'flex';

    ensureSatelliteLayers();

    const m = getMap();
    if (m && typeof m.getPitch === 'function' && m.getPitch() < 30) {
      m.easeTo({ pitch: 50, duration: 600 });
    }

    if (availableDates.length === 0) {
      loadDates();
    } else if (dateSelect && dateSelect.value) {
      loadTrackForDay(dateSelect.value);
    }
  }

  function closePlaybackMode() {
    if (!isPlaybackActive) return;
    isPlaybackActive = false;

    pausePlayback();
    document.body.classList.remove('playback-mode');

    if (topBarEl) topBarEl.style.display = 'none';
    if (hudPanelEl) hudPanelEl.style.display = 'none';
    if (bottomControlsEl) bottomControlsEl.style.display = 'none';

    if (carMarker) {
      carMarker.remove();
      carMarker = null;
    }

    const m = getMap();
    if (m && typeof m.getSource === 'function') {
      const linesSrc = m.getSource('satellites-lines-source');
      const ptsSrc = m.getSource('satellites-points-source');
      if (linesSrc) linesSrc.setData({ type: 'FeatureCollection', features: [] });
      if (ptsSrc) ptsSrc.setData({ type: 'FeatureCollection', features: [] });

      // Sprawdzenie czy mapa 3D jest włączona w konfiguracji; jeśli nie, wyrównaj pitch
      const cfg = window.LayerManager?.getStoredConfig?.() || {};
      if (!cfg.settings3D?.map3D && typeof m.getPitch === 'function' && m.getPitch() > 0) {
        m.easeTo({ pitch: 0, duration: 600 });
      }
    }
  }

  // Podpięcie zdarzeń
  if (btnOpenPlayback) {
    btnOpenPlayback.addEventListener('click', openPlaybackMode);
  }

  if (btnClosePlayback) {
    btnClosePlayback.addEventListener('click', closePlaybackMode);
  }

  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (isPlaying) pausePlayback();
      else startPlayback();
    });
  }

  if (slider) {
    slider.addEventListener('input', (e) => {
      pausePlayback();
      currentIndex = parseInt(e.target.value, 10);
      if (trackData[currentIndex]) {
        virtualTime = new Date(trackData[currentIndex].timestamp).getTime();
        renderCarAt(currentIndex, true);
      }
    });
  }

  if (dateSelect) {
    dateSelect.addEventListener('change', (e) => {
      loadTrackForDay(e.target.value);
    });
  }

  if (satViewSelect) {
    satViewSelect.addEventListener('change', () => {
      if (trackData[currentIndex]) updateSatellitesDisplay(trackData[currentIndex]);
    });
  }

  // Automatyczny start przy parametrze URL ?mode=playback
  function checkUrlForPlaybackMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'playback' || params.get('playback') === '1') {
      openPlaybackMode();
    }
  }

  function initPlaybackWhenReady() {
    const m = getMap();
    if (!m) {
      setTimeout(initPlaybackWhenReady, 100);
      return;
    }

    const onMapLoaded = () => {
      ensureSatelliteLayers();
      checkUrlForPlaybackMode();
    };

    const isLoaded = (typeof m.loaded === 'function' ? m.loaded() : (typeof m.isStyleLoaded === 'function' ? m.isStyleLoaded() : false));
    if (isLoaded) {
      onMapLoaded();
    } else {
      m.once('load', onMapLoaded);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPlaybackWhenReady);
  } else {
    initPlaybackWhenReady();
  }

  window.openPlaybackMode = openPlaybackMode;
  window.closePlaybackMode = closePlaybackMode;

})();
