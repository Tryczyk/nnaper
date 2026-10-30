/**
 * export-manager.js - Zaawansowany moduł eksportu tras telemetrycznych dla NNAPER
 * 
 * Funkcjonalności:
 * 1. Otwierany przyciskiem "Eksport trasy" w prawym panelu bocznym.
 * 2. Pełny panel eksportu (modal) z zakresem (Dzień, Miesiąc, Rok, Wszystko, Widoczne na mapie)
 *    oraz formatami wyjściowymi (HTML, PNG, SVG, GIF, GPX, CSV, GeoJSON, KML).
 * 3. Obsługa 3 trybów kolorowania śladu:
 *    - "speed" (ciągły 8-stopniowy gradient prędkości od 0 do 170+ km/h)
 *    - "altitude" (ciągły gradient topograficzny wysokości od minAlt do maxAlt)
 *    - "single" (jednolity kolor z próbnikiem color picker umożliwiającym wybór dowolnego koloru)
 * 4. Całkowite usunięcie oznaczeń "Start" i "Meta".
 * 5. Całkowite usunięcie profilu prędkości.
 * 6. Profil wysokości dołączany tylko przy krótkich trasach (<= 60 km) w obrębie 1 dnia.
 * 7. Segmentacja tras (splitIntoContiguousSegments) zapobiegająca łączeniu długich przerw/postojów prostą linią.
 * 8. Sanityzacja prędkości (cleanAndSanitizeSpeeds) eliminująca fałszywe piki GPS i stabilizująca Vmax wokół ~170 km/h.
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
        delay: Math.max(2, Math.round(delayMs / 10))
      });
    }

    buildPalette() {
      const colorCounts = new Map();
      for (let f = 0; f < this.frames.length; f++) {
        const d = this.frames[f].data;
        for (let i = 0; i < d.length; i += 8) {
          const r = d[i] & 0xf8;
          const g = d[i + 1] & 0xf8;
          const b = d[i + 2] & 0xf8;
          const key = (r << 16) | (g << 8) | b;
          colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
        }
      }

      const sorted = Array.from(colorCounts.entries()).sort((a, b) => b[1] - a[1]);
      const palette = [];
      palette.push([9, 13, 22]); // Tło #090d16

      for (let i = 0; i < sorted.length && palette.length < 256; i++) {
        const rgb = sorted[i][0];
        const r = (rgb >> 16) & 0xff;
        const g = (rgb >> 8) & 0xff;
        const b = rgb & 0xff;
        if (r === 9 && g === 13 && b === 22) continue;
        palette.push([r, g, b]);
      }

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

      // Header GIF89a
      const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
      for (const b of header) bytes.push(b);

      bytes.push(this.width & 0xff);
      bytes.push((this.width >> 8) & 0xff);
      bytes.push(this.height & 0xff);
      bytes.push((this.height >> 8) & 0xff);
      bytes.push(0xf7);
      bytes.push(0x00);
      bytes.push(0x00);

      for (let i = 0; i < 256; i++) {
        bytes.push(this.palette[i][0]);
        bytes.push(this.palette[i][1]);
        bytes.push(this.palette[i][2]);
      }

      const loopExt = [
        0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45,
        0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00
      ];
      for (const b of loopExt) bytes.push(b);

      for (let f = 0; f < this.frames.length; f++) {
        const frame = this.frames[f];
        bytes.push(0x21);
        bytes.push(0xf9);
        bytes.push(0x04);
        bytes.push(0x04);
        bytes.push(frame.delay & 0xff);
        bytes.push((frame.delay >> 8) & 0xff);
        bytes.push(0x00);
        bytes.push(0x00);

        bytes.push(0x2c);
        bytes.push(0x00); bytes.push(0x00);
        bytes.push(0x00); bytes.push(0x00);
        bytes.push(this.width & 0xff);
        bytes.push((this.width >> 8) & 0xff);
        bytes.push(this.height & 0xff);
        bytes.push((this.height >> 8) & 0xff);
        bytes.push(0x00);

        const indexedPixels = new Uint8Array(this.width * this.height);
        const d = frame.data;
        let pIdx = 0;
        for (let i = 0; i < d.length; i += 4) {
          indexedPixels[pIdx++] = this.findNearestColor(d[i], d[i + 1], d[i + 2]);
        }

        this.writeLzwData(bytes, indexedPixels, 8);
      }

      bytes.push(0x3b);
      return new Uint8Array(bytes);
    }

    writeLzwData(bytes, indices, minCodeSize) {
      bytes.push(minCodeSize);
      const clearCode = 1 << minCodeSize;
      const eoiCode = clearCode + 1;
      let nextCode = clearCode + 2;
      let codeSize = minCodeSize + 1;

      let curAccum = 0;
      let curBits = 0;
      const packet = [];

      function writePacket(pkt) {
        bytes.push(pkt.length);
        for (let i = 0; i < pkt.length; i++) bytes.push(pkt[i]);
        pkt.length = 0;
      }

      function outputCode(code) {
        curAccum |= (code << curBits);
        curBits += codeSize;
        while (curBits >= 8) {
          packet.push(curAccum & 0xff);
          if (packet.length === 254) writePacket(packet);
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

      if (curBits > 0) packet.push(curAccum & 0xff);
      if (packet.length > 0) writePacket(packet);
      bytes.push(0x00);
    }
  }

  // -------------------------------------------------------------
  // 2. PALETY KOLORÓW I GRADIENTY (PRĘDKOŚĆ, WYSOKOŚĆ, JEDNOLITY)
  // -------------------------------------------------------------
  const SPEED_STOPS = [
    { spd: 0,   r: 6,   g: 182, b: 212 }, // #06b6d4 Cyan
    { spd: 25,  r: 20,  g: 184, b: 166 }, // #14b8a6 Teal
    { spd: 50,  r: 34,  g: 197, b: 94  }, // #22c55e Green
    { spd: 75,  r: 132, g: 204, b: 22  }, // #84cc16 Lime
    { spd: 95,  r: 234, g: 179, b: 8   }, // #eab308 Yellow
    { spd: 115, r: 249, g: 115, b: 22  }, // #f97316 Orange
    { spd: 135, r: 239, g: 68,  b: 68  }, // #ef4444 Red
    { spd: 165, r: 225, g: 29,  b: 72  }  // #e11d48 Crimson
  ];

  const ALTITUDE_STOPS = [
    { pct: 0.00, r: 16,  g: 185, b: 129 }, // #10b981 Szmaragd / nizinna zieleń (dolina)
    { pct: 0.20, r: 132, g: 204, b: 22  }, // #84cc16 Limonka (pagórki)
    { pct: 0.40, r: 234, g: 179, b: 8   }, // #eab308 Żółty (wzniesienia)
    { pct: 0.65, r: 249, g: 115, b: 22  }, // #f97316 Pomarańcz (wyżyna)
    { pct: 0.85, r: 239, g: 68,  b: 68  }, // #ef4444 Czerwień (góry)
    { pct: 1.00, r: 168, g: 85,  b: 247 }  // #a855f7 Fiolet (szczyt)
  ];

  function hexToRgb(hex) {
    let c = (hex || '#06b6d4').replace(/^#/, '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    const num = parseInt(c, 16);
    if (isNaN(num)) return [6, 182, 212];
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function getSpeedRgb(spd) {
    const clamped = Math.max(0, Math.min(165, Number(spd) || 0));
    for (let i = 0; i < SPEED_STOPS.length - 1; i++) {
      const s0 = SPEED_STOPS[i];
      const s1 = SPEED_STOPS[i + 1];
      if (clamped >= s0.spd && clamped <= s1.spd) {
        const factor = (clamped - s0.spd) / (s1.spd - s0.spd);
        const r = Math.round(s0.r + (s1.r - s0.r) * factor);
        const g = Math.round(s0.g + (s1.g - s0.g) * factor);
        const b = Math.round(s0.b + (s1.b - s0.b) * factor);
        return [r, g, b];
      }
    }
    const last = SPEED_STOPS[SPEED_STOPS.length - 1];
    return [last.r, last.g, last.b];
  }

  function getAltitudeRgb(alt, minAlt, maxAlt) {
    const span = Math.max(10, maxAlt - minAlt);
    const validAlt = (alt !== null && alt !== undefined && !isNaN(Number(alt))) ? Number(alt) : minAlt;
    const rawPct = (validAlt - minAlt) / span;
    const clamped = Math.max(0, Math.min(1.0, rawPct));

    for (let i = 0; i < ALTITUDE_STOPS.length - 1; i++) {
      const s0 = ALTITUDE_STOPS[i];
      const s1 = ALTITUDE_STOPS[i + 1];
      if (clamped >= s0.pct && clamped <= s1.pct) {
        const factor = (clamped - s0.pct) / (s1.pct - s0.pct);
        const r = Math.round(s0.r + (s1.r - s0.r) * factor);
        const g = Math.round(s0.g + (s1.g - s0.g) * factor);
        const b = Math.round(s0.b + (s1.b - s0.b) * factor);
        return [r, g, b];
      }
    }
    const last = ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1];
    return [last.r, last.g, last.b];
  }

  function getTrackRgb(pt, options, stats) {
    const mode = options?.colorMode || 'speed';
    if (mode === 'altitude') {
      return getAltitudeRgb(pt.altitude, stats.minAlt, stats.maxAlt);
    } else if (mode === 'single') {
      return hexToRgb(options?.singleColor || '#06b6d4');
    } else {
      return getSpeedRgb(pt.speed_kmh || 0);
    }
  }

  function getTrackColor(pt, options, stats) {
    const [r, g, b] = getTrackRgb(pt, options, stats);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function getTrackHex(pt, options, stats) {
    const [r, g, b] = getTrackRgb(pt, options, stats);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // -------------------------------------------------------------
  // 3. STATYSTYKI, FILTROWANIE I SEGMENTACJA TRASY
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

  function cleanAndSanitizeSpeeds(points) {
    if (!points || !points.length) return;

    for (let i = 0; i < points.length; i++) {
      let spd = Number(points[i].speed_kmh) || 0;
      if (spd < 0) spd = 0;
      if (spd > 260) spd = 260;
      points[i].speed_kmh = spd;
    }

    // Filtr pojedynczych nierealistycznych szpilek GPS (np. natychmiastowy skok o >80 km/h powyżej 190 km/h z natychmiastowym spadkiem)
    for (let i = 1; i < points.length - 1; i++) {
      const prevSpd = points[i - 1].speed_kmh;
      const currSpd = points[i].speed_kmh;
      const nextSpd = points[i + 1].speed_kmh;

      if (currSpd > 190 && (currSpd - prevSpd > 80) && (currSpd - nextSpd > 80)) {
        points[i].speed_kmh = (prevSpd + nextSpd) / 2;
      }
    }
  }

  function splitIntoContiguousSegments(points) {
    if (!points || !points.length) return [];
    const segments = [];
    let currentSeg = [points[0]];

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      const tPrev = new Date(prev.timestamp).getTime();
      const tCurr = new Date(curr.timestamp).getTime();
      const dtSec = (isNaN(tPrev) || isNaN(tCurr)) ? 0 : Math.abs(tCurr - tPrev) / 1000;
      const dKm = haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);

      const prevDate = prev.timestamp ? prev.timestamp.slice(0, 10) : '';
      const currDate = curr.timestamp ? curr.timestamp.slice(0, 10) : '';
      const dateChanged = prevDate && currDate && prevDate !== currDate;

      // Warunki podziału na segmenty (zapobiegają długim prostym liniom):
      const isGap = dateChanged || dtSec > 180 || dKm > 1.5 || (dtSec > 60 && dKm > 0.8);

      if (isGap) {
        if (currentSeg.length > 0) {
          segments.push(currentSeg);
        }
        currentSeg = [curr];
      } else {
        currentSeg.push(curr);
      }
    }

    if (currentSeg.length > 0) {
      segments.push(currentSeg);
    }
    return segments;
  }

  function computeRouteStats(points, segments) {
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
    let sumSpd = 0;
    let minAlt = Infinity, maxAlt = -Infinity;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;

      sumSpd += (p.speed_kmh || 0);

      if (p.altitude !== null && p.altitude !== undefined && !isNaN(Number(p.altitude))) {
        const alt = Number(p.altitude);
        if (alt < minAlt) minAlt = alt;
        if (alt > maxAlt) maxAlt = alt;
      }
    }

    const segList = segments || splitIntoContiguousSegments(points);
    for (const seg of segList) {
      for (let j = 1; j < seg.length; j++) {
        dist += haversineDistanceKm(seg[j - 1].lat, seg[j - 1].lon, seg[j].lat, seg[j].lon);
      }
    }

    if (minAlt === Infinity) minAlt = 0;
    if (maxAlt === -Infinity) maxAlt = 50;
    if (maxAlt - minAlt < 5) maxAlt = minAlt + 20;

    let realisticVmax = 0;
    for (let i = 0; i < points.length; i++) {
      const s = points[i].speed_kmh || 0;
      if (s > realisticVmax) realisticVmax = s;
    }

    let drivingSeconds = 0;
    let movingSeconds = 0;

    for (const seg of segList) {
      let stationaryRunSec = 0;
      for (let j = 1; j < seg.length; j++) {
        const pPrev = seg[j - 1];
        const pCurr = seg[j];
        const tPrev = new Date(pPrev.timestamp).getTime();
        const tCurr = new Date(pCurr.timestamp).getTime();
        if (isNaN(tPrev) || isNaN(tCurr)) continue;

        const dtSec = (tCurr - tPrev) / 1000;
        // Pomiń przeskoki czasowe większe niż 180s (postój wyłączony, przerwa między podróżami)
        if (dtSec <= 0 || dtSec > 180) continue;

        const isMoving = (pCurr.speed_kmh || 0) > 2.0 || (pPrev.speed_kmh || 0) > 2.0;
        if (isMoving) {
          stationaryRunSec = 0;
          movingSeconds += dtSec;
          drivingSeconds += dtSec;
        } else {
          // Krótki postój na światłach / w korku - wliczamy do 3 minut
          stationaryRunSec += dtSec;
          if (stationaryRunSec <= 180) {
            drivingSeconds += dtSec;
          }
        }
      }
    }

    if (drivingSeconds <= 0 && points.length > 1) {
      drivingSeconds = Math.max(1, points.length);
    }

    const durationHours = drivingSeconds / 3600;
    const realAvgSpeed = durationHours > 0 ? (dist / durationHours) : 0;

    return {
      count: points.length,
      totalDistanceKm: dist,
      durationSeconds: Math.round(drivingSeconds),
      movingSeconds: Math.round(movingSeconds),
      avgSpeedKmh: Number(realAvgSpeed.toFixed(1)),
      maxSpeedKmh: realisticVmax,
      minAlt,
      maxAlt,
      startTime: points[0].timestamp,
      endTime: points[points.length - 1].timestamp,
      bounds: [minLon, minLat, maxLon, maxLat]
    };
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
  // 4. GENERATOR PNG (OBRAZ HD 1920x1080)
  // -------------------------------------------------------------
  function generatePng(points, segments, stats, titleText, scopeName, options = {}) {
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

    const isShortRoute = (stats.totalDistanceKm <= 60 && scopeName === 'day' && options.includeChart !== false);

    const [minLon, minLat, maxLon, maxLat] = stats.bounds;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);

    const mapX = 80;
    const mapY = 120;
    const mapW = W - 160;
    const mapH = isShortRoute ? (H - 320) : (H - 180);

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

    // Poświata pod trasą
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const [gr, gg, gb] = getTrackRgb(points[0], options, stats);
    ctx.strokeStyle = `rgba(${gr}, ${gg}, ${gb}, 0.25)`;
    ctx.lineWidth = 11;
    for (const seg of segments) {
      if (seg.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < seg.length; i++) {
        const [sx, sy] = toScreen(seg[i].lon, seg[i].lat);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }

    // Właściwa trasa z dynamicznym kolorem (speed / altitude / single)
    ctx.lineWidth = 4;
    for (const seg of segments) {
      for (let i = 1; i < seg.length; i++) {
        const p0 = seg[i - 1];
        const p1 = seg[i];
        const [x0, y0] = toScreen(p0.lon, p0.lat);
        const [x1, y1] = toScreen(p1.lon, p1.lat);

        ctx.strokeStyle = getTrackColor(p1, options, stats);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }

    // Karta informacyjna HUD (brak oznaczeń START i META)
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(80, 40, 520, 100, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText(`NNAPER • ${titleText.toUpperCase()}`, 100, 70);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13.5px system-ui, sans-serif';
    ctx.fillText(`Dystans: ${stats.totalDistanceKm.toFixed(2)} km   |   Czas jazdy: ${formatDuration(stats.durationSeconds)}`, 100, 96);
    ctx.fillText(`Śr. prędkość: ${stats.avgSpeedKmh.toFixed(1)} km/h   |   V max: ${stats.maxSpeedKmh.toFixed(1)} km/h`, 100, 120);

    // Profil wysokości wyłącznie dla krótkich tras jednodniowych
    if (isShortRoute) {
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
      ctx.fillText(`Profil wysokości n.p.m. (Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m)`, chartX + 15, chartY + 20);

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
    }

    // Dynamiczna Legenda w prawym górnym rogu
    const legX = W - 320;
    const legY = 40;
    const legW = 240;
    const legH = 75;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(legX, legY, legW, legH, 8);
    ctx.fill();
    ctx.stroke();

    const gradW = legW - 30;
    const mode = options.colorMode || 'speed';

    if (mode === 'altitude') {
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText('WYSOKOŚĆ (M N.P.M.)', legX + 15, legY + 22);

      const altGrad = ctx.createLinearGradient(legX + 15, 0, legX + 15 + gradW, 0);
      altGrad.addColorStop(0, '#10b981');
      altGrad.addColorStop(0.2, '#84cc16');
      altGrad.addColorStop(0.4, '#eab308');
      altGrad.addColorStop(0.65, '#f97316');
      altGrad.addColorStop(0.85, '#ef4444');
      altGrad.addColorStop(1, '#a855f7');

      ctx.fillStyle = altGrad;
      ctx.fillRect(legX + 15, legY + 34, gradW, 10);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px monospace';
      ctx.fillText(`${stats.minAlt.toFixed(0)}m`, legX + 15, legY + 58);
      ctx.fillText(`${((stats.minAlt + stats.maxAlt) / 2).toFixed(0)}m`, legX + 15 + gradW * 0.45, legY + 58);
      ctx.fillText(`${stats.maxAlt.toFixed(0)}m`, legX + 15 + gradW - 35, legY + 58);

    } else if (mode === 'single') {
      const sColor = options.singleColor || '#06b6d4';
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText('KOLOR ŚLADU', legX + 15, legY + 22);

      ctx.fillStyle = sColor;
      ctx.fillRect(legX + 15, legY + 34, gradW, 10);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '10px monospace';
      ctx.fillText(`Jednolity: ${sColor.toUpperCase()}`, legX + 15, legY + 58);

    } else {
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText('PRĘDKOŚĆ (KM/H)', legX + 15, legY + 22);

      const barGrad = ctx.createLinearGradient(legX + 15, 0, legX + 15 + gradW, 0);
      barGrad.addColorStop(0, '#06b6d4');
      barGrad.addColorStop(0.2, '#14b8a6');
      barGrad.addColorStop(0.35, '#22c55e');
      barGrad.addColorStop(0.5, '#84cc16');
      barGrad.addColorStop(0.65, '#eab308');
      barGrad.addColorStop(0.8, '#f97316');
      barGrad.addColorStop(0.92, '#ef4444');
      barGrad.addColorStop(1, '#e11d48');

      ctx.fillStyle = barGrad;
      ctx.fillRect(legX + 15, legY + 34, gradW, 10);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px monospace';
      ctx.fillText('0', legX + 15, legY + 58);
      ctx.fillText('50', legX + 15 + gradW * 0.32, legY + 58);
      ctx.fillText('100', legX + 15 + gradW * 0.62, legY + 58);
      ctx.fillText('170+', legX + 15 + gradW - 25, legY + 58);
    }

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png');
    });
  }

  // -------------------------------------------------------------
  // 5. GENERATOR SVG (WEKTOR BEZSTRATNY)
  // -------------------------------------------------------------
  function generateSvg(points, segments, stats, titleText, scopeName, options = {}) {
    const W = 1200;
    const H = 800;
    const [minLon, minLat, maxLon, maxLat] = stats.bounds;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);

    const includeElevation = options.includeChart !== false;

    const mapX = 60, mapY = 110;
    const mapW = W - 120;
    const mapH = includeElevation ? (H - 280) : (H - 140);

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
    for (const seg of segments) {
      for (let i = 1; i < seg.length; i++) {
        const [x0, y0] = toSvg(seg[i - 1].lon, seg[i - 1].lat);
        const [x1, y1] = toSvg(seg[i].lon, seg[i].lat);
        const col = getTrackHex(seg[i], options, stats);
        trackPaths += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>\n`;
      }
    }

    let elevationSvgSection = '';
    if (includeElevation) {
      const chartX = 60, chartY = H - 140, chartW = W - 120, chartH = 90;
      const altSpan = Math.max(10, stats.maxAlt - stats.minAlt);
      let chartPolyline = '';
      let minAltIdx = 0, maxAltIdx = 0;
      let minAltVal = Infinity, maxAltVal = -Infinity;

      for (let i = 0; i < points.length; i++) {
        const cx = (chartX + 15 + (i / Math.max(1, points.length - 1)) * (chartW - 30)).toFixed(1);
        const alt = points[i].altitude ?? stats.minAlt;
        if (alt < minAltVal) { minAltVal = alt; minAltIdx = i; }
        if (alt > maxAltVal) { maxAltVal = alt; maxAltIdx = i; }
        const cy = ((chartY + chartH - 15) - ((alt - stats.minAlt) / altSpan) * (chartH - 35)).toFixed(1);
        chartPolyline += `${cx},${cy} `;
      }

      const minCx = (chartX + 15 + (minAltIdx / Math.max(1, points.length - 1)) * (chartW - 30)).toFixed(1);
      const minCy = ((chartY + chartH - 15) - ((minAltVal - stats.minAlt) / altSpan) * (chartH - 35)).toFixed(1);
      const maxCx = (chartX + 15 + (maxAltIdx / Math.max(1, points.length - 1)) * (chartW - 30)).toFixed(1);
      const maxCy = ((chartY + chartH - 15) - ((maxAltVal - stats.minAlt) / altSpan) * (chartH - 35)).toFixed(1);

      elevationSvgSection = `
  <rect x="${chartX}" y="${chartY}" width="${chartW}" height="${chartH}" rx="8" fill="#0f172a" stroke="#1e293b"/>
  <text x="${chartX + 15}" y="${chartY + 20}" fill="#94a3b8" font-size="11">Profil wysokości n.p.m. (Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m)</text>
  <polyline points="${chartPolyline}" fill="none" stroke="#38bdf8" stroke-width="2"/>
  <circle cx="${maxCx}" cy="${maxCy}" r="4" fill="#10b981" stroke="#ffffff" stroke-width="1.5"/>
  <text x="${maxCx}" y="${Math.max(chartY + 22, maxCy - 6)}" fill="#10b981" font-size="10" font-weight="bold" text-anchor="middle">▲ MAX ${maxAltVal.toFixed(0)}m</text>
  <circle cx="${minCx}" cy="${minCy}" r="4" fill="#f59e0b" stroke="#ffffff" stroke-width="1.5"/>
  <text x="${minCx}" y="${Math.min(chartY + chartH - 4, Number(minCy) + 14)}" fill="#f59e0b" font-size="10" font-weight="bold" text-anchor="middle">▼ MIN ${minAltVal.toFixed(0)}m</text>
      `;
    }

    const mode = options.colorMode || 'speed';
    let legendGradientDef = '';
    let legendContent = '';

    if (mode === 'altitude') {
      legendGradientDef = `
    <linearGradient id="legendGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#10b981" />
      <stop offset="20%" stop-color="#84cc16" />
      <stop offset="40%" stop-color="#eab308" />
      <stop offset="65%" stop-color="#f97316" />
      <stop offset="85%" stop-color="#ef4444" />
      <stop offset="100%" stop-color="#a855f7" />
    </linearGradient>`;
      legendContent = `
    <rect width="210" height="65" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="15" y="20" fill="#94a3b8" font-size="10" font-weight="bold">WYSOKOŚĆ (M N.P.M.)</text>
    <rect x="15" y="28" width="180" height="8" rx="2" fill="url(#legendGrad)"/>
    <text x="15" y="50" fill="#94a3b8" font-size="9" font-family="monospace">${stats.minAlt.toFixed(0)}m</text>
    <text x="155" y="50" fill="#94a3b8" font-size="9" font-family="monospace">${stats.maxAlt.toFixed(0)}m</text>`;
    } else if (mode === 'single') {
      const sColor = options.singleColor || '#06b6d4';
      legendContent = `
    <rect width="210" height="65" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="15" y="20" fill="#94a3b8" font-size="10" font-weight="bold">KOLOR ŚLADU</text>
    <rect x="15" y="28" width="180" height="8" rx="2" fill="${sColor}"/>
    <text x="15" y="50" fill="#cbd5e1" font-size="9" font-family="monospace">${sColor.toUpperCase()}</text>`;
    } else {
      legendGradientDef = `
    <linearGradient id="legendGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#06b6d4" />
      <stop offset="20%" stop-color="#14b8a6" />
      <stop offset="35%" stop-color="#22c55e" />
      <stop offset="50%" stop-color="#84cc16" />
      <stop offset="65%" stop-color="#eab308" />
      <stop offset="80%" stop-color="#f97316" />
      <stop offset="92%" stop-color="#ef4444" />
      <stop offset="100%" stop-color="#e11d48" />
    </linearGradient>`;
      legendContent = `
    <rect width="210" height="65" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="15" y="20" fill="#94a3b8" font-size="10" font-weight="bold">PRĘDKOŚĆ (KM/H)</text>
    <rect x="15" y="28" width="180" height="8" rx="2" fill="url(#legendGrad)"/>
    <text x="15" y="50" fill="#94a3b8" font-size="9" font-family="monospace">0</text>
    <text x="95" y="50" fill="#94a3b8" font-size="9" font-family="monospace">90</text>
    <text x="165" y="50" fill="#94a3b8" font-size="9" font-family="monospace">170+</text>`;
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="background:#090d16; font-family:system-ui, -apple-system, sans-serif;">
  <defs>
    ${legendGradientDef}
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2.5" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" fill="#090d16"/>
  <rect x="${mapX}" y="${mapY}" width="${mapW}" height="${mapH}" fill="#0f172a" stroke="#1e293b" rx="8"/>

  <g filter="url(#glow)">
    ${trackPaths}
  </g>

  <!-- Karta HUD / Nagłówek -->
  <rect x="60" y="30" width="560" height="65" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="80" y="55" fill="#38bdf8" font-size="15" font-weight="bold">NNAPER • ${titleText.toUpperCase()}</text>
  <text x="80" y="78" fill="#cbd5e1" font-size="12">Dystans: ${stats.totalDistanceKm.toFixed(2)} km  |  Czas jazdy: ${formatDuration(stats.durationSeconds)}  |  Śr. prędkość: ${stats.avgSpeedKmh.toFixed(1)} km/h  |  V max: ${stats.maxSpeedKmh.toFixed(1)} km/h</text>

  <!-- Profil wysokości -->
  ${elevationSvgSection}

  <!-- Legenda -->
  <g transform="translate(${W - 270}, 30)">
    ${legendContent}
  </g>
</svg>`;

    return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  }

  // -------------------------------------------------------------
  // 6. GENERATOR ANIMOWANEGO GIF
  // -------------------------------------------------------------
  async function generateGif(points, segments, stats, titleText, scopeName, options = {}, onProgress = null) {
    if (!segments || !segments.length) {
      throw new Error('Brak segmentów trasy do wygenerowania animacji GIF.');
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

    // 1. Redukcja punktów wyłącznie w rozdzielczości ekranu (próg sub-pixel 0.74 px).
    // Gwarantuje 100% zachowanie krzywizn dróg, rond i łuków bez kanciastego upraszczania.
    const animSegments = [];
    const minScreenDistSq = 0.55; // (0.74 px)^2

    for (const seg of segments) {
      if (!seg || seg.length === 0) continue;
      if (seg.length <= 2) {
        animSegments.push([...seg]);
        continue;
      }
      const kept = [seg[0]];
      let [lastX, lastY] = toScreen(seg[0].lon, seg[0].lat);

      for (let i = 1; i < seg.length - 1; i++) {
        const pt = seg[i];
        const [sx, sy] = toScreen(pt.lon, pt.lat);
        const dx = sx - lastX;
        const dy = sy - lastY;
        if ((dx * dx + dy * dy) >= minScreenDistSq) {
          kept.push(pt);
          lastX = sx;
          lastY = sy;
        }
      }
      kept.push(seg[seg.length - 1]);
      animSegments.push(kept);
    }

    // 2. Przygotowanie płaskiej listy wszystkich odcinków do wyrysowania w animacji
    const allLines = [];
    for (const seg of animSegments) {
      for (let i = 1; i < seg.length; i++) {
        allLines.push({
          p0: seg[i - 1],
          p1: seg[i],
          color: getTrackColor(seg[i], options, stats)
        });
      }
    }

    let TOTAL_ANIM_FRAMES = 60;
    let delayMs = 65;
    if (options.gifSpeed === 'hd') {
      TOTAL_ANIM_FRAMES = 90;
      delayMs = 50;
    } else if (options.gifSpeed === 'fast') {
      TOTAL_ANIM_FRAMES = 40;
      delayMs = 50;
    } else {
      TOTAL_ANIM_FRAMES = 60;
      delayMs = 65;
    }
    const totalLines = allLines.length;

    for (let f = 0; f < TOTAL_ANIM_FRAMES; f++) {
      const progress = f / (TOTAL_ANIM_FRAMES - 1);
      const linesToDraw = Math.round(progress * totalLines);

      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(mapX, mapY, mapW, mapH, 6);
      ctx.fill();
      ctx.stroke();

      // 1. Przebyty odcinek trasy do bieżącej klatki (animowany ślad rysowany płynnie od zera)
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < linesToDraw; i++) {
        const line = allLines[i];
        const [x0, y0] = toScreen(line.p0.lon, line.p0.lat);
        const [x1, y1] = toScreen(line.p1.lon, line.p1.lat);
        ctx.strokeStyle = line.color;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // 3. Pozycja pojazdu i telemetria
      let currPt = null;
      if (linesToDraw > 0 && linesToDraw <= allLines.length) {
        currPt = allLines[linesToDraw - 1].p1;
      } else if (allLines.length > 0) {
        currPt = allLines[0].p0;
      } else if (points.length > 0) {
        currPt = points[0];
      }

      if (currPt) {
        const [carX, carY] = toScreen(currPt.lon, currPt.lat);
        // Poświata
        ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
        ctx.beginPath(); ctx.arc(carX, carY, 8, 0, Math.PI * 2); ctx.fill();
        // Kropka pojazdu
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath(); ctx.arc(carX, carY, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
      }

      // 4. Pasek postępu na dole okna
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, H - 6, W, 6);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(0, H - 6, W * progress, 6);

      // 5. Nagłówek HUD
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fillRect(mapX, 10, mapW, 50);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.strokeRect(mapX, 10, mapW, 50);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(`NNAPER REPLAY • ${titleText}`, mapX + 12, 28);

      let tStr = '--:--:--';
      if (currPt && currPt.timestamp) {
        const parts = currPt.timestamp.split('T');
        if (scopeName === 'day') {
          tStr = parts[1] ? parts[1].replace('Z', '').slice(0, 8) : parts[0];
        } else {
          tStr = `${parts[0]} ${parts[1] ? parts[1].replace('Z', '').slice(0, 5) : ''}`;
        }
      }
      const spdStr = (currPt && currPt.speed_kmh !== undefined) ? Number(currPt.speed_kmh).toFixed(1) : '0.0';
      const altStr = (currPt && currPt.altitude !== null && currPt.altitude !== undefined) ? `${Number(currPt.altitude).toFixed(0)}m` : '--';

      ctx.fillStyle = '#f8fafc';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`Czas: ${tStr}   |   V: ${spdStr} km/h   |   Wys.: ${altStr}   |   Postęp: ${(progress * 100).toFixed(0)}%`, mapX + 12, 48);

      encoder.addFrame(canvas, delayMs);

      if (onProgress) {
        onProgress(Math.round(((f + 1) / (TOTAL_ANIM_FRAMES + 1)) * 90));
      }

      // Zwróć sterowanie do przeglądarki, aby pasek postępu w DOM mógł się płynnie odświeżać
      if (f % 4 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Pojedyncza klatka zatrzymania na ukończonej trasie (750ms pauzy przed płynnym pętleniem GIF)
    encoder.addFrame(canvas, 750);

    if (onProgress) onProgress(95);

    const gifBytes = encoder.encode();
    return new Blob([gifBytes], { type: 'image/gif' });
  }

  // -------------------------------------------------------------
  // 7. GENERATOR INTERAKTYWNEGO HTML (STANDALONE)
  // -------------------------------------------------------------
  function generateHtml(points, segments, stats, titleText, scopeName, options = {}) {
    const includeElevation = options.includeChart !== false;
    const colorMode = options.colorMode || 'speed';
    const singleColor = options.singleColor || '#06b6d4';
    const defaultSpeed = 30;
    const includeGForce = options.includeGForce !== false;

    const hasGForceData = includeGForce && points.some(p => p.g_x !== null && p.g_x !== undefined && !isNaN(Number(p.g_x)));
    const showBottomPanel = includeElevation || hasGForceData;

    const rawJson = JSON.stringify(points);
    const statsJson = JSON.stringify(stats);
    const segsJson = JSON.stringify(segments.map(seg => seg.map(p => ({
      lat: p.lat,
      lon: p.lon,
      speed_kmh: p.speed_kmh,
      altitude: p.altitude,
      timestamp: p.timestamp,
      g_x: p.g_x,
      g_y: p.g_y,
      g_z: p.g_z
    }))));

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
    header { background: #0f172a; border-bottom: 1px solid #334155; padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; z-index: 100; flex-wrap: wrap; gap: 10px; }
    .title-box h1 { font-size: 15px; color: #38bdf8; font-weight: 700; }
    .title-box p { font-size: 11.5px; color: #94a3b8; margin-top: 2px; }
    .kpi-row { display: flex; gap: 14px; flex-wrap: wrap; }
    .kpi-item { display: flex; flex-direction: column; align-items: flex-end; }
    .kpi-lbl { font-size: 9.5px; text-transform: uppercase; color: #64748b; font-weight: 700; }
    .kpi-val { font-size: 13px; font-weight: 700; color: #f8fafc; font-family: ui-monospace, monospace; }
    #main-container { flex: 1; display: flex; flex-direction: column; position: relative; overflow: hidden; }
    #map { flex: 1; width: 100%; height: 100%; }

    #hud-card {
      position: absolute; top: 14px; right: 14px; z-index: 1000;
      background: rgba(15, 23, 42, 0.94); border: 1px solid #38bdf8;
      border-radius: 8px; padding: 10px 14px; min-width: 205px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.7); backdrop-filter: blur(8px);
    }
    .hud-header { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.5px; }
    .hud-line { display: flex; justify-content: space-between; font-size: 11.5px; margin-bottom: 3.5px; }
    .hud-lbl { color: #94a3b8; }
    .hud-v { font-weight: 700; color: #38bdf8; font-family: ui-monospace, monospace; }
    #hud-gg-box {
      margin-top: 8px; padding-top: 6px; border-top: 1px solid #1e293b;
      display: flex; flex-direction: column; align-items: center;
    }
    .hud-gg-title { font-size: 9px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 4px; letter-spacing: 0.4px; }
    #hud-gg-canvas { background: #090d16; border-radius: 50%; border: 1px solid #334155; box-shadow: inset 0 0 8px rgba(0,0,0,0.8); }

    .ctrl-bar {
      position: absolute; bottom: ${showBottomPanel ? '165px' : '20px'}; left: 50%; transform: translateX(-50%);
      z-index: 1000; background: rgba(15, 23, 42, 0.94); border: 1px solid #334155;
      border-radius: 30px; padding: 6px 16px; display: flex; align-items: center; gap: 9px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.7); backdrop-filter: blur(8px); max-width: 95vw;
      flex-wrap: wrap; justify-content: center; transition: bottom 0.2s ease;
    }
    .ctrl-bar.chart-collapsed { bottom: 38px !important; }
    .ctrl-btn {
      background: #1e293b; color: #f8fafc; border: 1px solid #475569;
      padding: 4.5px 13px; border-radius: 16px; font-size: 11.5px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; gap: 5px; transition: all 0.15s;
    }
    .ctrl-btn:hover { background: #38bdf8; color: #090d16; border-color: #38bdf8; }
    .ctrl-speed-box {
      display: inline-flex; align-items: center; gap: 4px;
      background: #1e293b; border: 1px solid #475569;
      padding: 2.5px 8px; border-radius: 12px; font-size: 11.5px;
      transition: border-color 0.15s;
    }
    .ctrl-speed-box:focus-within { border-color: #38bdf8; }
    .ctrl-speed-lbl { color: #94a3b8; font-weight: 500; }
    .ctrl-speed-input {
      background: transparent; color: #38bdf8; border: none; outline: none;
      width: 44px; text-align: center; font-size: 11.5px; font-weight: 700;
      font-family: ui-monospace, monospace;
      -moz-appearance: textfield;
    }
    .ctrl-speed-input::-webkit-outer-spin-button,
    .ctrl-speed-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .ctrl-speed-unit { color: #38bdf8; font-weight: 700; font-family: ui-monospace, monospace; font-size: 11px; }
    .ctrl-label { font-size: 11.5px; color: #94a3b8; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
    .ctrl-label input { accent-color: #38bdf8; cursor: pointer; }
    .ctrl-sep { height: 16px; width: 1px; background: #334155; }
    #timeline-slider { width: 180px; accent-color: #38bdf8; cursor: pointer; }
    @media (min-width: 768px) { #timeline-slider { width: 250px; } }

    #chart-panel {
      height: 150px; background: #0f172a; border-top: 1px solid #334155;
      padding: 6px 14px 8px 14px; display: ${showBottomPanel ? 'flex' : 'none'};
      flex-direction: column; position: relative; z-index: 900;
      transition: height 0.2s ease, padding 0.2s ease;
    }
    #chart-panel.collapsed { height: 26px !important; padding-top: 3px; padding-bottom: 3px; overflow: hidden; }
    #chart-panel.collapsed .chart-canvas-wrap { display: none; }
    .chart-header {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 11px; color: #94a3b8; margin-bottom: 4px; flex-wrap: wrap; gap: 6px;
    }
    .chart-tabs { display: flex; align-items: center; gap: 5px; }
    .chart-tab-btn {
      background: #1e293b; color: #94a3b8; border: 1px solid #334155;
      border-radius: 5px; padding: 2.5px 9px; font-size: 11px; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
    }
    .chart-tab-btn:hover { background: #334155; color: #f8fafc; }
    .chart-tab-btn.active {
      background: #0284c7; color: #ffffff; border-color: #38bdf8;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
    }
    .chart-legend-box {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      font-size: 11px; font-family: ui-monospace, monospace;
    }
    .g-pill {
      display: inline-flex; align-items: center; gap: 4px; padding: 1.5px 6.5px;
      border-radius: 4px; background: #1e293b; border: 1px solid #334155;
      cursor: pointer; user-select: none; transition: opacity 0.15s, border-color 0.15s;
    }
    .g-pill:hover { border-color: #64748b; }
    .g-pill.disabled { opacity: 0.35; text-decoration: line-through; }
    .g-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .chart-actions { display: flex; align-items: center; gap: 8px; }
    .chart-hint { color: #64748b; font-size: 10px; }
    @media (max-width: 700px) { .chart-hint { display: none; } }
    .chart-min-btn {
      background: #1e293b; color: #94a3b8; border: 1px solid #334155;
      border-radius: 4px; width: 22px; height: 20px; line-height: 18px;
      text-align: center; cursor: pointer; font-size: 11px;
    }
    .chart-min-btn:hover { background: #334155; color: #f8fafc; }
    .chart-canvas-wrap { flex: 1; width: 100%; height: 110px; position: relative; }
    #chart-canvas { width: 100%; height: 100%; cursor: crosshair; display: block; }
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
      <div class="kpi-item"><span class="kpi-lbl">Czas jazdy</span><span class="kpi-val">${formatDuration(stats.durationSeconds)}</span></div>
      <div class="kpi-item"><span class="kpi-lbl">Śr. prędkość</span><span class="kpi-val">${stats.avgSpeedKmh.toFixed(1)} km/h</span></div>
      <div class="kpi-item"><span class="kpi-lbl">V max</span><span class="kpi-val">${stats.maxSpeedKmh.toFixed(1)} km/h</span></div>
      <div class="kpi-item"><span class="kpi-lbl">Punkty</span><span class="kpi-val">${points.length}</span></div>
    </div>
  </header>

  <div id="main-container">
    <div id="map"></div>

    <div id="hud-card">
      <div class="hud-header">Telemetria pojazdu</div>
      <div class="hud-line"><span class="hud-lbl">Czas:</span><span id="h-time" class="hud-v">--:--:--</span></div>
      <div class="hud-line"><span class="hud-lbl">Prędkość:</span><span id="h-spd" class="hud-v">0.0 km/h</span></div>
      <div class="hud-line"><span class="hud-lbl">Wysokość:</span><span id="h-alt" class="hud-v">-- m</span></div>
      ${hasGForceData ? `
      <div id="hud-gg-box">
        <div class="hud-gg-title">Akcelerometr (G-G)</div>
        <canvas id="hud-gg-canvas" width="80" height="80"></canvas>
      </div>` : ''}
    </div>

    <div class="ctrl-bar">
      <button id="btn-play" class="ctrl-btn" type="button" title="Odtwórz / Wstrzymaj animację">▶ Odtwórz</button>
      <input type="range" id="timeline-slider" min="0" max="${Math.max(0, points.length - 1)}" value="0" />
      <span id="lbl-prog" style="font-size:11px; color:#94a3b8; font-family:monospace; min-width:65px;">1 / ${points.length}</span>
      <div class="ctrl-sep"></div>
      <div class="ctrl-speed-box" title="Wpisz dowolne tempo odtwarzania z ręki (np. 1, 15, 30, 60, 100)">
        <span class="ctrl-speed-lbl">Tempo:</span>
        <input type="number" id="speed-input" class="ctrl-speed-input" min="0.1" max="1000" step="any" value="30" />
        <span class="ctrl-speed-unit">x</span>
      </div>
      <div class="ctrl-sep"></div>
      <label class="ctrl-label" title="Śledź pojazd kamerą mapy">
        <input type="checkbox" id="chk-follow" checked />
        <span>Kamera</span>
      </label>
    </div>

    ${showBottomPanel ? `
    <div id="chart-panel">
      <div class="chart-header">
        <div class="chart-tabs">
          ${includeElevation ? '<button class="chart-tab-btn active" id="tab-btn-alt" type="button">🏔️ Profil wysokości</button>' : ''}
          ${hasGForceData ? '<button class="chart-tab-btn ' + (!includeElevation ? 'active' : '') + '" id="tab-btn-gforce" type="button">⚡ Przeciążenia G</button>' : ''}
          ${hasGForceData ? '<button class="chart-tab-btn" id="tab-btn-gg" type="button">🎯 Diagram G-G</button>' : ''}
        </div>

        <div class="chart-legend-box" id="chart-legend-alt" style="display: ${includeElevation ? 'flex' : 'none'};">
          <span style="color:#38bdf8;">Wysokość: <b id="val-alt">-- m</b></span>
          <span style="color:#64748b;">(Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m)</span>
        </div>

        <div class="chart-legend-box" id="chart-legend-gforce" style="display: ${(!includeElevation && hasGForceData) ? 'flex' : 'none'};">
          <span class="g-pill" id="pill-gx" title="Kliknij, aby włączyć/wyłączyć oś Gx (wzdłużne)">
            <span class="g-dot" style="background:#38bdf8;"></span> Gx: <b id="val-gx">--</b>
          </span>
          <span class="g-pill" id="pill-gy" title="Kliknij, aby włączyć/wyłączyć oś Gy (poprzeczne)">
            <span class="g-dot" style="background:#f59e0b;"></span> Gy: <b id="val-gy">--</b>
          </span>
          <span class="g-pill" id="pill-gz" title="Kliknij, aby włączyć/wyłączyć oś Gz (pionowe)">
            <span class="g-dot" style="background:#c084fc;"></span> Gz: <b id="val-gz">--</b>
          </span>
          <span class="g-pill disabled" id="pill-gmag" title="Kliknij, aby włączyć/wyłączyć wypadkowe |G|">
            <span class="g-dot" style="background:#10b981;"></span> |G|: <b id="val-gmag">--</b>
          </span>
        </div>

        <div class="chart-legend-box" id="chart-legend-gg" style="display: none;">
          <span style="color:#94a3b8;">Przeciążenie 2D (Gx vs Gy) | Max skręt: <b id="val-gg-max-lat" style="color:#f59e0b;">--</b> | Max wzdłużne: <b id="val-gg-max-lon" style="color:#38bdf8;">--</b></span>
        </div>

        <div class="chart-actions">
          <span class="chart-hint">Kliknij/przeciągnij, aby przewinąć trasę</span>
          <button class="chart-min-btn" id="btn-toggle-chart" type="button" title="Zwiń / Rozwiń wykres">▾</button>
        </div>
      </div>

      <div class="chart-canvas-wrap">
        <canvas id="chart-canvas"></canvas>
      </div>
    </div>` : ''}
  </div>

  <script>
    const points = ${rawJson};
    const segments = ${segsJson};
    const stats = ${statsJson};
    const colorMode = ${JSON.stringify(colorMode)};
    const singleColor = ${JSON.stringify(singleColor)};
    const minAlt = ${stats.minAlt};
    const maxAlt = ${stats.maxAlt};
    const hasGForceData = ${hasGForceData ? 'true' : 'false'};
    const includeElevation = ${includeElevation ? 'true' : 'false'};
    const showBottomPanel = ${showBottomPanel ? 'true' : 'false'};

    const SPEED_STOPS = [
      { spd: 0,   r: 6,   g: 182, b: 212 },
      { spd: 25,  r: 20,  g: 184, b: 166 },
      { spd: 50,  r: 34,  g: 197, b: 94  },
      { spd: 75,  r: 132, g: 204, b: 22  },
      { spd: 95,  r: 234, g: 179, b: 8   },
      { spd: 115, r: 249, g: 115, b: 22  },
      { spd: 135, r: 239, g: 68,  b: 68  },
      { spd: 165, r: 225, g: 29,  b: 72  }
    ];

    const ALTITUDE_STOPS = [
      { pct: 0.00, r: 16,  g: 185, b: 129 },
      { pct: 0.20, r: 132, g: 204, b: 22  },
      { pct: 0.40, r: 234, g: 179, b: 8   },
      { pct: 0.65, r: 249, g: 115, b: 22  },
      { pct: 0.85, r: 239, g: 68,  b: 68  },
      { pct: 1.00, r: 168, g: 85,  b: 247 }
    ];

    function getTrackColor(pt) {
      if (colorMode === 'single') return singleColor;
      if (colorMode === 'altitude') {
        const span = Math.max(10, maxAlt - minAlt);
        const alt = pt.altitude !== null ? pt.altitude : minAlt;
        const clamped = Math.max(0, Math.min(1.0, (alt - minAlt) / span));
        for (let i = 0; i < ALTITUDE_STOPS.length - 1; i++) {
          const s0 = ALTITUDE_STOPS[i];
          const s1 = ALTITUDE_STOPS[i + 1];
          if (clamped >= s0.pct && clamped <= s1.pct) {
            const f = (clamped - s0.pct) / (s1.pct - s0.pct);
            const r = Math.round(s0.r + (s1.r - s0.r) * f);
            const g = Math.round(s0.g + (s1.g - s0.g) * f);
            const b = Math.round(s0.b + (s1.b - s0.b) * f);
            return 'rgb(' + r + ',' + g + ',' + b + ')';
          }
        }
        return 'rgb(168, 85, 247)';
      }

      // Speed mode
      const spd = Math.max(0, Math.min(165, pt.speed_kmh || 0));
      for (let i = 0; i < SPEED_STOPS.length - 1; i++) {
        const s0 = SPEED_STOPS[i];
        const s1 = SPEED_STOPS[i + 1];
        if (spd >= s0.spd && spd <= s1.spd) {
          const f = (spd - s0.spd) / (s1.spd - s0.spd);
          const r = Math.round(s0.r + (s1.r - s0.r) * f);
          const g = Math.round(s0.g + (s1.g - s0.g) * f);
          const b = Math.round(s0.b + (s1.b - s0.b) * f);
          return 'rgb(' + r + ',' + g + ',' + b + ')';
        }
      }
      return 'rgb(225, 29, 72)';
    }

    if (!points || !points.length) {
      document.getElementById('map').innerHTML = '<div style="padding:20px; color:#ef4444;">Brak punktów trasy do wyświetlenia.</div>';
    } else {
      const map = L.map('map', { attributionControl: false }).setView([points[0].lat, points[0].lon], 13);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
      }).addTo(map);

      const allLatLngs = [];
      for (const seg of segments) {
        for (let i = 1; i < seg.length; i++) {
          allLatLngs.push([seg[i].lat, seg[i].lon]);
          const col = getTrackColor(seg[i]);
          L.polyline([[seg[i-1].lat, seg[i-1].lon], [seg[i].lat, seg[i].lon]], {
            color: col,
            weight: 4,
            opacity: 0.95
          }).addTo(map);
        }
      }

      if (allLatLngs.length > 0) {
        map.fitBounds(L.latLngBounds(allLatLngs), { padding: [40, 40] });
      }

      const carIcon = L.divIcon({
        html: '<div style="font-size:22px; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));">🚗</div>',
        className: 'car-icon',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      const carMarker = L.marker([points[0].lat, points[0].lon], { icon: carIcon }).addTo(map);

      const hTime = document.getElementById('h-time');
      const hSpd = document.getElementById('h-spd');
      const hAlt = document.getElementById('h-alt');
      const hGx = document.getElementById('h-gx');
      const hGy = document.getElementById('h-gy');
      const hGz = document.getElementById('h-gz');
      const hGmag = document.getElementById('h-gmag');
      const slider = document.getElementById('timeline-slider');
      const lblProg = document.getElementById('lbl-prog');
      const btnPlay = document.getElementById('btn-play');
      const speedInput = document.getElementById('speed-input');
      const chkFollow = document.getElementById('chk-follow');

      const chartPanel = document.getElementById('chart-panel');
      const ctrlBar = document.querySelector('.ctrl-bar');
      const btnToggleChart = document.getElementById('btn-toggle-chart');
      const canvas = document.getElementById('chart-canvas');

      const tabBtnGForce = document.getElementById('tab-btn-gforce');
      const tabBtnAlt = document.getElementById('tab-btn-alt');
      const tabBtnGG = document.getElementById('tab-btn-gg');

      const legendGForce = document.getElementById('chart-legend-gforce');
      const legendAlt = document.getElementById('chart-legend-alt');
      const legendGG = document.getElementById('chart-legend-gg');

      const pillGx = document.getElementById('pill-gx');
      const pillGy = document.getElementById('pill-gy');
      const pillGz = document.getElementById('pill-gz');
      const pillGmag = document.getElementById('pill-gmag');

      const valGx = document.getElementById('val-gx');
      const valGy = document.getElementById('val-gy');
      const valGz = document.getElementById('val-gz');
      const valGmag = document.getElementById('val-gmag');
      const valAlt = document.getElementById('val-alt');
      const valGgMaxLat = document.getElementById('val-gg-max-lat');
      const valGgMaxLon = document.getElementById('val-gg-max-lon');

      let activeTab = includeElevation ? 'alt' : (hasGForceData ? 'gforce' : 'none');
      const seriesVisible = { gx: true, gy: true, gz: true, gMag: false };

      // Prekalkulacja statystyk przeciążeń
      let minG = -1.0, maxG = 1.0;
      let peakLatG = 0.0, peakLonG = 0.0;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const gx = (p.g_x !== null && p.g_x !== undefined && !isNaN(Number(p.g_x))) ? Number(p.g_x) : null;
        const gy = (p.g_y !== null && p.g_y !== undefined && !isNaN(Number(p.g_y))) ? Number(p.g_y) : null;
        const gz = (p.g_z !== null && p.g_z !== undefined && !isNaN(Number(p.g_z))) ? Number(p.g_z) : null;

        if (gx !== null) {
          minG = Math.min(minG, gx);
          maxG = Math.max(maxG, gx);
          peakLonG = Math.max(peakLonG, Math.abs(gx));
        }
        if (gy !== null) {
          minG = Math.min(minG, gy);
          maxG = Math.max(maxG, gy);
          peakLatG = Math.max(peakLatG, Math.abs(gy));
        }
        if (gz !== null) {
          minG = Math.min(minG, gz);
          maxG = Math.max(maxG, gz);
        }
      }
      const spanG = Math.max(0.4, maxG - minG);
      minG = Math.floor((minG - spanG * 0.08) * 10) / 10;
      maxG = Math.ceil((maxG + spanG * 0.08) * 10) / 10;

      if (valGgMaxLat) valGgMaxLat.innerText = peakLatG.toFixed(2) + ' G';
      if (valGgMaxLon) valGgMaxLon.innerText = peakLonG.toFixed(2) + ' G';

      // Obliczenie timestampów
      const timestamps = points.map(p => {
        if (!p.timestamp) return null;
        const t = new Date(p.timestamp).getTime();
        return isNaN(t) ? null : t;
      });
      const hasTimestamps = timestamps.length > 0 && timestamps[0] !== null;

      let isPlaying = false;
      let animFrameId = null;
      let lastWallClock = performance.now();
      let currentIndex = 0;
      let virtualTime = (hasTimestamps && timestamps[0]) ? timestamps[0] : 0;
      let fallbackAccumMs = 0;

      function drawHudGG(idx) {
        const hudCanvas = document.getElementById('hud-gg-canvas');
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

        // Oznaczenia
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
        const pt = points[idx];
        if (pt && pt.g_x !== null && pt.g_y !== null) {
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

      function drawGForceTimeline(currIdx) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const reqW = Math.round(rect.width) || canvas.parentElement?.clientWidth || 800;
        const reqH = Math.round(rect.height) || 110;
        if (canvas.width !== reqW || canvas.height !== reqH) {
          canvas.width = reqW;
          canvas.height = reqH;
        }
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, W, H);

        const padLeft = 45;
        const padRight = 15;
        const padTop = 14;
        const padBottom = 20;
        const plotW = Math.max(10, W - padLeft - padRight);
        const plotH = Math.max(10, H - padTop - padBottom);

        function valToY(val) {
          return padTop + ((maxG - val) / (maxG - minG)) * plotH;
        }

        // Linie siatki Y
        const step = (maxG - minG) > 3.0 ? 1.0 : 0.5;
        const startVal = Math.ceil(minG / step) * step;
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (let v = startVal; v <= maxG + 0.001; v += step) {
          const y = valToY(v);
          const isZero = Math.abs(v) < 0.001;

          ctx.beginPath();
          ctx.moveTo(padLeft, y);
          ctx.lineTo(padLeft + plotW, y);
          ctx.strokeStyle = isZero ? '#64748b' : '#1e293b';
          ctx.lineWidth = isZero ? 1.5 : 1;
          ctx.setLineDash(isZero ? [4, 4] : [2, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = isZero ? '#94a3b8' : '#475569';
          ctx.fillText((v >= 0 ? '+' : '') + v.toFixed(1) + 'G', padLeft - 6, y);
        }

        // Serie wykresu
        const series = [
          { key: 'gx', color: '#38bdf8', width: 1.8, prop: 'g_x' },
          { key: 'gy', color: '#f59e0b', width: 1.8, prop: 'g_y' },
          { key: 'gz', color: '#c084fc', width: 1.8, prop: 'g_z' },
          { key: 'gMag', color: '#10b981', width: 1.5, prop: 'mag' }
        ];

        for (const s of series) {
          if (!seriesVisible[s.key]) continue;
          ctx.strokeStyle = s.color;
          ctx.lineWidth = s.width;
          ctx.beginPath();
          let inPath = false;

          for (let i = 0; i < points.length; i++) {
            const p = points[i];
            let val = null;
            if (s.key === 'gMag') {
              if (p.g_x !== null && p.g_y !== null && p.g_z !== null) {
                val = Math.hypot(Number(p.g_x), Number(p.g_y), Number(p.g_z));
              }
            } else {
              val = (p[s.prop] !== null && p[s.prop] !== undefined) ? Number(p[s.prop]) : null;
            }

            if (val === null || isNaN(val)) {
              inPath = false;
              continue;
            }

            const x = padLeft + (i / Math.max(1, points.length - 1)) * plotW;
            const y = valToY(val);

            if (!inPath) {
              ctx.moveTo(x, y);
              inPath = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        }

        // Kursor bieżącej pozycji
        if (points.length > 0 && currIdx >= 0 && currIdx < points.length) {
          const curX = padLeft + (currIdx / Math.max(1, points.length - 1)) * plotW;

          ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(curX, padTop);
          ctx.lineTo(curX, padTop + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          const pCur = points[currIdx];
          for (const s of series) {
            if (!seriesVisible[s.key]) continue;
            let val = null;
            if (s.key === 'gMag') {
              if (pCur.g_x !== null && pCur.g_y !== null && pCur.g_z !== null) {
                val = Math.hypot(Number(pCur.g_x), Number(pCur.g_y), Number(pCur.g_z));
              }
            } else {
              val = (pCur[s.prop] !== null && pCur[s.prop] !== undefined) ? Number(pCur[s.prop]) : null;
            }

            if (val !== null && !isNaN(val)) {
              const curY = valToY(val);
              ctx.fillStyle = s.color;
              ctx.beginPath();
              ctx.arc(curX, curY, 3.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
        }
      }

      function drawGGFrictionCircle(currIdx) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const reqW = Math.round(rect.width) || canvas.parentElement?.clientWidth || 800;
        const reqH = Math.round(rect.height) || 110;
        if (canvas.width !== reqW || canvas.height !== reqH) {
          canvas.width = reqW;
          canvas.height = reqH;
        }
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, W, H);

        const cx = W / 2;
        const cy = H / 2;
        const r = Math.min((W - 90) / 2, (H - 26) / 2);
        const maxScale = Math.max(1.2, Math.ceil(Math.max(peakLatG, peakLonG) * 10) / 10);

        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillStyle = '#475569';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';

        [0.5, 1.0, 1.5].forEach(circleG => {
          if (circleG <= maxScale) {
            const rad = (circleG / maxScale) * r;
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillText(circleG.toFixed(1) + 'G', cx + 3, cy - rad + 11);
          }
        });

        // Osie
        ctx.strokeStyle = '#334155';
        ctx.beginPath();
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
        ctx.stroke();

        ctx.fillStyle = '#64748b';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('▲ Przyspieszanie (+Gx)', cx, cy - r - 12);
        ctx.textBaseline = 'bottom';
        ctx.fillText('▼ Hamowanie (-Gx)', cx, cy + r + 12);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillText('◄ Lewo (-Gy)', cx - r - 8, cy);
        ctx.textAlign = 'left';
        ctx.fillText('Prawo (+Gy) ►', cx + r + 8, cy);

        // Punkty trasy (chmura)
        ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
        for (let i = 0; i < points.length; i += 2) {
          const p = points[i];
          if (p.g_x === null || p.g_y === null) continue;
          const px = cx + (Number(p.g_y) / maxScale) * r;
          const py = cy - (Number(p.g_x) / maxScale) * r;
          ctx.beginPath();
          ctx.arc(px, py, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Aktualny punkt
        const curP = points[currIdx];
        if (curP && curP.g_x !== null && curP.g_y !== null) {
          const curGx = Number(curP.g_x);
          const curGy = Number(curP.g_y);
          const px = cx + (curGy / maxScale) * r;
          const py = cy - (curGx / maxScale) * r;

          ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(px, py);
          ctx.stroke();

          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      function drawAltChart(currIdx) {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const reqW = Math.round(rect.width) || canvas.parentElement?.clientWidth || 800;
        const reqH = Math.round(rect.height) || 110;
        if (canvas.width !== reqW || canvas.height !== reqH) {
          canvas.width = reqW;
          canvas.height = reqH;
        }
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, W, H);

        const padLeft = 45;
        const padRight = 15;
        const padTop = 14;
        const padBottom = 20;
        const plotW = Math.max(10, W - padLeft - padRight);
        const plotH = Math.max(10, H - padTop - padBottom);

        const minA = stats.minAlt;
        const maxA = Math.max(minA + 10, stats.maxAlt);
        const altSpan = maxA - minA;

        function altToY(a) {
          return padTop + ((maxA - a) / altSpan) * plotH;
        }

        // Siatka
        const stepA = altSpan > 200 ? 50 : (altSpan > 50 ? 20 : 10);
        const startA = Math.ceil(minA / stepA) * stepA;
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = '#1e293b';
        ctx.fillStyle = '#475569';

        for (let a = startA; a <= maxA; a += stepA) {
          const y = altToY(a);
          ctx.beginPath();
          ctx.moveTo(padLeft, y);
          ctx.lineTo(padLeft + plotW, y);
          ctx.setLineDash([2, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillText(a.toFixed(0) + 'm', padLeft - 6, y);
        }

        // Gradient
        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
        grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

        ctx.beginPath();
        let inPath = false;
        for (let i = 0; i < points.length; i++) {
          const a = points[i].altitude ?? minA;
          const x = padLeft + (i / Math.max(1, points.length - 1)) * plotW;
          const y = altToY(a);
          if (!inPath) { ctx.moveTo(x, y); inPath = true; }
          else { ctx.lineTo(x, y); }
        }
        ctx.lineTo(padLeft + plotW, padTop + plotH);
        ctx.lineTo(padLeft, padTop + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Linia profilu
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        inPath = false;
        for (let i = 0; i < points.length; i++) {
          const a = points[i].altitude ?? minA;
          const x = padLeft + (i / Math.max(1, points.length - 1)) * plotW;
          const y = altToY(a);
          if (!inPath) { ctx.moveTo(x, y); inPath = true; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();

        // Oznaczenie punktów MIN i MAX na profilu wysokości
        let actualMinA = Infinity, actualMaxA = -Infinity;
        let minIdx = -1, maxIdx = -1;
        for (let i = 0; i < points.length; i++) {
          const rawA = points[i].altitude;
          if (rawA !== null && rawA !== undefined && !isNaN(rawA)) {
            const a = Number(rawA);
            if (a < actualMinA) {
              actualMinA = a;
              minIdx = i;
            }
            if (a > actualMaxA) {
              actualMaxA = a;
              maxIdx = i;
            }
          }
        }

        if (minIdx >= 0 && maxIdx >= 0 && points.length > 1) {
          const minX = padLeft + (minIdx / (points.length - 1)) * plotW;
          const minY = altToY(actualMinA);
          const maxX = padLeft + (maxIdx / (points.length - 1)) * plotW;
          const maxY = altToY(actualMaxA);

          ctx.save();
          // Przerywane linie poziome od osi Y do punktów skrajnych
          ctx.setLineDash([3, 4]);
          ctx.lineWidth = 1;

          // Pozioma linia Max (szmaragdowa)
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.45)';
          ctx.beginPath();
          ctx.moveTo(padLeft, maxY);
          ctx.lineTo(padLeft + plotW, maxY);
          ctx.stroke();

          // Pozioma linia Min (bursztynowa)
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
          ctx.beginPath();
          ctx.moveTo(padLeft, minY);
          ctx.lineTo(padLeft + plotW, minY);
          ctx.stroke();
          ctx.restore();

          // Funkcja rysująca etykietę ze strzałką i wartością (pill badge)
          function drawAltBadge(x, y, text, isMax) {
            const badgeW = 76;
            const badgeH = 17;
            let boxY = isMax ? (y - badgeH - 6) : (y + 6);
            if (boxY < padTop + 2) boxY = y + 6;
            if (boxY + badgeH > padTop + plotH - 2) boxY = y - badgeH - 6;

            let boxX = x - badgeW / 2;
            if (boxX < padLeft + 2) boxX = padLeft + 2;
            if (boxX + badgeW > padLeft + plotW - 2) boxX = padLeft + plotW - badgeW - 2;

            const themeColor = isMax ? '#10b981' : '#f59e0b';

            // Ramka z tłem
            ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
            ctx.strokeStyle = themeColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(boxX, boxY, badgeW, badgeH, 4);
            ctx.fill();
            ctx.stroke();

            // Napis
            ctx.font = 'bold 9.5px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = themeColor;
            ctx.fillText(text, boxX + badgeW / 2, boxY + badgeH / 2);

            // Kropka punktu na profilu
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = themeColor;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }

          drawAltBadge(maxX, maxY, '▲ MAX ' + actualMaxA.toFixed(0) + 'm', true);
          drawAltBadge(minX, minY, '▼ MIN ' + actualMinA.toFixed(0) + 'm', false);
        }

        // Kursor
        if (points.length > 0 && currIdx >= 0 && currIdx < points.length) {
          const curX = padLeft + (currIdx / Math.max(1, points.length - 1)) * plotW;
          const curA = points[currIdx].altitude ?? minA;
          const curY = altToY(curA);

          ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(curX, padTop);
          ctx.lineTo(curX, padTop + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.arc(curX, curY, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      function updateChart(currIdx) {
        if (!canvas || !showBottomPanel) return;
        if (activeTab === 'gforce') {
          drawGForceTimeline(currIdx);
        } else if (activeTab === 'alt') {
          drawAltChart(currIdx);
        } else if (activeTab === 'gg') {
          drawGGFrictionCircle(currIdx);
        }
      }

      function renderCarAt(idx) {
        if (idx < 0 || idx >= points.length) return;
        currentIndex = idx;
        const pt = points[idx];
        carMarker.setLatLng([pt.lat, pt.lon]);

        if (chkFollow && chkFollow.checked) {
          map.panTo([pt.lat, pt.lon], { animate: false });
        }

        if (hTime) {
          if (pt.timestamp) {
            const parts = pt.timestamp.split('T');
            hTime.innerText = parts[1] ? parts[1].replace('Z', '') : parts[0];
          } else {
            hTime.innerText = '--:--:--';
          }
        }
        if (hSpd) hSpd.innerText = (pt.speed_kmh || 0).toFixed(1) + ' km/h';
        if (hAlt) hAlt.innerText = (pt.altitude !== null && pt.altitude !== undefined && !isNaN(Number(pt.altitude))) ? Number(pt.altitude).toFixed(1) + ' m' : '--';

        const gx = (pt.g_x !== null && pt.g_x !== undefined && !isNaN(Number(pt.g_x))) ? Number(pt.g_x) : null;
        const gy = (pt.g_y !== null && pt.g_y !== undefined && !isNaN(Number(pt.g_y))) ? Number(pt.g_y) : null;
        const gz = (pt.g_z !== null && pt.g_z !== undefined && !isNaN(Number(pt.g_z))) ? Number(pt.g_z) : null;
        const gMag = (gx !== null && gy !== null && gz !== null) ? Math.hypot(gx, gy, gz) : null;

        if (hGx) hGx.innerText = gx !== null ? ((gx >= 0 ? '+' : '') + gx.toFixed(3) + ' G') : '--';
        if (hGy) hGy.innerText = gy !== null ? ((gy >= 0 ? '+' : '') + gy.toFixed(3) + ' G') : '--';
        if (hGz) hGz.innerText = gz !== null ? ((gz >= 0 ? '+' : '') + gz.toFixed(3) + ' G') : '--';
        if (hGmag) hGmag.innerText = gMag !== null ? (gMag.toFixed(3) + ' G') : '--';

        if (valGx) valGx.innerText = gx !== null ? ((gx >= 0 ? '+' : '') + gx.toFixed(2) + ' G') : '--';
        if (valGy) valGy.innerText = gy !== null ? ((gy >= 0 ? '+' : '') + gy.toFixed(2) + ' G') : '--';
        if (valGz) valGz.innerText = gz !== null ? ((gz >= 0 ? '+' : '') + gz.toFixed(2) + ' G') : '--';
        if (valGmag) valGmag.innerText = gMag !== null ? (gMag.toFixed(2) + ' G') : '--';
        if (valAlt) valAlt.innerText = (pt.altitude !== null && pt.altitude !== undefined && !isNaN(Number(pt.altitude))) ? Number(pt.altitude).toFixed(1) + ' m' : '-- m';

        if (slider) slider.value = idx;
        if (lblProg) lblProg.innerText = (idx + 1) + ' / ' + points.length;

        drawHudGG(idx);
        updateChart(idx);
      }

      function stopPlayback() {
        isPlaying = false;
        if (animFrameId) {
          cancelAnimationFrame(animFrameId);
          animFrameId = null;
        }
        btnPlay.innerText = '▶ Odtwórz';
      }

      function startPlayback() {
        if (currentIndex >= points.length - 1) {
          currentIndex = 0;
          if (hasTimestamps && timestamps[0] !== null) {
            virtualTime = timestamps[0];
          }
          renderCarAt(0);
        }
        isPlaying = true;
        btnPlay.innerText = '⏸ Pauza';
        lastWallClock = performance.now();
        if (hasTimestamps && timestamps[currentIndex] !== null) {
          virtualTime = timestamps[currentIndex];
        }
        fallbackAccumMs = 0;
        animFrameId = requestAnimationFrame(playbackLoop);
      }

      function playbackLoop(now) {
        if (!isPlaying) return;

        const deltaWall = Math.min(250, now - lastWallClock);
        lastWallClock = now;

        const parsedMult = speedInput ? parseFloat(speedInput.value) : 30;
        const mult = (!isNaN(parsedMult) && parsedMult > 0) ? parsedMult : 30;

        if (hasTimestamps) {
          virtualTime += deltaWall * mult;

          let targetIndex = currentIndex;
          while (targetIndex < points.length - 1) {
            const nextT = timestamps[targetIndex + 1];
            const currT = timestamps[targetIndex];

            // Pomiń postoje dłuższe niż 5 minut
            if (nextT !== null && currT !== null && (nextT - currT > 5 * 60 * 1000) && virtualTime < nextT) {
              virtualTime = nextT;
            }

            if (nextT !== null && virtualTime >= nextT) {
              targetIndex++;
            } else {
              break;
            }
          }

          if (targetIndex !== currentIndex) {
            renderCarAt(targetIndex);
          }

          if (currentIndex >= points.length - 1) {
            stopPlayback();
            return;
          }
        } else {
          fallbackAccumMs += deltaWall * mult;
          const stepMs = 1000;
          const stepCount = Math.floor(fallbackAccumMs / stepMs);
          if (stepCount > 0) {
            fallbackAccumMs -= stepCount * stepMs;
            const nextIdx = Math.min(points.length - 1, currentIndex + stepCount);
            if (nextIdx !== currentIndex) {
              renderCarAt(nextIdx);
            }
            if (currentIndex >= points.length - 1) {
              stopPlayback();
              return;
            }
          }
        }

        animFrameId = requestAnimationFrame(playbackLoop);
      }

      btnPlay.addEventListener('click', () => {
        if (isPlaying) {
          stopPlayback();
        } else {
          startPlayback();
        }
      });

      slider.addEventListener('input', (e) => {
        const idx = parseInt(e.target.value, 10);
        if (hasTimestamps && timestamps[idx] !== null) {
          virtualTime = timestamps[idx];
        }
        renderCarAt(idx);
      });

      if (speedInput) {
        const onSpeedChange = () => {
          lastWallClock = performance.now();
          if (hasTimestamps && timestamps[currentIndex] !== null) {
            virtualTime = timestamps[currentIndex];
          }
          fallbackAccumMs = 0;
        };
        speedInput.addEventListener('input', onSpeedChange);
        speedInput.addEventListener('change', onSpeedChange);
      }

      // Obsługa zakładek wykresów
      function switchTab(tab) {
        activeTab = tab;
        if (tabBtnGForce) tabBtnGForce.classList.toggle('active', tab === 'gforce');
        if (tabBtnAlt) tabBtnAlt.classList.toggle('active', tab === 'alt');
        if (tabBtnGG) tabBtnGG.classList.toggle('active', tab === 'gg');

        if (legendGForce) legendGForce.style.display = (tab === 'gforce') ? 'flex' : 'none';
        if (legendAlt) legendAlt.style.display = (tab === 'alt') ? 'flex' : 'none';
        if (legendGG) legendGG.style.display = (tab === 'gg') ? 'flex' : 'none';

        updateChart(currentIndex);
      }
      if (tabBtnGForce) tabBtnGForce.addEventListener('click', () => switchTab('gforce'));
      if (tabBtnAlt) tabBtnAlt.addEventListener('click', () => switchTab('alt'));
      if (tabBtnGG) tabBtnGG.addEventListener('click', () => switchTab('gg'));

      // Obsługa włączania/wyłączania osi w wykresie przeciążeń
      function setupPill(pillEl, seriesKey) {
        if (!pillEl) return;
        pillEl.addEventListener('click', () => {
          seriesVisible[seriesKey] = !seriesVisible[seriesKey];
          pillEl.classList.toggle('disabled', !seriesVisible[seriesKey]);
          updateChart(currentIndex);
        });
      }
      setupPill(pillGx, 'gx');
      setupPill(pillGy, 'gy');
      setupPill(pillGz, 'gz');
      setupPill(pillGmag, 'gMag');

      // Zwijanie / Rozwijanie panelu wykresu
      if (btnToggleChart && chartPanel) {
        btnToggleChart.addEventListener('click', () => {
          const isCollapsed = chartPanel.classList.toggle('collapsed');
          if (ctrlBar) ctrlBar.classList.toggle('chart-collapsed', isCollapsed);
          btnToggleChart.innerText = isCollapsed ? '▴' : '▾';
          if (!isCollapsed) {
            setTimeout(() => updateChart(currentIndex), 120);
          }
        });
      }

      // Interaktywne przewijanie na osi czasu wykresu
      if (canvas) {
        function seekOnCanvas(e) {
          if (activeTab === 'gg') return;
          const rect = canvas.getBoundingClientRect();
          const clientX = e.touches ? e.touches[0].clientX : e.clientX;
          const padLeft = 45;
          const plotW = Math.max(1, rect.width - 60);
          const clickX = clientX - rect.left - padLeft;
          const ratio = Math.max(0, Math.min(1, clickX / plotW));
          const newIdx = Math.round(ratio * (points.length - 1));
          if (hasTimestamps && timestamps[newIdx] !== null) {
            virtualTime = timestamps[newIdx];
          }
          renderCarAt(newIdx);
        }

        let isDragging = false;
        canvas.addEventListener('mousedown', (e) => { isDragging = true; seekOnCanvas(e); });
        window.addEventListener('mousemove', (e) => { if (isDragging) seekOnCanvas(e); });
        window.addEventListener('mouseup', () => { isDragging = false; });
        canvas.addEventListener('touchstart', (e) => { isDragging = true; seekOnCanvas(e); }, { passive: true });
        window.addEventListener('touchmove', (e) => { if (isDragging) seekOnCanvas(e); }, { passive: true });
        window.addEventListener('touchend', () => { isDragging = false; });
      }

      renderCarAt(0);

      window.addEventListener('resize', () => {
        drawHudGG(currentIndex);
        updateChart(currentIndex);
      });
      setTimeout(() => {
        drawHudGG(currentIndex);
        updateChart(currentIndex);
      }, 120);
    }
  </script>
</body>
</html>`;

    return new Blob([html], { type: 'text/html;charset=utf-8' });
  }

  // -------------------------------------------------------------
  // 8. GENERATORY PLIKÓW DANYCH (GPX, CSV, GEOJSON, KML)
  // -------------------------------------------------------------
  function generateGpx(points, segments, stats, titleText) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NNAPER" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Trasa ${titleText}</name></metadata>
  <trk>
    <name>Trasa NNAPER - ${titleText}</name>
`;
    for (const seg of segments) {
      xml += '    <trkseg>\n';
      for (const p of seg) {
        xml += `      <trkpt lat="${p.lat}" lon="${p.lon}">\n`;
        if (p.altitude !== null && p.altitude !== undefined) xml += `        <ele>${p.altitude}</ele>\n`;
        if (p.timestamp) xml += `        <time>${p.timestamp}</time>\n`;
        if (p.speed_kmh !== null && p.speed_kmh !== undefined) {
          xml += `        <speed>${(Number(p.speed_kmh) / 3.6).toFixed(2)}</speed>\n`;
        }
        xml += `      </trkpt>\n`;
      }
      xml += '    </trkseg>\n';
    }
    xml += '  </trk>\n</gpx>';
    return new Blob([xml], { type: 'application/gpx+xml;charset=utf-8' });
  }

  function generateCsv(points, segments, stats, titleText) {
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

  function generateGeoJson(points, segments, stats, titleText) {
    const multiCoords = segments.map(seg => seg.map(p => [p.lon, p.lat, p.altitude || 0]));
    const geo = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: multiCoords
          },
          properties: {
            name: `Trasa ${titleText}`,
            distance_km: stats.totalDistanceKm,
            duration_seconds: stats.durationSeconds,
            points_count: points.length,
            segments_count: segments.length,
            avg_speed_kmh: stats.avgSpeedKmh,
            max_speed_kmh: stats.maxSpeedKmh
          }
        }
      ]
    };
    return new Blob([JSON.stringify(geo, null, 2)], { type: 'application/geo+json;charset=utf-8' });
  }

  function generateKml(points, segments, stats, titleText, options = {}) {
    let kmlColor = 'ff00d406'; // domyślny błękit w formacie aabbggrr
    if (options.colorMode === 'single' && options.singleColor) {
      const [r, g, b] = hexToRgb(options.singleColor);
      const toHex2 = (n) => String(n.toString(16)).padStart(2, '0');
      kmlColor = `ff${toHex2(b)}${toHex2(g)}${toHex2(r)}`;
    }

    let placemarks = '';
    for (let s = 0; s < segments.length; s++) {
      const coordsStr = segments[s].map(p => `${p.lon},${p.lat},${p.altitude || 0}`).join(' ');
      placemarks += `    <Placemark>
      <name>Segment ${s + 1}</name>
      <styleUrl>#routeStyle</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coordsStr}</coordinates>
      </LineString>
    </Placemark>\n`;
    }

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Trasa NNAPER - ${titleText}</name>
    <Style id="routeStyle">
      <LineStyle>
        <color>${kmlColor}</color>
        <width>4</width>
      </LineStyle>
    </Style>
${placemarks}
  </Document>
</kml>`;
    return new Blob([kml], { type: 'application/vnd.google-earth.kml+xml;charset=utf-8' });
  }

  // -------------------------------------------------------------
  // 9. OBSŁUGA MODALA I LOGIKA INTERFEJSU EKSPORTU
  // -------------------------------------------------------------
  let cachedDatesTree = null;
  let activeScope = 'day';
  let activeFormat = 'html';

  const modalBackdrop = document.getElementById('export-modal-backdrop');
  const btnClose = document.getElementById('btn-close-export');
  const btnCancel = document.getElementById('btn-cancel-export');
  const btnDoExport = document.getElementById('btn-do-export');
  const btnOpenMenu = document.getElementById('btn-open-export');

  const selDay = document.getElementById('export-sel-day');
  const selYear = document.getElementById('export-sel-year');
  const selYearM = document.getElementById('export-sel-year-m');
  const selMonth = document.getElementById('export-sel-month');

  const selColorMode = document.getElementById('export-opt-color-mode');
  const inSingleColor = document.getElementById('export-opt-single-color');
  const chkIncludeChart = document.getElementById('export-opt-include-chart');
  const chartRow = document.getElementById('opt-chart-row');
  const chkIncludeGForce = document.getElementById('export-opt-include-gforce');
  const gforceRow = document.getElementById('opt-gforce-row');
  const selGifSpeed = document.getElementById('export-opt-gif-speed');
  const gifSpeedRow = document.getElementById('opt-gif-speed-row');

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

    if (chartRow) {
      chartRow.style.display = (activeFormat === 'html' || activeFormat === 'svg' || scope === 'day') ? 'flex' : 'none';
    }
  }

  function setFormat(fmt) {
    activeFormat = fmt;
    document.querySelectorAll('.format-card').forEach(c => {
      c.classList.toggle('active', c.getAttribute('data-format') === fmt);
    });

    if (gifSpeedRow) {
      gifSpeedRow.style.display = (fmt === 'gif') ? 'flex' : 'none';
    }
    if (gforceRow) {
      gforceRow.style.display = (fmt === 'html') ? 'flex' : 'none';
    }
    if (chartRow) {
      chartRow.style.display = (fmt === 'html' || fmt === 'svg' || activeScope === 'day') ? 'flex' : 'none';
    }
  }

  // Obsługa wyboru koloru: prędkość / wysokość / jednolity
  if (selColorMode) {
    selColorMode.addEventListener('change', () => {
      const mode = selColorMode.value;
      if (inSingleColor) {
        inSingleColor.style.display = (mode === 'single') ? 'inline-block' : 'none';
      }
    });
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

    if (selColorMode && inSingleColor) {
      inSingleColor.style.display = (selColorMode.value === 'single') ? 'inline-block' : 'none';
    }
  }

  function closeExportModal() {
    if (modalBackdrop) modalBackdrop.style.display = 'none';
  }

  // Podpięcie zdarzeń
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

  async function performExport() {
    if (btnDoExport) btnDoExport.disabled = true;
    if (statusBox) statusBox.style.display = 'block';
    if (progressFill) progressFill.style.width = '15%';
    if (statusText) statusText.innerText = 'Pobieranie punktów trasy z bazy...';

    const colorMode = selColorMode ? selColorMode.value : 'speed';
    const singleColor = inSingleColor ? inSingleColor.value : '#06b6d4';
    const includeChart = chkIncludeChart ? chkIncludeChart.checked : true;
    const includeGForce = chkIncludeGForce ? chkIncludeGForce.checked : true;
    const gifSpeed = selGifSpeed ? selGifSpeed.value : 'normal';

    const options = {
      colorMode,
      singleColor,
      includeChart,
      includeGForce,
      gifSpeed
    };

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

      const rawPoints = await res.json();
      if (!rawPoints || !rawPoints.length) {
        throw new Error('Brak punktów telemetrycznych w wybranym okresie.');
      }

      // 0. Oczyszczenie punktów z błędnych współrzędnych (np. null, NaN, (0,0) przed fixem GPS)
      const points = rawPoints.map(p => {
        p.lat = Number(p.lat);
        p.lon = Number(p.lon);
        p.speed_kmh = Number(p.speed_kmh) || 0;
        return p;
      }).filter(p => (
        !isNaN(p.lat) && !isNaN(p.lon) &&
        p.lat >= -90 && p.lat <= 90 &&
        p.lon >= -180 && p.lon <= 180 &&
        !(Math.abs(p.lat) < 1.0 && Math.abs(p.lon) < 1.0)
      ));

      if (!points.length) {
        throw new Error('Brak prawidłowych współrzędnych GPS w wybranym okresie.');
      }

      if (statusText) statusText.innerText = `Przetwarzanie ${points.length} epok...`;
      if (progressFill) progressFill.style.width = '55%';

      // 1. Sanityzacja prędkości (usunięcie szumów GPS)
      cleanAndSanitizeSpeeds(points);

      // 2. Segmentacja na ciągłe przejazdy (eliminacja długich prostych linii)
      const segments = splitIntoContiguousSegments(points);
      const stats = computeRouteStats(points, segments);
      const filenameBase = `trasa_${scopeFilename}`;

      if (statusText) statusText.innerText = `Generowanie formatu ${activeFormat.toUpperCase()}...`;

      let blob = null;
      let outExt = activeFormat;

      if (activeFormat === 'html') {
        blob = generateHtml(points, segments, stats, title, activeScope, options);
        outExt = 'html';
      } else if (activeFormat === 'svg') {
        blob = generateSvg(points, segments, stats, title, activeScope, options);
        outExt = 'svg';
      } else if (activeFormat === 'png') {
        blob = await generatePng(points, segments, stats, title, activeScope, options);
        outExt = 'png';
      } else if (activeFormat === 'gif') {
        blob = await generateGif(points, segments, stats, title, activeScope, options, (pct) => {
          if (progressFill) progressFill.style.width = `${55 + pct * 0.4}%`;
          if (statusText) statusText.innerText = `Renderowanie klatek GIF (${pct}%)...`;
        });
        outExt = 'gif';
      } else if (activeFormat === 'gpx') {
        blob = generateGpx(points, segments, stats, title);
        outExt = 'gpx';
      } else if (activeFormat === 'csv') {
        blob = generateCsv(points, segments, stats, title);
        outExt = 'csv';
      } else if (activeFormat === 'geojson') {
        blob = generateGeoJson(points, segments, stats, title);
        outExt = 'geojson';
      } else if (activeFormat === 'kml') {
        blob = generateKml(points, segments, stats, title, options);
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

  // Globalny interfejs pomocniczy
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
