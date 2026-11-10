co onst config = Object.assign({
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

  // Znak A-11a "Próg zwalniający" (wektorowy SVG, proporcje wg rozporządzenia: trójkąt równoboczny,
  // żółte tło, czerwona obwódka, biały rant zewnętrzny, czarny symbol progu na jezdni)
  const SVG_A11A_SPEED_BUMP = `<svg id="A-11a" xmlns="http://www.w3.org/2000/svg" width="68" height="60" viewBox="0 0 680 600">
    <path d="M340 8 C356 8 368 16 377 31 L668 535 C686 566 664 592 630 592 L50 592 C16 592 -6 566 12 535 L303 31 C312 16 324 8 340 8 Z" fill="#fff"/>
    <path d="M340 8 C356 8 368 16 377 31 L668 535 C686 566 664 592 630 592 L50 592 C16 592 -6 566 12 535 L303 31 C312 16 324 8 340 8 Z" fill="none" stroke="#000" stroke-width="2"/>
    <path d="M340 30 C350 30 357 35 363 45 L648 538 C659 557 646 574 624 574 L56 574 C34 574 21 557 32 538 L317 45 C323 35 330 30 340 30 Z" fill="#d6001c"/>
    <path d="M340 118 L567 512 L113 512 Z" fill="#ffd200" stroke="#ffd200" stroke-width="22" stroke-linejoin="round"/>
    <path d="M160 470 L160 448 L262 448 C292 448 306 384 340 384 C374 384 388 448 418 448 L520 448 L520 470 Z" fill="#000"/>
  </svg>`;

  const SVG_D6_CROSSING = `<svg id="D-6" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 602 602">
    <rect x="1" y="1" width="600" height="600" rx="30" ry="30" fill="#fff"/>
    <rect x=".5" y=".5" width="601" height="601" rx="30.5" ry="30.5" fill="none" stroke="#000"/>
    <rect x="7" y="7" width="588" height="588" rx="24" ry="24" fill="#039"/>
    <g>
      <polygon points="301 11 11 511 591 511 301 11" fill="#fff"/>
      <g>
        <g>
          <circle cx="301" cy="121" r="24" fill="#000"/>
          <path fill="#000" d="M301.91,150.19l-38.17,84.5-54.37,54.98,12.66,24.41,70.01-69.29,9.49,63.92-46.6,65.63-30.97,92.7-32.88,6.45.04,9.68,60.17,10.88,32.36-100.21,39.62-47.14,73.72,123.12-20.94,16.69v9.46h20.01l37.63-21.64-74.94-154.44,2.73-8.84-9.29-59.94-.38-32.87,24.6,29.57v86.01l24.32-14v-86.44l-51.47-67.13-47.36-16.08h0v.02Z" fill-rule="evenodd"/>
        </g>
        <path fill="#000" d="M89.2,409.25l-12.61,21.72h148.95l7.18-21.72H89.2ZM287.84,409.25l-6.95,21.72h79.83l-12.88-21.72h-60.01.01ZM413.22,409.25l11,21.72h101.18l-12.04-21.72h-100.15,0Z" fill-rule="evenodd"/>
      </g>
    </g>
  </svg>`;

  const SVG_D51_SPEED_CAMERA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 134.29413 167.72765" width="60" height="75">
    <g transform="translate(-175.876,-8.742042)">
      <rect style="fill:#ffffff;stroke:#000000;stroke-width:0.79375;stroke-linecap:round;stroke-linejoin:round" width="133.50038" height="166.9339" x="176.27287" y="9.138917" rx="6.9192028" ry="6.9192028" />
      <rect ry="6.1632504" rx="6.1632504" y="10.419911" x="177.42023" height="164.37724" width="131.17183" style="fill:#003399;stroke:none" />
      <path d="m 257.09899,107.99276 1.52001,1.13576 c 2.43651,-6.63392 0.037,-13.064317 0.037,-13.064317 h -1e-5 l -1.46375,1.077553 c 1.79194,5.753744 -0.0933,10.851004 -0.0933,10.851004 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.26458332px" />
      <path d="m 261.83052,111.52821 1.56288,1.16781 c 4.21021,-12.07231 -0.25952,-19.928278 -0.25952,-19.928278 l -1.3566,0.998685 c 0,0 3.82182,8.193633 0.0532,17.761783 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.26458332px" />
      <path d="m 266.43389,114.96791 1.41305,1.05584 c 6.63887,-14.8655 -0.11659,-26.639752 -0.11659,-26.639752 l -1.24947,0.919816 c 5.79995,12.458056 -0.047,24.664096 -0.047,24.664096 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.26458332px" />
      <path d="m 270.97271,118.35936 1.33813,0.99987 c 9.05715,-16.19646 0.13214,-33.444495 0.13214,-33.444495 l -1.55041,1.141353 c 0,0 8.47091,14.970792 0.0801,31.303272 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.26458332px" />
      <path d="m 275.34049,121.62302 1.53085,1.14387 c 11.51248,-21.40819 -0.0486,-40.076397 -0.0486,-40.076397 h 4e-5 l -1.41137,1.039001 c 10.96789,20.836446 -0.0709,37.893526 -0.0709,37.893526 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.26458332px" />
      <path d="m 279.92219,125.04652 1.33813,0.99987 c 14.07251,-25.4895 0.16796,-46.746292 0.16796,-46.746292 l -1.48421,1.09262 c 12.98333,22.970512 -0.0219,44.653802 -0.0219,44.653802 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.26458332px" />
      <path d="m 284.49304,128.46192 1.2849,0.96009 c 16.31953,-27.64671 0.26728,-53.520728 0.26728,-53.520728 l -1.59375,1.173258 c 15.75612,27.44109 0.0416,51.38738 0.0416,51.38738 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.26458332px" />
      <g style="fill:#ffffff">
        <path d="m 192.37303,19.087574 h 2.7175 v 6.725811 l 5.91056,-6.725811 h 3.60068 l -6.35215,7.235342 6.35215,9.069654 h -3.32893 l -4.85753,-6.963592 -1.32478,1.528594 v 5.434998 h -2.7175 z" />
        <path d="m 207.2518,34.033821 q -1.69843,-1.698437 -1.69843,-4.076249 0,-2.377813 1.69843,-4.07625 1.69844,-1.698437 4.07625,-1.698437 2.37781,0 4.07625,1.698437 1.69844,1.698437 1.69844,4.07625 0,2.377812 -1.69844,4.076249 -1.69844,1.698437 -4.07625,1.698437 -2.37781,0 -4.07625,-1.698437 z m 1.90225,-6.21628 q -0.88318,0.883187 -0.88318,2.140031 0,1.256843 0.88318,2.173999 0.91716,0.883187 2.174,0.883187 1.25685,0 2.14003,-0.883187 0.91716,-0.917156 0.91716,-2.173999 0,-1.256844 -0.91716,-2.140031 -0.88318,-0.917156 -2.14003,-0.917156 -1.25684,0 -2.174,0.917156 z" />
        <path d="m 220.29917,24.522573 h 2.7175 v 1.053031 q 1.15494,-1.053031 2.7175,-1.053031 1.66447,0 2.85338,1.188906 1.22287,1.188906 1.22287,2.887343 v 6.793748 h -2.7175 v -6.114373 q 0,-0.849219 -0.61144,-1.426688 -0.57746,-0.611437 -1.42668,-0.611437 -0.84922,0 -1.46066,0.611437 -0.57747,0.577469 -0.57747,1.426688 v 6.114373 h -2.7175 z" />
        <path d="m 234.29877,21.805073 2.7175,-2.717499 v 5.434999 h 2.03812 v 2.717499 h -2.03812 v 4.076249 q 0,0.577469 0.37365,0.985094 0.40763,0.373656 0.9851,0.373656 h 1.42668 l -1.42668,2.717499 q -1.69844,0 -2.88735,-1.188906 -1.1889,-1.188906 -1.1889,-2.887343 v -4.076249 h -2.03813 v -2.717499 h 2.03813 z" />
        <path d="m 242.49373,24.522573 h 2.71749 v 0.577468 q 1.29082,-0.577468 2.7175,-0.577468 v 2.717499 q -1.56256,0 -2.7175,1.053031 v 7.099467 h -2.71749 z" />
        <path d="m 251.33119,34.033821 q -1.69844,-1.698437 -1.69844,-4.076249 0,-2.377813 1.69844,-4.07625 1.69844,-1.698437 4.07625,-1.698437 2.37781,0 4.07625,1.698437 1.69843,1.698437 1.69843,4.07625 0,2.377812 -1.69843,4.076249 -1.69844,1.698437 -4.07625,1.698437 -2.37781,0 -4.07625,-1.698437 z m 1.90225,-6.21628 q -0.88319,0.883187 -0.88319,2.140031 0,1.256843 0.88319,2.173999 0.91715,0.883187 2.174,0.883187 1.25684,0 2.14003,-0.883187 0.91715,-0.917156 0.91715,-2.173999 0,-1.256844 -0.91715,-2.140031 -0.88319,-0.917156 -2.14003,-0.917156 -1.25685,0 -2.174,0.917156 z" />
        <path d="m 264.31171,19.087574 h 2.7175 V 35.39257 h -2.7175 z" />
        <path d="m 271.95468,33.79604 q -1.59653,-1.596531 -1.59653,-3.838468 0,-2.241938 1.59653,-3.838469 1.59653,-1.59653 3.83847,-1.59653 1.46065,0 2.7175,0.747312 v -0.747312 h 2.7175 v 8.152498 l 0.67937,2.717499 h -2.7175 l -0.23778,-1.019062 q -1.42669,1.019062 -3.15909,1.019062 -2.24194,0 -3.83847,-1.59653 z m 1.90225,-5.774687 q -0.78128,0.781281 -0.78128,1.936219 0,1.154937 0.78128,1.970187 0.81525,0.781281 1.93622,0.781281 1.12097,0 1.90225,-0.781281 0.81525,-0.81525 0.81525,-1.970187 0,-1.154938 -0.81525,-1.936219 -0.78128,-0.81525 -1.90225,-0.81525 -1.12097,0 -1.93622,0.81525 z" />
      </g>
      <g style="fill:#ffffff">
        <path d="m 195.80499,49.336096 q -0.78128,0.781281 -0.78128,1.936219 0,1.154937 0.78128,1.970187 0.81525,0.781281 1.93622,0.781281 1.12096,0 1.90224,-0.781281 0.81525,-0.81525 0.81525,-1.970187 0,-1.154938 -0.81525,-1.936219 -0.78128,-0.81525 -1.90224,-0.81525 -1.12097,0 -1.93622,0.81525 z m -3.49878,-3.49878 h 2.7175 v 0.747312 q 1.25684,-0.747312 2.7175,-0.747312 2.24193,0 3.83846,1.596531 1.59653,1.59653 1.59653,3.838468 0,2.241937 -1.59653,3.838468 -1.59653,1.596531 -3.83846,1.596531 -1.46066,0 -2.7175,-0.747313 v 6.182312 h -2.7175 z" />
        <path d="m 206.48816,45.837316 h 2.7175 v 0.577468 q 1.29081,-0.577468 2.7175,-0.577468 v 2.717499 q -1.56257,0 -2.7175,1.053031 v 7.099468 h -2.7175 z" />
        <path d="m 223.477,60.409907 -1.29081,1.732406 q -1.35875,-1.019063 -1.35875,-2.7175 0,-1.698437 1.35875,-2.717499 -0.40763,0.543499 -0.40763,1.358749 0,0.81525 0.47556,1.460656 0.47557,0.645406 1.22288,0.883188 z m -1.12097,-10.156655 q -0.30572,-0.883187 -1.12097,-1.460656 -0.78128,-0.577468 -1.76637,-0.577468 -0.9851,0 -1.80035,0.577468 -0.78128,0.577469 -1.087,1.460656 z m -5.77469,2.038125 q 0.33969,0.917156 1.12097,1.494625 0.78128,0.543499 1.76638,0.543499 l 4.07625,-0.339687 -1.35875,2.7175 -1.83432,0.271749 q -0.54349,0.06794 -0.88318,0.06794 -2.37781,0 -4.07625,-1.698437 -1.69844,-1.698437 -1.69844,-4.076249 0,-2.377813 1.69844,-4.07625 1.69844,-1.698437 4.07625,-1.698437 3.02322,0 4.75562,2.513687 v 4.280062 z" />
        <path d="m 228.40696,55.110783 q -1.59654,-1.596531 -1.59654,-3.838468 0,-2.241938 1.59654,-3.838468 1.59653,-1.596531 3.83846,-1.596531 1.46066,0 2.7175,0.747312 v -6.182311 h 2.7175 v 16.304997 h -2.7175 v -0.747313 q -1.25684,0.747313 -2.7175,0.747313 -2.24193,0 -3.83846,-1.596531 z m 1.90224,-5.774687 q -0.78128,0.781281 -0.78128,1.936219 0,1.154937 0.78128,1.970187 0.81525,0.781281 1.93622,0.781281 1.12097,0 1.90225,-0.781281 0.81525,-0.81525 0.81525,-1.970187 0,-1.154938 -0.81525,-1.936219 -0.78128,-0.81525 -1.90225,-0.81525 -1.12097,0 -1.93622,0.81525 z" />
        <path d="m 241.40896,40.402317 h 2.7175 v 9.511248 h 1.01906 l 3.05718,-4.076249 h 3.39688 l -4.07625,5.434999 4.07625,5.434999 h -3.39688 l -3.05718,-4.07625 h -1.01906 v 4.07625 h -2.7175 z" />
        <path d="m 254.08981,55.348564 q -1.69844,-1.698437 -1.69844,-4.076249 0,-2.377813 1.69844,-4.07625 1.69843,-1.698437 4.07625,-1.698437 2.37781,0 4.07625,1.698437 1.69843,1.698437 1.69843,4.07625 0,2.377812 -1.69843,4.076249 -1.69844,1.698437 -4.07625,1.698437 -2.37782,0 -4.07625,-1.698437 z m 1.90225,-6.21628 q -0.88319,0.883187 -0.88319,2.140031 0,1.256843 0.88319,2.173999 0.91715,0.883187 2.174,0.883187 1.25684,0 2.14003,-0.883187 0.91715,-0.917156 0.91715,-2.173999 0,-1.256844 -0.91715,-2.140031 -0.88319,-0.917156 -2.14003,-0.917156 -1.25685,0 -2.174,0.917156 z" />
        <path d="m 271.24279,40.402317 h 2.7175 l -4.07625,4.076249 z m -1.35875,5.434999 q 1.32478,0 2.37781,0.27175 v 2.445749 q -1.15494,-0.339687 -2.37781,-0.339687 -0.27175,0 -0.47557,0.203812 -0.20381,0.203813 -0.20381,0.475562 0,0.407625 0.33969,0.577469 l 2.07209,1.256844 q 0.78128,0.441593 1.22288,1.222874 0.44159,0.781282 0.44159,1.698438 0,1.392718 -0.98509,2.41178 -0.9851,0.985094 -2.41178,0.985094 -2.24194,0 -4.14419,-0.781281 l 0.74731,-2.275906 q 1.6305,0.679375 3.39688,0.679375 0.44159,0 0.71334,-0.27175 0.30572,-0.305719 0.30572,-0.747312 0,-0.611438 -0.50953,-0.883188 l -2.20797,-1.290812 q -1.42669,-0.951125 -1.42669,-2.581625 0,-1.290812 0.95113,-2.173999 0.95112,-0.883187 2.174,-0.883187 z" />
        <path d="m 285.10359,55.790157 q -1.56256,1.256844 -3.60069,1.256844 -2.41178,0 -4.11021,-1.698437 -1.66447,-1.698437 -1.66447,-4.076249 0,-2.411781 1.66447,-4.07625 1.69843,-1.698437 4.11021,-1.698437 1.80035,0 3.261,1.019062 l -1.05303,2.649562 q -0.88319,-0.951124 -2.20797,-0.951124 -1.25684,0 -2.174,0.883187 -0.88318,0.883187 -0.88318,2.174 0,1.256843 0.88318,2.173999 0.91716,0.883187 2.174,0.883187 1.42669,0 2.34385,-1.086999 z" />
        <path d="m 288.00469,45.837316 h 2.7175 v 10.869998 h -2.7175 z m 0,-5.434999 h 2.7175 v 2.717499 h -2.7175 z" />
      </g>
      <g style="fill:#ffffff">
        <path d="m 195.02371,152.54622 v 4.07624 h 4.75562 v 2.7175 h -4.75562 v 6.79375 h -2.7175 v -16.30499 h 8.83187 v 2.7175 z" />
        <path d="m 204.06163,164.77496 q -1.69844,-1.69843 -1.69844,-4.07625 0,-2.37781 1.69844,-4.07625 1.69843,-1.69843 4.07625,-1.69843 2.37781,0 4.07625,1.69843 1.69843,1.69844 1.69843,4.07625 0,2.37782 -1.69843,4.07625 -1.69844,1.69844 -4.07625,1.69844 -2.37782,0 -4.07625,-1.69844 z m 1.90225,-6.21628 q -0.88319,0.88319 -0.88319,2.14003 0,1.25685 0.88319,2.174 0.91715,0.88319 2.174,0.88319 1.25684,0 2.14003,-0.88319 0.91715,-0.91715 0.91715,-2.174 0,-1.25684 -0.91715,-2.14003 -0.88319,-0.91715 -2.14003,-0.91715 -1.25685,0 -2.174,0.91715 z" />
        <path d="m 217.78836,152.54622 2.7175,-2.7175 v 5.43499 h 2.03813 v 2.7175 h -2.03813 v 4.07625 q 0,0.57747 0.37366,0.9851 0.40762,0.37365 0.98509,0.37365 h 1.42669 l -1.42669,2.7175 q -1.69844,0 -2.88734,-1.1889 -1.18891,-1.18891 -1.18891,-2.88735 v -4.07625 h -2.03812 v -2.7175 h 2.03812 z" />
        <path d="m 226.73511,164.77496 q -1.69843,-1.69843 -1.69843,-4.07625 0,-2.37781 1.69843,-4.07625 1.69844,-1.69843 4.07625,-1.69843 2.37781,0 4.07625,1.69843 1.69844,1.69844 1.69844,4.07625 0,2.37782 -1.69844,4.07625 -1.69844,1.69844 -4.07625,1.69844 -2.37781,0 -4.07625,-1.69844 z m 1.90225,-6.21628 q -0.88319,0.88319 -0.88319,2.14003 0,1.25685 0.88319,2.174 0.91716,0.88319 2.174,0.88319 1.25685,0 2.14003,-0.88319 0.91716,-0.91715 0.91716,-2.174 0,-1.25684 -0.91716,-2.14003 -0.88318,-0.91715 -2.14003,-0.91715 -1.25684,0 -2.174,0.91715 z" />
        <path d="m 239.64884,155.26371 h 2.7175 v 0.57747 q 1.29081,-0.57747 2.7175,-0.57747 v 2.7175 q -1.56256,0 -2.7175,1.05304 v 7.09946 h -2.7175 z" />
        <path d="m 248.24965,164.53718 q -1.59653,-1.59653 -1.59653,-3.83847 0,-2.24193 1.59653,-3.83846 1.59653,-1.59654 3.83847,-1.59654 1.46066,0 2.7175,0.74732 v -0.74732 h 2.7175 v 8.1525 l 0.67937,2.7175 h -2.7175 l -0.23778,-1.01906 q -1.42668,1.01906 -3.15909,1.01906 -2.24194,0 -3.83847,-1.59653 z m 1.90225,-5.77468 q -0.78128,0.78128 -0.78128,1.93621 0,1.15494 0.78128,1.97019 0.81525,0.78128 1.93622,0.78128 1.12097,0 1.90225,-0.78128 0.81525,-0.81525 0.81525,-1.97019 0,-1.15493 -0.81525,-1.93621 -0.78128,-0.81525 -1.90225,-0.81525 -1.12097,0 -1.93622,0.81525 z" />
        <path d="m 262.29797,164.53718 q -1.59653,-1.59653 -1.59653,-3.83847 0,-2.24193 1.59653,-3.83846 1.59653,-1.59654 3.83847,-1.59654 1.46065,0 2.7175,0.74732 v -6.18231 h 2.7175 v 16.30499 h -2.7175 v -0.74731 q -1.25685,0.74731 -2.7175,0.74731 -2.24194,0 -3.83847,-1.59653 z m 1.90225,-5.77468 q -0.78128,0.78128 -0.78128,1.93621 0,1.15494 0.78128,1.97019 0.81525,0.78128 1.93622,0.78128 1.12097,0 1.90225,-0.78128 0.81525,-0.81525 0.81525,-1.97019 0,-1.15493 -0.81525,-1.93621 -0.78128,-0.81525 -1.90225,-0.81525 -1.12097,0 -1.93622,0.81525 z" />
        <path d="m 276.4131,164.53718 q -1.59653,-1.59653 -1.59653,-3.83847 0,-2.24193 1.59653,-3.83846 1.59654,-1.59654 3.83847,-1.59654 1.46066,0 2.7175,0.74732 v -0.74732 h 2.7175 v 8.1525 l 0.67938,2.7175 h -2.7175 l -0.23778,-1.01906 q -1.42669,1.01906 -3.1591,1.01906 -2.24193,0 -3.83847,-1.59653 z m 1.90225,-5.77468 q -0.78128,0.78128 -0.78128,1.93621 0,1.15494 0.78128,1.97019 0.81525,0.78128 1.93622,0.78128 1.12097,0 1.90225,-0.78128 0.81525,-0.81525 0.81525,-1.97019 0,-1.15493 -0.81525,-1.93621 -0.78128,-0.81525 -1.90225,-0.81525 -1.12097,0 -1.93622,0.81525 z" />
        <path d="m 289.54538,155.26371 h 2.7175 v 0.57747 q 1.29081,-0.57747 2.7175,-0.57747 v 2.7175 q -1.56256,0 -2.7175,1.05304 v 7.09946 h -2.7175 z" />
      </g>
      <rect y="79.576241" x="196.77719" height="5.3453841" width="3.47453" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.794" />
      <path transform="scale(0.26458333)" d="m 817.21289,313.70508 a 65.847948,64.206443 0 0 0 -46.0918,18.37109 H 731.09766 V 443.19141 H 904.84375 V 332.07617 H 863.23633 A 65.847948,64.206443 0 0 0 817.21289,313.70508 Z M 817.84375,325 a 56.951089,56.57229 0 0 1 56.95117,56.57227 56.951089,56.57229 0 0 1 -56.95117,56.57226 A 56.951089,56.57229 0 0 1 760.89453,381.57227 56.951089,56.57229 0 0 1 817.84375,325 Z" style="fill:#ffffff;stroke:#ffffff;stroke-width:3" />
      <ellipse style="fill:#ffffff;stroke:none" cx="216.45491" cy="101.00518" rx="11.593806" ry="11.79426" />
    </g>
  </svg>`;

  const SVG_D51A_AVERAGE_SPEED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 116.34026 145.30403" width="60" height="75">
    <g transform="translate(-13.902541,-27.077397)">
      <rect style="fill:#ffffff;stroke:#000000;stroke-width:0.68763304;stroke-linecap:round;stroke-linejoin:round" width="115.65263" height="144.61639" x="14.246358" y="27.421213" rx="3.9153011" ry="3.9153011" />
      <rect ry="3.0714242" rx="3.0714242" y="28.530951" x="15.240321" height="142.40154" width="113.63538" style="fill:#003399;stroke:none" />
      <rect y="34.778927" x="51.147068" height="3.3252325" width="1.9358988" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.43711314" />
      <path transform="scale(0.26458333)" d="m 234.0918,140.31836 a 33.427233,27.33765 0 0 0 -26.20899,10.41602 H 185.8125 v 63.63867 h 96.42383 V 150.73438 H 260.33984 A 33.427233,27.33765 0 0 0 234.0918,140.31836 Z m 0.0273,6.96484 a 32.432715,32.767221 0 0 1 32.43164,32.76758 32.432715,32.767221 0 0 1 -32.43164,32.76758 32.432715,32.767221 0 0 1 -32.43359,-32.76758 32.432715,32.767221 0 0 1 32.43359,-32.76758 z" style="fill:#ffffff;stroke:#ffffff;stroke-width:1.65208113" />
      <ellipse style="fill:#ffffff;stroke:none" cx="61.960537" cy="47.571529" rx="7.2615128" ry="7.2330866" />
      <path d="m 18.642049,44.730974 h 2.171565 l 27.401972,89.550276 h -3.590774 z" style="fill:#ffffff;stroke:none" />
      <path d="m 58.665944,61.769607 -0.862733,1.216609 c 5.011708,1.109579 8.340026,1.64e-4 8.340026,1.64e-4 l -0.944474,-1.35336 c 0,0 -2.289351,0.738259 -6.532819,0.136587 z" style="fill:#ffffff;stroke:none" />
      <path d="m 56.902356,64.256583 -0.820026,1.156386 c 6.354612,2.20273 11.779186,0.03558 11.779186,0.03558 l -0.880289,-1.261391 c 0,0 -3.599344,1.562283 -10.078871,0.06943 z" style="fill:#ffffff;stroke:none" />
      <path d="m 55.154532,66.72133 -0.77732,1.096161 c 7.850708,3.024468 15.171226,0.04829 15.171226,0.04829 v 3e-6 l -0.913115,-1.308428 c 0,0 -6.161071,2.729006 -13.480791,0.163974 z" style="fill:#ffffff;stroke:none" />
      <path d="m 53.467187,69.10079 -0.842384,1.187913 c 9.949675,4.07578 18.599615,-0.02136 18.599615,-0.02136 v -3e-6 l -0.811369,-1.162633 c 0,0 -8.840831,3.722973 -16.945862,-0.0039 z" style="fill:#ffffff;stroke:none" />
      <path d="m 51.71277,71.574834 -0.864742,1.219441 c 11.340874,5.192999 22.116553,-0.03341 22.116553,-0.03341 v 10e-7 l -0.833253,-1.19399 c 0,0 -10.024572,4.735311 -20.418558,0.008 z" style="fill:#ffffff;stroke:none" />
      <rect width="2.4687979" height="4.2405767" x="88.424522" y="95.57608" style="fill:#ffffff;stroke:#ffffff;stroke-width:0.55743825" />
      <path style="fill:#ffffff;stroke:#ffffff;stroke-width:0.58316553" d="m 102.56367,98.809041 a 11.799426,9.6498738 0 0 0 -9.251476,3.676739 H 85.52163 v 22.46371 h 34.03649 v -22.46371 h -7.72921 a 11.799426,9.6498738 0 0 0 -9.26524,-3.676739 z m 0.0101,2.458499 a 11.448373,11.566449 0 0 1 11.44798,11.56659 11.448373,11.566449 0 0 1 -11.44798,11.56656 11.448373,11.566449 0 0 1 -11.448686,-11.56656 11.448373,11.566449 0 0 1 11.448686,-11.56659 z" />
      <ellipse ry="9.6498737" rx="9.6877985" cy="112.74487" cx="102.59535" style="fill:#ffffff;stroke:none" />
      <path d="m 118.82516,125.59989 6.59206,8.70498 h -3.59077 l -6.45958,-8.70879 z" style="fill:#ffffff;stroke:none" />
      <path d="m 96.043507,99.544354 -30.980082,-41.767287 2.405324,0.0053 30.902668,40.807775 c 0,0 -0.567474,-0.07117 -2.32791,0.954212 z" style="fill:#ffffff;stroke:none" />
      <path d="m 39.568019,50.537753 -2.879404,-5.806779 h 2.171565 l 2.928856,5.807193" style="fill:#ffffff;stroke:none" />
      <path d="m 43.860718,59.162341 4.331246,8.713216 h 2.598587 L 46.302083,59.15848 Z" style="fill:#ffffff;stroke:none" />
      <path d="m 53.921628,79.375785 h 2.77292 l 7.483547,14.499373 h -3.073599 z" style="fill:#ffffff;stroke:none" />
      <path d="m 69.736607,111.03571 h 3.449031 l 11.90625,23.43453 h -3.779761 z" style="fill:#ffffff;stroke:none" />
      <path d="m 89.23836,144.35829 -1.169909,1.68747 c 15.071799,6.94531 29.104169,-0.0945 29.104169,-0.0945 l -1.03358,-1.50252 c 0,0 -13.51851,5.8965 -26.90068,-0.0904 z" style="fill:#ffffff;stroke:none" />
      <path d="m 114.99906,142.79155 -1.11365,-1.61892 c 0,0 -10.7924,4.82588 -22.37051,-0.098 v -2e-5 l -1.156937,1.66877 c 12.876787,5.52299 24.641097,0.0482 24.641097,0.0482 z" style="fill:#ffffff;stroke:none" />
      <path d="m 112.74155,139.5098 -1.06685,-1.55089 c 0,0 -8.74253,3.45681 -17.94833,-0.0741 v -10e-6 l -1.188224,1.71389 c 11.162434,4.08883 20.203404,-0.0889 20.203404,-0.0889 z" style="fill:#ffffff;stroke:none" />
      <path d="m 110.55131,136.32584 -1.15072,-1.6728 c 0,0 -6.70227,2.18569 -13.424168,-0.0137 v -1e-5 l -1.146092,1.65312 c 8.60298,2.85149 15.72098,0.0334 15.72098,0.0334 z" style="fill:#ffffff;stroke:none" />
      <path d="m 108.18748,132.88954 -1.22022,-1.77384 c 0,0 -3.02595,1.35731 -8.646205,0.14174 l -1.193743,1.72185 c 6.439628,1.85493 11.060168,-0.0897 11.060168,-0.0897 z" style="fill:#ffffff;stroke:none" />
    </g>
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
      'icon-infra-speed-camera': { svg: SVG_D51_SPEED_CAMERA, w: 26, h: 32, halo: { color: '#ef4444', size: 46 } },
      'icon-infra-average-speed': { svg: SVG_D51A_AVERAGE_SPEED, w: 26, h: 32, halo: { color: '#ef4444', size: 46 } },
      'icon-infra-speed-bump': { svg: SVG_A11A_SPEED_BUMP, w: 31, h: 27 }
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
