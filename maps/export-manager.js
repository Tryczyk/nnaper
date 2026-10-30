/**
 * export-manager.js - Zaawansowany moduł eksportu tras telemetrycznych dla NNAPER
 * 
 * Funkcjonalności:
 * 1. Otwierany przyciskiem "Eksport trasy" w prawym panelu bocznym.
 * 2. Pełny panel eksportu (modal) z zakresem (Dzień, Miesiąc, Rok, Wszystko, Widoczne na mapie)
 *    oraz formatami wyjściowymi (HTML, PNG, SVG, GIF, GPX, CSV, GeoJSON, KML).
 * 3. Obsługa 3 trybów kolorowania śladu:
 *    - "speed" (ciągły 8-stopniowy dynamiczny gradient prędkości od 0 do Vmax trasy)
 *    - "altitude" (ciągły gradient topograficzny wysokości od minAlt do maxAlt)
 *    - "single" (jednolity kolor z próbnikiem color picker umożliwiającym wybór dowolnego koloru)
 * 4. Całkowite usunięcie oznaczeń "Start" i "Meta".
 * 5. Całkowite usunięcie profilu prędkości.
 * 6. Profil wysokości dołączany tylko przy krótkich trasach (<= 60 km) w obrębie 1 dnia.
 * 7. Segmentacja tras (splitIntoContiguousSegments) zapobiegająca łączeniu długich przerw/postojów prostą linią.
 * 8. Sanityzacja prędkości (cleanAndSanitizeSpeeds) eliminująca wartości ujemne oraz piki GPS powyżej 500 km/h.
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
  const SPEED_PALETTE = [
    { pct: 0.00, r: 6,   g: 182, b: 212 }, // #06b6d4 Głęboki cyjan (0 km/h, postój)
    { pct: 0.08, r: 14,  g: 165, b: 233 }, // #0ea5e9 Błękit / toczenie (10 km/h)
    { pct: 0.18, r: 16,  g: 185, b: 129 }, // #10b981 Szmaragd / strefy tempo 30 (25-30 km/h)
    { pct: 0.32, r: 34,  g: 197, b: 94  }, // #22c55e Soczysta zieleń (miasto 50 km/h)
    { pct: 0.48, r: 132, g: 204, b: 22  }, // #84cc16 Limonka (arterie miejskie 60-70 km/h)
    { pct: 0.64, r: 234, g: 179, b: 8   }, // #eab308 Ciepły żółty (drogi krajowe 80-90 km/h)
    { pct: 0.78, r: 249, g: 115, b: 22  }, // #f97316 Pomarańcz (drogi ekspresowe 100-110 km/h)
    { pct: 0.90, r: 239, g: 68,  b: 68  }, // #ef4444 Czerwień (autostrady 120-130 km/h)
    { pct: 1.00, r: 225, g: 29,  b: 72  }  // #e11d48 Karmazyn (Vmax, 140+ km/h)
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

  function getSpeedRgb(spd, maxSpeed) {
    const maxV = Math.max(10, Number(maxSpeed) || 100);
    const validSpd = (spd !== null && spd !== undefined && !isNaN(Number(spd))) ? Number(spd) : 0;
    const ratio = Math.max(0, Math.min(1.0, validSpd / maxV));
    // Perceptualna krzywa gamma (0.85) rozszerza pasma prędkości miejskich i podmiejskich (30-80 km/h),
    // zapobiegając dominacji błękitu przy dużych Vmax w zbiorczych zakresach (np. "wszystko").
    const clamped = Math.pow(ratio, 0.85);
    for (let i = 0; i < SPEED_PALETTE.length - 1; i++) {
      const s0 = SPEED_PALETTE[i];
      const s1 = SPEED_PALETTE[i + 1];
      if (clamped >= s0.pct && clamped <= s1.pct) {
        const factor = (clamped - s0.pct) / (s1.pct - s0.pct);
        const r = Math.round(s0.r + (s1.r - s0.r) * factor);
        const g = Math.round(s0.g + (s1.g - s0.g) * factor);
        const b = Math.round(s0.b + (s1.b - s0.b) * factor);
        return [r, g, b];
      }
    }
    const last = SPEED_PALETTE[SPEED_PALETTE.length - 1];
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
      return getAltitudeRgb(pt.altitude, stats?.minAlt, stats?.maxAlt);
    } else if (mode === 'single') {
      return hexToRgb(options?.singleColor || '#06b6d4');
    } else {
      const spd = (pt.color_speed !== undefined ? pt.color_speed : pt.speed_kmh) || 0;
      return getSpeedRgb(spd, stats?.maxSpeedKmh);
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
    if (lat1 === lat2 && lon1 === lon2) return 0;
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

    // 1. Podstawowe oczyszczenie wartości ujemnych
    for (let i = 0; i < points.length; i++) {
      let spd = Number(points[i].speed_kmh) || 0;
      if (spd < 0) spd = 0;
      points[i].speed_kmh = spd;
    }

    // 2. Dwufazowy filtr szpilek i nierealistycznych skoków prędkości (haversine position jitter)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < points.length; i++) {
        const curr = points[i].speed_kmh;
        const prev = i > 0 ? points[i - 1].speed_kmh : curr;
        const next = i < points.length - 1 ? points[i + 1].speed_kmh : curr;
        const neighborAvg = (prev + next) / 2;

        // Anomalia: prędkość skokowa powyżej 180 km/h niepoparta ciągłą jazdą w otoczeniu
        if (curr > 180 && (prev < 150 || next < 150)) {
          points[i].speed_kmh = (prev < 150 && next < 150) ? neighborAvg : (prev < 150 ? prev : next);
          continue;
        }

        // Szpilka: prędkość skacze o >35 km/h powyżej obu bezpośrednich sąsiadów
        if (curr > Math.max(prev, next) + 35) {
          points[i].speed_kmh = neighborAvg;
        }
      }
    }

    // 3. Bezwzględny sufit fizyczny (eliminacja jakichkolwiek artefaktów > 200 km/h)
    for (let i = 0; i < points.length; i++) {
      if (points[i].speed_kmh > 200) {
        points[i].speed_kmh = 200;
      }
    }
  }

  // Inteligentna kompresja punktów postoju dla zbiorczych zakresów (wszystko/rok/miesiąc)
  function optimizePointsForExport(points, scope) {
    if (!points || points.length < 5000 || scope === 'day') {
      return points;
    }

    const out = [points[0]];
    let stationaryCount = 0;

    for (let i = 1; i < points.length; i++) {
      const prev = out[out.length - 1];
      const curr = points[i];

      const dLat = Math.abs(curr.lat - prev.lat);
      const dLon = Math.abs(curr.lon - prev.lon);
      const isStationary = (curr.speed_kmh < 1.0) && (dLat < 0.00008 && dLon < 0.00008);

      if (isStationary) {
        stationaryCount++;
        // Zachowaj próbkę co 30 punktów postoju lub ostatni punkt tuż przed ruszeniem
        const next = points[i + 1];
        const isNextMoving = next && (next.speed_kmh >= 1.0 || Math.abs(next.lat - curr.lat) >= 0.00008);
        if (stationaryCount % 30 === 0 || isNextMoving || i === points.length - 1) {
          out.push(curr);
        }
      } else {
        stationaryCount = 0;
        out.push(curr);
      }
    }
    return out;
  }

  // Przestrzenna agregacja prędkości dla nakładających się przejazdów tą samą drogą
  function computeLocationSpeeds(points, mode = 'max') {
    if (!points || points.length === 0) return;
    if (mode === 'last') {
      for (let i = 0; i < points.length; i++) {
        points[i].color_speed = points[i].speed_kmh || 0;
      }
      return;
    }

    const midLat = points[0].lat;
    const cosLat = Math.cos(midLat * Math.PI / 180);
    // Komórka siatki przestrzennej ~45-50m (zamiast 25m), co w oknie sąsiadów 3x3 daje korytarz ~150m.
    // Pozwala to prawidłowo łączyć wielokrotne przejazdy po wielopasmowych drogach, skrzyżowaniach i rondach.
    const cellLat = 0.00045;
    const cellLon = cellLat / Math.max(0.1, cosLat);
    const grid = new Map();

    // 1. Przypisz prędkości punktów do komórek siatki
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const ci = Math.floor(p.lat / cellLat);
      const cj = Math.floor(p.lon / cellLon);
      const key = ci + '_' + cj;
      let cell = grid.get(key);
      if (!cell) {
        cell = { ci, cj, speeds: [] };
        grid.set(key, cell);
      }
      cell.speeds.push(p.speed_kmh || 0);
    }

    // 2. Prekomputacja Vmax i Vavg dla każdej komórki
    for (const cell of grid.values()) {
      let maxS = 0;
      let sumMoving = 0;
      let countMoving = 0;
      let sumAll = 0;

      for (let s = 0; s < cell.speeds.length; s++) {
        const spd = cell.speeds[s];
        if (spd > maxS) maxS = spd;
        sumAll += spd;
        if (spd >= 2.0) {
          sumMoving += spd;
          countMoving++;
        }
      }

      cell.maxSpeed = maxS;
      cell.avgSpeed = countMoving > 0 ? (sumMoving / countMoving) : (sumAll / Math.max(1, cell.speeds.length));
    }

    // 3. Oblicz prędkość wizualną każdego punktu z otoczenia sąsiadów 3x3 komórek (~30m)
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const ci = Math.floor(p.lat / cellLat);
      const cj = Math.floor(p.lon / cellLon);

      if (mode === 'max') {
        let maxV = p.speed_kmh || 0;
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const neighbor = grid.get((ci + di) + '_' + (cj + dj));
            if (neighbor && neighbor.maxSpeed > maxV) {
              maxV = neighbor.maxSpeed;
            }
          }
        }
        p.color_speed = maxV;
      } else if (mode === 'avg') {
        let sumV = 0;
        let countV = 0;
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const neighbor = grid.get((ci + di) + '_' + (cj + dj));
            if (neighbor) {
              sumV += neighbor.avgSpeed;
              countV++;
            }
          }
        }
        p.color_speed = countV > 0 ? (sumV / countV) : (p.speed_kmh || 0);
      }
    }
  }

  function splitIntoContiguousSegments(points) {
    if (!points || !points.length) return [];
    const segments = [];
    let currentSeg = [points[0]];

    let prevTime = points[0].timestamp ? Date.parse(points[0].timestamp) : NaN;
    let prevDate = points[0].timestamp ? points[0].timestamp.slice(0, 10) : '';

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      const currTime = curr.timestamp ? Date.parse(curr.timestamp) : NaN;
      const dtSec = (isNaN(prevTime) || isNaN(currTime)) ? 0 : Math.abs(currTime - prevTime) / 1000;
      const dKm = (prev.lat === curr.lat && prev.lon === curr.lon) ? 0 : haversineDistanceKm(prev.lat, prev.lon, curr.lat, curr.lon);

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

      prevTime = currTime;
      prevDate = currDate;
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
    let realisticVmax = 0;
    const movingSpeeds = [];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;

      const s = p.speed_kmh || 0;
      sumSpd += s;
      if (s > realisticVmax) realisticVmax = s;
      if (s > 5.0) movingSpeeds.push(s);

      if (p.altitude !== null && p.altitude !== undefined && !isNaN(Number(p.altitude))) {
        const alt = Number(p.altitude);
        if (alt < minAlt) minAlt = alt;
        if (alt > maxAlt) maxAlt = alt;
      }
    }

    // Zabezpieczenie skali gradientu przed rzadkimi skrajnymi anomaliami w wielotysięcznych zbiorach
    if (movingSpeeds.length >= 20) {
      movingSpeeds.sort((a, b) => a - b);
      const idx995 = Math.min(movingSpeeds.length - 1, Math.floor(movingSpeeds.length * 0.995));
      const p995 = movingSpeeds[idx995];
      if (realisticVmax > p995 + 15) {
        realisticVmax = Math.round(p995 + 5);
      }
    }
    realisticVmax = Math.min(realisticVmax, 200);

    const segList = segments || splitIntoContiguousSegments(points);
    for (let s = 0; s < segList.length; s++) {
      const seg = segList[s];
      for (let j = 1; j < seg.length; j++) {
        const pPrev = seg[j - 1];
        const pCurr = seg[j];
        if (pPrev.lat !== pCurr.lat || pPrev.lon !== pCurr.lon) {
          dist += haversineDistanceKm(pPrev.lat, pPrev.lon, pCurr.lat, pCurr.lon);
        }
      }
    }

    if (minAlt === Infinity) minAlt = 0;
    if (maxAlt === -Infinity) maxAlt = 50;
    if (maxAlt - minAlt < 5) maxAlt = minAlt + 20;

    let drivingSeconds = 0;
    let movingSeconds = 0;

    for (let s = 0; s < segList.length; s++) {
      const seg = segList[s];
      if (seg.length < 2) continue;
      let stationaryRunSec = 0;
      let prevT = seg[0].timestamp ? Date.parse(seg[0].timestamp) : NaN;

      for (let j = 1; j < seg.length; j++) {
        const pPrev = seg[j - 1];
        const pCurr = seg[j];
        const currT = pCurr.timestamp ? Date.parse(pCurr.timestamp) : NaN;
        if (isNaN(prevT) || isNaN(currT)) {
          prevT = currT;
          continue;
        }

        const dtSec = (currT - prevT) / 1000;
        prevT = currT;

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

    const hasAltitude = points.some(p => p.altitude !== null && p.altitude !== undefined && !isNaN(Number(p.altitude)));
    const includeElevation = (options.includeChart !== false) && hasAltitude;

    const [minLon, minLat, maxLon, maxLat] = stats.bounds;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);

    const mapX = 80;
    const mapY = 120;
    const mapW = W - 160;
    const mapH = includeElevation ? (H - 330) : (H - 180);

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
    const pngLines = [];
    for (const seg of segments) {
      for (let i = 1; i < seg.length; i++) {
        const p0 = seg[i - 1];
        const p1 = seg[i];
        const [x0, y0] = toScreen(p0.lon, p0.lat);
        const [x1, y1] = toScreen(p1.lon, p1.lat);
        const col = getTrackColor(p1, options, stats);
        const sortVal = (p1.color_speed !== undefined ? p1.color_speed : p1.speed_kmh) || 0;
        pngLines.push({ x0, y0, x1, y1, col, sortVal });
      }
    }
    // Szybsze odcinki (czerwone) rysowane na wierzchu wolniejszych (zielonych)
    pngLines.sort((a, b) => a.sortVal - b.sortVal);
    for (let k = 0; k < pngLines.length; k++) {
      const line = pngLines[k];
      ctx.strokeStyle = line.col;
      ctx.beginPath();
      ctx.moveTo(line.x0, line.y0);
      ctx.lineTo(line.x1, line.y1);
      ctx.stroke();
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

    // Profil wysokości n.p.m. z oznaczonym MIN i MAX
    if (includeElevation) {
      const chartX = 80;
      const chartY = H - 170;
      const chartW = W - 160;
      const chartH = 120;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(chartX, chartY, chartW, chartH, 8);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText('PROFIL WYSOKOŚCI N.P.M.', chartX + 15, chartY + 22);

      const altSpan = Math.max(10, stats.maxAlt - stats.minAlt);
      ctx.fillStyle = '#64748b';
      ctx.font = '11px monospace';
      ctx.fillText(`(Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m, Różnica: ${(stats.maxAlt - stats.minAlt).toFixed(0)}m)`, chartX + 190, chartY + 22);

      const plotX = chartX + 15;
      const plotW = chartW - 30;
      const plotBottom = chartY + chartH - 18;
      const plotH = chartH - 48;

      let minAltIdx = 0, maxAltIdx = 0;
      let minAltVal = Infinity, maxAltVal = -Infinity;

      for (let i = 0; i < points.length; i++) {
        const alt = (points[i].altitude !== null && points[i].altitude !== undefined && !isNaN(Number(points[i].altitude)))
          ? Number(points[i].altitude) : stats.minAlt;
        if (alt < minAltVal) { minAltVal = alt; minAltIdx = i; }
        if (alt > maxAltVal) { maxAltVal = alt; maxAltIdx = i; }
      }
      if (minAltVal === Infinity) minAltVal = stats.minAlt;
      if (maxAltVal === -Infinity) maxAltVal = stats.maxAlt;

      // Wypełnienie gradientem pod wykresem wysokości
      const areaGrad = ctx.createLinearGradient(0, chartY + 30, 0, plotBottom);
      areaGrad.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
      areaGrad.addColorStop(1, 'rgba(56, 189, 248, 0.02)');

      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const cx = plotX + (i / Math.max(1, points.length - 1)) * plotW;
        const alt = (points[i].altitude !== null && points[i].altitude !== undefined && !isNaN(Number(points[i].altitude)))
          ? Number(points[i].altitude) : stats.minAlt;
        const cy = plotBottom - ((alt - stats.minAlt) / altSpan) * plotH;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      ctx.lineTo(plotX + plotW, plotBottom);
      ctx.lineTo(plotX, plotBottom);
      ctx.closePath();
      ctx.fillStyle = areaGrad;
      ctx.fill();

      // Linia wykresu
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const cx = plotX + (i / Math.max(1, points.length - 1)) * plotW;
        const alt = (points[i].altitude !== null && points[i].altitude !== undefined && !isNaN(Number(points[i].altitude)))
          ? Number(points[i].altitude) : stats.minAlt;
        const cy = plotBottom - ((alt - stats.minAlt) / altSpan) * plotH;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      ctx.stroke();

      // Punkt MAX (zielony)
      const maxCx = plotX + (maxAltIdx / Math.max(1, points.length - 1)) * plotW;
      const maxCy = plotBottom - ((maxAltVal - stats.minAlt) / altSpan) * plotH;

      ctx.beginPath();
      ctx.arc(maxCx, maxCy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#10b981';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#10b981';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const maxLabelY = Math.max(chartY + 36, maxCy - 8);
      ctx.fillText(`▲ MAX ${maxAltVal.toFixed(0)}m`, maxCx, maxLabelY);

      // Punkt MIN (pomarańczowy)
      const minCx = plotX + (minAltIdx / Math.max(1, points.length - 1)) * plotW;
      const minCy = plotBottom - ((minAltVal - stats.minAlt) / altSpan) * plotH;

      ctx.beginPath();
      ctx.arc(minCx, minCy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#f59e0b';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const minLabelY = Math.min(plotBottom + 13, minCy + 15);
      ctx.fillText(`▼ MIN ${minAltVal.toFixed(0)}m`, minCx, minLabelY);
      ctx.textAlign = 'left';
    }

    // Dynamiczna Legenda w prawym górnym rogu (wyłącznie dla trybów gradientowych: prędkość lub wysokość)
    const mode = options.colorMode || 'speed';
    if (mode !== 'single') {
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
        ctx.textAlign = 'left';
        ctx.fillText(`${stats.minAlt.toFixed(0)}m`, legX + 15, legY + 58);
        ctx.textAlign = 'center';
        ctx.fillText(`${((stats.minAlt + stats.maxAlt) / 2).toFixed(0)}m`, legX + 15 + gradW * 0.5, legY + 58);
        ctx.textAlign = 'right';
        ctx.fillText(`${stats.maxAlt.toFixed(0)}m`, legX + 15 + gradW, legY + 58);
        ctx.textAlign = 'left';

      } else {
        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillText('PRĘDKOŚĆ (KM/H)', legX + 15, legY + 22);

        const barGrad = ctx.createLinearGradient(legX + 15, 0, legX + 15 + gradW, 0);
        barGrad.addColorStop(0.00, '#06b6d4');
        barGrad.addColorStop(0.08, '#0ea5e9');
        barGrad.addColorStop(0.18, '#10b981');
        barGrad.addColorStop(0.32, '#22c55e');
        barGrad.addColorStop(0.48, '#84cc16');
        barGrad.addColorStop(0.64, '#eab308');
        barGrad.addColorStop(0.78, '#f97316');
        barGrad.addColorStop(0.90, '#ef4444');
        barGrad.addColorStop(1.00, '#e11d48');

        ctx.fillStyle = barGrad;
        ctx.fillRect(legX + 15, legY + 34, gradW, 10);

        const maxV = Math.max(10, Math.round(stats.maxSpeedKmh || 100));
        const v1 = Math.round(maxV * 0.33);
        const v2 = Math.round(maxV * 0.66);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('0', legX + 15, legY + 58);
        ctx.textAlign = 'center';
        ctx.fillText(`${v1}`, legX + 15 + gradW * 0.33, legY + 58);
        ctx.fillText(`${v2}`, legX + 15 + gradW * 0.66, legY + 58);
        ctx.textAlign = 'right';
        ctx.fillText(`${maxV}`, legX + 15 + gradW, legY + 58);
        ctx.textAlign = 'left';
      }
    }

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png');
    });
  }

  // -------------------------------------------------------------
  // 5. GENERATOR SVG (WEKTOR BEZSTRATNY) Z TELEMETRIĄ G-FORCE
  // -------------------------------------------------------------
  function generateSvg(points, segments, stats, titleText, scopeName, options = {}) {
    const W = 1200;
    const H = 800;
    const [minLon, minLat, maxLon, maxLat] = stats.bounds;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180);

    const hasAltitude = points.some(p => p.altitude !== null && p.altitude !== undefined && !isNaN(Number(p.altitude)));
    const includeElevation = (options.includeChart !== false) && hasAltitude;

    // Przetwarzanie i statystyki przeciążeń G
    const gPoints = [];
    let maxAccG = 0, maxBrkG = 0, maxLatLeftG = 0, maxLatRightG = 0, maxGMag = 0;
    let peakGPoint = null;

    if (options.includeGForce !== false) {
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.g_x !== null && p.g_x !== undefined && !isNaN(Number(p.g_x)) &&
            p.g_y !== null && p.g_y !== undefined && !isNaN(Number(p.g_y))) {
          const gx = Number(p.g_x);
          const gy = Number(p.g_y);
          const mag = Math.hypot(gx, gy);
          gPoints.push({ gx, gy, mag, lat: p.lat, lon: p.lon, i });

          if (gx > maxAccG) maxAccG = gx;
          if (gx < -maxBrkG) maxBrkG = Math.abs(gx);
          if (gy < -maxLatLeftG) maxLatLeftG = Math.abs(gy);
          if (gy > maxLatRightG) maxLatRightG = gy;
          if (mag > maxGMag) {
            maxGMag = mag;
            peakGPoint = p;
          }
        }
      }
    }

    const hasGForce = gPoints.length > 0;
    const maxLatG = Math.max(maxLatLeftG, maxLatRightG);
    const showBottomPanel = includeElevation || hasGForce;

    const mapX = 60, mapY = 105;
    const mapW = W - 120;
    const mapH = showBottomPanel ? 530 : 665;

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

    const svgLines = [];
    for (const seg of segments) {
      for (let i = 1; i < seg.length; i++) {
        const [x0, y0] = toSvg(seg[i - 1].lon, seg[i - 1].lat);
        const [x1, y1] = toSvg(seg[i].lon, seg[i].lat);
        const col = getTrackHex(seg[i], options, stats);
        const sortVal = (seg[i].color_speed !== undefined ? seg[i].color_speed : seg[i].speed_kmh) || 0;
        svgLines.push({ x0, y0, x1, y1, col, sortVal });
      }
    }
    // Szybsze odcinki (czerwone) wyżej w hierarchii DOM SVG
    svgLines.sort((a, b) => a.sortVal - b.sortVal);
    let trackPaths = '';
    for (let k = 0; k < svgLines.length; k++) {
      const line = svgLines[k];
      trackPaths += `<line x1="${line.x0}" y1="${line.y0}" x2="${line.x1}" y2="${line.y1}" stroke="${line.col}" stroke-width="3" stroke-linecap="round"/>\n`;
    }

    // Znacznik szczytowego przeciążenia na trasie (beacon na mapie)
    let peakGMarkerSvg = '';
    if (hasGForce && peakGPoint) {
      const [px, py] = toSvg(peakGPoint.lon, peakGPoint.lat);
      const isNearRight = Number(px) > (mapX + mapW - 120);
      const isNearTop = Number(py) < (mapY + 30);
      const badgeX = isNearRight ? -100 : 10;
      const badgeY = isNearTop ? 14 : -10;

      peakGMarkerSvg = `
  <!-- Znacznik szczytowego przeciążenia G na trasie -->
  <g transform="translate(${px}, ${py})">
    <circle r="12" fill="rgba(245, 158, 11, 0.2)"/>
    <circle r="6" fill="#f59e0b" stroke="#ffffff" stroke-width="1.5"/>
    <rect x="${badgeX}" y="${badgeY - 14}" width="95" height="18" rx="4" fill="rgba(15, 23, 42, 0.92)" stroke="#f59e0b" stroke-width="1"/>
    <text x="${badgeX + 6}" y="${badgeY - 1}" fill="#f59e0b" font-size="9.5" font-weight="bold" font-family="ui-monospace, monospace">🎯 MAX ${maxGMag.toFixed(2)}G</text>
  </g>`;
    }

    // Dolny panel telemetryczny (Profil wysokości / Wykres przeciążeń w czasie + Diagram G-G)
    let bottomPanelSvg = '';
    if (showBottomPanel) {
      const panelY = 650;
      const panelH = 110;

      // Karta G-G Friction Circle (z prawej strony, gdy dane G są dostępne)
      let ggCardSvg = '';
      if (hasGForce) {
        const ggX = includeElevation ? 810 : 810;
        const ggW = 330;
        const cx = ggX + 65;
        const cy = panelY + 55;
        const r = 38;
        const scaleG = Math.max(1.2, Math.ceil(Math.max(maxLatG, Math.max(maxAccG, maxBrkG)) * 10) / 10);

        const rad05 = (0.5 / scaleG) * r;
        const rad10 = (1.0 / scaleG) * r;

        // Próbkowanie chmury punktów G (do ~200 punktów dla optymalnego rozmiaru pliku SVG)
        let scatterSvg = '';
        const scatterStep = Math.max(1, Math.floor(gPoints.length / 200));
        for (let k = 0; k < gPoints.length; k += scatterStep) {
          const pt = gPoints[k];
          const dotX = cx + (pt.gy / scaleG) * r;
          const dotY = cy - (pt.gx / scaleG) * r;
          scatterSvg += `<circle cx="${dotX.toFixed(1)}" cy="${dotY.toFixed(1)}" r="1.5" fill="rgba(56, 189, 248, 0.4)"/>\n`;
        }

        // Szczytowe punkty G
        let peakDotsSvg = '';
        if (maxLatG > 0.1) {
          const pLat = gPoints.reduce((best, cur) => Math.abs(cur.gy) > Math.abs(best.gy) ? cur : best, gPoints[0]);
          const plx = cx + (pLat.gy / scaleG) * r;
          const ply = cy - (pLat.gx / scaleG) * r;
          peakDotsSvg += `<circle cx="${plx.toFixed(1)}" cy="${ply.toFixed(1)}" r="3.5" fill="#f59e0b" stroke="#ffffff" stroke-width="1"/>\n`;
        }
        if (maxBrkG > 0.1) {
          const pBrk = gPoints.reduce((best, cur) => cur.gx < best.gx ? cur : best, gPoints[0]);
          const pbx = cx + (pBrk.gy / scaleG) * r;
          const pby = cy - (pBrk.gx / scaleG) * r;
          peakDotsSvg += `<circle cx="${pbx.toFixed(1)}" cy="${pby.toFixed(1)}" r="3.5" fill="#38bdf8" stroke="#ffffff" stroke-width="1"/>\n`;
        }

        ggCardSvg = `
    <!-- Karta Diagramu G-G (Friction Circle 2D) -->
    <rect x="${ggX}" y="${panelY}" width="${ggW}" height="${panelH}" rx="8" fill="#0f172a" stroke="#1e293b"/>
    
    <!-- Okręgi skali G -->
    <circle cx="${cx}" cy="${cy}" r="${rad05.toFixed(1)}" fill="none" stroke="#1e293b" stroke-dasharray="2,2"/>
    <text x="${cx + 2}" y="${(cy - rad05 + 8).toFixed(1)}" fill="#475569" font-size="7.5" font-family="monospace">0.5G</text>
    <circle cx="${cx}" cy="${cy}" r="${rad10.toFixed(1)}" fill="none" stroke="#334155"/>
    <text x="${cx + 2}" y="${(cy - rad10 + 8).toFixed(1)}" fill="#64748b" font-size="7.5" font-family="monospace">1.0G</text>

    <!-- Osie i etykiety kierunków -->
    <line x1="${cx - r - 4}" y1="${cy}" x2="${cx + r + 4}" y2="${cy}" stroke="#334155" stroke-width="1"/>
    <line x1="${cx}" y1="${cy - r - 4}" x2="${cx}" y2="${cy + r + 4}" stroke="#334155" stroke-width="1"/>
    <text x="${cx}" y="${cy - r - 4}" fill="#64748b" font-size="7.5" font-weight="bold" text-anchor="middle">ACC</text>
    <text x="${cx}" y="${cy + r + 10}" fill="#64748b" font-size="7.5" font-weight="bold" text-anchor="middle">BRK</text>
    <text x="${cx - r - 5}" y="${cy + 2.5}" fill="#64748b" font-size="7.5" font-weight="bold" text-anchor="end">L</text>
    <text x="${cx + r + 5}" y="${cy + 2.5}" fill="#64748b" font-size="7.5" font-weight="bold" text-anchor="start">R</text>

    <!-- Chmura punktów G trasy -->
    ${scatterSvg}
    ${peakDotsSvg}

    <!-- Statystyki boczne diagramu -->
    <text x="${ggX + 135}" y="${panelY + 22}" fill="#94a3b8" font-size="9.5" font-weight="bold" letter-spacing="0.5">DIAGRAM G-G (2D)</text>
    <text x="${ggX + 135}" y="${panelY + 44}" fill="#cbd5e1" font-size="11" font-family="ui-monospace, monospace">Max skręt: <tspan fill="#f59e0b" font-weight="bold">${maxLatG.toFixed(2)}G</tspan></text>
    <text x="${ggX + 135}" y="${panelY + 66}" fill="#cbd5e1" font-size="11" font-family="ui-monospace, monospace">Max ham.: <tspan fill="#38bdf8" font-weight="bold">-${maxBrkG.toFixed(2)}G</tspan></text>
    <text x="${ggX + 135}" y="${panelY + 88}" fill="#cbd5e1" font-size="11" font-family="ui-monospace, monospace">Wypadkowe: <tspan fill="#10b981" font-weight="bold">${maxGMag.toFixed(2)}G</tspan></text>`;
      }

      // Lewa karta (Profil wysokości LUB wykres przebiegu G w czasie)
      let leftCardSvg = '';
      const leftW = hasGForce ? 730 : 1080;

      if (includeElevation) {
        const altSpan = Math.max(10, stats.maxAlt - stats.minAlt);
        let chartPolyline = '';
        let minAltIdx = 0, maxAltIdx = 0;
        let minAltVal = Infinity, maxAltVal = -Infinity;

        for (let i = 0; i < points.length; i++) {
          const cx = (60 + 15 + (i / Math.max(1, points.length - 1)) * (leftW - 30)).toFixed(1);
          const alt = points[i].altitude ?? stats.minAlt;
          if (alt < minAltVal) { minAltVal = alt; minAltIdx = i; }
          if (alt > maxAltVal) { maxAltVal = alt; maxAltIdx = i; }
          const cy = ((panelY + panelH - 15) - ((alt - stats.minAlt) / altSpan) * (panelH - 35)).toFixed(1);
          chartPolyline += `${cx},${cy} `;
        }

        const minCx = (60 + 15 + (minAltIdx / Math.max(1, points.length - 1)) * (leftW - 30)).toFixed(1);
        const minCy = ((panelY + panelH - 15) - ((minAltVal - stats.minAlt) / altSpan) * (panelH - 35)).toFixed(1);
        const maxCx = (60 + 15 + (maxAltIdx / Math.max(1, points.length - 1)) * (leftW - 30)).toFixed(1);
        const maxCy = ((panelY + panelH - 15) - ((maxAltVal - stats.minAlt) / altSpan) * (panelH - 35)).toFixed(1);

        leftCardSvg = `
    <!-- Karta Profilu Wysokości -->
    <rect x="60" y="${panelY}" width="${leftW}" height="${panelH}" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="75" y="${panelY + 22}" fill="#94a3b8" font-size="10.5" font-weight="bold">PROFIL WYSOKOŚCI N.P.M. (Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m)</text>
    <polyline points="${chartPolyline}" fill="none" stroke="#38bdf8" stroke-width="2"/>
    <circle cx="${maxCx}" cy="${maxCy}" r="4" fill="#10b981" stroke="#ffffff" stroke-width="1.5"/>
    <text x="${maxCx}" y="${Math.max(panelY + 22, Number(maxCy) - 6)}" fill="#10b981" font-size="10" font-weight="bold" text-anchor="middle">▲ MAX ${maxAltVal.toFixed(0)}m</text>
    <circle cx="${minCx}" cy="${minCy}" r="4" fill="#f59e0b" stroke="#ffffff" stroke-width="1.5"/>
    <text x="${minCx}" y="${Math.min(panelY + panelH - 4, Number(minCy) + 14)}" fill="#f59e0b" font-size="10" font-weight="bold" text-anchor="middle">▼ MIN ${minAltVal.toFixed(0)}m</text>`;
      } else if (hasGForce) {
        // Brak wysokości, ale są przeciążenia -> wykres Gx i Gy w czasie
        const maxPlotG = Math.max(1.2, Math.ceil(Math.max(maxLatG, Math.max(maxAccG, maxBrkG)) * 10) / 10);
        const zeroY = panelY + panelH / 2;
        const gPlotH = panelH - 40;

        let gxPointsStr = '';
        let gyPointsStr = '';
        const step = Math.max(1, Math.floor(gPoints.length / 300));

        for (let k = 0; k < gPoints.length; k += step) {
          const pt = gPoints[k];
          const x = (60 + 15 + (k / Math.max(1, gPoints.length - 1)) * (leftW - 30)).toFixed(1);
          const yGx = (zeroY - (pt.gx / maxPlotG) * (gPlotH / 2)).toFixed(1);
          const yGy = (zeroY - (pt.gy / maxPlotG) * (gPlotH / 2)).toFixed(1);
          gxPointsStr += `${x},${yGx} `;
          gyPointsStr += `${x},${yGy} `;
        }

        leftCardSvg = `
    <!-- Karta Przebiegu Przeciążeń G w Czasie -->
    <rect x="60" y="${panelY}" width="${leftW}" height="${panelH}" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="75" y="${panelY + 20}" fill="#94a3b8" font-size="10" font-weight="bold">PRZEBIEG PRZECIĄŻEŃ W CZASIE</text>
    <text x="${leftW - 140}" y="${panelY + 20}" fill="#64748b" font-size="9.5" font-family="ui-monospace, monospace"><tspan fill="#38bdf8">─ Gx (wzdłużne)</tspan>   <tspan fill="#f59e0b">─ Gy (boczne)</tspan></text>
    <line x1="75" y1="${zeroY}" x2="${60 + leftW - 15}" y2="${zeroY}" stroke="#334155" stroke-dasharray="3,3"/>
    <polyline points="${gxPointsStr}" fill="none" stroke="#38bdf8" stroke-width="1.6"/>
    <polyline points="${gyPointsStr}" fill="none" stroke="#f59e0b" stroke-width="1.6"/>`;
      }

      bottomPanelSvg = `
  <!-- Dolny panel telemetryczny -->
  ${leftCardSvg}
  ${ggCardSvg}`;
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
    <rect width="210" height="70" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="15" y="20" fill="#94a3b8" font-size="10" font-weight="bold">WYSOKOŚĆ (M N.P.M.)</text>
    <rect x="15" y="28" width="180" height="8" rx="2" fill="url(#legendGrad)"/>
    <text x="15" y="52" fill="#94a3b8" font-size="9" font-family="monospace">${stats.minAlt.toFixed(0)}m</text>
    <text x="105" y="52" fill="#94a3b8" font-size="9" font-family="monospace" text-anchor="middle">${((stats.minAlt + stats.maxAlt) / 2).toFixed(0)}m</text>
    <text x="195" y="52" fill="#94a3b8" font-size="9" font-family="monospace" text-anchor="end">${stats.maxAlt.toFixed(0)}m</text>`;
    } else if (mode === 'single') {
      // Dla jednolitego koloru brak okienka legendy w prawym górnym rogu
      legendContent = '';
    } else {
      const maxV = Math.max(10, Math.round(stats.maxSpeedKmh || 100));
      const v1 = Math.round(maxV * 0.33);
      const v2 = Math.round(maxV * 0.66);
      legendGradientDef = `
    <linearGradient id="legendGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#06b6d4" />
      <stop offset="8%" stop-color="#0ea5e9" />
      <stop offset="18%" stop-color="#10b981" />
      <stop offset="32%" stop-color="#22c55e" />
      <stop offset="48%" stop-color="#84cc16" />
      <stop offset="64%" stop-color="#eab308" />
      <stop offset="78%" stop-color="#f97316" />
      <stop offset="90%" stop-color="#ef4444" />
      <stop offset="100%" stop-color="#e11d48" />
    </linearGradient>`;
      legendContent = `
    <rect width="210" height="70" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="15" y="20" fill="#94a3b8" font-size="10" font-weight="bold">PRĘDKOŚĆ (KM/H)</text>
    <rect x="15" y="28" width="180" height="8" rx="2" fill="url(#legendGrad)"/>
    <text x="15" y="52" fill="#94a3b8" font-size="9" font-family="monospace">0</text>
    <text x="74" y="52" fill="#94a3b8" font-size="9" font-family="monospace" text-anchor="middle">${v1}</text>
    <text x="134" y="52" fill="#94a3b8" font-size="9" font-family="monospace" text-anchor="middle">${v2}</text>
    <text x="195" y="52" fill="#94a3b8" font-size="9" font-family="monospace" text-anchor="end">${maxV}</text>`;
    }

    const mainHudW = hasGForce ? 530 : (mode === 'single' ? 1080 : 840);

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

  ${peakGMarkerSvg}

  <!-- Karta HUD / Nagłówek główny -->
  <rect x="60" y="25" width="${mainHudW}" height="70" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="80" y="52" fill="#38bdf8" font-size="15" font-weight="bold">NNAPER • ${titleText.toUpperCase()}</text>
  <text x="80" y="75" fill="#cbd5e1" font-size="11.5" font-family="ui-monospace, monospace">Dystans: ${stats.totalDistanceKm.toFixed(2)} km  |  Czas: ${formatDuration(stats.durationSeconds)}  |  Śr. V: ${stats.avgSpeedKmh.toFixed(1)} km/h  |  V max: ${stats.maxSpeedKmh.toFixed(1)} km/h</text>

  <!-- Karta Telemetrii Przeciążeń w nagłówku -->
  ${hasGForce ? `
  <g transform="translate(605, 25)">
    <rect width="310" height="70" rx="8" fill="#0f172a" stroke="#1e293b"/>
    <text x="16" y="20" fill="#94a3b8" font-size="9.5" font-weight="bold" letter-spacing="0.5">TELEMETRIA PRZECIĄŻEŃ (G)</text>
    <text x="16" y="42" fill="#f8fafc" font-size="12" font-family="ui-monospace, monospace">
      <tspan fill="#10b981" font-weight="bold">|G| max: ${maxGMag.toFixed(2)}G</tspan>
      <tspan fill="#475569"> │ </tspan>
      <tspan fill="#f59e0b">Skręt: ${maxLatG.toFixed(2)}G</tspan>
    </text>
    <text x="16" y="60" fill="#94a3b8" font-size="10.5" font-family="ui-monospace, monospace">
      <tspan fill="#38bdf8">Ham.: -${maxBrkG.toFixed(2)}G</tspan>
      <tspan fill="#475569"> │ </tspan>
      <tspan fill="#c084fc">Przysp.: +${maxAccG.toFixed(2)}G</tspan>
    </text>
  </g>` : ''}

  <!-- Dolny panel z wykresami i diagramem G-G -->
  ${bottomPanelSvg}

  <!-- Legenda -->
  ${(mode !== 'single' && legendContent) ? `
  <g transform="translate(${W - 270}, 25)">
    ${legendContent}
  </g>` : ''}
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
        const p0 = seg[i - 1];
        const p1 = seg[i];
        let repPt = p1;
        if (options.colorMode === 'speed') {
          const spd0 = (p0.color_speed !== undefined ? p0.color_speed : p0.speed_kmh) || 0;
          const spd1 = (p1.color_speed !== undefined ? p1.color_speed : p1.speed_kmh) || 0;
          if (spd0 > spd1) {
            repPt = p0;
          }
        }
        allLines.push({
          p0,
          p1,
          color: getTrackColor(repPt, options, stats)
        });
      }
    }

    const durSec = Math.max(0.5, Math.min(60, parseFloat(options.gifDurationSec) || 4.0));
    const maxMb = (options.gifMaxMb !== undefined && options.gifMaxMb !== null && options.gifMaxMb !== '') ? parseFloat(options.gifMaxMb) : 5.0;
    const maxBytes = (!isNaN(maxMb) && maxMb > 0) ? Math.round(maxMb * 1024 * 1024) : 0;
    const isAutoFrames = (options.gifFramesAuto !== false && (!options.gifFrames || options.gifFrames === 'auto'));

    let TOTAL_ANIM_FRAMES;
    if (isAutoFrames) {
      // Domyślnie maksymalna płynność (25-30 FPS zależnie od czasu trwania)
      const targetFps = durSec <= 4.0 ? 25 : 22;
      TOTAL_ANIM_FRAMES = Math.max(20, Math.min(250, Math.round(durSec * targetFps)));
      // Jeśli użytkownik podał ścisły limit w MB, wstępnie dopasuj liczbę klatek do limitu (~24KB/klatka)
      if (maxBytes > 0) {
        const maxEstimatedFrames = Math.max(16, Math.floor((maxBytes * 0.92) / 24000));
        if (maxEstimatedFrames < TOTAL_ANIM_FRAMES) {
          TOTAL_ANIM_FRAMES = maxEstimatedFrames;
        }
      }
    } else {
      TOTAL_ANIM_FRAMES = Math.max(8, Math.min(300, parseInt(options.gifFrames, 10) || 60));
    }

    const delayMs = Math.max(20, Math.round((durSec * 1000) / TOTAL_ANIM_FRAMES));
    const totalLines = allLines.length;

    // Analiza rozkładu klatek w poszczególnych dniach:
    // Jeśli na dany dzień w animacji nie przypada więcej niż 1 klatka, nie wyświetlamy godziny.
    const dayFrameCounts = {};
    for (let f = 0; f < TOTAL_ANIM_FRAMES; f++) {
      const progress = f / (TOTAL_ANIM_FRAMES - 1);
      const linesToDraw = Math.round(progress * totalLines);
      let pt = null;
      if (linesToDraw > 0 && linesToDraw <= allLines.length) {
        pt = allLines[linesToDraw - 1].p1;
      } else if (allLines.length > 0) {
        pt = allLines[0].p0;
      } else if (points.length > 0) {
        pt = points[0];
      }

      if (pt && pt.timestamp) {
        const delimiter = pt.timestamp.includes('T') ? 'T' : ' ';
        const dStr = pt.timestamp.split(delimiter)[0].trim();
        if (dStr) {
          dayFrameCounts[dStr] = (dayFrameCounts[dStr] || 0) + 1;
        }
      }
    }

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

      // 5. Nagłówek HUD (czysty i minimalistyczny - bez zbędnych prędkości, wysokości i procentów)
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(mapX, 10, mapW, 48, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 11px system-ui, -apple-system, sans-serif';
      ctx.fillText(`NNAPER REPLAY • ${titleText}`.toUpperCase(), mapX + 14, 27);

      // Formatowanie daty i godziny:
      // Jeśli na ten dzień w animacji nie przypada więcej niż 1 klatka, godzina jest ukrywana.
      let timeDisplay = '';
      if (currPt && currPt.timestamp) {
        const delimiter = currPt.timestamp.includes('T') ? 'T' : ' ';
        const parts = currPt.timestamp.split(delimiter);
        const dateStr = parts[0] || '';
        let timeStr = parts[1] ? parts[1].replace('Z', '').trim() : '';
        if (timeStr.length > 8) timeStr = timeStr.slice(0, 8);

        const framesThisDay = dateStr ? (dayFrameCounts[dateStr] || 0) : 0;
        const showHour = framesThisDay > 1 && Boolean(timeStr);

        if (scopeName === 'day') {
          timeDisplay = showHour ? `Czas: ${timeStr}` : dateStr;
        } else {
          timeDisplay = showHour ? `${dateStr}   ${timeStr}` : dateStr;
        }
      }

      if (timeDisplay) {
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(timeDisplay, mapX + 14, 46);
      }

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

    if (onProgress) onProgress(90);

    let gifBytes = encoder.encode();

    // Adaptacyjne dopasowanie do zadanego przez użytkownika limitu wagi (MB)
    // z zachowaniem maksymalnej płynności (downsampling klatek w pamięci bez powtórnego rysowania trasy)
    if (maxBytes > 0 && gifBytes.length > maxBytes && encoder.frames.length > 15) {
      if (onProgress) onProgress(93);

      const lastHoldFrame = encoder.frames[encoder.frames.length - 1];
      const animFrames = encoder.frames.slice(0, -1);
      const curBytes = gifBytes.length;

      // Wylicz docelową liczbę klatek (z marginesem bezpieczeństwa 6% na fluktuacje słownika LZW)
      const ratio = maxBytes / curBytes;
      let targetCount = Math.max(12, Math.floor(animFrames.length * ratio * 0.94));

      if (targetCount < animFrames.length) {
        let newDelayHund = Math.max(2, Math.round((durSec * 100) / targetCount));
        let downsampled = [];
        for (let k = 0; k < targetCount; k++) {
          const srcIdx = Math.round((k * (animFrames.length - 1)) / (targetCount - 1));
          downsampled.push({
            data: animFrames[srcIdx].data,
            delay: newDelayHund
          });
        }
        downsampled.push(lastHoldFrame);

        encoder.frames = downsampled;
        encoder.colorMap.clear();
        gifBytes = encoder.encode();

        // Dodatkowa korekta awaryjna w przypadku trudnokompresowalnych klatek
        if (gifBytes.length > maxBytes && encoder.frames.length > 15) {
          const secondFrames = encoder.frames.slice(0, -1);
          const secondRatio = maxBytes / gifBytes.length;
          targetCount = Math.max(10, Math.floor(secondFrames.length * secondRatio * 0.93));
          newDelayHund = Math.max(2, Math.round((durSec * 100) / targetCount));
          downsampled = [];
          for (let k = 0; k < targetCount; k++) {
            const srcIdx = Math.round((k * (secondFrames.length - 1)) / (targetCount - 1));
            downsampled.push({
              data: secondFrames[srcIdx].data,
              delay: newDelayHund
            });
          }
          downsampled.push(lastHoldFrame);
          encoder.frames = downsampled;
          encoder.colorMap.clear();
          gifBytes = encoder.encode();
        }
      }
    }

    if (onProgress) onProgress(100);
    return new Blob([gifBytes], { type: 'image/gif' });
  }

  // -------------------------------------------------------------
  // 7. GENERATOR INTERAKTYWNEGO HTML (STANDALONE)
  // -------------------------------------------------------------
  function generateHtml(points, segments, stats, titleText, scopeName, options = {}) {
    const isSingleDay = (scopeName === 'day' || scopeName === 'active');
    const hasAltitude = points.some(p => p.altitude !== null && p.altitude !== undefined && !isNaN(Number(p.altitude)));
    const includeElevation = isSingleDay && (options.includeChart !== false) && hasAltitude;
    const colorMode = options.colorMode || 'speed';
    const singleColor = options.singleColor || '#06b6d4';
    const speedOverlap = options.speedOverlap || 'max';
    const defaultSpeed = 30;
    const includeGForce = isSingleDay && (options.includeGForce !== false);

    const hasGForceData = includeGForce && points.some(p => p.g_x !== null && p.g_x !== undefined && !isNaN(Number(p.g_x)));
    const showBottomPanel = isSingleDay && (includeElevation || hasGForceData);

    // Kompaktowa reprezentacja punktów w HTML (bez zbędnych pól i bez duplikacji w segments)
    const compactPoints = points.map(p => {
      const item = {
        lat: p.lat,
        lon: p.lon,
        speed_kmh: Math.round((p.speed_kmh || 0) * 10) / 10,
        color_speed: Math.round(((p.color_speed !== undefined ? p.color_speed : p.speed_kmh) || 0) * 10) / 10,
        altitude: p.altitude !== null && p.altitude !== undefined && !isNaN(p.altitude) ? Math.round(Number(p.altitude) * 10) / 10 : null,
        timestamp: p.timestamp || null
      };
      if (isSingleDay) {
        item.g_x = p.g_x !== null && p.g_x !== undefined && !isNaN(Number(p.g_x)) ? Math.round(Number(p.g_x) * 1000) / 1000 : null;
        item.g_y = p.g_y !== null && p.g_y !== undefined && !isNaN(Number(p.g_y)) ? Math.round(Number(p.g_y) * 1000) / 1000 : null;
        item.g_z = p.g_z !== null && p.g_z !== undefined && !isNaN(Number(p.g_z)) ? Math.round(Number(p.g_z) * 1000) / 1000 : null;
      }
      return item;
    });

    const segmentLengths = segments.map(seg => seg.length);
    const rawJson = JSON.stringify(compactPoints);
    const segLensJson = JSON.stringify(segmentLengths);
    const statsJson = JSON.stringify(stats);

    const html = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <title>Trasa NNAPER - ${titleText}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20100%20100%27%3E%3Cdefs%3E%3ClinearGradient%20id%3D%27b%27%20x1%3D%2725%25%27%20y1%3D%270%25%27%20x2%3D%2775%25%27%20y2%3D%27100%25%27%3E%3Cstop%20offset%3D%270%25%27%20stop-color%3D%27%23FF383D%27%2F%3E%3Cstop%20offset%3D%2745%25%27%20stop-color%3D%27%23E31E24%27%2F%3E%3Cstop%20offset%3D%27100%25%27%20stop-color%3D%27%23A80F14%27%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%27g%27%20x1%3D%270%25%27%20y1%3D%270%25%27%20x2%3D%270%25%27%20y2%3D%27100%25%27%3E%3Cstop%20offset%3D%270%25%27%20stop-color%3D%27%23FFFFFF%27%20stop-opacity%3D%270.45%27%2F%3E%3Cstop%20offset%3D%27100%25%27%20stop-color%3D%27%23FFFFFF%27%20stop-opacity%3D%270%27%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20fill%3D%27url(%23b)%27%20stroke%3D%27%23800D11%27%20stroke-width%3D%271.2%27%20stroke-linejoin%3D%27round%27%20fill-rule%3D%27evenodd%27%20d%3D%27M%2050%2094%20C%2045.5%2081%2C%2020%2054.5%2C%2020%2036.5%20A%2030%2030%200%201%201%2080%2036.5%20C%2080%2054.5%2C%2054.5%2081%2C%2050%2094%20Z%20M%2050%2025%20A%2011.5%2011.5%200%201%200%2050%2048%20A%2011.5%2011.5%200%201%200%2050%2025%20Z%27%2F%3E%3Ccircle%20cx%3D%2750%27%20cy%3D%2736.5%27%20r%3D%2711.5%27%20fill%3D%27none%27%20stroke%3D%27%23FFFFFF%27%20stroke-width%3D%271%27%20stroke-opacity%3D%270.45%27%2F%3E%3Cpath%20fill%3D%27url(%23g)%27%20d%3D%27M%2026%2034%20A%2024%2024%200%200%201%2074%2034%20C%2070%2020%2C%2060%2014%2C%2050%2014%20C%2040%2014%2C%2030%2020%2C%2026%2034%20Z%27%2F%3E%3C%2Fsvg%3E" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
  <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <script src="https://unpkg.com/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js"></script>
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

    #legend-card {
      position: absolute; bottom: ${showBottomPanel ? '165px' : '20px'}; left: 16px;
      z-index: 1000; background: rgba(15, 23, 42, 0.94); border: 1px solid #334155;
      border-radius: 8px; padding: 7px 11px 8px 11px; box-shadow: 0 6px 20px rgba(0,0,0,0.65);
      backdrop-filter: blur(8px); min-width: 195px; transition: bottom 0.2s ease; user-select: none;
    }
    #legend-card.chart-collapsed { bottom: 38px !important; }
    .legend-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
    .legend-title { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; }
    .legend-min-btn { background: transparent; border: none; color: #64748b; font-size: 10px; cursor: pointer; padding: 0 2px; }
    .legend-min-btn:hover { color: #f8fafc; }
    #legend-card.collapsed #legend-body { display: none; }
    #legend-card.collapsed { padding-bottom: 5px; }
    .legend-bar { height: 9px; border-radius: 4px; width: 100%; margin-bottom: 4px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.4); }
    .legend-ticks { display: flex; justify-content: space-between; font-size: 9.5px; font-family: ui-monospace, monospace; color: #94a3b8; }

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

    <div id="legend-card" style="display: ${colorMode !== 'single' ? 'block' : 'none'};">
      <div class="legend-header">
        <span id="legend-title" class="legend-title">${colorMode === 'altitude' ? 'WYSOKOŚĆ (M N.P.M.)' : 'PRĘDKOŚĆ (KM/H)'}</span>
        <button id="btn-toggle-legend" class="legend-min-btn" type="button" title="Zwiń / Rozwiń legendę">▴</button>
      </div>
      <div id="legend-body">
        <div id="legend-bar" class="legend-bar"></div>
        <div id="legend-ticks" class="legend-ticks"></div>
      </div>
    </div>

    <div id="hud-card">
      <div class="hud-header">Telemetria pojazdu</div>
      <div class="hud-line"><span class="hud-lbl">Czas:</span><span id="h-time" class="hud-v">--:--:--</span></div>
      <div class="hud-line"><span class="hud-lbl">Prędkość:</span><span id="h-spd" class="hud-v">0.0 km/h</span></div>
      <div class="hud-line"><span class="hud-lbl">Wysokość:</span><span id="h-alt" class="hud-v">-- m</span></div>
      ${hasGForceData ? `
      <div id="hud-gg-box">
        <div class="hud-gg-title">Diagram G-G</div>
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
      <div class="ctrl-speed-box" title="Wybierz sposób kolorowania trasy na mapie (prędkość, wysokość, jednolity)">
        <span class="ctrl-speed-lbl">Kolor:</span>
        <select id="sel-color-mode" class="ctrl-speed-input" style="width: auto; padding: 2px 6px; font-size: 11px; cursor: pointer;">
          <option value="speed" ${colorMode === 'speed' ? 'selected' : ''}>Prędkość</option>
          <option value="altitude" ${colorMode === 'altitude' ? 'selected' : ''}>Wysokość</option>
          <option value="single" ${colorMode === 'single' ? 'selected' : ''}>Jednolity</option>
        </select>
      </div>
      <div class="ctrl-speed-box" id="box-overlap-mode" style="display: ${colorMode === 'speed' ? 'inline-flex' : 'none'};" title="Wybierz sposób kolorowania wspólnych odcinków dróg (nakładające się trasy)">
        <span class="ctrl-speed-lbl">Wspólne:</span>
        <select id="sel-overlap-mode" class="ctrl-speed-input" style="width: auto; padding: 2px 6px; font-size: 11px; cursor: pointer;">
          <option value="max" ${speedOverlap === 'max' ? 'selected' : ''}>V max (szybszy)</option>
          <option value="avg" ${speedOverlap === 'avg' ? 'selected' : ''}>V śr (średnia)</option>
          <option value="last" ${speedOverlap === 'last' ? 'selected' : ''}>Ostatni</option>
        </select>
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
          ${hasGForceData ? '<button class="chart-tab-btn ' + (!includeElevation ? 'active' : '') + '" id="tab-btn-gg" type="button">🎯 Diagram G-G</button>' : ''}
        </div>

        <div class="chart-legend-box" id="chart-legend-alt" style="display: ${includeElevation ? 'flex' : 'none'};">
          <span style="color:#38bdf8;">Wysokość: <b id="val-alt">-- m</b></span>
          <span style="color:#64748b;">(Min: ${stats.minAlt.toFixed(0)}m, Max: ${stats.maxAlt.toFixed(0)}m)</span>
        </div>

        <div class="chart-legend-box" id="chart-legend-gg" style="display: ${(!includeElevation && hasGForceData) ? 'flex' : 'none'};">
          <span style="color:#e2e8f0;">Bieżące: <b id="val-gg-curr">--</b></span>
          <span style="color:#64748b;">|</span>
          <span style="color:#94a3b8;">Max skręt: <b id="val-gg-max-lat" style="color:#f59e0b;">--</b></span>
          <span style="color:#64748b;">|</span>
          <span style="color:#94a3b8;">Max wzdłużne: <b id="val-gg-max-lon" style="color:#38bdf8;">--</b></span>
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
    const segLens = ${segLensJson};
    const segments = [];
    let _curOff = 0;
    for (let _i = 0; _i < segLens.length; _i++) {
      const _l = segLens[_i];
      segments.push(points.slice(_curOff, _curOff + _l));
      _curOff += _l;
    }
    const stats = ${statsJson};
    let activeColorMode = ${JSON.stringify(colorMode)};
    const singleColor = ${JSON.stringify(singleColor)};
    const minAlt = ${stats.minAlt};
    const maxAlt = ${stats.maxAlt};
    const hasGForceData = ${hasGForceData ? 'true' : 'false'};
    const includeElevation = ${includeElevation ? 'true' : 'false'};
    const showBottomPanel = ${showBottomPanel ? 'true' : 'false'};

    const SPEED_PALETTE = [
      { pct: 0.00, r: 6,   g: 182, b: 212 },
      { pct: 0.08, r: 14,  g: 165, b: 233 },
      { pct: 0.18, r: 16,  g: 185, b: 129 },
      { pct: 0.32, r: 34,  g: 197, b: 94  },
      { pct: 0.48, r: 132, g: 204, b: 22  },
      { pct: 0.64, r: 234, g: 179, b: 8   },
      { pct: 0.78, r: 249, g: 115, b: 22  },
      { pct: 0.90, r: 239, g: 68,  b: 68  },
      { pct: 1.00, r: 225, g: 29,  b: 72  }
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
      if (activeColorMode === 'single') return singleColor;
      if (activeColorMode === 'altitude') {
        const span = Math.max(10, maxAlt - minAlt);
        const alt = (pt.altitude !== null && pt.altitude !== undefined && !isNaN(Number(pt.altitude))) ? Number(pt.altitude) : minAlt;
        const clamped = Math.max(0, Math.min(1.0, Math.round(((alt - minAlt) / span) * 16) / 16));
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

      // Speed mode (kwantyzacja do 20 koszyków dla wydajności Canvas z perceptualną korekcją gamma)
      const rawSpd = pt.color_speed !== undefined ? pt.color_speed : (pt.speed_kmh || 0);
      const maxSpd = Math.max(10, Number(stats.maxSpeedKmh) || 100);
      const ratio = Math.max(0, Math.min(1.0, rawSpd / maxSpd));
      const clamped = Math.round(Math.pow(ratio, 0.85) * 20) / 20;
      for (let i = 0; i < SPEED_PALETTE.length - 1; i++) {
        const s0 = SPEED_PALETTE[i];
        const s1 = SPEED_PALETTE[i + 1];
        if (clamped >= s0.pct && clamped <= s1.pct) {
          const f = (clamped - s0.pct) / (s1.pct - s0.pct);
          const r = Math.round(s0.r + (s1.r - s0.r) * f);
          const g = Math.round(s0.g + (s1.g - s0.g) * f);
          const b = Math.round(s0.b + (s1.b - s0.b) * f);
          return 'rgb(' + r + ',' + g + ',' + b + ')';
        }
      }
      return 'rgb(225, 29, 72)';
    }

    function updateLegend(mode) {
      const card = document.getElementById('legend-card');
      const title = document.getElementById('legend-title');
      const bar = document.getElementById('legend-bar');
      const ticks = document.getElementById('legend-ticks');
      if (!card || !title || !bar || !ticks) return;

      if (mode === 'single') {
        card.style.display = 'none';
        return;
      }

      card.style.display = 'block';
      if (mode === 'altitude') {
        title.innerText = 'WYSOKOŚĆ (M N.P.M.)';
        bar.style.background = 'linear-gradient(to right, #10b981 0%, #84cc16 20%, #eab308 40%, #f97316 65%, #ef4444 85%, #a855f7 100%)';
        ticks.innerHTML = '<span>' + minAlt.toFixed(0) + 'm</span><span>' + ((minAlt + maxAlt) / 2).toFixed(0) + 'm</span><span>' + maxAlt.toFixed(0) + 'm</span>';
      } else {
        const maxSpd = Math.max(10, Math.round(stats.maxSpeedKmh || 100));
        title.innerText = 'PRĘDKOŚĆ (KM/H)';
        bar.style.background = 'linear-gradient(to right, #06b6d4 0%, #0ea5e9 8%, #10b981 18%, #22c55e 32%, #84cc16 48%, #eab308 64%, #f97316 78%, #ef4444 90%, #e11d48 100%)';
        ticks.innerHTML = '<span>0</span><span>' + Math.round(maxSpd * 0.25) + '</span><span>' + Math.round(maxSpd * 0.5) + '</span><span>' + Math.round(maxSpd * 0.75) + '</span><span>' + maxSpd + '</span>';
      }
    }

    function computeLocationSpeeds(pts, mode) {
      if (!pts || !pts.length) return;
      if (mode === 'last') {
        for (let i = 0; i < pts.length; i++) {
          pts[i].color_speed = pts[i].speed_kmh || 0;
        }
        return;
      }
      const midLat = pts[0].lat;
      const cosLat = Math.cos(midLat * Math.PI / 180);
      const cellLat = 0.00045;
      const cellLon = cellLat / Math.max(0.1, cosLat);
      const grid = new Map();

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const ci = Math.floor(p.lat / cellLat);
        const cj = Math.floor(p.lon / cellLon);
        const key = ci + '_' + cj;
        let cell = grid.get(key);
        if (!cell) {
          cell = { ci, cj, speeds: [] };
          grid.set(key, cell);
        }
        cell.speeds.push(p.speed_kmh || 0);
      }

      for (const cell of grid.values()) {
        let maxS = 0;
        let sumMoving = 0;
        let countMoving = 0;
        let sumAll = 0;
        for (let s = 0; s < cell.speeds.length; s++) {
          const spd = cell.speeds[s];
          if (spd > maxS) maxS = spd;
          sumAll += spd;
          if (spd >= 2.0) {
            sumMoving += spd;
            countMoving++;
          }
        }
        cell.maxSpeed = maxS;
        cell.avgSpeed = countMoving > 0 ? (sumMoving / countMoving) : (sumAll / Math.max(1, cell.speeds.length));
      }

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const ci = Math.floor(p.lat / cellLat);
        const cj = Math.floor(p.lon / cellLon);
        if (mode === 'max') {
          let maxV = p.speed_kmh || 0;
          for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
              const neighbor = grid.get((ci + di) + '_' + (cj + dj));
              if (neighbor && neighbor.maxSpeed > maxV) {
                maxV = neighbor.maxSpeed;
              }
            }
          }
          p.color_speed = maxV;
        } else if (mode === 'avg') {
          let sumV = 0;
          let countV = 0;
          for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
              const neighbor = grid.get((ci + di) + '_' + (cj + dj));
              if (neighbor) {
                sumV += neighbor.avgSpeed;
                countV++;
              }
            }
          }
          p.color_speed = countV > 0 ? (sumV / countV) : (p.speed_kmh || 0);
        }
      }
    }

    if (!points || !points.length) {
      document.getElementById('map').innerHTML = '<div style="padding:20px; color:#ef4444;">Brak punktów trasy do wyświetlenia.</div>';
    } else {
      const map = L.map('map', {
        attributionControl: false,
        preferCanvas: true
      }).setView([points[0].lat, points[0].lon], 13);

      try {
        if (typeof L.maplibreGL === 'function') {
          // Wektorowy styl Carto Dark (OpenFreeMap Dark) - bez klucza API i bez znaków wodnych
          L.maplibreGL({
            style: 'https://tiles.openfreemap.org/styles/dark'
          }).addTo(map);
        } else {
          throw new Error('maplibreGL niedostępne');
        }
      } catch (e) {
        // Zapasowy raster Carto Dark
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 19,
          subdomains: 'abcd'
        }).addTo(map);
      }

      const canvasRenderer = L.canvas({ padding: 0.5 });
      const trackLayerGroup = L.featureGroup().addTo(map);

      function renderTrackLayers() {
        trackLayerGroup.clearLayers();

        if (activeColorMode === 'single') {
          for (let s = 0; s < segments.length; s++) {
            const seg = segments[s];
            if (seg.length < 2) continue;
            const coords = [];
            for (let i = 0; i < seg.length; i++) {
              coords.push([seg[i].lat, seg[i].lon]);
            }
            L.polyline(coords, {
              color: singleColor,
              weight: 3.5,
              opacity: 0.92,
              renderer: canvasRenderer
            }).addTo(trackLayerGroup);
          }
        } else {
          // Kolorowanie ciągłe (speed / altitude) - grupowanie w multilinie i sortowanie wg wartości
          const bucketMap = new Map();
          for (let s = 0; s < segments.length; s++) {
            const seg = segments[s];
            for (let i = 1; i < seg.length; i++) {
              const pt = seg[i];
              const col = getTrackColor(pt);
              const sortKey = (activeColorMode === 'speed')
                ? ((pt.color_speed !== undefined ? pt.color_speed : pt.speed_kmh) || 0)
                : ((pt.altitude !== null && !isNaN(Number(pt.altitude))) ? Number(pt.altitude) : minAlt);

              let entry = bucketMap.get(col);
              if (!entry) {
                entry = { color: col, sortKey: sortKey, lines: [] };
                bucketMap.set(col, entry);
              }
              entry.lines.push([[seg[i - 1].lat, seg[i - 1].lon], [seg[i].lat, seg[i].lon]]);
            }
          }

          // Sortujemy rosnąco wg sortKey: wolniejsze/niższe na spód, szybsze/wyższe na wierzch!
          const sortedEntries = Array.from(bucketMap.values()).sort((a, b) => a.sortKey - b.sortKey);

          for (let k = 0; k < sortedEntries.length; k++) {
            const item = sortedEntries[k];
            L.polyline(item.lines, {
              color: item.color,
              weight: 3.5,
              opacity: 0.92,
              renderer: canvasRenderer
            }).addTo(trackLayerGroup);
          }
        }
      }

      renderTrackLayers();

      const selColor = document.getElementById('sel-color-mode');
      const boxOverlap = document.getElementById('box-overlap-mode');

      if (selColor) {
        selColor.addEventListener('change', () => {
          activeColorMode = selColor.value;
          if (boxOverlap) {
            boxOverlap.style.display = (activeColorMode === 'speed') ? 'inline-flex' : 'none';
          }
          updateLegend(activeColorMode);
          renderTrackLayers();
        });
      }

      const selOverlap = document.getElementById('sel-overlap-mode');
      if (selOverlap) {
        selOverlap.addEventListener('change', () => {
          computeLocationSpeeds(points, selOverlap.value);
          renderTrackLayers();
        });
      }

      const btnToggleLegend = document.getElementById('btn-toggle-legend');
      const legendCard = document.getElementById('legend-card');
      if (btnToggleLegend && legendCard) {
        btnToggleLegend.addEventListener('click', () => {
          const isCollapsed = legendCard.classList.toggle('collapsed');
          btnToggleLegend.innerText = isCollapsed ? '▾' : '▴';
        });
      }

      updateLegend(activeColorMode);

      if (stats.bounds && stats.bounds.length === 4) {
        map.fitBounds([
          [stats.bounds[1], stats.bounds[0]],
          [stats.bounds[3], stats.bounds[2]]
        ], { padding: [40, 40] });
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

      const tabBtnAlt = document.getElementById('tab-btn-alt');
      const tabBtnGG = document.getElementById('tab-btn-gg');

      const legendAlt = document.getElementById('chart-legend-alt');
      const legendGG = document.getElementById('chart-legend-gg');

      const valAlt = document.getElementById('val-alt');
      const valGgCurr = document.getElementById('val-gg-curr');
      const valGgMaxLat = document.getElementById('val-gg-max-lat');
      const valGgMaxLon = document.getElementById('val-gg-max-lon');

      let activeTab = includeElevation ? 'alt' : (hasGForceData ? 'gg' : 'none');

      // Prekalkulacja statystyk przeciążeń
      let minG = -1.0, maxG = 1.0;
      let peakLatG = 0.0, peakLonG = 0.0;
      if (hasGForceData) {
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
      }

      // Szybkie obliczenie timestampów
      const timestamps = new Float64Array(points.length);
      for (let i = 0; i < points.length; i++) {
        timestamps[i] = points[i].timestamp ? Date.parse(points[i].timestamp) : NaN;
      }
      const hasTimestamps = timestamps.length > 0 && !isNaN(timestamps[0]);

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
        if (activeTab === 'alt') {
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

        if (hasGForceData) {
          const gx = (pt.g_x !== null && pt.g_x !== undefined && !isNaN(Number(pt.g_x))) ? Number(pt.g_x) : null;
          const gy = (pt.g_y !== null && pt.g_y !== undefined && !isNaN(Number(pt.g_y))) ? Number(pt.g_y) : null;

          if (valGgCurr) {
            if (gx !== null && gy !== null) {
              valGgCurr.innerText = 'Gx: ' + (gx >= 0 ? '+' : '') + gx.toFixed(2) + 'G, Gy: ' + (gy >= 0 ? '+' : '') + gy.toFixed(2) + 'G';
            } else {
              valGgCurr.innerText = '--';
            }
          }
          if (valAlt) valAlt.innerText = (pt.altitude !== null && pt.altitude !== undefined && !isNaN(Number(pt.altitude))) ? Number(pt.altitude).toFixed(1) + ' m' : '-- m';

          drawHudGG(idx);
          updateChart(idx);
        }

        if (slider) slider.value = idx;
        if (lblProg) lblProg.innerText = (idx + 1) + ' / ' + points.length;
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
          if (hasTimestamps && !isNaN(timestamps[0])) {
            virtualTime = timestamps[0];
          }
          renderCarAt(0);
        }
        isPlaying = true;
        btnPlay.innerText = '⏸ Pauza';
        lastWallClock = performance.now();
        if (hasTimestamps && !isNaN(timestamps[currentIndex])) {
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
            if (!isNaN(nextT) && !isNaN(currT) && (nextT - currT > 5 * 60 * 1000) && virtualTime < nextT) {
              virtualTime = nextT;
            }

            if (!isNaN(nextT) && virtualTime >= nextT) {
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

      // Obsługa zakładek wykresów (Profil wysokości, Diagram G-G)
      function switchTab(tab) {
        activeTab = tab;
        if (tabBtnAlt) tabBtnAlt.classList.toggle('active', tab === 'alt');
        if (tabBtnGG) tabBtnGG.classList.toggle('active', tab === 'gg');

        if (legendAlt) legendAlt.style.display = (tab === 'alt') ? 'flex' : 'none';
        if (legendGG) legendGG.style.display = (tab === 'gg') ? 'flex' : 'none';

        updateChart(currentIndex);
      }
      if (tabBtnAlt) tabBtnAlt.addEventListener('click', () => switchTab('alt'));
      if (tabBtnGG) tabBtnGG.addEventListener('click', () => switchTab('gg'));

      // Zwijanie / Rozwijanie panelu wykresu
      if (btnToggleChart && chartPanel) {
        btnToggleChart.addEventListener('click', () => {
          const isCollapsed = chartPanel.classList.toggle('collapsed');
          if (ctrlBar) ctrlBar.classList.toggle('chart-collapsed', isCollapsed);
          const legendEl = document.getElementById('legend-card');
          if (legendEl) legendEl.classList.toggle('chart-collapsed', isCollapsed);
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
  const escapeXml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function generateGpx(points, segments, stats, titleText, options = {}) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NNAPER" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Trasa ${escapeXml(titleText)}</name></metadata>
`;
    if (options.stops && Array.isArray(options.stops)) {
      for (const st of options.stops) {
        if (Number.isFinite(Number(st.lat)) && Number.isFinite(Number(st.lon))) {
          xml += `  <wpt lat="${st.lat}" lon="${st.lon}">\n`;
          if (st.name) xml += `    <name>${escapeXml(st.name)}</name>\n`;
          xml += `  </wpt>\n`;
        }
      }
    }

    xml += `  <trk>\n    <name>Trasa NNAPER - ${escapeXml(titleText)}</name>\n`;
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

  function generateGeoJson(points, segments, stats, titleText, options = {}) {
    const multiCoords = segments.map(seg => seg.map(p => [p.lon, p.lat, p.altitude || 0]));
    const features = [
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
    ];

    if (options.stops && Array.isArray(options.stops)) {
      for (let i = 0; i < options.stops.length; i++) {
        const st = options.stops[i];
        const role = i === 0 ? 'start' : (i === options.stops.length - 1 ? 'destination' : `stop_${i}`);
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [st.lon, st.lat]
          },
          properties: {
            role: role,
            name: st.name || ''
          }
        });
      }
    }

    const geo = {
      type: 'FeatureCollection',
      features
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
    if (options.stops && Array.isArray(options.stops)) {
      for (let i = 0; i < options.stops.length; i++) {
        const st = options.stops[i];
        const role = i === 0 ? 'Start' : (i === options.stops.length - 1 ? 'Cel' : `Punkt ${i}`);
        placemarks += `    <Placemark>
      <name>${escapeXml(role + ': ' + (st.name || ''))}</name>
      <Point>
        <coordinates>${st.lon},${st.lat},0</coordinates>
      </Point>
    </Placemark>\n`;
      }
    }

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
    <name>Trasa NNAPER - ${escapeXml(titleText)}</name>
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

  const selDayYear = document.getElementById('export-sel-day-year');
  const selDayMonth = document.getElementById('export-sel-day-month');
  const selDayDay = document.getElementById('export-sel-day-day');
  const selYear = document.getElementById('export-sel-year');
  const selYearM = document.getElementById('export-sel-year-m');
  const selMonth = document.getElementById('export-sel-month');

  const exportOptionsBox = document.getElementById('export-options-box');
  const colorModeRow = document.getElementById('opt-color-mode-row');
  const selColorMode = document.getElementById('export-opt-color-mode');
  const inSingleColor = document.getElementById('export-opt-single-color');
  const selSpeedOverlap = document.getElementById('export-opt-speed-overlap');
  const speedOverlapRow = document.getElementById('opt-speed-overlap-row');
  const chkIncludeChart = document.getElementById('export-opt-include-chart');
  const chartRow = document.getElementById('opt-chart-row');
  const chkIncludeGForce = document.getElementById('export-opt-include-gforce');
  const gforceRow = document.getElementById('opt-gforce-row');
  const inGifFrames = document.getElementById('export-opt-gif-frames');
  const inGifDuration = document.getElementById('export-opt-gif-duration');
  const inGifMaxMb = document.getElementById('export-opt-gif-max-mb');
  const selGifPreset = document.getElementById('export-opt-gif-preset');
  const gifFramesBadge = document.getElementById('gif-frames-badge');
  const gifCalcInfo = document.getElementById('gif-calc-info');
  const gifSpeedRow = document.getElementById('opt-gif-speed-row');
  let isGifAutoFrames = true;

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

  function getSelectedDay() {
    const y = selDayYear ? selDayYear.value : '';
    const m = selDayMonth ? selDayMonth.value : '';
    const d = selDayDay ? selDayDay.value : '';
    if (!y || !m || !d) return '';
    return `${y}-${m}-${d}`;
  }

  function updateDayDays(preselectDay = null) {
    if (!selDayYear || !selDayMonth || !selDayDay || !cachedDatesTree) return;
    const y = selDayYear.value;
    const m = selDayMonth.value;
    const days = (y && m && cachedDatesTree[y] && cachedDatesTree[y][m])
      ? [...cachedDatesTree[y][m]].sort().reverse()
      : [];

    selDayDay.innerHTML = days.length ? '' : '<option value="">Brak dni</option>';
    days.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.innerText = d;
      selDayDay.appendChild(opt);
    });

    if (preselectDay) {
      const dPad = String(preselectDay).padStart(2, '0');
      if (days.includes(dPad)) selDayDay.value = dPad;
    }
  }

  function updateDayMonths(preselectMonth = null, preselectDay = null) {
    if (!selDayYear || !selDayMonth || !cachedDatesTree) return;
    const y = selDayYear.value;
    const months = y && cachedDatesTree[y] ? Object.keys(cachedDatesTree[y]).sort().reverse() : [];

    selDayMonth.innerHTML = months.length ? '' : '<option value="">Brak miesięcy</option>';
    months.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.innerText = `${m} - ${MONTH_NAMES[m] || m}`;
      selDayMonth.appendChild(opt);
    });

    if (preselectMonth) {
      const mPad = String(preselectMonth).padStart(2, '0');
      if (months.includes(mPad)) selDayMonth.value = mPad;
    }

    updateDayDays(preselectDay);
  }

  if (selDayYear) {
    selDayYear.addEventListener('change', () => updateDayMonths());
  }
  if (selDayMonth) {
    selDayMonth.addEventListener('change', () => updateDayDays());
  }

  async function populateScopeControls(preselect = {}) {
    const tree = await loadDatesTree();
    const years = Object.keys(tree).sort().reverse();

    // 1. Kontrolki wyboru dnia (osobno Rok, Miesiąc, Dzień)
    let preDayYear = null;
    let preDayMonth = null;
    let preDayDay = null;

    if (preselect.day) {
      const parts = String(preselect.day).split('-');
      if (parts.length === 3) {
        preDayYear = parts[0];
        preDayMonth = parts[1];
        preDayDay = parts[2];
      }
    }

    if (selDayYear) {
      selDayYear.innerHTML = years.length ? '' : '<option value="">Brak lat</option>';
      years.forEach(y => {
        const opt = document.createElement('option');
        opt.value = y;
        opt.innerText = y;
        selDayYear.appendChild(opt);
      });
      if (preDayYear && years.includes(String(preDayYear))) {
        selDayYear.value = String(preDayYear);
      }
    }

    updateDayMonths(preDayMonth, preDayDay);

    // 2. Kontrolki wyboru roku
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

    // 3. Kontrolki wyboru miesiąca
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

  function updatePlannedRouteScopeInfo() {
    const infoEl = document.getElementById('export-planned-route-info');
    if (!infoEl) return;
    const planned = window.getPlannedRouteData?.();
    if (planned && planned.points && planned.points.length >= 2) {
      const stopsStr = (planned.stops && planned.stops.length)
        ? planned.stops.map((s, idx) => {
            const role = idx === 0 ? '🟢 Start' : (idx === planned.stops.length - 1 ? '🏁 Cel' : `📍 Punkt ${idx}`);
            return `<b>${role}:</b> ${s.name || 'Współrzędne'}`;
          }).join('<br/>')
        : 'Trasa zaplanowana';
      infoEl.innerHTML = `
        <div style="font-weight: 600; color: #38bdf8; margin-bottom: 6px;">🎯 Aktywna trasa z planera:</div>
        <div style="font-size: 12px; color: #f1f5f9; line-height: 1.6; margin-bottom: 8px; background: rgba(15, 23, 42, 0.6); padding: 8px 10px; border-radius: 6px; border: 1px solid #1e293b;">
          ${stopsStr}
        </div>
        <div style="font-size: 12px; color: #94a3b8;">
          Dystans: <b style="color: #10b981;">${planned.distanceKm.toFixed(1)} km</b>
          ${planned.durationMin ? ` • Szacowany czas: <b style="color: #e2e8f0;">${planned.durationMin} min</b>` : ''}
          • Punkty geometrii: <b>${planned.points.length}</b>
        </div>
      `;
    } else {
      infoEl.innerHTML = `
        <div style="color: #f59e0b; font-weight: 600; margin-bottom: 6px;">⚠️ Brak wyznaczonej trasy w planerze</div>
        <div style="font-size: 12px; color: #94a3b8; line-height: 1.5;">
          Otwórz panel <b>Planowanie trasy</b> na mapie, dodaj punkty A i B, aby wyznaczyć trasę, a następnie wróć tutaj lub kliknij przycisk <b>„📥 Eksportuj trasę”</b> bezpośrednio w panelu planera.
        </div>
      `;
    }
  }

  function updateOptionVisibility() {
    const isSingleDayOrActive = (activeScope === 'day' || activeScope === 'active');
    const isPlannedRoute = (activeScope === 'planned');
    const isStaticVisual = (activeFormat === 'png' || activeFormat === 'svg' || activeFormat === 'gif');
    const isGraphicWithChart = (activeFormat === 'html' || activeFormat === 'png' || activeFormat === 'svg');

    // Wiersz trybu kolorowania:
    // NIEWYŚWIETLANY dla HTML (wewnątrz wyeksportowanego HTML użytkownik sam wybiera tryb na żywo w pasku).
    // Widoczny wyłącznie dla statycznych formatów graficznych: PNG, SVG, GIF.
    if (colorModeRow) {
      colorModeRow.style.display = isStaticVisual ? 'flex' : 'none';
    }

    // Wybór koloru pojedynczego (tylko dla formatów statycznych w trybie 'single')
    if (inSingleColor) {
      inSingleColor.style.display = (isStaticVisual && selColorMode && selColorMode.value === 'single') ? 'inline-block' : 'none';
    }

    // Wspólne odcinki dróg:
    // Ukryte dla planned (nie nakładają się różne dni) oraz dla HTML
    if (speedOverlapRow) {
      speedOverlapRow.style.display = (!isPlannedRoute && isStaticVisual && selColorMode && selColorMode.value === 'speed') ? 'flex' : 'none';
    }

    // Profil wysokości: dozwolony WYŁĄCZNIE dla formatów HTML, PNG i SVG przy 1 dniu / aktywnych (dla planned brak wysokości GPS)
    if (chartRow) {
      chartRow.style.display = (!isPlannedRoute && isSingleDayOrActive && isGraphicWithChart) ? 'flex' : 'none';
    }

    // Wykres przeciążeń G / Diagram G-G: TYLKO dla HTML oraz SVG (dla 1 dnia / aktywnych z telemetrią G)
    if (gforceRow) {
      gforceRow.style.display = (!isPlannedRoute && isSingleDayOrActive && (activeFormat === 'html' || activeFormat === 'svg')) ? 'flex' : 'none';
    }

    // Parametry animacji GIF: TYLKO dla formatu GIF
    if (gifSpeedRow) {
      gifSpeedRow.style.display = (activeFormat === 'gif') ? 'flex' : 'none';
    }

    // Cała sekcja 3 (Opcje stylu i wykresów):
    // Wyświetlana tylko wtedy, gdy przynajmniej jedna opcja jest faktycznie dostępna.
    const hasAnyOption = isStaticVisual || (activeFormat === 'html' && isSingleDayOrActive && !isPlannedRoute);
    if (exportOptionsBox) {
      exportOptionsBox.style.display = hasAnyOption ? 'block' : 'none';
      const exportOptionsTitle = exportOptionsBox.querySelector('.export-section-title');
      if (exportOptionsTitle) {
        if (activeFormat === 'html') {
          exportOptionsTitle.innerText = '3. Opcje wykresów i telemetrii:';
        } else if (activeFormat === 'gif') {
          exportOptionsTitle.innerText = '3. Opcje stylu i animacji GIF:';
        } else {
          exportOptionsTitle.innerText = '3. Opcje stylu i wykresów:';
        }
      }
    }
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
      active: document.getElementById('export-scope-active-box'),
      planned: document.getElementById('export-scope-planned-box')
    };

    Object.keys(boxes).forEach(k => {
      if (boxes[k]) boxes[k].style.display = (k === scope) ? 'block' : 'none';
    });

    if (scope === 'planned') {
      updatePlannedRouteScopeInfo();
    }

    updateOptionVisibility();
  }

  function setFormat(fmt) {
    activeFormat = fmt;
    document.querySelectorAll('.format-card').forEach(c => {
      c.classList.toggle('active', c.getAttribute('data-format') === fmt);
    });

    updateOptionVisibility();
  }

  // Obsługa wyboru koloru: prędkość / wysokość / jednolity
  if (selColorMode) {
    selColorMode.addEventListener('change', () => {
      updateOptionVisibility();
    });
  }

  // Obsługa parametrów animacji GIF (maksymalna płynność, czas i dopasowanie do limitu MB)
  function updateGifCalcInfo() {
    if (!gifCalcInfo) return;
    const dur = Math.max(0.5, Math.min(60, parseFloat(inGifDuration?.value) || 4.0));
    const maxMb = inGifMaxMb ? parseFloat(inGifMaxMb.value) : 5.0;
    const maxMbStr = (!isNaN(maxMb) && maxMb > 0) ? `do ${maxMb.toFixed(1)} MB` : 'bez limitu wagi';

    if (isGifAutoFrames) {
      const targetFps = dur <= 4.0 ? 25 : 22;
      const autoFrames = Math.max(20, Math.min(250, Math.round(dur * targetFps)));
      if (inGifFrames) inGifFrames.value = autoFrames;
      if (gifFramesBadge) {
        gifFramesBadge.innerText = 'AUTO';
        gifFramesBadge.style.background = '#0284c7';
      }
      gifCalcInfo.innerText = `Maks. płynność (~${targetFps} FPS, ${autoFrames} kl.) • ${maxMbStr}`;
    } else {
      const frames = Math.max(5, Math.min(300, parseInt(inGifFrames?.value, 10) || 60));
      const fps = (frames / dur).toFixed(1);
      if (gifFramesBadge) {
        gifFramesBadge.innerText = 'RĘCZNE';
        gifFramesBadge.style.background = '#64748b';
      }
      gifCalcInfo.innerText = `Ręczne: ${frames} kl., ${dur.toFixed(1)}s (~${fps} FPS) • ${maxMbStr}`;
    }
  }

  if (gifFramesBadge) {
    gifFramesBadge.addEventListener('click', () => {
      isGifAutoFrames = !isGifAutoFrames;
      if (!isGifAutoFrames && selGifPreset) selGifPreset.value = 'custom';
      updateGifCalcInfo();
    });
  }

  if (inGifFrames) {
    inGifFrames.addEventListener('input', () => {
      isGifAutoFrames = false;
      if (selGifPreset) selGifPreset.value = 'custom';
      updateGifCalcInfo();
    });
  }

  if (inGifDuration) {
    inGifDuration.addEventListener('input', () => {
      if (selGifPreset && !isGifAutoFrames) selGifPreset.value = 'custom';
      updateGifCalcInfo();
    });
  }

  if (inGifMaxMb) {
    inGifMaxMb.addEventListener('input', () => {
      if (selGifPreset) selGifPreset.value = 'custom';
      updateGifCalcInfo();
    });
  }

  if (selGifPreset) {
    selGifPreset.addEventListener('change', () => {
      const p = selGifPreset.value;
      if (p === 'auto-5mb') {
        if (inGifMaxMb) inGifMaxMb.value = '5.0';
        if (inGifDuration) inGifDuration.value = '4.0';
        isGifAutoFrames = true;
      } else if (p === 'messenger-2mb') {
        if (inGifMaxMb) inGifMaxMb.value = '2.0';
        if (inGifDuration) inGifDuration.value = '3.0';
        isGifAutoFrames = true;
      } else if (p === 'discord-8mb') {
        if (inGifMaxMb) inGifMaxMb.value = '8.0';
        if (inGifDuration) inGifDuration.value = '5.0';
        isGifAutoFrames = true;
      } else if (p === 'hq-15mb') {
        if (inGifMaxMb) inGifMaxMb.value = '15.0';
        if (inGifDuration) inGifDuration.value = '6.0';
        isGifAutoFrames = true;
      } else if (p === 'unlimited') {
        if (inGifMaxMb) inGifMaxMb.value = '0';
        if (inGifDuration) inGifDuration.value = '4.0';
        isGifAutoFrames = true;
      } else if (p === 'custom') {
        isGifAutoFrames = false;
      }
      updateGifCalcInfo();
    });
  }

  function openExportModal(params = {}) {
    if (modalBackdrop) modalBackdrop.style.display = 'flex';
    if (statusBox) statusBox.style.display = 'none';

    populateScopeControls(params).then(() => {
      const scopeToSet = params.scope || (params.day ? 'day' : (params.month ? 'month' : (params.year ? 'year' : activeScope)));
      setScopeTab(scopeToSet);
    });

    setFormat(params.format || activeFormat || 'html');
    updateOptionVisibility();
    updateGifCalcInfo();
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

    const colorMode = (activeFormat === 'html') ? 'speed' : (selColorMode ? selColorMode.value : 'speed');
    const singleColor = (activeFormat === 'html') ? '#06b6d4' : (inSingleColor ? inSingleColor.value : '#06b6d4');
    const speedOverlap = (activeFormat === 'html') ? 'max' : (selSpeedOverlap ? selSpeedOverlap.value : 'max');
    const isSingleDayOrActive = (activeScope === 'day' || activeScope === 'active');
    const includeChart = isSingleDayOrActive ? (chkIncludeChart ? chkIncludeChart.checked : true) : false;
    const includeGForce = isSingleDayOrActive ? (chkIncludeGForce ? chkIncludeGForce.checked : true) : false;
    const gifFrames = inGifFrames ? (parseInt(inGifFrames.value, 10) || 100) : 100;
    const gifDurationSec = inGifDuration ? (parseFloat(inGifDuration.value) || 4.0) : 4.0;
    const gifMaxMb = inGifMaxMb ? (parseFloat(inGifMaxMb.value) || 0) : 5.0;
    const gifFramesAuto = isGifAutoFrames;

    const options = {
      colorMode,
      singleColor,
      speedOverlap,
      includeChart,
      includeGForce,
      gifFrames,
      gifFramesAuto,
      gifDurationSec,
      gifMaxMb
    };

    try {
      let queryUrl = `${apiBaseUrl}/api/export-data?scope=${activeScope}`;
      let title = 'Trasa';
      let scopeFilename = 'trasa';
      let rawPoints = null;

      if (activeScope === 'planned') {
        const planned = window.getPlannedRouteData?.();
        if (!planned || !planned.points || planned.points.length < 2) {
          throw new Error('Brak wyznaczonej trasy w planerze. Otwórz panel „Planowanie trasy” i wyznacz trasę między co najmniej dwoma punktami.');
        }
        rawPoints = planned.points;
        options.stops = planned.stops;
        options.plannedDistanceKm = planned.distanceKm;
        options.plannedDurationSeconds = (planned.durationMin || 0) * 60;
        title = `Utworzona trasa (${planned.distanceKm.toFixed(1)} km)`;
        scopeFilename = 'utworzona_trasa';
      } else if (activeScope === 'day') {
        const d = getSelectedDay();
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

      if (!rawPoints) {
        const res = await fetch(queryUrl);
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.detail || `Błąd serwera (HTTP ${res.status})`);
        }
        rawPoints = await res.json();
      }

      if (!rawPoints || !rawPoints.length) {
        throw new Error('Brak punktów telemetrycznych w wybranym okresie.');
      }

      // 0. Oczyszczenie punktów z błędnych współrzędnych (np. null, NaN, (0,0) przed fixem GPS)
      let points = rawPoints.map(p => {
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

      if (statusText) statusText.innerText = `Przetwarzanie ${points.length} punktów...`;
      if (progressFill) progressFill.style.width = '55%';

      // 1. Sanityzacja prędkości (usunięcie szumów GPS)
      cleanAndSanitizeSpeeds(points);

      // 2. Optymalizacja zbędnych punktów postoju dla zakresów zbiorczych
      points = optimizePointsForExport(points, activeScope);

      // 2.5. Przestrzenna agregacja prędkości dla nakładających się przejazdów
      if (colorMode === 'speed') {
        computeLocationSpeeds(points, speedOverlap);
      }

      // 3. Segmentacja na ciągłe przejazdy (eliminacja długich prostych linii)
      const segments = splitIntoContiguousSegments(points);
      const stats = computeRouteStats(points, segments);
      if (activeScope === 'planned' && options.plannedDistanceKm) {
        stats.totalDistanceKm = options.plannedDistanceKm;
        if (options.plannedDurationSeconds) {
          stats.durationSeconds = options.plannedDurationSeconds;
          stats.avgSpeedKmh = stats.durationSeconds > 0
            ? Math.round((stats.totalDistanceKm / (stats.durationSeconds / 3600)) * 10) / 10
            : 50.0;
        }
      }
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
        blob = generateGpx(points, segments, stats, title, options);
        outExt = 'gpx';
      } else if (activeFormat === 'csv') {
        blob = generateCsv(points, segments, stats, title);
        outExt = 'csv';
      } else if (activeFormat === 'geojson') {
        blob = generateGeoJson(points, segments, stats, title, options);
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
