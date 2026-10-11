const PMTILES_URL = 'pmtiles://http://localhost:8080/osm_data/pomorskie.pmtiles';

const MAP_STYLE = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    'pomorskie-tiles': {
      type: 'vector',
      url: PMTILES_URL
    },
    'terrain-dem': {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
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