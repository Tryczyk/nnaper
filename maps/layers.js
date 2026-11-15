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
    }
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#090d16' } },
    {
      id: 'Przyroda/Lasy',
      source: 'pomorskie-tiles',
      'source-layer': 'landcover',
      filter: ['==', 'class', 'wood'],
      type: 'fill',
      paint: { 'fill-color': '#064e3b', 'fill-opacity': 0.6 }
    },
    {
      id: 'Przyroda/Parki',
      source: 'pomorskie-tiles',
      'source-layer': 'park',
      type: 'fill',
      paint: { 'fill-color': '#15803d', 'fill-opacity': 0.4 }
    },
    {
      id: 'Przyroda/Trawy',
      source: 'pomorskie-tiles',
      'source-layer': 'landcover',
      filter: ['in', 'class', 'grass', 'scrub'],
      type: 'fill',
      paint: { 'fill-color': '#166534', 'fill-opacity': 0.3 }
    },
    {
      id: 'Przyroda/Wydmy i plaże',
      source: 'pomorskie-tiles',
      'source-layer': 'landcover',
      filter: ['==', 'class', 'sand'],
      type: 'fill',
      paint: { 'fill-color': '#eab308', 'fill-opacity': 0.3 }
    },
    {
      id: 'Przyroda/Tereny zabudowane',
      source: 'pomorskie-tiles',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'residential', 'commercial', 'industrial'],
      type: 'fill',
      paint: { 'fill-color': '#111827', 'fill-opacity': 0.7 }
    },
    {
      id: 'Woda/Morza i jeziora',
      source: 'pomorskie-tiles',
      'source-layer': 'water',
      type: 'fill',
      paint: { 'fill-color': '#0284c7', 'fill-opacity': 0.85 }
    },
    {
      id: 'Woda/Rzeki i potoki',
      source: 'pomorskie-tiles',
      'source-layer': 'waterway',
      type: 'line',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#38bdf8', 'line-width': 1.6 }
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
      type: 'symbol',
      layout: {
        'icon-image': 'icon-infra-average-speed',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.62, 11, 0.78, 14, 0.95, 17, 1.15],
        'icon-allow-overlap': true,
        'icon-ignore-placement': false,
        'icon-pitch-alignment': 'viewport'
      },
      paint: {
        'icon-opacity': 1.0,
        'text-color': '#d946ef'
      }
    },
    {
      id: 'Infrastruktura drogowa/Przejścia dla pieszych',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'crossing'],
      type: 'symbol',
      minzoom: 14,
      layout: {
        'icon-image': 'icon-infra-crossing',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 16, 0.85, 18, 1.1],
        // Przejść jest bardzo dużo (27 tys.) - nakładające się znaki są wygaszane i pojawiają się po przybliżeniu
        'icon-allow-overlap': false,
        'icon-padding': 1,
        'icon-pitch-alignment': 'viewport'
      },
      paint: {
        'icon-opacity': 0.96,
        'text-color': '#38bdf8'
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
      type: 'symbol',
      layout: {
        'icon-image': 'icon-infra-traffic-signals',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 13, 0.7, 15, 0.88, 17, 1.08],
        'icon-allow-overlap': true,
        'icon-ignore-placement': false,
        'icon-pitch-alignment': 'viewport'
      },
      paint: {
        'icon-opacity': 0.98,
        'text-color': '#22c55e'
      }
    },
    {
      id: 'Infrastruktura drogowa/Fotoradary',
      source: 'osm-infrastructure-source',
      'source-layer': 'osm-infrastructure',
      filter: ['==', 'category', 'speed_camera'],
      type: 'symbol',
      layout: {
        'icon-image': 'icon-infra-speed-camera',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.62, 11, 0.78, 14, 0.95, 17, 1.15],
        'icon-allow-overlap': true,
        'icon-ignore-placement': false,
        'symbol-z-order': 'source',
        'icon-pitch-alignment': 'viewport'
      },
      paint: {
        'icon-opacity': 1.0,
        'text-color': '#ef4444'
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

  // Nowoczesne, uniwersalne ikony infrastruktury drogowej (standard międzynarodowy, styl Apple Maps / Google Maps)
  // Próg zwalniający (profil drogi z łagodnym progiem + pojazd pokonujący próg na ciepłej tarczy ostrzegawczej)
  const SVG_A11A_SPEED_BUMP = `<svg id="A-11a" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="bumpBg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f59e0b"/>
        <stop offset="100%" stop-color="#d97706"/>
      </linearGradient>
    </defs>
    <!-- Tarcza ostrzegawcza w ciepłym odcieniu bursztynowym z białą obwódką -->
    <rect x="4" y="4" width="56" height="56" rx="16" ry="16" fill="url(#bumpBg)" stroke="#ffffff" stroke-width="3"/>
    <rect x="7" y="7" width="50" height="50" rx="13" ry="13" fill="none" stroke="#fef3c7" stroke-width="1.2" opacity="0.6"/>
    <!-- Profil jezdni z łagodnym progiem zwalniającym (międzynarodowy standard UNECE / ISO) -->
    <path d="M10 46 L20 46 C24 46 26 35 32 35 C38 35 40 46 44 46 L54 46" stroke="#1c1917" stroke-width="5" stroke-linecap="round" fill="none"/>
    <!-- Sylwetka pojazdu pokonującego próg -->
    <path d="M24 23 L28 17 L36 17 L40 23 Z" fill="#1c1917"/>
    <rect x="19" y="23" width="26" height="9" rx="3" fill="#1c1917"/>
    <circle cx="24" cy="33" r="3.2" fill="#1c1917"/>
    <circle cx="40" cy="33" r="3.2" fill="#1c1917"/>
    <circle cx="24" cy="33" r="1.3" fill="#fde68a"/>
    <circle cx="40" cy="33" r="1.3" fill="#fde68a"/>
  </svg>`;

  // Przejście dla pieszych (międzynarodowy znak Vienna Convention E,12: błękitna tarcza, zebra i dynamiczna sylwetka pieszego)
  const SVG_D6_CROSSING = `<svg id="D-6" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="crossBg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0284c7"/>
        <stop offset="100%" stop-color="#0369a1"/>
      </linearGradient>
    </defs>
    <!-- Błękitna tarcza z białą obwódką -->
    <rect x="4" y="4" width="56" height="56" rx="16" ry="16" fill="url(#crossBg)" stroke="#ffffff" stroke-width="3"/>
    <rect x="7" y="7" width="50" height="50" rx="13" ry="13" fill="none" stroke="#38bdf8" stroke-width="1.2" opacity="0.6"/>
    <!-- Pasy przejścia dla pieszych (zebra) -->
    <rect x="14" y="43" width="36" height="3.2" rx="1.6" fill="#ffffff"/>
    <rect x="16" y="48.5" width="32" height="3.2" rx="1.6" fill="#ffffff"/>
    <rect x="18" y="54" width="28" height="2.8" rx="1.4" fill="#ffffff" opacity="0.85"/>
    <!-- Sylwetka pieszego na pasach -->
    <circle cx="34" cy="17" r="4.2" fill="#ffffff"/>
    <path d="M31 22.5 C29.5 22.5 28 23.7 28 25.5 L27.5 32 L22 34.5 C21.2 34.9 20.8 35.9 21.2 36.7 C21.6 37.5 22.6 37.9 23.4 37.5 L28.5 34.8 L29.5 39 L24 47 C23.4 47.8 23.6 48.9 24.4 49.5 C25.2 50.1 26.3 49.9 26.9 49.1 L33 40 L34 34.5 L37 37.5 L40.5 45 C40.9 45.8 41.9 46.2 42.7 45.8 C43.5 45.4 43.9 44.4 43.5 43.6 L39.5 35 C39 34 38.2 33.2 37.2 32.7 L34.8 31.3 L35.2 25.5 C35.2 23.7 33.5 22.5 31 22.5 Z" fill="#ffffff"/>
  </svg>`;

  // Fotoradar (uniwersalny piktogram kamery prędkości z obiektywem o wysokim kontraście, fleszem i falami radarowymi)
  const SVG_D51_SPEED_CAMERA = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="camBg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2c2d35"/>
        <stop offset="100%" stop-color="#15161b"/>
      </linearGradient>
      <radialGradient id="lensGrad" cx="45%" cy="40%" r="55%">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="60%" stop-color="#0284c7"/>
        <stop offset="100%" stop-color="#033d6b"/>
      </radialGradient>
    </defs>
    <!-- Nowoczesna ciemna tarcza z białą obwódką -->
    <rect x="4" y="4" width="56" height="56" rx="16" ry="16" fill="url(#camBg)" stroke="#ffffff" stroke-width="3"/>
    <rect x="7" y="7" width="50" height="50" rx="13" ry="13" fill="none" stroke="#475569" stroke-width="1.2" opacity="0.6"/>
    <!-- Korpus aparatu / radaru -->
    <path d="M22 23 L26 17 L38 17 L42 23 Z" fill="#f8fafc"/>
    <rect x="12" y="23" width="40" height="26" rx="6" ry="6" fill="#f8fafc"/>
    <!-- Obiektyw aparatu z antyrefleksem -->
    <circle cx="32" cy="36" r="9.5" fill="#1e222a"/>
    <circle cx="32" cy="36" r="7.5" fill="url(#lensGrad)"/>
    <circle cx="32" cy="36" r="4.5" fill="#0f172a"/>
    <circle cx="30" cy="34" r="1.8" fill="#ffffff" opacity="0.85"/>
    <!-- Dioda ostrzegawcza / flesz -->
    <circle cx="43.5" cy="28.5" r="2.8" fill="#ef4444"/>
    <circle cx="42.5" cy="27.5" r="1" fill="#fca5a5" opacity="0.9"/>
    <!-- Fale detekcji prędkości -->
    <path d="M46 16 C50 18.5 53 22 53.5 26" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M50 12 C56 15 59.5 20 60 26" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>
  </svg>`;

  // Odcinkowy pomiar prędkości (uniwersalny piktogram dwóch zsynchronizowanych kamer ze wskaźnikiem pomiaru AVG)
  const SVG_D51A_AVERAGE_SPEED = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="avgBg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2c2d35"/>
        <stop offset="100%" stop-color="#15161b"/>
      </linearGradient>
    </defs>
    <!-- Tarcza z białą obwódką -->
    <rect x="4" y="4" width="56" height="56" rx="16" ry="16" fill="url(#avgBg)" stroke="#ffffff" stroke-width="3"/>
    <rect x="7" y="7" width="50" height="50" rx="13" ry="13" fill="none" stroke="#475569" stroke-width="1.2" opacity="0.6"/>
    <!-- Kamera A -->
    <g transform="translate(10, 15) scale(0.48)">
      <path d="M10 11 L14 5 L24 5 L28 11 Z" fill="#f8fafc"/>
      <rect x="2" y="11" width="34" height="22" rx="4" fill="#f8fafc"/>
      <circle cx="19" cy="22" r="7.5" fill="#1e222a"/>
      <circle cx="19" cy="22" r="4.8" fill="#38bdf8"/>
    </g>
    <!-- Kamera B -->
    <g transform="translate(36, 15) scale(0.48)">
      <path d="M10 11 L14 5 L24 5 L28 11 Z" fill="#f8fafc"/>
      <rect x="2" y="11" width="34" height="22" rx="4" fill="#f8fafc"/>
      <circle cx="19" cy="22" r="7.5" fill="#1e222a"/>
      <circle cx="19" cy="22" r="4.8" fill="#38bdf8"/>
    </g>
    <!-- Wskaźnik odcinka ze strzałką pomiaru prędkości A -> B -->
    <path d="M16 41 L42 41" stroke="#f8fafc" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M39 37 L46 41 L39 45 Z" fill="#f8fafc"/>
    <text x="32" y="53" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="900" font-size="9" fill="#ef4444" letter-spacing="0.5">AVG</text>
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
            try { map.removeImage(iconId); } catch (e) {}
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

    const toSvgUri = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    // Rozmiary logiczne ikon (px CSS przy icon-size = 1) - jedna tabela dla rejestracji i fallbacku
    const ICON_DEFS = {
      'icon-infra-traffic-signals': { svg: SVG_APPLE_TRAFFIC_SIGNALS, w: 28, h: 28 },
      'icon-infra-crossing': { svg: SVG_D6_CROSSING, w: 28, h: 28 },
      // Fotoradary i OPP: czerwona poświata z obręczą, żeby wyróżniały się spośród setek przejść i progów
      'icon-infra-speed-camera': { svg: SVG_D51_SPEED_CAMERA, w: 28, h: 28, halo: { color: '#ef4444', size: 46 } },
      'icon-infra-average-speed': { svg: SVG_D51A_AVERAGE_SPEED, w: 28, h: 28, halo: { color: '#ef4444', size: 46 } },
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
