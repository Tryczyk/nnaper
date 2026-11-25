const config = Object.assign({
  API_BASE_URL: 'http://localhost:8000',
  TILES_BASE_URL: 'http://localhost:8080',
  PMTILES_FILE: 'pomorskie.pmtiles',
  GLYPHS_URL: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  TERRAIN_TILES_URL: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
}, window.NNAPER_CONFIG || {});
const API_BASE_CLEAN = (config.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const PMTILES_URL = `pmtiles://${(config.TILES_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}/osm_data/${config.PMTILES_FILE || 'pomorskie.pmtiles'}?v=20261109_v45_nocache`;

const MAP_STYLE = {
  version: 8,
  glyphs: config.GLYPHS_URL || "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    'pomorskie-tiles': {
      type: 'vector',
      url: PMTILES_URL
    },
    'osm-infrastructure-source': {
      type: 'vector',
      tiles: [`${API_BASE_CLEAN}/api/infrastructure/{z}/{x}/{y}.pbf`],
      minzoom: 8,
      maxzoom: 18
    },
    'osm-pois-source': {
      type: 'vector',
      tiles: [`${API_BASE_CLEAN}/api/poi/{z}/{x}/{y}.pbf`],
      minzoom: 11,
      maxzoom: 18
    },
    'terrain-dem': {
      type: 'raster-dem',
      tiles: [config.TERRAIN_TILES_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 15,
      encoding: 'terrarium'
    },
    'world-satellite-source': {
      type: 'raster',
      tiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Satelita: &copy; Esri, Maxar, Earthstar Geographics'
    },
    'geoportal-orto-source': {
      type: 'raster',
      tiles: [
        'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg'
      ],
      tileSize: 256,
      maxzoom: 20,
      attribution: 'Ortofotomapa: &copy; Główny Urząd Geodezji i Kartografii (GUGiK)'
    }
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#090d16' } },
    {
      id: 'Podkłady/Satelita (Świat - ESRI)',
      source: 'world-satellite-source',
      type: 'raster',
      layout: { visibility: 'visible' },
      paint: { 'raster-opacity': 1.0 }
    },
    {
      id: 'Podkłady/Ortofotomapa (Polska - GUGiK)',
      source: 'geoportal-orto-source',
      type: 'raster',
      layout: { visibility: 'visible' },
      paint: { 'raster-opacity': 1.0 }
    },
    {
      id: 'Drogi/Autostrady i ekspresówki',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: ['all', ['!=', 'surface', 'unpaved'], ['in', 'class', 'motorway', 'trunk', 'primary']],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ef4444', 'line-width': 3.2 }
    },
    {
      id: 'Drogi/Drogi główne',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: ['all', ['!=', 'surface', 'unpaved'], ['in', 'class', 'secondary', 'tertiary']],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#f97316', 'line-width': 2.2 }
    },
    {
      id: 'Drogi/Ulice osiedlowe',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: [
        'all',
        ['!=', 'surface', 'unpaved'],
        ['!in', 'class', 'track', 'path', 'pedestrian', 'footway', 'steps', 'cycleway', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'rail', 'transit', 'ferry']
      ],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#94a3b8', 'line-width': 1.4 }
    },
    {
      id: 'Drogi/Drogi gruntowe',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: ['all', ['!in', 'class', 'rail', 'transit', 'ferry'], ['any', ['==', 'class', 'track'], ['==', 'surface', 'unpaved']]],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#f59e0b', 'line-width': 1.8, 'line-dasharray': [2, 1.5] }
    },
    {
      id: 'Ruch alternatywny/Drogi rowerowe',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: ['any', ['==', 'subclass', 'cycleway'], ['==', 'class', 'cycleway'], ['==', 'bicycle', 'designated']],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#10b981', 'line-width': 2.5 }
    },
    {
      id: 'Ruch alternatywny/Chodniki i deptaki',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'path', 'pedestrian', 'footway', 'steps'],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#a855f7', 'line-width': 1.5, 'line-dasharray': [1.5, 1.5] }
    },
    {
      id: 'Ruch alternatywny/Kolej i tramwaje',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: ['in', 'class', 'rail', 'transit'],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#cbd5e1', 'line-width': 1.8, 'line-dasharray': [3, 2] }
    },
    {
      id: 'Ruch alternatywny/Szlaki morskie',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation',
      filter: ['==', 'class', 'ferry'],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#67e8f9', 'line-width': 1.5, 'line-dasharray': [3, 2] }
    },
    {
      id: 'Budynki/Bryły 3D',
      source: 'pomorskie-tiles',
      'source-layer': 'building',
      type: 'fill-extrusion',
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': '#1e293b',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true
      }
    },
    {
      id: 'Punkty POI/Miejsca kultu',
      source: 'pomorskie-tiles',
      'source-layer': 'poi',
      filter: ['==', 'subclass', 'place_of_worship'],
      type: 'circle',
      paint: {
        'circle-color': '#facc15',
        'circle-radius': 4.5,
        'circle-stroke-width': 0,
        'circle-stroke-color': '#facc15',
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    },
    {
      id: 'Punkty POI/Gastronomia',
      source: 'pomorskie-tiles',
      'source-layer': 'poi',
      filter: ['in', 'class', 'restaurant', 'cafe', 'fast_food', 'bar', 'pub'],
      type: 'circle',
      paint: {
        'circle-color': '#fb923c',
        'circle-radius': 4.0,
        'circle-stroke-width': 0,
        'circle-stroke-color': '#fb923c',
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    },
    {
      id: 'Punkty POI/Opieka zdrowotna',
      source: 'pomorskie-tiles',
      'source-layer': 'poi',
      filter: ['in', 'class', 'hospital', 'pharmacy', 'doctors'],
      type: 'circle',
      paint: {
        'circle-color': '#f43f5e',
        'circle-radius': 4.5,
        'circle-stroke-width': 0,
        'circle-stroke-color': '#f43f5e',
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    },
    {
      id: 'Punkty POI/Sklepy i usługi',
      source: 'pomorskie-tiles',
      'source-layer': 'poi',
      filter: ['in', 'class', 'shop', 'grocery', 'supermarket', 'convenience', 'bakery', 'clothes', 'fuel', 'bank', 'post', 'lodging'],
      type: 'circle',
      paint: {
        'circle-color': '#38bdf8',
        'circle-radius': 4.0,
        'circle-stroke-width': 0,
        'circle-stroke-color': '#38bdf8',
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    },
    {
      id: 'Infrastruktura drogowa/Odcinkowe pomiary prędkości',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'average_speed'],
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#d946ef',
        'line-width': 3.5,
        'line-opacity': 0.94
      }
    },
    {
      id: 'Infrastruktura drogowa/Odcinkowe pomiary prędkości - znaki',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'average_speed_point'],
      type: 'circle',
      paint: {
        'circle-color': '#d946ef',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 12, 5.5, 15, 7.5],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.95
      }
    },
    {
      id: 'Infrastruktura drogowa/Przejścia dla pieszych',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'crossing'],
      type: 'circle',
      minzoom: 14,
      paint: {
        'circle-color': '#38bdf8',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3.5, 16, 4.5, 18, 6.0],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.95
      }
    },
    {
      id: 'Infrastruktura drogowa/Progi zwalniające',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'speed_bump'],
      type: 'symbol',
      minzoom: 13,
      layout: {
        'icon-image': 'icon-infra-speed-bump',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.55, 15, 0.8, 17, 1.0, 18, 1.15],
        'icon-allow-overlap': false,
        'icon-padding': 1,
        'icon-pitch-alignment': 'viewport'
      },
      paint: {
        'icon-opacity': 0.98,
        'text-color': '#f59e0b'
      }
    },
    {
      id: 'Infrastruktura drogowa/Sygnalizacja drogowa',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'traffic_signals'],
      type: 'circle',
      paint: {
        'circle-color': '#22c55e',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 13, 5.0, 16, 6.5],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 0.95
      }
    },
    {
      id: 'Infrastruktura drogowa/Fotoradary',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'speed_camera'],
      type: 'circle',
      paint: {
        'circle-color': '#ef4444',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.0, 11, 5.5, 14, 7.5, 17, 9.0],
        'circle-stroke-width': 2.0,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 1.0
      }
    },
    {
      id: 'Granice i Etykiety/Granice administracyjne',
      source: 'pomorskie-tiles',
      'source-layer': 'boundary',
      type: 'line',
      paint: { 'line-color': '#ec4899', 'line-width': 1.5, 'line-dasharray': [4, 2], 'line-opacity': 0.6 }
    },
    {
      id: 'Granice i Etykiety/Nazwy ulic',
      source: 'pomorskie-tiles',
      'source-layer': 'transportation_name',
      type: 'symbol',
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': ['Open Sans Regular'] },
      paint: { 'text-color': '#cbd5e1', 'text-halo-color': '#0f172a', 'text-halo-width': 1.5 }
    },
    {
      id: 'Granice i Etykiety/Miejscowości',
      source: 'pomorskie-tiles',
      'source-layer': 'place',
      filter: ['in', 'class', 'town', 'village', 'hamlet', 'suburb'],
      type: 'symbol',
      layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-font': ['Open Sans Regular'] },
      paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#020617', 'text-halo-width': 2 }
    },
    {
      id: 'Granice i Etykiety/Miasta',
      source: 'pomorskie-tiles',
      'source-layer': 'place',
      filter: ['==', 'class', 'city'],
      type: 'symbol',
      layout: { 'text-field': ['get', 'name'], 'text-size': 15, 'text-font': ['Open Sans Bold'] },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 2.5 }
    }
  ]
};
window.MAP_STYLE = MAP_STYLE;

(function () {
  // Zewnętrzne pliki SVG oraz definicje wektorowe znaków drogowych
  const SVG_APPLE_TRAFFIC_SIGNALS = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="tlBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2c2c2e"/>
        <stop offset="100%" stop-color="#141416"/>
      </linearGradient>
    </defs>
    <rect x="15" y="3" width="34" height="58" rx="17" ry="17" fill="url(#tlBody)" stroke="#ffffff" stroke-width="3"/>
    <rect x="18" y="6" width="28" height="52" rx="14" ry="14" fill="none" stroke="#3a3a3c" stroke-width="1.2"/>
    <circle cx="32" cy="16.5" r="6.8" fill="#ff3b30"/>
    <circle cx="30" cy="14.5" r="2.2" fill="#ff9f99" opacity="0.75"/>
    <circle cx="32" cy="32" r="6.8" fill="#ffcc00"/>
    <circle cx="30" cy="30" r="2.2" fill="#fff099" opacity="0.75"/>
    <circle cx="32" cy="47.5" r="6.8" fill="#30d158"/>
    <circle cx="30" cy="45.5" r="2.2" fill="#a4f5b8" opacity="0.75"/>
  </svg>`;

  // Znak A-11a / ikona progu zwalniającego z assets/icons/signs/speed-bump.svg
  const SVG_A11A_SPEED_BUMP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="64" height="64">
    <path d="M 14 64 L 30 64 C 38 64, 41 46, 50 46 C 59 46, 62 64, 70 64 L 86 64 A 6 6 0 0 1 86 76 L 14 76 A 6 6 0 0 1 14 64 Z" fill="#F97316" stroke="#ffffff" stroke-width="10" stroke-linejoin="round" paint-order="stroke fill" />
  </svg>`;

  const SVG_D6_CROSSING = `<svg id="D-6" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="3" y="3" width="58" height="58" rx="14" ry="14" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>
    <circle cx="34" cy="14" r="5" fill="#18181b"/>
    <path d="M31 20 C29 20 27.5 21.5 27.5 23.5 L27 29.5 L22.5 32 C21.7 32.5 21.4 33.5 21.8 34.3 C22.2 35.1 23.2 35.4 24 35 L28 32.8 L29 37 L24 45.5 C23.4 46.4 23.7 47.6 24.6 48.2 C25.5 48.8 26.7 48.5 27.3 47.6 L33 38.5 L34 32.5 L37 35.5 L40.5 43.5 C40.9 44.4 41.9 44.8 42.8 44.4 C43.7 44 44.1 43 43.7 42.1 L39.5 33 C39 32 38.2 31.2 37.2 30.7 L35 29.5 L35.2 23.5 C35.2 21.5 33.2 20 31 20 Z" fill="#18181b"/>
    <path d="M7 54 L12 42 L16 42 L11 54 Z" fill="#18181b"/>
    <path d="M19 54 L22 42 L26 42 L23 54 Z" fill="#18181b"/>
    <path d="M30 54 L31 42 L35 42 L34 54 Z" fill="#18181b"/>
    <path d="M41 54 L40 42 L44 42 L45 54 Z" fill="#18181b"/>
    <path d="M52 54 L49 42 L53 42 L56 54 Z" fill="#18181b"/>
  </svg>`;

  const SVG_D51_SPEED_CAMERA = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="3" y="3" width="58" height="58" rx="14" ry="14" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>
    <rect x="7" y="10" width="34" height="44" rx="8" ry="8" fill="#18181b"/>
    <circle cx="21" cy="38" r="11" fill="#18181b" stroke="#ffffff" stroke-width="3.5"/>
    <circle cx="15" cy="44" r="1.5" fill="#ffffff"/>
    <circle cx="31" cy="22" r="5.5" fill="#18181b" stroke="#ffffff" stroke-width="2.8"/>
    <rect x="44" y="15" width="2.8" height="34" rx="1" fill="#18181b"/>
    <rect x="48" y="17" width="2.8" height="30" rx="1" fill="#18181b"/>
    <rect x="52" y="22" width="2.8" height="20" rx="1" fill="#18181b"/>
    <rect x="54" y="27" width="6" height="10" rx="1" fill="#18181b"/>
  </svg>`;

  const SVG_D51A_AVERAGE_SPEED = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="3" y="3" width="58" height="58" rx="14" ry="14" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>
    <g transform="translate(3, -2) scale(0.85)">
      <rect x="7" y="10" width="34" height="44" rx="8" ry="8" fill="#18181b"/>
      <circle cx="21" cy="38" r="11" fill="#18181b" stroke="#ffffff" stroke-width="3.5"/>
      <circle cx="15" cy="44" r="1.5" fill="#ffffff"/>
      <circle cx="31" cy="22" r="5.5" fill="#18181b" stroke="#ffffff" stroke-width="2.8"/>
      <rect x="44" y="15" width="2.8" height="34" rx="1" fill="#18181b"/>
      <rect x="48" y="17" width="2.8" height="30" rx="1" fill="#18181b"/>
      <rect x="52" y="22" width="2.8" height="20" rx="1" fill="#18181b"/>
      <rect x="54" y="27" width="6" height="10" rx="1" fill="#18181b"/>
    </g>
    <path d="M12 55 L52 55 M48 51 L52 55 L48 59 M16 51 L12 55 L16 59" fill="none" stroke="#dc2626" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  // Rasteryzacja SVG w wysokiej rozdzielczości (4x lub więcej przy ekranach HiDPI), aby znaki były ostre
  // przy każdym przybliżeniu. width/height to rozmiar logiczny ikony w pikselach CSS przy icon-size = 1.
  const ICON_RASTER_RATIO = Math.max(4, Math.ceil((window.devicePixelRatio || 1) * 2));

  function loadSvgOrUrlToMap(map, iconId, srcUrl, width, height, replaceExisting, opts) {
    if (!map) return;
    if (!replaceExisting && map.hasImage && map.hasImage(iconId)) return;
    const halo = opts && opts.halo ? opts.halo : null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      try {
        const ratio = ICON_RASTER_RATIO;
        const pad = Math.round(2 * ratio); // margines na cień
        // Przy poświacie płótno jest kwadratem o boku halo.size, a znak jest wyśrodkowany
        const outerW = halo ? Math.max(halo.size, width) : width;
        const outerH = halo ? Math.max(halo.size, height) : height;
        const cw = Math.round(outerW * ratio) + pad * 2;
        const ch = Math.round(outerH * ratio) + pad * 2;
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (halo) {
          // Wyróżnienie: miękka czerwona poświata + wyraźna obręcz (biała obwódka zewnętrzna dla kontrastu)
          const cx = cw / 2;
          const cy = ch / 2;
          const r = (Math.min(cw, ch) - pad * 2) / 2;
          const grad = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
          grad.addColorStop(0, halo.color + 'cc');
          grad.addColorStop(0.7, halo.color + '66');
          grad.addColorStop(1, halo.color + '00');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();

          ctx.lineWidth = 1.6 * ratio;
          ctx.strokeStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1.1 * ratio;
          ctx.strokeStyle = halo.color;
          ctx.beginPath();
          ctx.arc(cx, cy, r * 0.78 - 1.3 * ratio, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Delikatny cień, żeby znak odcinał się od ciemnego podkładu i kolorowych linii dróg
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = 1.6 * ratio;
        ctx.shadowOffsetY = 0.6 * ratio;
        const sw = width * ratio;
        const sh = height * ratio;
        ctx.drawImage(img, (cw - sw) / 2, (ch - sh) / 2, sw, sh);
        const imgData = ctx.getImageData(0, 0, cw, ch);
        if (map.hasImage && map.hasImage(iconId)) {
          if (replaceExisting) {
            try { map.removeImage(iconId); } catch (e) { }
          } else {
            return;
          }
        }
        map.addImage(iconId, imgData, { pixelRatio: ratio });
        if (typeof map.triggerRepaint === 'function') map.triggerRepaint();
      } catch (e) {
        console.warn('Nie udało się zarejestrować ikony:', iconId, e);
      }
    };
    img.src = srcUrl;
  }

  window.registerInfrastructureMapIcons = function (map) {
    if (!map || map._infraIconsRegistered) return;
    map._infraIconsRegistered = true;

    const toSvgUri = (src) => {
      if (typeof src === 'string' && (src.startsWith('/') || src.startsWith('http') || src.startsWith('data:'))) {
        return src;
      }
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
    };

    // Rozmiary logiczne ikon (px CSS przy icon-size = 1) - jedna tabela dla rejestracji i fallbacku
    const ICON_DEFS = {
      'icon-infra-traffic-signals': { svg: SVG_APPLE_TRAFFIC_SIGNALS, w: 28, h: 28 },
      'icon-infra-crossing': { svg: SVG_D6_CROSSING, w: 28, h: 28 },
      'icon-infra-speed-camera': { svg: SVG_D51_SPEED_CAMERA, w: 28, h: 28 },
      'icon-infra-average-speed': { svg: SVG_D51A_AVERAGE_SPEED, w: 28, h: 28 },
      'icon-infra-speed-bump': { svg: SVG_A11A_SPEED_BUMP, w: 28, h: 28 }
    };

    const registerOne = (id) => {
      const def = ICON_DEFS[id];
      if (def) loadSvgOrUrlToMap(map, id, toSvgUri(def.svg), def.w, def.h, false, { halo: def.halo || null });
    };

    Object.keys(ICON_DEFS).forEach(registerOne);
    map.on('styleimagemissing', (e) => {
      if (e && ICON_DEFS[e.id]) registerOne(e.id);
    });
  };
})();
