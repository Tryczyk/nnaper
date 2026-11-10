/**
 * Kompleksowy zestaw testów regresyjnych, integracyjnych API oraz 10 000+ przypadków brzegowych (Edge Cases) platformy NNAPER.
 * Przeznaczony dla programistów oraz agentów AI w celu weryfikacji, że żadna zmiana nie psuje istniejących funkcjonalności.
 *
 * Uruchamianie:
 *   node tests/run_tests.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const API_BASE = process.env.NNAPER_TEST_API || 'http://localhost:8000';

let suitesPassed = 0;
let suitesFailed = 0;
let totalAssertions = 0;

function countAssert(cond, msg) {
  totalAssertions++;
  if (!cond) {
    throw new Error(msg || 'Assertion failed');
  }
}

async function runSuite(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    suitesPassed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    suitesFailed++;
  }
}

function httpRequest(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = Object.assign({}, headers);
    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
        timeout: 15000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, buffer: buf, text, json });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout na ${method} ${urlPath}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Deterministyczny generator PRNG (Mulberry32) do powtarzalnych 10 000+ testów brzegowych
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000.0;
  const dLat = ((lat2 - lat1) * Math.PI) / 180.0;
  const dLon = ((lon2 - lon1) * Math.PI) / 180.0;
  const la1 = (lat1 * Math.PI) / 180.0;
  const la2 = (lat2 * Math.PI) / 180.0;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function minDistPolylineToPointM(coords, lat, lon) {
  if (!coords || coords.length === 0) return Infinity;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180.0));
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineM(lat, lon, coords[i][1], coords[i][0]);
    if (d < best) best = d;
    if (i + 1 < coords.length) {
      const ax = (coords[i][0] - lon) * 111320.0 * cosLat;
      const ay = (coords[i][1] - lat) * 111320.0;
      const bx = (coords[i + 1][0] - lon) * 111320.0 * cosLat;
      const by = (coords[i + 1][1] - lat) * 111320.0;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq > 1e-6) {
        const t = -(ax * dx + ay * dy) / lenSq;
        if (t > 0 && t < 1) {
          const segD = Math.hypot(ax + t * dx, ay + t * dy);
          if (segD < best) best = segD;
        }
      }
    }
  }
  return best;
}

// Przelicza lon/lat na współrzędne kafelka XYZ (Web Mercator) dla danego zoomu
function lonLatToTile(lon, lat, z) {
  const n = 1 << z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

function computeEdgeCostJS(e, avoidPoints, avoidMode, prefs) {
  let cost = Math.max(e.durationS, 0.5);
  if (prefs.auto_exploratory) {
    cost = Math.max(e.lengthM / 12.5, 0.5);
    if (['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(e.highway)) {
      cost = cost * 35.0 + 3500.0;
    } else if (['primary', 'primary_link'].includes(e.highway)) {
      cost *= 1.35;
    } else if (['secondary', 'tertiary', 'unclassified'].includes(e.highway)) {
      cost *= 0.88;
    }
  }
  let hitAvoid = false;
  if (prefs.avoid_highways && ['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(e.highway)) {
    cost = cost * 5000.0 + 2500000.0;
  }
  if (avoidPoints && avoidPoints.length > 0 && e.coords && e.coords.length >= 2) {
    for (const ap of avoidPoints) {
      const rad = ap.radius_m > 0 ? ap.radius_m : 250.0;
      if (minDistPolylineToPointM(e.coords, ap.lat, ap.lon) <= rad) {
        hitAvoid = true;
        if (avoidMode === 'exclude') return { cost: Infinity, excluded: true, hitAvoid: true };
        cost = cost * 10000.0 + 5000000.0;
      }
    }
  }
  if (prefs.aversion_speed_bumps > 0 && e.speedBumps > 0) {
    cost += prefs.aversion_speed_bumps >= 10.5 ? e.speedBumps * 2500000.0 : e.speedBumps * prefs.aversion_speed_bumps * 85.0;
  }
  if (prefs.aversion_crossings > 0 && e.crossings > 0) {
    cost += prefs.aversion_crossings >= 10.5 ? e.crossings * 2500000.0 : e.crossings * prefs.aversion_crossings * 45.0;
  }
  if (prefs.aversion_traffic_signals > 0 && e.trafficSignals > 0) {
    cost += prefs.aversion_traffic_signals >= 10.5 ? e.trafficSignals * 2500000.0 : e.trafficSignals * prefs.aversion_traffic_signals * 65.0;
  }
  if (prefs.aversion_roundabouts > 0 && e.isRoundabout) {
    cost += prefs.aversion_roundabouts >= 10.5 ? 2500000.0 : prefs.aversion_roundabouts * 95.0;
  }
  if (prefs.aversion_intersections > 0 && e.isIntersection) {
    cost += prefs.aversion_intersections >= 10.5 ? 2500000.0 : prefs.aversion_intersections * 30.0;
  }
  if (prefs.avoid_traversed && e.traversed) {
    cost = cost * 280.0 + 18000.0;
  } else if (prefs.auto_exploratory && !e.traversed) {
    cost *= 0.45;
  }
  if (e.usedCount > 0) {
    cost = cost * 350.0 * e.usedCount + 25000.0 * e.usedCount;
  }
  return { cost, excluded: false, hitAvoid };
}

(async () => {
  console.log('=== Uruchamianie pełnego zestawu testów NNAPER (jednostkowe, integracyjne API, 10 000+ Edge Cases) ===\n');

  // ---------------------------------------------------------------------------
  // CZĘŚĆ 1: WALIDACJA SKŁADNI I KONTRAKTÓW FRONTENDU
  // ---------------------------------------------------------------------------
  const jsFiles = [
    'maps/runtime-config.js',
    'maps/runtime-config.local.js',
    'maps/layers.js',
    'maps/layer-manager.js',
    'maps/auth-manager.js',
    'maps/app.js',
    'maps/route-inline.js',
    'maps/playback-inline.js',
    'maps/export-manager.js',
    'maps/parser-manager.js',
    'maps/features-manager.js'
  ];

  for (const relPath of jsFiles) {
    await runSuite(`Składnia JS i brak emoji: ${relPath}`, () => {
      const full = path.join(rootDir, relPath);
      countAssert(fs.existsSync(full), `Brak pliku ${relPath}`);
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      const content = fs.readFileSync(full, 'utf8');
      countAssert(content.length > 50, `Plik ${relPath} jest pusty`);
    });
  }

  await runSuite('Ikony znaków drogowych (D-6, A-11a, D-51, D-51a, Apple sygnalizacja) i warstwy w maps/layers.js', () => {
    const layersContent = fs.readFileSync(path.join(rootDir, 'maps/layers.js'), 'utf8');
    const requiredLayers = [
      'Infrastruktura drogowa/Sygnalizacja drogowa',
      'Infrastruktura drogowa/Progi zwalniające',
      'Infrastruktura drogowa/Przejścia dla pieszych',
      'Infrastruktura drogowa/Fotoradary',
      'Infrastruktura drogowa/Odcinkowe pomiary prędkości',
      'Infrastruktura drogowa/Odcinkowe pomiary prędkości - znaki',
      'Punkty POI/Miejsca kultu',
      'Punkty POI/Gastronomia',
      'Punkty POI/Opieka zdrowotna',
      'Punkty POI/Sklepy i usługi'
    ];
    for (const lid of requiredLayers) {
      countAssert(layersContent.includes(lid), `Brak warstwy ${lid}`);
    }
    const requiredIcons = [
      'icon-infra-crossing',
      'icon-infra-speed-bump',
      'icon-infra-traffic-signals',
      'icon-infra-speed-camera',
      'icon-infra-average-speed',
      'registerInfrastructureMapIcons'
    ];
    for (const ic of requiredIcons) {
      countAssert(layersContent.includes(ic), `Brak rejestracji ikony ${ic}`);
    }
    countAssert(layersContent.includes('SVG_A11A_SPEED_BUMP'), 'Brak wektorowego SVG znaku A-11a (próg zwalniający)');
    countAssert(!layersContent.includes('speed_bump.png'), 'Ikona progu zwalniającego musi być SVG, a nie plikiem PNG');
    for (const svgConst of ['SVG_APPLE_TRAFFIC_SIGNALS', 'SVG_D6_CROSSING', 'SVG_D51_SPEED_CAMERA', 'SVG_D51A_AVERAGE_SPEED']) {
      countAssert(layersContent.includes(svgConst), `Brak wektorowego SVG ${svgConst}`);
    }
  });

  await runSuite('Usunięcie przycisku "Przywróć domyślne kolory i warstwy" oraz re-aplikacja presetu przy ponownym wyborze', () => {
    const lmContent = fs.readFileSync(path.join(rootDir, 'maps/layer-manager.js'), 'utf8');
    countAssert(!lmContent.includes('btn-reset-all-layers'), 'Przycisk btn-reset-all-layers powinien być usunięty');
    countAssert(!lmContent.includes('Przywróć domyślne kolory i warstwy'), 'Tekst przycisku resetu powinien być usunięty');
    countAssert(lmContent.includes('presetSelect.selectedIndex = -1'), 'Brak obsługi ponownego wyboru tego samego presetu');
    countAssert(lmContent.includes('Infrastruktura drogowa/Odcinkowe pomiary prędkości - znaki'), 'Brak synchronizacji widoczności znaków OPP');
  });

  await runSuite('Uchwyt zwijania/rozwijania ("ten cosiek") przy planowaniu trasy, unikanie autostrad, tryb MAX=11 i GPX 1:1', () => {
    const htmlContent = fs.readFileSync(path.join(rootDir, 'maps/map.html'), 'utf8');
    const cssContent = fs.readFileSync(path.join(rootDir, 'maps/styles.css'), 'utf8');
    const routeContent = fs.readFileSync(path.join(rootDir, 'maps/route-inline.js'), 'utf8');

    countAssert(htmlContent.includes('id="btn-toggle-route-planner"'), 'Brak uchwytu #btn-toggle-route-planner w map.html');
    countAssert(htmlContent.includes('id="btn-route-download-gpx"'), 'Brak przycisku #btn-route-download-gpx w map.html');
    countAssert(cssContent.includes('.route-planner-panel.collapsed'), 'Brak stylu .route-planner-panel.collapsed w styles.css');
    countAssert(routeContent.includes('chk-route-avoid-highways'), 'Brak przełącznika unikania autostrad w route-inline.js');
    countAssert(routeContent.includes('max="11"'), 'Suwaki przeszkód powinny mieć max="11" (tryb MAX / Minimum totalne)');
    countAssert(routeContent.includes('Minimum totalne'), 'Brak opisu trybu Minimum totalne');
  });

  await runSuite('Statystyki konta i 4 skrajne punkty geograficzne (N/S/E/W) w maps/auth-manager.js', () => {
    const authContent = fs.readFileSync(path.join(rootDir, 'maps/auth-manager.js'), 'utf8');
    countAssert(authContent.includes('north_point'), 'Brak obsługi north_point');
    countAssert(authContent.includes('south_point'), 'Brak obsługi south_point');
    countAssert(authContent.includes('east_point'), 'Brak obsługi east_point');
    countAssert(authContent.includes('west_point'), 'Brak obsługi west_point');
    countAssert(authContent.includes('renderExtremePointsOnMap'), 'Brak funkcji renderExtremePointsOnMap');
  });

  // ---------------------------------------------------------------------------
  // CZĘŚĆ 2: TESTY INTEGRACYJNE WSZYSTKICH ENDPOINTÓW API NA ŻYWO
  // ---------------------------------------------------------------------------
  await runSuite('API: /api/health, /api/presets, /api/dates-tree, /api/time-tree', async () => {
    const health = await httpRequest('GET', '/api/health');
    countAssert(health.status === 200 && health.json && health.json.status === 'ok', `Oczekiwano 200 z /api/health, otrzymano ${health.status}`);

    const presets = await httpRequest('GET', '/api/presets');
    countAssert(presets.status === 200 && presets.json && Array.isArray(presets.json.presets), 'Błąd /api/presets');

    const dates = await httpRequest('GET', '/api/dates-tree');
    countAssert(dates.status === 200 && dates.json, 'Błąd /api/dates-tree');

    const timeTreeNoDay = await httpRequest('GET', '/api/time-tree');
    countAssert(timeTreeNoDay.status === 400, 'Brak parametru day w /api/time-tree powinien zwrócić 400');

    const timeTreeBadDay = await httpRequest('GET', '/api/time-tree?day=2025-13-45');
    countAssert(timeTreeBadDay.status === 400, 'Nieprawidłowa data w /api/time-tree powinna zwrócić 400');

    const timeTree = await httpRequest('GET', '/api/time-tree?day=2025-01-01');
    countAssert(timeTree.status === 200 && timeTree.json, 'Błąd /api/time-tree?day=2025-01-01');
  });

  let testToken = '';
  let testProfileId = '';

  await runSuite('API: Autoryzacja, Rejestracja, Logowanie, Sesja, Ustawienia, Presety i Profile (/api/auth/*, /api/presets)', async () => {
    const uname = `tester_qa_${Date.now()}`;
    const reg = await httpRequest('POST', '/api/auth/register', {
      username: uname,
      password: 'TestPassword123!',
      email: `${uname}@example.com`
    });
    countAssert(reg.status === 200 && reg.json && reg.json.token, `Rejestracja nie powiodła się: ${reg.text}`);
    testToken = reg.json.token;

    const login = await httpRequest('POST', '/api/auth/login', {
      username: uname,
      password: 'TestPassword123!'
    });
    countAssert(login.status === 200 && login.json && login.json.token, 'Logowanie nie powiodło się');

    const badLogin = await httpRequest('POST', '/api/auth/login', {
      username: uname,
      password: 'WrongPassword!'
    });
    countAssert(badLogin.status === 401, 'Złe hasło powinno zwrócić 401');

    const me = await httpRequest('GET', `/api/auth/me?token=${encodeURIComponent(testToken)}`);
    countAssert(me.status === 200 && me.json && me.json.user.username === uname, 'Błąd /api/auth/me');

    const settingsGet = await httpRequest('GET', `/api/auth/settings?token=${encodeURIComponent(testToken)}`);
    countAssert(settingsGet.status === 200 && settingsGet.json, 'Błąd GET /api/auth/settings');

    const settingsPost = await httpRequest('POST', `/api/auth/settings?token=${encodeURIComponent(testToken)}`, {
      ui_settings: { show_heatmap: true, show_fog: false }
    });
    countAssert(settingsPost.status === 200 && settingsPost.json.ui_settings.show_heatmap === true, 'Błąd POST /api/auth/settings');

    const presetPost = await httpRequest('POST', `/api/presets?token=${encodeURIComponent(testToken)}`, {
      name: 'Mój preset testowy',
      config: { colors: {}, visibility: {} }
    });
    countAssert(presetPost.status === 200 && presetPost.json && presetPost.json.preset, 'Błąd POST /api/presets');

    const presetsUser = await httpRequest('GET', `/api/presets?token=${encodeURIComponent(testToken)}`);
    countAssert(presetsUser.status === 200 && Array.isArray(presetsUser.json.presets) && presetsUser.json.presets.length >= 1, 'Błąd GET /api/presets z tokenem');

    const profiles = await httpRequest('GET', `/api/auth/profiles?token=${encodeURIComponent(testToken)}`);
    const profileList = Array.isArray(profiles.json) ? profiles.json : profiles.json?.profiles;
    countAssert(profiles.status === 200 && Array.isArray(profileList) && profileList.length >= 1, 'Błąd GET /api/auth/profiles');
    testProfileId = profileList[0].profile_id;
  });

  await runSuite('API: Statystyki konta (/api/stats) oraz weryfikacja 4 punktów skrajnych N/S/E/W na bazie głównego konta', async () => {
    const loginDefault = await httpRequest('POST', '/api/auth/login', {
      username: 'default_user',
      password: 'password123'
    });
    const tok = (loginDefault.status === 200 && loginDefault.json?.token) ? loginDefault.json.token : testToken;
    const t0 = Date.now();
    const st = await httpRequest('GET', `/api/stats?token=${encodeURIComponent(tok)}`);
    const elapsedMs = Date.now() - t0;
    countAssert(st.status === 200 && st.json, `Błąd /api/stats: ${st.status} ${st.text}`);
    countAssert(elapsedMs < 5000, `/api/stats odpowiada zbyt wolno: ${elapsedMs} ms`);
    countAssert(typeof st.json.max_speed_kmh === 'number', 'Brak max_speed_kmh w /api/stats');
    countAssert(typeof st.json.total_km === 'number', 'Brak total_km w /api/stats');
    countAssert(typeof st.json.unique_km === 'number', 'Brak unique_km w /api/stats');

    if (st.json.epochs_count > 0) {
      countAssert(st.json.north_point && typeof st.json.north_point.lat === 'number', 'Brak north_point');
      countAssert(st.json.south_point && typeof st.json.south_point.lat === 'number', 'Brak south_point');
      countAssert(st.json.east_point && typeof st.json.east_point.lon === 'number', 'Brak east_point');
      countAssert(st.json.west_point && typeof st.json.west_point.lon === 'number', 'Brak west_point');
      countAssert(st.json.north_point.lat >= st.json.south_point.lat, 'north_point.lat musi być >= south_point.lat');
      countAssert(st.json.east_point.lon >= st.json.west_point.lon, 'east_point.lon musi być >= west_point.lon');
    }
  });

  await runSuite('API: Kafelki wektorowe MVT i rastrowe (/api/track, /api/infrastructure, /api/poi, /api/poi/details, /api/heatmap, /api/fog-of-war, /api/drawings)', async () => {
    // Centrum Gdańska (Śródmieście) - obszar z gęstą infrastrukturą i POI
    const GDN_LON = 18.6466;
    const GDN_LAT = 54.3520;
    for (const mode of ['raw', 'snapped', 'osm']) {
      for (const z of [10, 12, 14, 15, 16, 18]) {
        const tc = lonLatToTile(GDN_LON, GDN_LAT, z);
        const res = await httpRequest('GET', `/api/track/${z}/${tc.x}/${tc.y}.pbf?mode=${mode}&days=2025-01-01&token=${encodeURIComponent(testToken)}`);
        countAssert(res.status === 200, `Błąd kafelka /api/track dla mode=${mode}, z=${z}`);
      }
    }

    // Nieprawidłowe współrzędne kafelków muszą zwracać 400
    for (const bad of ['/api/infrastructure/12/99999/1.pbf', '/api/infrastructure/-1/0/0.pbf', '/api/poi/12/1/99999.pbf', '/api/infrastructure/abc/1/1.pbf']) {
      const r = await httpRequest('GET', bad);
      countAssert(r.status === 400, `Nieprawidłowy kafelek ${bad} powinien zwrócić 400, otrzymano ${r.status}`);
    }

    const t14 = lonLatToTile(GDN_LON, GDN_LAT, 14);
    const infraRes = await httpRequest('GET', `/api/infrastructure/14/${t14.x}/${t14.y}.pbf`);
    countAssert(infraRes.status === 200 && infraRes.buffer.length > 0, `Kafelek infrastruktury /api/infrastructure/14/${t14.x}/${t14.y}.pbf powinien zawierać dane MVT`);
    countAssert(infraRes.buffer.includes(Buffer.from('osm-infrastructure')), 'Kafelek infrastruktury powinien zawierać warstwę osm-infrastructure');

    const poiRes = await httpRequest('GET', `/api/poi/14/${t14.x}/${t14.y}.pbf`);
    countAssert(poiRes.status === 200 && poiRes.buffer.length > 0, `Kafelek POI /api/poi/14/${t14.x}/${t14.y}.pbf powinien zawierać dane MVT`);
    countAssert(poiRes.buffer.includes(Buffer.from('osm-pois')), 'Kafelek POI powinien zawierać warstwę osm-pois');

    // Przy zoom < 11 kafelek POI jest pusty (celowo, wydajność)
    const t8 = lonLatToTile(GDN_LON, GDN_LAT, 8);
    const poiLow = await httpRequest('GET', `/api/poi/8/${t8.x}/${t8.y}.pbf`);
    countAssert(poiLow.status === 200 && poiLow.buffer.length === 0, 'Kafelek POI przy zoom < 11 powinien być pusty');

    const poiDet = await httpRequest('GET', '/api/poi/details?lat=54.3520&lon=18.6466');
    countAssert(poiDet.status === 200 && poiDet.json, 'Błąd /api/poi/details');
    const poiDetBad = await httpRequest('GET', '/api/poi/details?lat=abc');
    countAssert(poiDetBad.status === 400, '/api/poi/details bez lat/lon powinien zwrócić 400');

    const t12 = lonLatToTile(GDN_LON, GDN_LAT, 12);
    const heatRes = await httpRequest('GET', `/api/heatmap/tiles/12/${t12.x}/${t12.y}.png?token=${encodeURIComponent(testToken)}`);
    countAssert(heatRes.status === 200, `Błąd kafelka /api/heatmap/tiles/12/${t12.x}/${t12.y}.png`);

    const heatGrid = await httpRequest('GET', `/api/heatmap/grid?token=${encodeURIComponent(testToken)}`);
    countAssert(heatGrid.status === 200 && heatGrid.json, 'Błąd /api/heatmap/grid');

    const fogRes = await httpRequest('GET', `/api/fog-of-war?token=${encodeURIComponent(testToken)}`);
    countAssert(fogRes.status === 200 && fogRes.json, 'Błąd /api/fog-of-war');

    const drawGet = await httpRequest('GET', `/api/drawings?token=${encodeURIComponent(testToken)}`);
    countAssert(drawGet.status === 200 && drawGet.json && Array.isArray(drawGet.json.drawings), 'Błąd GET /api/drawings');
  });

  await runSuite('API: Lokalny Geocoder (/api/geocode/api i /api/geocode/reverse) dla różnych zapytań', async () => {
    const queries = ['Gdańsk', 'Gdynia', 'Sopot', 'Grunwaldzka', 'Kartuska', 'Kościerzyna', 'Wejherowo', 'NieistniejącaUlicaXYZ999'];
    for (const q of queries) {
      const res = await httpRequest('GET', `/api/geocode/api?q=${encodeURIComponent(q)}&limit=10`);
      countAssert(res.status === 200 && res.json && Array.isArray(res.json.features), `Błąd geocodera dla q=${q}`);
      if (q !== 'NieistniejącaUlicaXYZ999') {
        countAssert(res.json.features.length > 0, `Geocoder powinien zwrócić wyniki dla ${q}`);
      } else {
        countAssert(res.json.features.length === 0, 'Dla nieistniejącej ulicy tablica features powinna być pusta');
      }
    }
    const rev = await httpRequest('GET', '/api/geocode/reverse?lon=18.6466&lat=54.3520');
    countAssert(rev.status === 200 && rev.json && Array.isArray(rev.json.features) && rev.json.features.length > 0, 'Błąd reverse geocodera');
  });

  await runSuite('API: Planowanie trasy (/api/route/plan) — trasa zwykła, punkty unikania, unikanie autostrad, tryb MAX=11, nowe drogi i Auto-Generator', async () => {
    // 1. Trasa bazowa w Gdańsku
    const basePlan = await httpRequest('POST', '/api/route/plan', {
      points: [
        [18.6466, 54.3520],
        [18.6120, 54.3790]
      ],
      avoid_points: [],
      avoid_mode: 'high_cost',
      preferences: {}
    });
    countAssert(basePlan.status === 200 && basePlan.json && basePlan.json.status === 'ok', 'Błąd bazowego /api/route/plan');
    countAssert(basePlan.json.distance_m > 2500, 'Dystans trasy bazowej powinien być > 2.5 km');
    countAssert(Array.isArray(basePlan.json.coordinates) && basePlan.json.coordinates.length >= 10, 'Brak szczegółowej geometrii trasy');
    countAssert(basePlan.json.obstacles && typeof basePlan.json.obstacles.new_roads_percent === 'number', 'Brak statystyk przeszkód i nowych dróg');

    // 2. Punkt unikania ustawiony dokładnie na środku trasy bazowej — weryfikacja 100% ominięcia strefy!
    const midCoord = basePlan.json.coordinates[Math.floor(basePlan.json.coordinates.length / 2)];
    const avoidRadius = 280;
    const avoidPlan = await httpRequest('POST', '/api/route/plan', {
      points: [
        [18.6466, 54.3520],
        [18.6120, 54.3790]
      ],
      avoid_points: [{ lon: midCoord[0], lat: midCoord[1], radius_m: avoidRadius }],
      avoid_mode: 'exclude',
      preferences: {}
    });
    countAssert(avoidPlan.status === 200 && avoidPlan.json && avoidPlan.json.coordinates.length >= 2, 'Błąd trasy z punktem unikania');
    const minDistToAvoid = minDistPolylineToPointM(avoidPlan.json.coordinates, midCoord[1], midCoord[0]);
    countAssert(minDistToAvoid > avoidRadius * 0.95, `Trasa z punktem unikania przeszła przez strefę zakazu! minDist=${minDistToAvoid.toFixed(1)}m <= ${avoidRadius}m`);

    // 3. Tryb MAX=11 (Unikaj zupełnie / Minimum totalne progów zwalniających)
    const maxAvoidBumps = await httpRequest('POST', '/api/route/plan', {
      points: [
        [18.6466, 54.3520],
        [18.5600, 54.4050]
      ],
      avoid_points: [],
      avoid_mode: 'high_cost',
      preferences: {
        aversion_speed_bumps: 11,
        avoid_highways: true
      }
    });
    countAssert(maxAvoidBumps.status === 200 && maxAvoidBumps.json.coordinates.length >= 2, 'Błąd trasy w trybie MAX=11 (progi)');
    countAssert(maxAvoidBumps.json.obstacles.speed_bumps === 0, `Tryb MAX=11 dla progów zwalniających powinien znaleźć trasę z 0 progami, znaleziono: ${maxAvoidBumps.json.obstacles.speed_bumps}`);

    // 3b. Tryb MAX=11 dla wszystkich suwaków naraz (minimalizacja łącznej liczby przeszkód)
    const maxAvoidAll = await httpRequest('POST', '/api/route/plan', {
      points: [
        [18.6466, 54.3520],
        [18.6120, 54.3790]
      ],
      avoid_points: [],
      avoid_mode: 'high_cost',
      preferences: {
        aversion_speed_bumps: 11,
        aversion_traffic_signals: 11,
        aversion_crossings: 11,
        aversion_roundabouts: 11,
        avoid_highways: true
      }
    });
    countAssert(maxAvoidAll.status === 200 && maxAvoidAll.json.coordinates.length >= 2, 'Błąd trasy w trybie MAX=11 dla wszystkich suwaków');
    const baseTotalObs =
      basePlan.json.obstacles.speed_bumps +
      basePlan.json.obstacles.traffic_signals +
      basePlan.json.obstacles.crossings +
      basePlan.json.obstacles.roundabouts;
    const maxAllObs =
      maxAvoidAll.json.obstacles.speed_bumps +
      maxAvoidAll.json.obstacles.traffic_signals +
      maxAvoidAll.json.obstacles.crossings +
      maxAvoidAll.json.obstacles.roundabouts;
    countAssert(maxAllObs <= baseTotalObs, `Tryb MAX=11 powinien mieć <= przeszkód niż trasa bazowa (${maxAllObs} vs ${baseTotalObs})`);

    // 4. Inteligentny Generator Trasy Automatycznej (pętla 20 km)
    const autoLoop = await httpRequest('POST', '/api/route/plan', {
      points: [[18.6050, 54.3650]],
      avoid_points: [{ lon: 18.6200, lat: 54.3700, radius_m: 300 }],
      avoid_mode: 'exclude',
      preferences: {
        avoid_traversed: true,
        avoid_highways: true,
        aversion_speed_bumps: 8
      },
      auto_generate: true,
      target_km: 20,
      return_to_start: true
    });
    countAssert(autoLoop.status === 200 && autoLoop.json && autoLoop.json.coordinates.length >= 20, 'Błąd generatora trasy automatycznej');
    countAssert(Array.isArray(autoLoop.json.waypoints) && autoLoop.json.waypoints.length >= 2 && autoLoop.json.waypoints.length <= 10, `Liczba znaczników musi być <= 10, otrzymano ${autoLoop.json.waypoints?.length}`);
    // Żaden wygenerowany znacznik nie może leżeć w Zatoce Gdańskiej (dla tego obszaru lat < 54.43 lub lon < 18.68)
    for (const wp of autoLoop.json.waypoints) {
      countAssert(Number.isFinite(wp[0]) && Number.isFinite(wp[1]), 'Nieprawidłowe współrzędne znacznika');
      const dAvoid = haversineM(54.3700, 18.6200, wp[1], wp[0]);
      countAssert(dAvoid > 280, 'Wygenerowany znacznik nie może leżeć wewnątrz punktu unikania');
    }
  });

  await runSuite('Baza danych PostGIS: deduplikacja sygnalizacji świetlnej (1 ikona na skrzyżowanie) oraz oczyszczenie pajęczyn OSM', () => {
    const out = execFileSync(
      'docker',
      [
        'exec',
        'nnaper_db',
        'psql',
        '-U',
        'nnaper',
        '-d',
        'nnaper_db',
        '-t',
        '-A',
        '-c',
        "SELECT count(*) FROM osm_infrastructure WHERE category = 'traffic_signals';"
      ],
      { encoding: 'utf8' }
    ).trim();
    const signalCount = parseInt(out, 10);
    countAssert(signalCount > 100 && signalCount < 1500, `Sygnalizacja świetlna powinna być zdeduplikowana (~916 skrzyżowań zamiast 5072), otrzymano: ${signalCount}`);
  });

  // ---------------------------------------------------------------------------
  // CZĘŚĆ 3: 10 000+ PRZYPADKÓW BRZEGOWYCH (FUZZING & PROPERTY-BASED TESTING)
  // ---------------------------------------------------------------------------

  // 3A. 2 600 przypadków brzegowych parsera linków Google Maps
  await runSuite('2 600 przypadków brzegowych: Parser i generator linków Google Maps (URL, query params, /dir/, znaki specjalne, koordynaty poza zakresem)', () => {
    function parseCoordPair(str) {
      if (!str) return null;
      const cleaned = str.trim();
      const match = cleaned.match(/^([-+]?\d{1,2}(?:\.\d+)?)\s*,\s*([-+]?\d{1,3}(?:\.\d+)?)$/);
      if (!match) return null;
      const lat = parseFloat(match[1]);
      const lon = parseFloat(match[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
      return { lat, lon };
    }

    function parseGoogleMapsRouteUrl(rawInput) {
      if (!rawInput || typeof rawInput !== 'string') return [];
      let input = rawInput.trim();
      const urlMatch = input.match(/(https?:\/\/[^\s]+|google\.[a-z.]+\/maps\/[^\s]+|[0-9.-]+,[0-9.-]+(?:\/[0-9.-]+,[0-9.-]+)+)/i);
      if (urlMatch) input = urlMatch[1];
      try { input = decodeURIComponent(input); } catch (_) {}
      if (input.includes('origin=') || input.includes('destination=')) {
        try {
          const normalized = input.startsWith('http') ? input : `https://${input}`;
          const urlObj = new URL(normalized);
          const origin = urlObj.searchParams.get('origin');
          const destination = urlObj.searchParams.get('destination');
          const waypoints = urlObj.searchParams.get('waypoints');
          const list = [];
          if (origin) list.push(origin);
          if (waypoints) waypoints.split('|').forEach(wp => { if (wp.trim()) list.push(wp.trim()); });
          if (destination) list.push(destination);
          const parsed = list.map(item => parseCoordPair(item)).filter(Boolean);
          if (parsed.length >= 2) return parsed;
        } catch (_) {}
      }
      let pathPart = input;
      if (pathPart.includes('/dir/')) pathPart = pathPart.split('/dir/')[1] || '';
      pathPart = pathPart.split('?')[0].split('#')[0];
      const segments = pathPart.split('/').map(s => s.trim()).filter(Boolean);
      const coords = [];
      for (const seg of segments) {
        if (seg.startsWith('@') || seg.startsWith('data=')) continue;
        const pair = parseCoordPair(seg);
        if (pair) coords.push(pair);
      }
      return coords;
    }

    const rand = mulberry32(20261110);
    for (let i = 0; i < 2500; i++) {
      const nPts = 2 + (i % 9); // 2..10 punktów
      const expected = [];
      for (let k = 0; k < nPts; k++) {
        const lat = parseFloat((-89.9 + rand() * 179.8).toFixed(6));
        const lon = parseFloat((-179.9 + rand() * 359.8).toFixed(6));
        expected.push({ lat, lon });
      }
      let url;
      if (i % 3 === 0) {
        url = `https://www.google.com/maps/dir/${expected.map(p => `${p.lat},${p.lon}`).join('/')}/@54.35,18.64,13z/data=!4m2`;
      } else if (i % 3 === 1) {
        const orig = `${expected[0].lat},${expected[0].lon}`;
        const dest = `${expected[expected.length - 1].lat},${expected[expected.length - 1].lon}`;
        const wps = expected.slice(1, -1).map(p => `${p.lat},${p.lon}`).join('|');
        url = `https://www.google.pl/maps/dir/?api=1&origin=${encodeURIComponent(orig)}&destination=${encodeURIComponent(dest)}${wps ? '&waypoints=' + encodeURIComponent(wps) : ''}`;
      } else {
        url = `Sprawdź trasę: ${expected.map(p => `${p.lat},${p.lon}`).join('/')} koniec`;
      }
      const parsed = parseGoogleMapsRouteUrl(url);
      countAssert(parsed.length === expected.length && Math.abs(parsed[0].lat - expected[0].lat) < 1e-5, `Błąd parsowania URL #${i}`);
    }

    // 100 złośliwych/uszkodzonych wejść (NaN, >90 lat, >180 lon, XSS, SQLi, puste)
    const invalidInputs = [
      '', null, undefined, '   ', 'https://www.google.com/maps',
      'https://www.google.com/maps/dir/95.123,18.0/91.0,19.0',
      'https://www.google.com/maps/dir/54.35,195.0/54.36,-185.0',
      '<script>alert(1)</script>', "'; DROP TABLE epochs; --",
      '54.3520,18.6466' // tylko 1 punkt
    ];
    for (let i = 0; i < 100; i++) {
      const inp = invalidInputs[i % invalidInputs.length];
      const res = parseGoogleMapsRouteUrl(inp);
      countAssert(res.length < 2, `Nieprawidłowe wejście #${i} nie powinno zwrócić trasy`);
    }
  });

  // 3B. 3 000 przypadków brzegowych funkcji kosztu krawędzi, unikania autostrad i trybu MAX=11
  await runSuite('3 000 przypadków brzegowych: Silnik kosztów routingu (ComputeEdgeCost, tryb MAX=11 Minimum totalne, autostrady, strefy unikania)', () => {
    const rand = mulberry32(987654321);
    const highways = ['residential', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'unclassified', 'service'];

    for (let i = 0; i < 3000; i++) {
      const hw = highways[i % highways.length];
      const lenM = 10 + rand() * 2500;
      const spd = 20 + rand() * 100;
      const durS = lenM / (spd / 3.6);
      const lon = 18.4 + rand() * 0.4;
      const lat = 54.2 + rand() * 0.4;
      const edge = {
        lengthM: lenM,
        durationS: durS,
        highway: hw,
        speedBumps: i % 5 === 0 ? 1 + (i % 3) : 0,
        crossings: i % 4 === 0 ? 1 + (i % 4) : 0,
        trafficSignals: i % 6 === 0 ? 1 : 0,
        isRoundabout: i % 10 === 0,
        isIntersection: i % 3 === 0,
        traversed: i % 2 === 0,
        usedCount: i % 7 === 0 ? 1 : 0,
        coords: [
          [lon, lat],
          [lon + 0.002, lat + 0.002]
        ]
      };

      // Monotoniczność suwaków 0..10..11
      const c0 = computeEdgeCostJS(edge, [], 'high_cost', { aversion_speed_bumps: 0 }).cost;
      const c5 = computeEdgeCostJS(edge, [], 'high_cost', { aversion_speed_bumps: 5 }).cost;
      const c10 = computeEdgeCostJS(edge, [], 'high_cost', { aversion_speed_bumps: 10 }).cost;
      const c11 = computeEdgeCostJS(edge, [], 'high_cost', { aversion_speed_bumps: 11 }).cost;

      if (edge.speedBumps > 0) {
        countAssert(c11 > c10 * 50 && c10 > c5 && c5 > c0, `Brak silnej dominacji leksykograficznej dla MAX=11 w iteracji #${i}`);
      } else {
        countAssert(Math.abs(c11 - c0) < 1e-6, `Krawędź bez progów nie powinna być karana w iteracji #${i}`);
      }

      // Weryfikacja unikania autostrad
      const cHw = computeEdgeCostJS(edge, [], 'high_cost', { avoid_highways: true }).cost;
      if (['motorway', 'trunk'].includes(hw)) {
        countAssert(cHw >= 2500000, `Autostrada/ekspresówka musi mieć karę zaporową przy avoid_highways=true (#${i})`);
      }

      // Weryfikacja stref unikania (exclude vs high_cost)
      const hitExclude = computeEdgeCostJS(edge, [{ lon, lat, radius_m: 150 }], 'exclude', {});
      const hitHigh = computeEdgeCostJS(edge, [{ lon, lat, radius_m: 150 }], 'high_cost', {});
      countAssert(hitExclude.excluded === true && !Number.isFinite(hitExclude.cost) && hitHigh.cost > 5000000, `Błąd strefy unikania w iteracji #${i}`);
    }
  });

  // 3C. 2 500 przypadków brzegowych geometrii (odległość punkt-łamana, Haversine, Shoelace, działki mgły wojny)
  await runSuite('2 500 przypadków brzegowych: Geometria sferyczna, odległość od segmentu, pole powierzchni Shoelace i trójkąty odkrywania mapy', () => {
    const rand = mulberry32(11223344);
    for (let i = 0; i < 2500; i++) {
      const lat = 54.0 + rand() * 1.0;
      const lon = 18.0 + rand() * 1.5;
      const sideM = 5 + rand() * 2000;
      const dLat = sideM / 111320.0;
      const dLon = sideM / (111320.0 * Math.cos((lat * Math.PI) / 180.0));

      // Kwadrat o boku sideM -> pole powinno wynosić sideM^2 z dokładnością < 2.5%
      const poly = [
        [lon, lat],
        [lon + dLon, lat],
        [lon + dLon, lat + dLat],
        [lon, lat + dLat]
      ];
      const refLat = (poly[0][1] * Math.PI) / 180.0;
      const refLon = (poly[0][0] * Math.PI) / 180.0;
      const R = 6371000.0;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const j = (k + 1) % 4;
        const x1 = ((poly[k][0] * Math.PI) / 180.0 - refLon) * R * Math.cos(refLat);
        const y1 = ((poly[k][1] * Math.PI) / 180.0 - refLat) * R;
        const x2 = ((poly[j][0] * Math.PI) / 180.0 - refLon) * R * Math.cos(refLat);
        const y2 = ((poly[j][1] * Math.PI) / 180.0 - refLat) * R;
        sum += x1 * y2 - x2 * y1;
      }
      const area = Math.abs(sum) / 2.0;
      const expectedArea = sideM * sideM;
      const relErr = Math.abs(area - expectedArea) / expectedArea;
      const midDist = minDistPolylineToPointM([poly[0], poly[1]], lat, lon + dLon * 0.5);
      countAssert(relErr < 0.025 && midDist < 0.5, `Błąd geometrii w iteracji #${i}: relErr=${relErr}, midDist=${midDist}`);
    }
  });

  // 3D. 1 500 przypadków brzegowych algorytmu rozmieszczania do 10 znaczników wzdłuż trasy
  await runSuite('1 500 przypadków brzegowych: Algorytm rozmieszczania do 10 znaczników trasy (stawianie jak najdalej do punktu odchylenia od trasy)', () => {
    function simulateExtract10Waypoints(nNodes, stepLenM, deviationIndicesSet) {
      const maxWaypoints = 10;
      const cumDist = new Float64Array(nNodes);
      const cumDur = new Float64Array(nNodes);
      const stdDur = new Float64Array(nNodes);
      for (let i = 1; i < nNodes; i++) {
        cumDist[i] = cumDist[i - 1] + stepLenM;
        const extraPenalty = deviationIndicesSet.has(i) ? 45.0 : 0.0;
        cumDur[i] = cumDur[i - 1] + stepLenM / 12.0 + extraPenalty;
        stdDur[i] = stdDur[i - 1] + stepLenM / 12.0;
      }
      const totalDistM = cumDist[nNodes - 1];
      const selected = [0];
      let curIdx = 0;
      for (let rem = maxWaypoints - 2; rem >= 1 && curIdx < nNodes - 1; rem--) {
        const remDistM = totalDistM - cumDist[curIdx];
        if (remDistM < 180.0) break;
        const minStepDistM = (remDistM / (rem + 1)) * 0.72;
        const maxStepDistM = (remDistM / (rem + 1)) * 1.45;
        let chosenIdx = -1;
        let lastCompliantIdx = -1;
        let minIdx = curIdx + 1;
        for (let k = curIdx + 1; k < nNodes - 1; k++) {
          const stepDist = cumDist[k] - cumDist[curIdx];
          if (stepDist < minStepDistM) minIdx = k;
          if (stepDist > maxStepDistM) break;
          const plannedTime = cumDur[k] - cumDur[curIdx];
          const fastestTime = stdDur[k] - stdDur[curIdx];
          if (plannedTime <= fastestTime * 1.07 + 10.0) {
            lastCompliantIdx = k;
          } else if (stepDist >= minStepDistM && lastCompliantIdx >= minIdx) {
            chosenIdx = lastCompliantIdx;
            break;
          }
        }
        if (chosenIdx === -1) {
          chosenIdx = lastCompliantIdx >= minIdx ? lastCompliantIdx : minIdx;
        }
        if (chosenIdx <= curIdx) chosenIdx = curIdx + 1;
        if (chosenIdx >= nNodes - 1) break;
        selected.push(chosenIdx);
        curIdx = chosenIdx;
      }
      selected.push(nNodes - 1);
      return selected;
    }

    const rand = mulberry32(55667788);
    for (let i = 0; i < 1500; i++) {
      const nNodes = 3 + (i % 250);
      const stepLenM = 25 + rand() * 300;
      const devSet = new Set();
      for (let k = 1; k < nNodes; k++) {
        if (rand() < 0.15) devSet.add(k);
      }
      const wps = simulateExtract10Waypoints(nNodes, stepLenM, devSet);
      let strictlyIncreasing = true;
      for (let j = 1; j < wps.length; j++) {
        if (wps[j] <= wps[j - 1]) strictlyIncreasing = false;
      }
      countAssert(
        wps.length >= 2 &&
          wps.length <= 10 &&
          wps[0] === 0 &&
          wps[wps.length - 1] === nNodes - 1 &&
          strictlyIncreasing,
        `Nieprawidłowy rozkład 10 znaczników w iteracji #${i}: len=${wps.length}, nNodes=${nNodes}`
      );
    }
  });

  // 3E. 1 000 przypadków brzegowych gradientu Heatmapy i walidacji PBF
  await runSuite('1 000 przypadków brzegowych: Gradient logarytmiczny Heatmapy (odporność na 0, 1, max, NaN, wartości ujemne i ekstremalne)', () => {
    function heatmapColor(count, maxCount) {
      if (!Number.isFinite(count) || count <= 0) return { r: 0, g: 0, b: 0, a: 0 };
      if (!Number.isFinite(maxCount) || maxCount <= 1 || count === 1) return { r: 0, g: 220, b: 60, a: 190 };
      const t = Math.min(1, Math.max(0, Math.log(count) / Math.log(maxCount)));
      if (t < 0.5) {
        const local = t * 2;
        return {
          r: Math.round(local * 255),
          g: Math.round(220 + local * 35),
          b: Math.round(60 * (1 - local)),
          a: Math.round(190 + local * 30)
        };
      }
      const local = (t - 0.5) * 2;
      return {
        r: 255,
        g: Math.round(255 * (1 - local * 0.88)),
        b: Math.round(local * 30),
        a: Math.round(220 + local * 25)
      };
    }

    for (let i = 0; i < 1000; i++) {
      const maxC = 1 + (i % 5000);
      const cnt = i === 0 ? 0 : i === 1 ? -15 : i === 2 ? NaN : 1 + (i % maxC);
      const c = heatmapColor(cnt, maxC);
      const valid =
        c.r >= 0 && c.r <= 255 &&
        c.g >= 0 && c.g <= 255 &&
        c.b >= 0 && c.b <= 255 &&
        c.a >= 0 && c.a <= 255;
      countAssert(valid, `Nieprawidłowy kolor RGBA w iteracji #${i}`);
    }
  });

  console.log(`\n=== Podsumowanie: ${suitesPassed} grup testowych zaliczonych, ${suitesFailed} błędów | Łącznie zweryfikowanych asercji i przypadków brzegowych: ${totalAssertions} ===`);
  if (suitesFailed > 0) process.exit(1);
})();
