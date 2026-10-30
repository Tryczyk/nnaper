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

  // Elementy DOM głównego UI Playback
  const topBarEl = document.getElementById('playback-top-bar');
  const hudPanelEl = document.getElementById('playback-hud-panel');
  const bottomControlsEl = document.getElementById('playback-bottom-controls');

  const btnOpenPlayback = document.getElementById('btn-open-playback');
  const btnClosePlayback = document.getElementById('btn-close-playback');
  const selYear = document.getElementById('playback-sel-year');
  const selMonth = document.getElementById('playback-sel-month');
  const selDay = document.getElementById('playback-sel-day');
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

  // Elementy DOM dolnego panelu wykresów (Wysokość, Przeciążenia G, Diagram G-G)
  const chartPanelEl = document.getElementById('playback-chart-panel');
  const chartCanvas = document.getElementById('playback-chart-canvas');
  const btnToggleChart = document.getElementById('btn-toggle-playback-chart');

  const tabBtnAlt = document.getElementById('playback-tab-btn-alt');
  const tabBtnGg = document.getElementById('playback-tab-btn-gg');

  const legendAlt = document.getElementById('playback-chart-legend-alt');
  const legendGg = document.getElementById('playback-chart-legend-gg');

  const valAlt = document.getElementById('playback-val-alt');
  const altMinMaxInfo = document.getElementById('playback-alt-minmax-info');

  const valGgMaxLat = document.getElementById('playback-val-gg-max-lat');
  const valGgMaxLon = document.getElementById('playback-val-gg-max-lon');
  const valGgCurr = document.getElementById('playback-val-gg-curr');

  // Stan wykresów dolnych
  let currentChartTab = 'alt'; // 'alt' | 'gg'
  let isChartCollapsed = false;
  let seriesVisible = { gx: true, gy: true, gz: true, gmag: false };
  let chartStats = {
    minAlt: 0,
    maxAlt: 100,
    minAltIdx: 0,
    maxAltIdx: 0,
    minG: -1.0,
    maxG: 1.0,
    maxLatG: 0,
    maxLonG: 0
  };

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

  // Obliczenie statystyk dla dolnego panelu wykresów
  function computePlaybackStats() {
    if (!trackData || !trackData.length) return;

    let minA = Infinity;
    let maxA = -Infinity;
    let minAIdx = 0;
    let maxAIdx = 0;

    let minG = -0.5;
    let maxG = 0.5;
    let maxLat = 0;
    let maxLon = 0;

    for (let i = 0; i < trackData.length; i++) {
      const p = trackData[i];
      if (p.altitude !== null && p.altitude !== undefined && !isNaN(Number(p.altitude))) {
        const a = Number(p.altitude);
        if (a < minA) { minA = a; minAIdx = i; }
        if (a > maxA) { maxA = a; maxAIdx = i; }
      }

      const gx = (p.g_x !== null && p.g_x !== undefined && !isNaN(Number(p.g_x))) ? Number(p.g_x) : null;
      const gy = (p.g_y !== null && p.g_y !== undefined && !isNaN(Number(p.g_y))) ? Number(p.g_y) : null;
      const gz = (p.g_z !== null && p.g_z !== undefined && !isNaN(Number(p.g_z))) ? Number(p.g_z) : null;

      if (gx !== null) {
        if (gx < minG) minG = gx;
        if (gx > maxG) maxG = gx;
        const absX = Math.abs(gx);
        if (absX > maxLon) maxLon = absX;
      }
      if (gy !== null) {
        if (gy < minG) minG = gy;
        if (gy > maxG) maxG = gy;
        const absY = Math.abs(gy);
        if (absY > maxLat) maxLat = absY;
      }
      if (gz !== null) {
        if (gz < minG) minG = gz;
        if (gz > maxG) maxG = gz;
      }
    }

    if (!isFinite(minA) || !isFinite(maxA)) {
      minA = 0; maxA = 100; minAIdx = 0; maxAIdx = 0;
    } else if (maxA - minA < 10) {
      maxA = minA + 10;
    }

    chartStats = {
      minAlt: minA,
      maxAlt: maxA,
      minAltIdx: minAIdx,
      maxAltIdx: maxAIdx,
      minG: Math.min(-0.5, Math.floor(minG * 10) / 10),
      maxG: Math.max(0.5, Math.ceil(maxG * 10) / 10),
      maxLatG: maxLat,
      maxLonG: maxLon
    };

    if (altMinMaxInfo) {
      altMinMaxInfo.innerText = `(Min: ${minA.toFixed(0)}m, Max: ${maxA.toFixed(0)}m)`;
    }
    if (valGgMaxLat) {
      valGgMaxLat.innerText = `${maxLat.toFixed(2)} G`;
    }
    if (valGgMaxLon) {
      valGgMaxLon.innerText = `${maxLon.toFixed(2)} G`;
    }
  }

  // Pobranie skalowanego kontekstu Canvas dla ostrych wykresów Retina / HiDPI
  function getChartCanvasContext() {
    if (!chartCanvas) return null;
    const rect = chartCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const expectedW = Math.round(rect.width * dpr);
    const expectedH = Math.round(rect.height * dpr);
    if (chartCanvas.width !== expectedW || chartCanvas.height !== expectedH) {
      chartCanvas.width = expectedW;
      chartCanvas.height = expectedH;
    }
    const ctx = chartCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    return { ctx, width: rect.width, height: rect.height };
  }

  // 1. Profil wysokości z oznaczeniami MIN i MAX oraz kursorem
  function drawPlaybackAltChart(currIdx) {
    const c = getChartCanvasContext();
    if (!c) return;
    const { ctx, width: W, height: H } = c;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, W, H);

    if (!trackData || trackData.length < 2) return;

    const pad = { top: 18, bottom: 20, left: 45, right: 30 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    if (plotW <= 10 || plotH <= 10) return;

    const { minAlt, maxAlt, minAltIdx, maxAltIdx } = chartStats;
    const altRange = Math.max(1, maxAlt - minAlt);

    // Poziome linie siatki i etykiety wysokości
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const steps = 3;
    for (let s = 0; s <= steps; s++) {
      const y = pad.top + (s / steps) * plotH;
      const altVal = maxAlt - (s / steps) * altRange;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillText(`${altVal.toFixed(0)}m`, pad.left - 6, y);
    }

    const N = trackData.length;
    const getX = (i) => pad.left + (i / (N - 1)) * plotW;
    const getY = (alt) => {
      const a = (alt !== null && alt !== undefined && !isNaN(Number(alt))) ? Number(alt) : minAlt;
      return pad.top + (1 - (a - minAlt) / altRange) * plotH;
    };

    // Wypełnienie pod krzywą profilu
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.28)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    ctx.beginPath();
    ctx.moveTo(getX(0), pad.top + plotH);
    for (let i = 0; i < N; i++) {
      ctx.lineTo(getX(i), getY(trackData[i].altitude));
    }
    ctx.lineTo(getX(N - 1), pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Główna linia wysokości
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = getX(i);
      const y = getY(trackData[i].altitude);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Oznaczenia minimów i maksimów wysokości
    function drawAltBadge(idx, text, isMax) {
      if (idx < 0 || idx >= N) return;
      const pt = trackData[idx];
      const x = getX(idx);
      const y = getY(pt.altitude);

      ctx.fillStyle = isMax ? '#38bdf8' : '#f43f5e';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      const textW = ctx.measureText(text).width;
      const badgeW = textW + 10;
      const badgeH = 15;
      let badgeX = Math.max(pad.left, Math.min(W - pad.right - badgeW, x - badgeW / 2));
      let badgeY = isMax ? (y - badgeH - 5) : (y + 5);
      if (badgeY < 2) badgeY = y + 5;
      if (badgeY + badgeH > H - 2) badgeY = y - badgeH - 5;

      ctx.fillStyle = isMax ? 'rgba(2, 132, 199, 0.92)' : 'rgba(225, 29, 72, 0.92)';
      ctx.strokeStyle = isMax ? '#38bdf8' : '#fda4af';
      ctx.lineWidth = 1;

      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, badgeX + badgeW / 2, badgeY + badgeH / 2);
    }

    if (minAltIdx !== maxAltIdx) {
      drawAltBadge(maxAltIdx, `▲ MAX ${maxAlt.toFixed(0)}m`, true);
      drawAltBadge(minAltIdx, `▼ MIN ${minAlt.toFixed(0)}m`, false);
    } else {
      drawAltBadge(maxAltIdx, `▲ ${maxAlt.toFixed(0)}m`, true);
    }

    // Kursor bieżącej pozycji odtwarzania
    if (currIdx >= 0 && currIdx < N) {
      const curX = getX(currIdx);
      const curY = getY(trackData[currIdx].altitude);

      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(curX, pad.top);
      ctx.lineTo(curX, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(curX, curY, 4.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(curX, curY, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 2. Wykres osi przeciążeń G w czasie (Gx, Gy, Gz, |G|)
  function drawPlaybackGForceTimeline(currIdx) {
    const c = getChartCanvasContext();
    if (!c) return;
    const { ctx, width: W, height: H } = c;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, W, H);

    if (!trackData || trackData.length < 2) return;

    const pad = { top: 16, bottom: 20, left: 45, right: 30 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    if (plotW <= 10 || plotH <= 10) return;

    const { minG, maxG } = chartStats;
    const gRange = Math.max(0.2, maxG - minG);

    // Linia pozioma 0G
    const zeroY = pad.top + (1 - (0 - minG) / gRange) * plotH;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(W - pad.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Siatka i etykiety G
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const gSteps = [minG, 0, maxG];
    gSteps.forEach(gVal => {
      const y = pad.top + (1 - (gVal - minG) / gRange) * plotH;
      if (Math.abs(y - zeroY) > 6) {
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(W - pad.right, y);
        ctx.stroke();
      }
      ctx.fillText(`${gVal > 0 ? '+' : ''}${gVal.toFixed(1)}G`, pad.left - 6, y);
    });

    const N = trackData.length;
    const getX = (i) => pad.left + (i / (N - 1)) * plotW;
    const getGY = (val) => {
      const v = (val !== null && val !== undefined && !isNaN(Number(val))) ? Number(val) : 0;
      return pad.top + (1 - (v - minG) / gRange) * plotH;
    };

    function drawGLine(prop, color) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < N; i++) {
        let val;
        if (prop === 'mag') {
          const gx = Number(trackData[i].g_x || 0);
          const gy = Number(trackData[i].g_y || 0);
          const gz = Number(trackData[i].g_z || 0);
          val = Math.sqrt(gx * gx + gy * gy + gz * gz);
        } else {
          val = trackData[i][prop];
        }
        if (val !== null && val !== undefined && !isNaN(Number(val))) {
          const x = getX(i);
          const y = getGY(val);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    if (seriesVisible.gx) drawGLine('g_x', '#38bdf8');
    if (seriesVisible.gy) drawGLine('g_y', '#f59e0b');
    if (seriesVisible.gz) drawGLine('g_z', '#c084fc');
    if (seriesVisible.gmag) drawGLine('mag', '#10b981');

    // Kursor i punkty przecięcia
    if (currIdx >= 0 && currIdx < N) {
      const curX = getX(currIdx);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(curX, pad.top);
      ctx.lineTo(curX, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      const pt = trackData[currIdx];
      const dots = [];
      if (seriesVisible.gx && pt.g_x !== null && pt.g_x !== undefined) dots.push({ y: getGY(pt.g_x), color: '#38bdf8' });
      if (seriesVisible.gy && pt.g_y !== null && pt.g_y !== undefined) dots.push({ y: getGY(pt.g_y), color: '#f59e0b' });
      if (seriesVisible.gz && pt.g_z !== null && pt.g_z !== undefined) dots.push({ y: getGY(pt.g_z), color: '#c084fc' });
      if (seriesVisible.gmag) {
        const mag = Math.sqrt(Math.pow(Number(pt.g_x || 0), 2) + Math.pow(Number(pt.g_y || 0), 2) + Math.pow(Number(pt.g_z || 0), 2));
        dots.push({ y: getGY(mag), color: '#10b981' });
      }

      dots.forEach(d => {
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(curX, d.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }
  }

  // 3. Koło tarcia (Diagram G-G) z chmurą punktów całej trasy i wektorem na żywo
  function drawPlaybackGGFrictionCircle(currIdx) {
    const c = getChartCanvasContext();
    if (!c) return;
    const { ctx, width: W, height: H } = c;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;
    const maxR = Math.min(cx - 30, cy - 12, 48);
    const maxScale = Math.max(1.0, Math.ceil(Math.max(chartStats.maxLatG, chartStats.maxLonG) * 2) / 2);

    // Okręgi skali (np. 0.5G, 1.0G, ewentualnie maxScale)
    const circles = [0.5, 1.0];
    if (maxScale > 1.0) circles.push(maxScale);

    ctx.lineWidth = 1;
    circles.forEach(gVal => {
      const r = (gVal / maxScale) * maxR;
      ctx.strokeStyle = (gVal === 1.0) ? '#334155' : '#1e293b';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${gVal.toFixed(1)}G`, cx + r + 2, cy - 2);
    });

    // Osie krzyżowe
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - maxR - 10, cy); ctx.lineTo(cx + maxR + 10, cy);
    ctx.moveTo(cx, cy - maxR - 8); ctx.lineTo(cx, cy + maxR + 8);
    ctx.stroke();

    // Etykiety kierunków (bez cyfr)
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('PRZYSPIESZENIE (ACC)', cx, cy - maxR - 10);
    ctx.textBaseline = 'bottom';
    ctx.fillText('HAMOWANIE (BRK)', cx, cy + maxR + 10);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText('LEWO (L)', cx - maxR - 14, cy);
    ctx.textAlign = 'left';
    ctx.fillText('PRAWO (R)', cx + maxR + 14, cy);

    if (!trackData || !trackData.length) return;

    // Chmura punktów całej trasy
    ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
    for (let i = 0; i < trackData.length; i += 2) {
      const pt = trackData[i];
      if (pt.g_x !== null && pt.g_x !== undefined && pt.g_y !== null && pt.g_y !== undefined) {
        const gx = Number(pt.g_x);
        const gy = Number(pt.g_y);
        const dotX = cx + (gy / maxScale) * maxR;
        const dotY = cy - (gx / maxScale) * maxR;
        ctx.fillRect(dotX - 1, dotY - 1, 2, 2);
      }
    }

    // Bieżący wektor i punkt przeciążenia
    const curr = trackData[currIdx];
    if (curr && curr.g_x !== null && curr.g_x !== undefined && curr.g_y !== null && curr.g_y !== undefined) {
      const gx = Number(curr.g_x);
      const gy = Number(curr.g_y);
      const dotX = cx + (gy / maxScale) * maxR;
      const dotY = cy - (gx / maxScale) * maxR;

      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(dotX, dotY);
      ctx.stroke();

      const grad = ctx.createRadialGradient(dotX, dotY, 1, dotX, dotY, 8);
      grad.addColorStop(0, '#ef4444');
      grad.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Odświeżenie danych i wywołanie aktywnego widoku wykresu
  function updatePlaybackChart(currIdx) {
    if (!trackData || !trackData.length || currIdx < 0 || currIdx >= trackData.length) return;
    const pt = trackData[currIdx];

    if (valAlt) {
      valAlt.innerText = (pt.altitude !== null && pt.altitude !== undefined && !isNaN(Number(pt.altitude)))
        ? `${Number(pt.altitude).toFixed(1)} m`
        : '-- m';
    }

    if (valGgCurr) {
      const gx = (pt.g_x !== null && pt.g_x !== undefined && !isNaN(Number(pt.g_x))) ? Number(pt.g_x) : 0;
      const gy = (pt.g_y !== null && pt.g_y !== undefined && !isNaN(Number(pt.g_y))) ? Number(pt.g_y) : 0;
      valGgCurr.innerText = `Gx: ${gx >= 0 ? '+' : ''}${gx.toFixed(2)}G, Gy: ${gy >= 0 ? '+' : ''}${gy.toFixed(2)}G`;
    }

    if (isChartCollapsed) return;

    if (currentChartTab === 'alt') {
      drawPlaybackAltChart(currIdx);
    } else if (currentChartTab === 'gg') {
      drawPlaybackGGFrictionCircle(currIdx);
    }
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

    drawPlaybackHudGG(pt);
    updatePlaybackChart(index);
    updateSatellitesDisplay(pt);
  }

  function drawPlaybackHudGG(pt) {
    const hudCanvas = document.getElementById('playback-hud-gg-canvas');
    if (!hudCanvas) return;
    const ctx = hudCanvas.getContext('2d');
    const W = hudCanvas.width, H = hudCanvas.height;
    const cx = W / 2, cy = H / 2;
    const r = 31;

    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, W, H);

    // Okręgi 0.5G i 1.0G
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Krzyżyk środka
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    // Oznaczenia bez cyfr
    ctx.fillStyle = '#64748b';
    ctx.font = '7.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('ACC', cx, 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText('BRK', cx, H - 2);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('L', 3, cy);
    ctx.textAlign = 'right';
    ctx.fillText('R', W - 3, cy);

    // Bieżący wektor przeciążenia
    if (pt && pt.g_x !== null && pt.g_x !== undefined && pt.g_y !== null && pt.g_y !== undefined) {
      const maxScale = 1.2;
      const gx = Math.max(-maxScale, Math.min(maxScale, Number(pt.g_x)));
      const gy = Math.max(-maxScale, Math.min(maxScale, Number(pt.g_y)));

      const dotX = cx + (gy / maxScale) * r;
      const dotY = cy - (gx / maxScale) * r;

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(dotX, dotY);
      ctx.stroke();

      const grad = ctx.createRadialGradient(dotX, dotY, 1, dotX, dotY, 6);
      grad.addColorStop(0, '#38bdf8');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(dotX, dotY, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let datesTree = null;
  const MONTH_NAMES = {
    '01': 'Styczeń', '02': 'Luty', '03': 'Marzec', '04': 'Kwiecień',
    '05': 'Maj', '06': 'Czerwiec', '07': 'Lipiec', '08': 'Sierpień',
    '09': 'Wrzesień', '10': 'Październik', '11': 'Listopad', '12': 'Grudzień'
  };

  function getSelectedPlaybackDay() {
    if (selYear && selMonth && selDay && selYear.value && selMonth.value && selDay.value) {
      return `${selYear.value}-${selMonth.value}-${selDay.value}`;
    }
    if (dateSelect && dateSelect.value) {
      return dateSelect.value;
    }
    return '';
  }

  function updatePlaybackDays(preselectDay = null) {
    if (!selYear || !selMonth || !selDay || !datesTree) return;
    const y = selYear.value;
    const m = selMonth.value;
    const days = (y && m && datesTree[y] && datesTree[y][m])
      ? [...datesTree[y][m]].sort().reverse()
      : [];

    selDay.innerHTML = days.length ? '' : '<option value="">Brak dni</option>';
    days.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.innerText = d;
      selDay.appendChild(opt);
    });

    if (preselectDay) {
      const dPad = String(preselectDay).padStart(2, '0');
      if (days.includes(dPad)) selDay.value = dPad;
    } else if (days.length > 0) {
      selDay.value = days[0];
    }
  }

  function updatePlaybackMonths(preselectMonth = null, preselectDay = null) {
    if (!selYear || !selMonth || !datesTree) return;
    const y = selYear.value;
    const months = (y && datesTree[y]) ? Object.keys(datesTree[y]).sort().reverse() : [];

    selMonth.innerHTML = months.length ? '' : '<option value="">Brak</option>';
    months.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.innerText = `${m} - ${MONTH_NAMES[m] || m}`;
      selMonth.appendChild(opt);
    });

    if (preselectMonth) {
      const mPad = String(preselectMonth).padStart(2, '0');
      if (months.includes(mPad)) selMonth.value = mPad;
    } else if (months.length > 0) {
      selMonth.value = months[0];
    }

    updatePlaybackDays(preselectDay);
  }

  function updatePlaybackYears(preselectYear = null, preselectMonth = null, preselectDay = null) {
    if (!selYear || !datesTree) return;
    const years = Object.keys(datesTree).sort().reverse();

    selYear.innerHTML = years.length ? '' : '<option value="">Brak lat</option>';
    years.forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.innerText = y;
      selYear.appendChild(opt);
    });

    if (preselectYear && years.includes(String(preselectYear))) {
      selYear.value = String(preselectYear);
    } else if (years.length > 0) {
      selYear.value = years[0];
    }

    updatePlaybackMonths(preselectMonth, preselectDay);
  }

  async function loadDates() {
    try {
      if (hudProgressInfo) hudProgressInfo.innerText = 'Pobieranie listy dat...';
      const res = await fetch(`${apiBaseUrl}/api/dates-tree`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      datesTree = await res.json();
      availableDates = [];
      Object.keys(datesTree).sort().reverse().forEach(y => {
        Object.keys(datesTree[y]).sort().reverse().forEach(m => {
          datesTree[y][m].sort().reverse().forEach(d => {
            availableDates.push(`${y}-${m}-${d}`);
          });
        });
      });

      if (availableDates.length === 0) {
        if (dateSelect) dateSelect.innerHTML = '<option value="">Brak dostępnych tras</option>';
        if (selDay) selDay.innerHTML = '<option value="">Brak tras</option>';
        if (hudProgressInfo) hudProgressInfo.innerText = 'Brak zarejestrowanych tras w bazie';
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const urlDay = params.get('day');
      const defaultDay = (urlDay && availableDates.includes(urlDay)) ? urlDay : availableDates[0];
      const [initY, initM, initD] = defaultDay.split('-');

      if (selYear && selMonth && selDay) {
        updatePlaybackYears(initY, initM, initD);
      }

      if (dateSelect) {
        dateSelect.innerHTML = '';
        availableDates.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d;
          opt.innerText = d;
          dateSelect.appendChild(opt);
        });
        dateSelect.value = defaultDay;
      }

      await loadTrackForDay(defaultDay);
    } catch (e) {
      console.error('Błąd pobierania dat playback:', e);
      if (dateSelect) dateSelect.innerHTML = '<option>Błąd pobierania dat</option>';
      if (selDay) selDay.innerHTML = '<option>Błąd</option>';
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

      computePlaybackStats();

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

    const parsedMult = speedMultiplier ? parseFloat(speedMultiplier.value) : 60;
    const mult = (!isNaN(parsedMult) && parsedMult > 0) ? parsedMult : 60;
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
    if (chartPanelEl) chartPanelEl.style.display = 'flex';

    ensureSatelliteLayers();

    const m = getMap();
    if (m && typeof m.getPitch === 'function' && m.getPitch() < 30) {
      m.easeTo({ pitch: 50, duration: 600 });
    }

    if (availableDates.length === 0) {
      loadDates();
    } else {
      const selectedDay = getSelectedPlaybackDay();
      if (selectedDay) {
        loadTrackForDay(selectedDay);
      } else if (trackData.length > 0) {
        computePlaybackStats();
        updatePlaybackChart(currentIndex);
      }
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
    if (chartPanelEl) chartPanelEl.style.display = 'none';

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

      const cfg = window.LayerManager?.getStoredConfig?.() || {};
      if (!cfg.settings3D?.map3D && typeof m.getPitch === 'function' && m.getPitch() > 0) {
        m.easeTo({ pitch: 0, duration: 600 });
      }
    }
  }

  // Interaktywna obsługa przewijania osi czasu przez kliknięcie/przeciągnięcie po Canvas
  function initChartCanvasInteraction() {
    if (!chartCanvas) return;
    let isDragging = false;

    function handleSeek(e) {
      if (!trackData || trackData.length < 2) return;
      if (currentChartTab === 'gg') return;

      const rect = chartCanvas.getBoundingClientRect();
      const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const relX = clientX - rect.left;

      const padLeft = 45;
      const padRight = 30;
      const plotW = rect.width - padLeft - padRight;
      if (plotW <= 0) return;

      const clampedX = Math.max(0, Math.min(plotW, relX - padLeft));
      const ratio = clampedX / plotW;
      const newIdx = Math.round(ratio * (trackData.length - 1));

      if (newIdx !== currentIndex && newIdx >= 0 && newIdx < trackData.length) {
        pausePlayback();
        currentIndex = newIdx;
        virtualTime = new Date(trackData[currentIndex].timestamp).getTime();
        renderCarAt(currentIndex, true);
      }
    }

    chartCanvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      handleSeek(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) handleSeek(e);
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    chartCanvas.addEventListener('touchstart', (e) => {
      isDragging = true;
      handleSeek(e);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (isDragging) handleSeek(e);
    }, { passive: true });

    window.addEventListener('touchend', () => {
      isDragging = false;
    });
  }

  // Obsługa zakładek wykresów oraz zwijania panelu (Profil wysokości, Diagram G-G)
  function initChartControls() {
    function setChartTab(tab) {
      currentChartTab = tab;
      [tabBtnAlt, tabBtnGg].forEach(b => b?.classList.remove('active'));
      [legendAlt, legendGg].forEach(l => { if (l) l.style.display = 'none'; });

      if (tab === 'alt') {
        tabBtnAlt?.classList.add('active');
        if (legendAlt) legendAlt.style.display = 'flex';
      } else if (tab === 'gg') {
        tabBtnGg?.classList.add('active');
        if (legendGg) legendGg.style.display = 'flex';
      }
      updatePlaybackChart(currentIndex);
    }

    if (tabBtnAlt) tabBtnAlt.addEventListener('click', () => setChartTab('alt'));
    if (tabBtnGg) tabBtnGg.addEventListener('click', () => setChartTab('gg'));

    if (btnToggleChart) {
      btnToggleChart.addEventListener('click', () => {
        isChartCollapsed = !isChartCollapsed;
        if (chartPanelEl) {
          chartPanelEl.classList.toggle('collapsed', isChartCollapsed);
        }
        if (bottomControlsEl) {
          bottomControlsEl.classList.toggle('chart-collapsed', isChartCollapsed);
        }
        document.body.classList.toggle('chart-collapsed', isChartCollapsed);
        btnToggleChart.innerText = isChartCollapsed ? '▴' : '▾';
        btnToggleChart.title = isChartCollapsed ? 'Rozwiń wykres' : 'Zwiń wykres';

        if (!isChartCollapsed) {
          setTimeout(() => updatePlaybackChart(currentIndex), 60);
        }
      });
    }

    initChartCanvasInteraction();

    window.addEventListener('resize', () => {
      if (isPlaybackActive && !isChartCollapsed) {
        updatePlaybackChart(currentIndex);
      }
    });
  }

  // Podpięcie zdarzeń głównych
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

  if (selYear) {
    selYear.addEventListener('change', () => {
      updatePlaybackMonths();
      const currentDay = getSelectedPlaybackDay();
      if (currentDay) loadTrackForDay(currentDay);
    });
  }
  if (selMonth) {
    selMonth.addEventListener('change', () => {
      updatePlaybackDays();
      const currentDay = getSelectedPlaybackDay();
      if (currentDay) loadTrackForDay(currentDay);
    });
  }
  if (selDay) {
    selDay.addEventListener('change', () => {
      const currentDay = getSelectedPlaybackDay();
      if (currentDay) loadTrackForDay(currentDay);
    });
  }
  if (dateSelect) {
    dateSelect.addEventListener('change', (e) => {
      if (e.target.value) loadTrackForDay(e.target.value);
    });
  }

  if (speedMultiplier) {
    const onSpeedChange = () => {
      lastWallClockTime = performance.now();
      if (trackData[currentIndex]) {
        virtualTime = new Date(trackData[currentIndex].timestamp).getTime();
      }
    };
    speedMultiplier.addEventListener('input', onSpeedChange);
    speedMultiplier.addEventListener('change', onSpeedChange);
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
    initChartControls();

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
