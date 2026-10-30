/**
 * export-manager.js - Zaawansowany moduł eksportu tras telemetrycznych dla NNAPER
 * Obsługuje eksport danych z danego dnia, miesiąca, roku lub całej bazy
 * do formatów: HTML (interaktywny standalone), PNG (obraz HD), SVG (wektor),
 * GIF (animacja przejazdu), GPX, CSV, GeoJSON, KML.
 */

(function () {
  'use strict';

  const apiBaseUrl = (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

  // -------------------------------------------------------------
  // 1. PURE JAVASCRIPT GIF89a ENCODER (LZW + PALETTE)
  // -------------------------------------------------------------
  class SimpleGifEncoder {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.frames = [];
      this.palette = [];
      this.colorMap = new Map();
    }

    addFrame(canvas, delayMs = 100) {
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, this.width, this.height);
      this.frames.push({
        data: imgData.data,
        delay: Math.max(2, Math.round(delayMs / 10)) // w setnych częściach sekundy
      });
    }

    // Buduje wspólną paletę maksymalnie 256 kolorów
    buildPalette() {
      const colorCounts = new Map();

      // Próbkowanie pikseli ze wszystkich klatek
      for (let f = 0; f < this.frames.length; f++) {
        const d = this.frames[f].data;
        // Krok co 2 piksele dla szybkości
        for (let i = 0; i < d.length; i += 8) {
          // Kwantyzacja do 5-5-5 bitów (32 poziomy na kanał)
          const r = d[i] & 0xf8;
          const g = d[i + 1] & 0xf8;
          const b = d[i + 2] & 0xf8;
          const key = (r << 16) | (g << 8) | b;
          colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
        }
      }

      // Sortuj kolory według częstotliwości występowania
      const sorted = Array.from(colorCounts.entries()).sort((a, b) => b[1] - a[1]);
      const palette = [];
      const colorMap = new Map();

      // Zawsze zarezerwuj tło na indeksie 0 (#090d16)
      palette.push([9, 13, 22]);

      for (let i = 0; i < sorted.length && palette.length < 256; i++) {
        const rgb = sorted[i][0];
        const r = (rgb >> 16) & 0xff;
        const g = (rgb >> 8) & 0xff;
        const b = rgb & 0xff;
        // Unikaj duplikatu z tłem
        if (r === 9 && g === 13 && b === 22) continue;
        palette.push([r, g, b]);
      }

      // Dopełnij do 256 kolorów
      while (palette.length < 256) {
        palette.push([0, 0, 0]);
      }

      this.palette = palette;
    }

    findNearestColor(r, g, b) {
      const key = ((r & 0xf8) << 16) | ((g & 0xf8) << 8) | (b & 0xf8);
      if (this.colorMap.has(key)) return this.colorMap.get(key);

      let bestIdx = 0;
      let minDiff = Infinity;
      for (let i = 0; i < this.palette.length; i++) {
        const pr = this.palette[i][0];
        const pg = this.palette[i][1];
        const pb = this.palette[i][2];
        const diff = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = i;
          if (diff === 0) break;
        }
      }
      this.colorMap.set(key, bestIdx);
      return bestIdx;
    }

    encode() {
      this.buildPalette();
      const bytes = [];

      // Nagłówek GIF89a
      const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
      for (const b of header) bytes.push(b);

      // Logical Screen Descriptor
      bytes.push(this.width & 0xff);
      bytes.push((this.width >> 8) & 0xff);
      bytes.push(this.height & 0xff);
      bytes.push((this.height >> 8) & 0xff);
      bytes.push(0xf7); // Globalna paleta 256 kolorów (8 bitów)
      bytes.push(0x00); // Tło
      bytes.push(0x00); // Pixel aspect ratio

      // Global Color Table (256 * 3 bajty)
      for (let i = 0; i < 256; i++) {
        bytes.push(this.palette[i][0]);
        bytes.push(this.palette[i][1]);
        bytes.push(this.palette[i][2]);
      }

      // Netscape 2.0 loop extension (nieskończona pętla)
      const loopExt = [
        0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45,
        0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00
      ];
      for (const b of loopExt) bytes.push(b);

      // Klatki
      for (let f = 0; f < this.frames.length; f++) {
        const frame = this.frames[f];
        // Graphic Control Extension
        bytes.push(0x21);
        bytes.push(0xf9);
        bytes.push(0x04);
        bytes.push(0x04); // Disposal method 1 (do not dispose)
        bytes.push(frame.delay & 0xff);
        bytes.push((frame.delay >> 8) & 0xff);
        bytes.push(0x00); // Transparent color
        bytes.push(0x00); // Block terminator

        // Image Descriptor
        bytes.push(0x2c);
        bytes.push(0x00); bytes.push(0x00); // Left 0
        bytes.push(0x00); bytes.push(0x00); // Top 0
        bytes.push(this.width & 0xff);
        bytes.push((this.width >> 8) & 0xff);
        bytes.push(this.height & 0xff);
        bytes.push((this.height >> 8) & 0xff);
        bytes.push(0x00); // Bez lokalnej palety

        // Indeksowanie pikseli
        const totalPixels = this.width * this.height;
        const indices = new Uint8Array(totalPixels);
        const data = frame.data;
        for (let i = 0, p = 0; i < totalPixels; i++, p += 4) {
          indices[i] = this.findNearestColor(data[p], data[p + 1], data[p + 2]);
        }

        // Kompresja LZW dla klatki
        this.writeLZW(indices, bytes);
      }

      // Trailer (koniec pliku GIF)
      bytes.push(0x3b);
      return new Uint8Array(bytes);
    }

    writeLZW(indices, bytes) {
      const minCodeSize = 8;
      bytes.push(minCodeSize);

      const clearCode = 1 << minCodeSize; // 256
      const eoiCode = clearCode + 1;      // 257

      let codeSize = minCodeSize + 1;
      let nextCode = clearCode + 2;

      let curAccum = 0;
      let curBits = 0;
      let packet = [];

      function writePacket(b) {
        bytes.push(b.length);
        for (let i = 0; i < b.length; i++) bytes.push(b[i]);
      }

      function outputCode(c) {
        curAccum |= (c << curBits);
        curBits += codeSize;
        while (curBits >= 8) {
          packet.push(curAccum & 0xff);
          if (packet.length >= 254) {
            writePacket(packet);
            packet = [];
          }
          curAccum >>= 8;
          curBits -= 8;
        }
      }

      outputCode(clearCode);

      const table = new Map();
      let curStr = String.fromCharCode(indices[0]);

      for (let i = 1; i < indices.length; i++) {
        const k = String.fromCharCode(indices[i]);
        const combined = curStr + k;

        if (table.has(combined)) {
          curStr = combined;
        } else {
          outputCode(curStr.length === 1 ? curStr.charCodeAt(0) : table.get(curStr));

          if (nextCode < 4096) {
            table.set(combined, nextCode++);
            if (nextCode > (1 << codeSize) && codeSize < 12) {
              codeSize++;
            }
          } else {
            outputCode(clearCode);
            table.clear();
            codeSize = minCodeSize + 1;
            nextCode = clearCode + 2;
          }
          curStr = k;
        }
      }

      outputCode(curStr.length === 1 ? curStr.charCodeAt(0) : table.get(curStr));
      outputCode(eoiCode);

      if (curBits > 0) {
        packet.push(curAccum & 0xff);
      }
      if (packet.length > 0) {
        writePacket(packet);
      }
      bytes.push(0x00); // Terminator bloku danych
    }
  }

  // -------------------------------------------------------------
  // 2. POMOCNICZE OBLICZENIA GEODEZYJNE I STATYSTYCZNE
  // -------------------------------------------------------------
  function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function computeRouteStats(points) {
    if (!points || points.length === 0) {
      return {
        count: 0,
        totalDistanceKm: 0,
        durationSeconds: 0,
        avgSpeedKmh: 0,
        maxSpeedKmh: 0,
        minAlt: 0,
        maxAlt: 0,
        startTime: null,
        endTime: null,
        bounds: [0, 0, 0, 0]
      };
    }

    let dist = 0;
    let minLat = points[0].lat, maxLat = points[0].lat;
    let minLon = points[0].lon, maxLon = points[0].lon;
    let maxSpd = 0;
    let sumSpd = 0;
    let minAlt = Infinity, maxAlt = -Infinity;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;

      const spd = p.speed_kmh || 0;
      if (spd > maxSpd) maxSpd = spd;
      sumSpd += spd;

      if (p.altitude !== null && p.altitude !== undefined) {
        if (p.altitude < minAlt) minAlt = p.altitude;
        if (p.altitude > maxAlt) maxAlt = p.altitude;
      }

      if (i > 0) {
        dist += haversineDistanceKm(points[i - 1].lat, points[i - 1].lon, p.lat, p.lon);
      }
    }

    if (minAlt === Infinity) minAlt = 0;
    if (maxAlt === -Infinity) maxAlt = 0;

    const startT = new Date(points[0].timestamp).getTime();
    const endT = new Date(points[points.length - 1].timestamp).getTime();
    const duration = isNaN(startT) || isNaN(endT) ? 0 : Math.max(0, (endT - startT) / 1000);

    return {
      count: points.length,
      totalDistanceKm: dist,
      durationSeconds: duration,
      avgSpeedKmh: points.length ? (sumSpd / points.length) : 0,
      maxSpeedKmh: maxSpd,
      minAlt,
      maxAlt,
      startTime: points[0].timestamp,
      endTime: points[points.length - 1].timestamp,
      bounds: [minLon, minLat, maxLon, maxLat]
    };
  }

  function getSpeedColor(spd) {
    if (spd < 30) return '#06b6d4'; // Cyan
    if (spd < 60) return '#10b981'; // Green
    if (spd < 90) return '#f59e0b'; // Amber
    return '#ef4444';               // Red
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '00:00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }

  // -------------------------------------------------------------
  // 3. GENERATOR OBRAZU PNG (CANVAS 1920x1080)
  // -------------------------------------------------------------
  function generatePng(points, stats, titleText, scopeName, options = {}) {
    const W = 1920;
    const H = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Tło
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, W, H);

    // Siatka pomocnicza
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let x = 60; x < W - 60; x += 80) {
      ctx.beginPath(); ctx.moveTo(x, 60); ctx.lineTo(x, H - 60); ctx.stroke();
    }
    for (let y = 60; y < H - 60; y += 80) {
      ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(W - 60, y); ctx.stroke();
    }

    // Bounding Box trasy z korekcją kosinusa szerokości geograficznej
    const [minLon, minLat, maxLon, maxLat] = stats.bounds;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);

    const mapX = 80;
    const mapY = 120;
    const mapW = W - 160;
    const mapH = H - 320;

    const spanLon = Math.max(0.0001, (maxLon - minLon) * cosLat);
    const spanLat = Math.max(0.0001, maxLat - minLat);

    const scale = Math.min((mapW - 100) / spanLon, (mapH - 100) / spanLat);
    const offsetX = mapX + (mapW - spanLon * scale) / 2;
    const offsetY = mapY + (mapH - spanLat * scale) / 2;

    function toScreen(lon, lat) {
      const x = offsetX + (lon - minLon) * cosLat * scale;
      const y = offsetY + (maxLat - lat) * scale;
      return [x, y];
    }

    // Rysowanie poświaty pod trasą
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.2)';
    ctx.lineWidth = 12;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const [sx, sy] = toScreen(points[i].lon, points[i].lat);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // Rysowanie właściwej trasy z kolorowaniem prędkości
    ctx.lineWidth = 4;
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1];
      const p1 = points[i];
      const [x0, y0] = toScreen(p0.lon, p0.lat);
      const [x1, y1] = toScreen(p1.lon, p1.lat);

      ctx.strokeStyle = getSpeedColor(p1.speed_kmh || 0);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Punkty Start i Meta
    if (points.length > 0) {
      const [startPx, startPy] = toScreen(points[0].lon, points[0].lat);
      ctx.fillStyle = '#10b981';
      ctx.beginPath(); ctx.arc(startPx, startPy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.stroke();

      ctx.fillStyle = '#10b981';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillText('START', startPx + 14, startPy + 5);

      const [endPx, endPy] = toScreen(points[points.length - 1].lon, points[points.length - 1].lat);
      ctx.fillStyle = '#ef4444';
      ctx.beginPath(); ctx.arc(endPx, endPy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.stroke();

      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillText('META', endPx + 14, endPy + 5);
    }

    // Nagłówek i Ramka Informacyjna (HUD Card)
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(80, 40, 520, 110, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText(`NNAPER • ${titleText.toUpperCase()}`, 100, 72);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13.5px system-ui, sans-serif';
    ctx.fillText(`Dystans: ${stats.totalDistanceKm.toFixed(2)} km   |   Czas: ${formatDuration(stats.durationSeconds)}`, 100, 100);
    ctx.fillText(`Śr. prędkość: ${stats.avgSpeedKmh.toFixed(1)} km/h   |   V max: ${stats.maxSpeedKmh.toFixed(1)} km/h`, 100, 124);

    // Mini wykres profilu wysokości na dole
    const chartX = 80;
    const chartY = H - 160;
    const chartW = W - 160;
    const chartH = 100;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(chartX, chartY, chartW, chartH, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`Profil wysokości (Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m)`, chartX + 15, chartY + 20);

    const altSpan = Math.max(10, stats.maxAlt - stats.minAlt);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const cx = chartX + 15 + (i / Math.max(1, points.length - 1)) * (chartW - 30);
      const alt = points[i].altitude ?? stats.minAlt;
      const cy = (chartY + chartH - 15) - ((alt - stats.minAlt) / altSpan) * (chartH - 45);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();

    // Legenda prędkości w prawym górnym rogu
    const legX = W - 320;
    const legY = 40;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.roundRect(legX, legY, 240, 95, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText('PRĘDKOŚĆ (KM/H)', legX + 15, legY + 22);

    const speeds = [
      { label: '< 30 km/h', col: '#06b6d4' },
      { label: '30 - 60 km/h', col: '#10b981' },
      { label: '60 - 90 km/h', col: '#f59e0b' },
      { label: '> 90 km/h', col: '#ef4444' }
    ];
    speeds.forEach((s, idx) => {
      const sy = legY + 40 + idx * 14;
      ctx.fillStyle = s.col;
      ctx.fillRect(legX + 15, sy - 8, 14, 8);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(s.label, legX + 38, sy);
    });

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png');
    });
  }

  // -------------------------------------------------------------
  // 4. GENERATOR WEKTOROWEGO SVG (BEZSTRATNY WEKTOR)
  // -------------------------------------------------------------
  function generateSvg(points, stats, titleText, scopeName, options = {}) {
    let svgPoints = points;
    if (points.length > 3000) {
      const step = Math.ceil(points.length / 3000);
      svgPoints = [];
      for (let i = 0; i < points.length; i += step) {
        svgPoints.push(points[i]);
      }
      if (svgPoints[svgPoints.length - 1] !== points[points.length - 1]) {
        svgPoints.push(points[points.length - 1]);
      }
    }
    const W = 1200;
    const H = 800;
    const [minLon, minLat, maxLon, maxLat] = stats.bounds;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);

    const mapX = 60, mapY = 110, mapW = W - 120, mapH = H - 280;
    const spanLon = Math.max(0.0001, (maxLon - minLon) * cosLat);
    const spanLat = Math.max(0.0001, maxLat - minLat);

    const scale = Math.min((mapW - 60) / spanLon, (mapH - 60) / spanLat);
    const offsetX = mapX + (mapW - spanLon * scale) / 2;
    const offsetY = mapY + (mapH - spanLat * scale) / 2;

    function toSvg(lon, lat) {
      const x = offsetX + (lon - minLon) * cosLat * scale;
      const y = offsetY + (maxLat - lat) * scale;
      return [x.toFixed(2), y.toFixed(2)];
    }

    let trackPaths = '';
    for (let i = 1; i < svgPoints.length; i++) {
      const [x0, y0] = toSvg(svgPoints[i - 1].lon, svgPoints[i - 1].lat);
      const [x1, y1] = toSvg(svgPoints[i].lon, svgPoints[i].lat);
      const col = getSpeedColor(svgPoints[i].speed_kmh || 0);
      trackPaths += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${col}" stroke-width="3.5" stroke-linecap="round"/>\n`;
    }

    const startPos = svgPoints.length > 0 ? toSvg(svgPoints[0].lon, svgPoints[0].lat) : [0, 0];
    const endPos = svgPoints.length > 0 ? toSvg(svgPoints[svgPoints.length - 1].lon, svgPoints[svgPoints.length - 1].lat) : [0, 0];

    // Profil wysokości
    const chartX = 60, chartY = H - 140, chartW = W - 120, chartH = 90;
    const altSpan = Math.max(10, stats.maxAlt - stats.minAlt);
    let chartPolyline = '';
    for (let i = 0; i < svgPoints.length; i++) {
      const cx = (chartX + 15 + (i / Math.max(1, svgPoints.length - 1)) * (chartW - 30)).toFixed(1);
      const alt = svgPoints[i].altitude ?? stats.minAlt;
      const cy = ((chartY + chartH - 15) - ((alt - stats.minAlt) / altSpan) * (chartH - 35)).toFixed(1);
      chartPolyline += `${cx},${cy} `;
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="background:#090d16; font-family:system-ui, -apple-system, sans-serif;">
  <defs>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Siatka tła -->
  <rect x="0" y="0" width="${W}" height="${H}" fill="#090d16"/>
  <rect x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" fill="#0f172a" stroke="#1e293b" rx="8"/>

  <!-- Ślad trasy -->
  <g filter="url(#glow)">
    ${trackPaths}
  </g>

  <!-- Punkt START -->
  <circle cx="${startPos[0]}" cy="${startPos[1]}" r="7" fill="#10b981" stroke="#ffffff" stroke-width="2"/>
  <text x="${Number(startPos[0]) + 12}" y="${Number(startPos[1]) + 4}" fill="#10b981" font-size="12" font-weight="bold">START</text>

  <!-- Punkt META -->
  <circle cx="${endPos[0]}" cy="${endPos[1]}" r="7" fill="#ef4444" stroke="#ffffff" stroke-width="2"/>
  <text x="${Number(endPos[0]) + 12}" y="${Number(endPos[1]) + 4}" fill="#ef4444" font-size="12" font-weight="bold">META</text>

  <!-- Karta HUD / Nagłówek -->
  <rect x="60" y="30" width="560" height="65" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="80" y="55" fill="#38bdf8" font-size="15" font-weight="bold">NNAPER • ${titleText.toUpperCase()}</text>
  <text x="80" y="78" fill="#cbd5e1" font-size="12">Dystans: ${stats.totalDistanceKm.toFixed(2)} km  |  Czas: ${formatDuration(stats.durationSeconds)}  |  Śr. prędkość: ${stats.avgSpeedKmh.toFixed(1)} km/h  |  V max: ${stats.maxSpeedKmh.toFixed(1)} km/h</text>

  <!-- Wykres profilu wysokości -->
  <rect x="${chartX}" y="${chartY}" width="${chartW}" height="${chartH}" rx="8" fill="#0f172a" stroke="#1e293b"/>
  <text x="${chartX + 15}" y="${chartY + 20}" fill="#94a3b8" font-size="11">Profil wysokości (Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m)</text>
  <polyline points="${chartPolyline}" fill="none" stroke="#38bdf8" stroke-width="2"/>

  <!-- Legenda -->
  <g transform="translate(${W - 260}, 30)">
    <rect width="200" height="65" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="15" y="20" fill="#94a3b8" font-size="10" font-weight="bold">PRĘDKOŚĆ</text>
    <rect x="15" y="32" width="10" height="8" fill="#06b6d4"/><text x="30" y="40" fill="#f8fafc" font-size="10">&lt;30 km/h</text>
    <rect x="105" y="32" width="10" height="8" fill="#10b981"/><text x="120" y="40" fill="#f8fafc" font-size="10">30-60</text>
    <rect x="15" y="48" width="10" height="8" fill="#f59e0b"/><text x="30" y="56" fill="#f8fafc" font-size="10">60-90</text>
    <rect x="105" y="48" width="10" height="8" fill="#ef4444"/><text x="120" y="56" fill="#f8fafc" font-size="10">&gt;90 km/h</text>
  </g>
</svg>`;

    return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  }

  // -------------------------------------------------------------
  // 5. GENERATOR ANIMOWANEGO GIF (ANIMACJA PRZEJAZDU)
  // -------------------------------------------------------------
  async function generateGif(points, stats, titleText, scopeName, options = {}, onProgress = null) {
    let animPoints = points;
    if (points.length > 1500) {
      const step = Math.ceil(points.length / 1500);
      animPoints = [];
      for (let i = 0; i < points.length; i += step) {
        animPoints.push(points[i]);
      }
      if (animPoints[animPoints.length - 1] !== points[points.length - 1]) {
        animPoints.push(points[points.length - 1]);
      }
    }

    const W = 640;
    const H = 400;
    const encoder = new SimpleGifEncoder(W, H);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const [minLon, minLat, maxLon, maxLat] = stats.bounds;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);

    const mapX = 30, mapY = 70, mapW = W - 60, mapH = H - 100;
    const spanLon = Math.max(0.0001, (maxLon - minLon) * cosLat);
    const spanLat = Math.max(0.0001, maxLat - minLat);

    const scale = Math.min((mapW - 40) / spanLon, (mapH - 40) / spanLat);
    const offsetX = mapX + (mapW - spanLon * scale) / 2;
    const offsetY = mapY + (mapH - spanLat * scale) / 2;

    function toScreen(lon, lat) {
      return [
        offsetX + (lon - minLon) * cosLat * scale,
        offsetY + (maxLat - lat) * scale
      ];
    }

    const TOTAL_ANIM_FRAMES = 32;
    const HOLD_FRAMES = 5; // pauza na końcu

    // Rysowanie poszczególnych klatek animacji
    for (let f = 0; f < TOTAL_ANIM_FRAMES; f++) {
      const progress = f / (TOTAL_ANIM_FRAMES - 1);
      const currentIdx = Math.min(animPoints.length - 1, Math.floor(progress * (animPoints.length - 1)));
      const currPt = animPoints[currentIdx];

      // Tło
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, W, H);

      // Karta mapy
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(mapX, mapY, mapW, mapH, 6);
      ctx.fill();
      ctx.stroke();

      // Cień pełnej trasy w tle
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < animPoints.length; i++) {
        const [x, y] = toScreen(animPoints[i].lon, animPoints[i].lat);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Przebyta trasa do bieżącego punktu
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      for (let i = 1; i <= currentIdx; i++) {
        const [x0, y0] = toScreen(animPoints[i - 1].lon, animPoints[i - 1].lat);
        const [x1, y1] = toScreen(animPoints[i].lon, animPoints[i].lat);
        ctx.strokeStyle = getSpeedColor(animPoints[i].speed_kmh || 0);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // Punkt startu
      const [startPx, startPy] = toScreen(animPoints[0].lon, animPoints[0].lat);
      ctx.fillStyle = '#10b981';
      ctx.beginPath(); ctx.arc(startPx, startPy, 4.5, 0, Math.PI * 2); ctx.fill();

      // Aktualna pozycja pojazdu
      const [carX, carY] = toScreen(currPt.lon, currPt.lat);
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath(); ctx.arc(carX, carY, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();

      // Pasek postępu na samym dole
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, H - 6, W, 6);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(0, H - 6, W * progress, 6);

      // Nagłówek HUD z danymi w czasie rzeczywistym
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(mapX, 10, mapW, 50);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.strokeRect(mapX, 10, mapW, 50);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(`NNAPER REPLAY • ${titleText}`, mapX + 12, 28);

      const tStr = currPt.timestamp ? currPt.timestamp.split('T')[1].replace('Z', '') : '--:--:--';
      const spdStr = (currPt.speed_kmh || 0).toFixed(1);
      const altStr = currPt.altitude !== null ? `${Number(currPt.altitude).toFixed(0)}m` : '--';
      ctx.fillStyle = '#f8fafc';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`Czas: ${tStr}   |   V: ${spdStr} km/h   |   Wys.: ${altStr}   |   Postęp: ${(progress * 100).toFixed(0)}%`, mapX + 12, 48);

      encoder.addFrame(canvas, 100);

      if (onProgress) {
        onProgress(Math.round(((f + 1) / (TOTAL_ANIM_FRAMES + HOLD_FRAMES)) * 90));
      }
    }

    // Dodanie klatek końcowych (pauza na pełnej trasie)
    for (let h = 0; h < HOLD_FRAMES; h++) {
      encoder.addFrame(canvas, 250);
    }

    if (onProgress) onProgress(95);

    const gifBytes = encoder.encode();
    return new Blob([gifBytes], { type: 'image/gif' });
  }

  // -------------------------------------------------------------
  // 6. GENERATOR SAMODZIELNEGO INTERAKTYWNEGO HTML (STANDALONE)
  // -------------------------------------------------------------
  function generateHtml(points, stats, titleText, scopeName) {
    const rawJson = JSON.stringify(points);
    const statsJson = JSON.stringify(stats);

    const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <title>Trasa NNAPER - ${titleText}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #090d16; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    header { background: #0f172a; border-bottom: 1px solid #334155; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; z-index: 100; }
    .title-box h1 { font-size: 16px; color: #38bdf8; font-weight: 700; }
    .title-box p { font-size: 12px; color: #94a3b8; margin-top: 2px; }
    .kpi-row { display: flex; gap: 16px; }
    .kpi-item { display: flex; flex-direction: column; align-items: flex-end; }
    .kpi-lbl { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .kpi-val { font-size: 13.5px; font-weight: 700; color: #f8fafc; font-family: ui-monospace, monospace; }
    #main-container { flex: 1; display: flex; flex-direction: column; position: relative; }
    #map { flex: 1; width: 100%; }
    #chart-panel { height: 130px; background: #0f172a; border-top: 1px solid #334155; padding: 10px 16px; display: flex; flex-direction: column; position: relative; }
    .chart-header { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
    #chart-canvas { width: 100%; height: 90px; }
    #hud-card { position: absolute; top: 15px; right: 15px; z-index: 1000; background: rgba(15, 23, 42, 0.95); border: 1px solid #38bdf8; border-radius: 8px; padding: 10px 14px; min-width: 200px; box-shadow: 0 8px 24px rgba(0,0,0,0.7); backdrop-filter: blur(6px); }
    .hud-line { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
    .hud-lbl { color: #94a3b8; }
    .hud-v { font-weight: 700; color: #38bdf8; font-family: monospace; }
    .ctrl-bar { position: absolute; bottom: 145px; left: 50%; transform: translateX(-50%); z-index: 1000; background: rgba(15, 23, 42, 0.95); border: 1px solid #334155; border-radius: 30px; padding: 6px 16px; display: flex; align-items: center; gap: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.6); }
    .ctrl-btn { background: #1e293b; color: #f8fafc; border: 1px solid #475569; padding: 4px 12px; border-radius: 16px; font-size: 12px; cursor: pointer; }
    .ctrl-btn:hover { background: #38bdf8; color: #090d16; }
    #timeline-slider { width: 220px; accent-color: #38bdf8; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <div class="title-box">
      <h1>Trasa NNAPER: ${titleText}</h1>
      <p id="sub-info">Zarejestrowane epoki GPS z telemetrią</p>
    </div>
    <div class="kpi-row">
      <div class="kpi-item"><span class="kpi-lbl">Dystans</span><span class="kpi-val">${stats.totalDistanceKm.toFixed(2)} km</span></div>
      <div class="kpi-item"><span class="kpi-lbl">Czas trwania</span><span class="kpi-val">${formatDuration(stats.durationSeconds)}</span></div>
      <div class="kpi-item"><span class="kpi-lbl">Śr. prędkość</span><span class="kpi-val">${stats.avgSpeedKmh.toFixed(1)} km/h</span></div>
      <div class="kpi-item"><span class="kpi-lbl">V max</span><span class="kpi-val">${stats.maxSpeedKmh.toFixed(1)} km/h</span></div>
      <div class="kpi-item"><span class="kpi-lbl">Punkty</span><span class="kpi-val">${points.length}</span></div>
    </div>
  </header>

  <div id="main-container">
    <div id="map"></div>

    <div id="hud-card">
      <div class="hud-line"><span class="hud-lbl">Czas:</span><span id="h-time" class="hud-v">--:--:--</span></div>
      <div class="hud-line"><span class="hud-lbl">Prędkość:</span><span id="h-spd" class="hud-v">0.0 km/h</span></div>
      <div class="hud-line"><span class="hud-lbl">Wysokość:</span><span id="h-alt" class="hud-v">-- m</span></div>
      <div class="hud-line"><span class="hud-lbl">Przeciążenie X:</span><span id="h-gx" class="hud-v">--</span></div>
      <div class="hud-line"><span class="hud-lbl">Przeciążenie Y:</span><span id="h-gy" class="hud-v">--</span></div>
      <div class="hud-line"><span class="hud-lbl">Przeciążenie Z:</span><span id="h-gz" class="hud-v">--</span></div>
    </div>

    <div class="ctrl-bar">
      <button id="btn-play" class="ctrl-btn">▶ Odtwórz</button>
      <input type="range" id="timeline-slider" min="0" max="${Math.max(0, points.length - 1)}" value="0" />
      <span id="lbl-prog" style="font-size:11px; color:#94a3b8; font-family:monospace;">1 / ${points.length}</span>
    </div>

    <div id="chart-panel">
      <div class="chart-header">
        <span>Profil wysokości n.p.m. i prędkości</span>
        <span style="color:#64748b;">Najedź myszą, aby zbadać punkt trasy</span>
      </div>
      <canvas id="chart-canvas"></canvas>
    </div>
  </div>

  <script>
    const points = ${rawJson};
    const stats = ${statsJson};

    if (!points || !points.length) {
      document.getElementById('map').innerHTML = '<div style="padding:20px; color:#ef4444;">Brak punktów trasy do wyświetlenia.</div>';
    } else {
      // Inicjalizacja Leaflet
      const map = L.map('map', { attributionControl: false }).setView([points[0].lat, points[0].lon], 13);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
      }).addTo(map);

      // Rysowanie odcinków pokolorowanych prędkością
      const latlngs = [];
      for (let i = 0; i < points.length; i++) {
        latlngs.push([points[i].lat, points[i].lon]);
        if (i > 0) {
          const spd = points[i].speed_kmh || 0;
          let col = '#06b6d4';
          if (spd >= 90) col = '#ef4444';
          else if (spd >= 60) col = '#f59e0b';
          else if (spd >= 30) col = '#10b981';

          L.polyline([[points[i-1].lat, points[i-1].lon], [points[i].lat, points[i].lon]], {
            color: col,
            weight: 4,
            opacity: 0.9
          }).addTo(map);
        }
      }

      if (latlngs.length > 0) {
        map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
      }

      // Znaczniki Start i Meta
      L.circleMarker([points[0].lat, points[0].lon], { radius: 7, color: '#fff', fillColor: '#10b981', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('<b>START</b><br>' + points[0].timestamp);
      L.circleMarker([points[points.length - 1].lat, points[points.length - 1].lon], { radius: 7, color: '#fff', fillColor: '#ef4444', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('<b>META</b><br>' + points[points.length - 1].timestamp);

      // Marker pojazdu
      const carIcon = L.divIcon({
        html: '<div style="font-size:24px; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));">🚗</div>',
        className: 'car-icon',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      const carMarker = L.marker([points[0].lat, points[0].lon], { icon: carIcon }).addTo(map);

      // HUD & Odtwarzacz
      const hTime = document.getElementById('h-time');
      const hSpd = document.getElementById('h-spd');
      const hAlt = document.getElementById('h-alt');
      const hGx = document.getElementById('h-gx');
      const hGy = document.getElementById('h-gy');
      const hGz = document.getElementById('h-gz');
      const slider = document.getElementById('timeline-slider');
      const lblProg = document.getElementById('lbl-prog');
      const btnPlay = document.getElementById('btn-play');

      function updatePoint(idx) {
        const pt = points[idx];
        if (!pt) return;
        carMarker.setLatLng([pt.lat, pt.lon]);
        if (hTime) hTime.innerText = pt.timestamp ? pt.timestamp.split('T')[1].replace('Z','') : '--';
        if (hSpd) hSpd.innerText = (pt.speed_kmh || 0).toFixed(1) + ' km/h';
        if (hAlt) hAlt.innerText = pt.altitude !== null ? Number(pt.altitude).toFixed(1) + ' m' : '--';
        if (hGx) hGx.innerText = pt.g_x !== null ? Number(pt.g_x).toFixed(3) + ' G' : '--';
        if (hGy) hGy.innerText = pt.g_y !== null ? Number(pt.g_y).toFixed(3) + ' G' : '--';
        if (hGz) hGz.innerText = pt.g_z !== null ? Number(pt.g_z).toFixed(3) + ' G' : '--';
        if (slider) slider.value = idx;
        if (lblProg) lblProg.innerText = (idx + 1) + ' / ' + points.length;
      }

      slider.addEventListener('input', (e) => {
        updatePoint(parseInt(e.target.value, 10));
      });

      let isPlaying = false;
      let playTimer = null;
      btnPlay.addEventListener('click', () => {
        if (isPlaying) {
          clearInterval(playTimer);
          isPlaying = false;
          btnPlay.innerText = '▶ Odtwórz';
        } else {
          isPlaying = true;
          btnPlay.innerText = '⏸ Pauza';
          playTimer = setInterval(() => {
            let next = parseInt(slider.value, 10) + 1;
            if (next >= points.length) next = 0;
            updatePoint(next);
          }, 60);
        }
      });

      updatePoint(0);

      // Wykres profilu wysokości na Canvas
      const canvas = document.getElementById('chart-canvas');
      function drawChart() {
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, W, H);

        const minA = stats.minAlt, maxA = Math.max(minA + 10, stats.maxAlt);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          const x = (i / (points.length - 1)) * W;
          const a = points[i].altitude ?? minA;
          const y = H - 10 - ((a - minA) / (maxA - minA)) * (H - 20);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      window.addEventListener('resize', drawChart);
      setTimeout(drawChart, 100);
    }
  </script>
</body>
</html>`;

    return new Blob([html], { type: 'text/html;charset=utf-8' });
  }

  // -------------------------------------------------------------
  // 7. GENERATORY PLIKÓW DANYCH (GPX, CSV, GEOJSON, KML)
  // -------------------------------------------------------------
  function generateGpx(points, stats, titleText) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NNAPER" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Trasa ${titleText}</name></metadata>
  <trk>
    <name>Trasa NNAPER - ${titleText}</name>
    <trkseg>
`;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      xml += `      <trkpt lat="${p.lat}" lon="${p.lon}">\n`;
      if (p.altitude !== null && p.altitude !== undefined) xml += `        <ele>${p.altitude}</ele>\n`;
      if (p.timestamp) xml += `        <time>${p.timestamp}</time>\n`;
      if (p.speed_kmh !== null && p.speed_kmh !== undefined) {
        xml += `        <speed>${(Number(p.speed_kmh) / 3.6).toFixed(2)}</speed>\n`;
      }
      xml += `      </trkpt>\n`;
    }
    xml += `    </trkseg>\n  </trk>\n</gpx>`;
    return new Blob([xml], { type: 'application/gpx+xml;charset=utf-8' });
  }

  function generateCsv(points, stats, titleText) {
    let csv = '\ufefftimestamp,latitude,longitude,altitude_m,speed_kmh,g_x,g_y,g_z\n';
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const alt = p.altitude !== null ? p.altitude : '';
      const spd = p.speed_kmh !== null ? p.speed_kmh : '0.0';
      const gx = p.g_x !== null ? p.g_x : '';
      const gy = p.g_y !== null ? p.g_y : '';
      const gz = p.g_z !== null ? p.g_z : '';
      csv += `${p.timestamp || ''},${p.lat},${p.lon},${alt},${spd},${gx},${gy},${gz}\n`;
    }
    return new Blob([csv], { type: 'text/csv;charset=utf-8' });
  }

  function generateGeoJson(points, stats, titleText) {
    const coords = points.map(p => [p.lon, p.lat, p.altitude || 0]);
    const geo = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: coords
          },
          properties: {
            name: `Trasa ${titleText}`,
            distance_km: stats.totalDistanceKm,
            duration_seconds: stats.durationSeconds,
            points_count: points.length,
            avg_speed_kmh: stats.avgSpeedKmh,
            max_speed_kmh: stats.maxSpeedKmh
          }
        }
      ]
    };
    return new Blob([JSON.stringify(geo, null, 2)], { type: 'application/geo+json;charset=utf-8' });
  }

  function generateKml(points, stats, titleText) {
    const coordsStr = points.map(p => `${p.lon},${p.lat},${p.altitude || 0}`).join(' ');
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Trasa NNAPER - ${titleText}</name>
    <Style id="routeStyle">
      <LineStyle>
        <color>ff00d406</color>
        <width>4</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>${titleText}</name>
      <styleUrl>#routeStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coordsStr}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
    return new Blob([kml], { type: 'application/vnd.google-earth.kml+xml;charset=utf-8' });
  }

  // -------------------------------------------------------------
  // 8. INTERFEJS UŻYTKOWNIKA I OBSŁUGA MODALA EKSPORTU
  // -------------------------------------------------------------
  let cachedDatesTree = null;
  let activeScope = 'day';
  let activeFormat = 'html';

  const modalBackdrop = document.getElementById('export-modal-backdrop');
  const btnClose = document.getElementById('btn-close-export');
  const btnCancel = document.getElementById('btn-cancel-export');
  const btnDoExport = document.getElementById('btn-do-export');
  const btnOpenMenu = document.getElementById('btn-open-export');
  const btnOpenPlaybackExport = document.getElementById('btn-playback-export');

  const selDay = document.getElementById('export-sel-day');
  const selYear = document.getElementById('export-sel-year');
  const selYearM = document.getElementById('export-sel-year-m');
  const selMonth = document.getElementById('export-sel-month');

  const statusBox = document.getElementById('export-status-box');
  const statusText = document.getElementById('export-status-text');
  const progressFill = document.getElementById('export-progress-fill');

  const MONTH_NAMES = {
    '01': 'Styczeń', '02': 'Luty', '03': 'Marzec', '04': 'Kwiecień',
    '05': 'Maj', '06': 'Czerwiec', '07': 'Lipiec', '08': 'Sierpień',
    '09': 'Wrzesień', '10': 'Październik', '11': 'Listopad', '12': 'Grudzień'
  };

  async function loadDatesTree() {
    if (cachedDatesTree) return cachedDatesTree;
    try {
      const res = await fetch(`${apiBaseUrl}/api/dates-tree`);
      if (res.ok) {
        cachedDatesTree = await res.json();
      }
    } catch (e) {
      console.error('Błąd pobierania drzewa dat dla eksportu:', e);
    }
    return cachedDatesTree || {};
  }

  async function populateScopeControls(preselect = {}) {
    const tree = await loadDatesTree();
    const years = Object.keys(tree).sort().reverse();

    // Dni (YYYY-MM-DD)
    const allDays = [];
    years.forEach(y => {
      Object.keys(tree[y]).sort().reverse().forEach(m => {
        tree[y][m].sort().reverse().forEach(d => {
          allDays.push(`${y}-${m}-${d}`);
        });
      });
    });

    if (selDay) {
      selDay.innerHTML = allDays.length ? '' : '<option value="">Brak zarejestrowanych dni</option>';
      allDays.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.innerText = d;
        selDay.appendChild(opt);
      });
      if (preselect.day && allDays.includes(preselect.day)) {
        selDay.value = preselect.day;
      }
    }

    // Lata
    if (selYear) {
      selYear.innerHTML = years.length ? '' : '<option value="">Brak lat</option>';
      years.forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.innerText = `Rok ${y}`;
        selYear.appendChild(opt);
      });
      if (preselect.year && years.includes(String(preselect.year))) {
        selYear.value = String(preselect.year);
      }
    }

    // Lata dla miesięcy
    if (selYearM) {
      selYearM.innerHTML = years.length ? '' : '<option value="">Brak lat</option>';
      years.forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.innerText = y;
        selYearM.appendChild(opt);
      });
      if (preselect.year && years.includes(String(preselect.year))) {
        selYearM.value = String(preselect.year);
      }
    }

    updateMonthSelect(preselect.month);
  }

  function updateMonthSelect(preselectMonth = null) {
    if (!selYearM || !selMonth || !cachedDatesTree) return;
    const y = selYearM.value;
    const months = y && cachedDatesTree[y] ? Object.keys(cachedDatesTree[y]).sort().reverse() : [];

    selMonth.innerHTML = months.length ? '' : '<option value="">Brak miesięcy</option>';
    months.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.innerText = `${m} - ${MONTH_NAMES[m] || m}`;
      selMonth.appendChild(opt);
    });

    if (preselectMonth) {
      const mPad = String(preselectMonth).padStart(2, '0');
      if (months.includes(mPad)) selMonth.value = mPad;
    }
  }

  if (selYearM) {
    selYearM.addEventListener('change', () => updateMonthSelect());
  }

  function setScopeTab(scope) {
    activeScope = scope;
    document.querySelectorAll('.scope-tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-scope') === scope);
    });

    const boxes = {
      day: document.getElementById('export-scope-day-box'),
      month: document.getElementById('export-scope-month-box'),
      year: document.getElementById('export-scope-year-box'),
      all: document.getElementById('export-scope-all-box'),
      active: document.getElementById('export-scope-active-box')
    };

    Object.keys(boxes).forEach(k => {
      if (boxes[k]) boxes[k].style.display = (k === scope) ? 'block' : 'none';
    });
  }

  function setFormat(fmt) {
    activeFormat = fmt;
    document.querySelectorAll('.format-card').forEach(c => {
      c.classList.toggle('active', c.getAttribute('data-format') === fmt);
    });

    const gifSpeedRow = document.getElementById('opt-gif-speed-row');
    if (gifSpeedRow) {
      gifSpeedRow.style.display = (fmt === 'gif') ? 'flex' : 'none';
    }
  }

  function openExportModal(params = {}) {
    if (modalBackdrop) modalBackdrop.style.display = 'flex';
    if (statusBox) statusBox.style.display = 'none';

    populateScopeControls(params).then(() => {
      if (params.scope) {
        setScopeTab(params.scope);
      } else if (params.day) {
        setScopeTab('day');
      } else if (params.month) {
        setScopeTab('month');
      } else if (params.year) {
        setScopeTab('year');
      }
    });

    if (params.format) {
      setFormat(params.format);
    }
  }

  function closeExportModal() {
    if (modalBackdrop) modalBackdrop.style.display = 'none';
  }

  // Podpięcie zdarzeń zakładek i formatów
  document.querySelectorAll('.scope-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      setScopeTab(tab.getAttribute('data-scope'));
    });
  });

  document.querySelectorAll('.format-card').forEach(card => {
    card.addEventListener('click', () => {
      setFormat(card.getAttribute('data-format'));
    });
  });

  if (btnClose) btnClose.addEventListener('click', closeExportModal);
  if (btnCancel) btnCancel.addEventListener('click', closeExportModal);
  if (btnOpenMenu) {
    btnOpenMenu.addEventListener('click', () => {
      if (typeof window.collapseRightMenu === 'function') window.collapseRightMenu();
      openExportModal();
    });
  }

  if (btnOpenPlaybackExport) {
    btnOpenPlaybackExport.addEventListener('click', () => {
      const curDay = document.getElementById('playback-date-select')?.value;
      openExportModal({ scope: 'day', day: curDay });
    });
  }

  // Główna logika generowania i pobierania pliku
  async function performExport() {
    if (btnDoExport) btnDoExport.disabled = true;
    if (statusBox) statusBox.style.display = 'block';
    if (progressFill) progressFill.style.width = '15%';
    if (statusText) statusText.innerText = 'Pobieranie punktów trasy z bazy danych...';

    try {
      let queryUrl = `${apiBaseUrl}/api/export-data?scope=${activeScope}`;
      let title = 'Trasa';
      let scopeFilename = 'trasa';

      if (activeScope === 'day') {
        const d = selDay ? selDay.value : '';
        if (!d) throw new Error('Nie wybrano dnia do eksportu.');
        queryUrl += `&day=${encodeURIComponent(d)}`;
        title = `Dzień: ${d}`;
        scopeFilename = d;
      } else if (activeScope === 'month') {
        const y = selYearM ? selYearM.value : '';
        const m = selMonth ? selMonth.value : '';
        if (!y || !m) throw new Error('Nie wybrano roku lub miesiąca.');
        queryUrl += `&year=${y}&month=${m}`;
        title = `Miesiąc: ${MONTH_NAMES[m] || m} ${y}`;
        scopeFilename = `${y}-${m}`;
      } else if (activeScope === 'year') {
        const y = selYear ? selYear.value : '';
        if (!y) throw new Error('Nie wybrano roku.');
        queryUrl += `&year=${y}`;
        title = `Rok: ${y}`;
        scopeFilename = `${y}`;
      } else if (activeScope === 'active') {
        // Dni zaznaczone obecnie na mapie
        const activeDays = Array.from(document.querySelectorAll('#tree-container input[type="checkbox"]:checked'))
          .map(cb => cb.value)
          .filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v));
        if (!activeDays.length) {
          throw new Error('Brak aktywnych dni w filtrze mapy. Zaznacz dni w lewym panelu.');
        }
        queryUrl = `${apiBaseUrl}/api/export-data?scope=days&days=${encodeURIComponent(activeDays.join(','))}`;
        title = `Aktywne filtry (${activeDays.length} dni)`;
        scopeFilename = `aktywne_${activeDays.length}_dni`;
      } else if (activeScope === 'all') {
        title = 'Wszystkie zarejestrowane trasy';
        scopeFilename = 'wszystko';
      }

      if (progressFill) progressFill.style.width = '35%';

      const res = await fetch(queryUrl);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || `Błąd serwera (HTTP ${res.status})`);
      }

      const points = await res.json();
      if (!points || !points.length) {
        throw new Error('Brak punktów telemetrycznych w wybranym okresie.');
      }

      if (statusText) statusText.innerText = `Przetwarzanie ${points.length} epok...`;
      if (progressFill) progressFill.style.width = '55%';

      const stats = computeRouteStats(points);
      const filenameBase = `trasa_${scopeFilename}`;

      if (statusText) statusText.innerText = `Generowanie formatu ${activeFormat.toUpperCase()}...`;

      let blob = null;
      let outExt = activeFormat;

      if (activeFormat === 'html') {
        blob = generateHtml(points, stats, title, scopeFilename);
        outExt = 'html';
      } else if (activeFormat === 'svg') {
        blob = generateSvg(points, stats, title, scopeFilename);
        outExt = 'svg';
      } else if (activeFormat === 'png') {
        blob = await generatePng(points, stats, title, scopeFilename);
        outExt = 'png';
      } else if (activeFormat === 'gif') {
        blob = await generateGif(points, stats, title, scopeFilename, {}, (pct) => {
          if (progressFill) progressFill.style.width = `${55 + pct * 0.4}%`;
          if (statusText) statusText.innerText = `Renderowanie klatek GIF (${pct}%)...`;
        });
        outExt = 'gif';
      } else if (activeFormat === 'gpx') {
        blob = generateGpx(points, stats, title);
        outExt = 'gpx';
      } else if (activeFormat === 'csv') {
        blob = generateCsv(points, stats, title);
        outExt = 'csv';
      } else if (activeFormat === 'geojson') {
        blob = generateGeoJson(points, stats, title);
        outExt = 'geojson';
      } else if (activeFormat === 'kml') {
        blob = generateKml(points, stats, title);
        outExt = 'kml';
      }

      if (progressFill) progressFill.style.width = '100%';
      if (statusText) statusText.innerText = 'Pobieranie pliku...';

      downloadBlob(blob, `${filenameBase}.${outExt}`);

      setTimeout(() => {
        closeExportModal();
      }, 1200);

    } catch (err) {
      console.error('Błąd eksportu trasy:', err);
      if (statusText) statusText.innerText = `Błąd: ${err.message}`;
      if (progressFill) progressFill.style.width = '0%';
    } finally {
      if (btnDoExport) btnDoExport.disabled = false;
    }
  }

  if (btnDoExport) {
    btnDoExport.addEventListener('click', performExport);
  }

  // Eksport globalny do window
  window.ExportManager = {
    open: openExportModal,
    close: closeExportModal,
    exportScope: (scope, val) => {
      if (scope === 'day') openExportModal({ scope: 'day', day: val });
      else if (scope === 'month') {
        const parts = val.split('-');
        openExportModal({ scope: 'month', year: parts[0], month: parts[1] });
      }
      else if (scope === 'year') openExportModal({ scope: 'year', year: val });
    }
  };

})();
