/**
 * LayerManager - Zsynchronizowany moduł zarządzania warstwami, stylami i trybem 3D dla NNAPER
 * Obsługuje:
 * - Persystencję konfiguracji warstw i stylów w localStorage
 * - Drzewo sterowania warstwami (widoczność, kolory, grubości, linie przerywane, obwódki, rozmiary)
 * - Przełączniki 3D (ukształtowanie terenu 3D oraz trójwymiarowe bryły budynków)
 * - Synchronizację w czasie rzeczywistym między zakładkami (window 'storage' event)
 */

(function (window) {
  'use strict';

  const STORAGE_KEY = 'nnaper_layer_customizations';

  function getStoredConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (!parsed.layers) parsed.layers = {};
          if (!parsed.categories) parsed.categories = {};
          if (!parsed.settings3D) parsed.settings3D = { map3D: false, buildings3D: false };
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Nie udało się odczytać konfiguracji warstw z localStorage:', e);
    }
    return {
      version: 1,
      layers: {},
      categories: {},
      settings3D: {
        map3D: false,
        buildings3D: false
      }
    };
  }

  function saveStoredConfig(config) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      console.warn('Nie udało się zapisać konfiguracji warstw do localStorage:', e);
    }
  }

  function notifyConfigChanged() {
    window.dispatchEvent(new CustomEvent('nnaper_layer_customizations_changed', {
      detail: getStoredConfig()
    }));
  }

  function updateLayerProperty(layerId, patch) {
    const cfg = getStoredConfig();
    if (!cfg.layers[layerId]) cfg.layers[layerId] = {};
    Object.assign(cfg.layers[layerId], patch);
    saveStoredConfig(cfg);
    notifyConfigChanged();
  }

  function updateCategoryVisibility(categoryName, isVisible) {
    const cfg = getStoredConfig();
    cfg.categories[categoryName] = isVisible;
    saveStoredConfig(cfg);
    notifyConfigChanged();
  }

  function update3DSettings(patch) {
    const cfg = getStoredConfig();
    cfg.settings3D = Object.assign(cfg.settings3D || {}, patch);
    saveStoredConfig(cfg);
    notifyConfigChanged();
  }

  function getLayerColor(layer) {
    if (!layer || !layer.paint) return '#94a3b8';
    const c = layer.paint['fill-color'] ||
      layer.paint['line-color'] ||
      layer.paint['circle-color'] ||
      layer.paint['fill-extrusion-color'] ||
      layer.paint['text-color'];
    return (typeof c === 'string' && c.startsWith('#')) ? c : '#94a3b8';
  }

  function getLayerStrokeColor(layer) {
    if (!layer || !layer.paint) return getLayerColor(layer);
    const c = layer.paint['circle-stroke-color'];
    return (typeof c === 'string' && c.startsWith('#')) ? c : getLayerColor(layer);
  }

  function getRawLayer(map, layerId) {
    try {
      const style = map.getStyle();
      if (style && style.layers) {
        const found = style.layers.find(l => l.id === layerId);
        if (found) return found;
      }
    } catch (e) { }

    if (window.MAP_STYLE && Array.isArray(window.MAP_STYLE.layers)) {
      return window.MAP_STYLE.layers.find(l => l.id === layerId) || null;
    }
    return null;
  }

  function ensureOutlineLayer(map, layerId) {
    if (!layerId || layerId.includes('Zaznaczone drogi') || layerId.startsWith('osm-traversed') || layerId.startsWith('GPS')) {
      return null;
    }
    const outlineId = `${layerId}-outline-line`;
    if (map.getLayer(outlineId)) return outlineId;

    const raw = getRawLayer(map, layerId);
    if (!raw) return null;

    const source = raw.source;
    const sourceLayer = raw['source-layer'] || raw.sourceLayer;
    if (!source || !sourceLayer) return null;

    const baseColor = getLayerColor(raw);

    try {
      if (raw.type === 'line') {
        const baseWidth = (raw.paint && typeof raw.paint['line-width'] === 'number') ? raw.paint['line-width'] : 1.5;
        map.addLayer({
          id: outlineId,
          source: source,
          'source-layer': sourceLayer,
          type: 'line',
          filter: raw.filter || ['all'],
          paint: {
            'line-color': baseColor,
            'line-width': 0.0,
            'line-gap-width': baseWidth,
            'line-opacity': 0.0
          }
        }, layerId);
        return outlineId;
      } else if (raw.type === 'fill') {
        map.addLayer({
          id: outlineId,
          source: source,
          'source-layer': sourceLayer,
          type: 'line',
          filter: raw.filter || ['all'],
          paint: {
            'line-color': baseColor,
            'line-width': 0.0,
            'line-opacity': 0.0
          }
        });
        return outlineId;
      }
    } catch (err) {
      console.warn(`Nie udało się dodać obwódki dla ${layerId}:`, err);
    }
    return null;
  }

  function updateLineDashArray(map, layerId, isDashed, dashLen, gapLen) {
    if (!map || !map.getLayer(layerId)) return;
    try {
      if (isDashed) {
        map.setPaintProperty(layerId, 'line-dasharray', [parseFloat(dashLen) || 3, parseFloat(gapLen) || 2]);
      } else {
        map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
      }
    } catch (e) { }
  }

  function createDashControls(map, targetLayerId, initialDashed, initialDash, initialGap, onUpdate) {
    const box = document.createElement('div');
    box.className = 'control-row dash-control-row';
    box.style.borderTop = '1px dotted #334155';
    box.style.paddingTop = '4px';

    const checkLabel = document.createElement('label');
    checkLabel.style.display = 'flex';
    checkLabel.style.alignItems = 'center';
    checkLabel.style.gap = '4px';
    checkLabel.style.cursor = 'pointer';

    const dashCheck = document.createElement('input');
    dashCheck.type = 'checkbox';
    dashCheck.checked = !!initialDashed;
    dashCheck.style.accentColor = '#38bdf8';

    const checkText = document.createElement('span');
    checkText.innerText = 'Przerywana:';

    checkLabel.appendChild(dashCheck);
    checkLabel.appendChild(checkText);
    box.appendChild(checkLabel);

    const inputsHolder = document.createElement('div');
    inputsHolder.style.display = initialDashed ? 'flex' : 'none';
    inputsHolder.style.alignItems = 'center';
    inputsHolder.style.gap = '4px';

    const lDash = document.createElement('span'); lDash.innerText = 'L:';
    const inDash = document.createElement('input');
    inDash.type = 'range'; inDash.min = '0.5'; inDash.max = '15'; inDash.step = '0.5';
    inDash.value = (initialDash !== undefined && initialDash !== null) ? String(initialDash) : '3';

    const lGap = document.createElement('span'); lGap.innerText = 'P:';
    const inGap = document.createElement('input');
    inGap.type = 'range'; inGap.min = '0.5'; inGap.max = '15'; inGap.step = '0.5';
    inGap.value = (initialGap !== undefined && initialGap !== null) ? String(initialGap) : '2';

    const apply = () => {
      const isDashed = dashCheck.checked;
      const dVal = parseFloat(inDash.value) || 3;
      const gVal = parseFloat(inGap.value) || 2;
      updateLineDashArray(map, targetLayerId, isDashed, dVal, gVal);
      if (typeof onUpdate === 'function') {
        onUpdate(isDashed, dVal, gVal);
      }
    };

    dashCheck.addEventListener('change', () => {
      inputsHolder.style.display = dashCheck.checked ? 'flex' : 'none';
      apply();
    });
    inDash.addEventListener('input', apply);
    inGap.addEventListener('input', apply);

    inputsHolder.appendChild(lDash); inputsHolder.appendChild(inDash);
    inputsHolder.appendChild(lGap); inputsHolder.appendChild(inGap);
    box.appendChild(inputsHolder);

    return box;
  }

  function applyCustomizationsToMap(map) {
    if (!map) return;

    ['GPS / Zaznaczone drogi OSM', 'GPS / Zaznaczone drogi OSM-outline-line', 'Zaznaczone drogi OSM', 'Zaznaczone drogi OSM-outline-line', 'osm-traversed-roads-layer-outline-line'].forEach(id => {
      if (map.getLayer(id)) {
        try { map.removeLayer(id); } catch (e) { }
      }
    });

    const cfg = getStoredConfig();
    let configModified = false;

    // 1. Zastosowanie styli poszczególnych warstw
    Object.keys(cfg.layers || {}).forEach(layerId => {
      if (layerId.includes('Zaznaczone drogi') || layerId.startsWith('osm-traversed-') || layerId.includes('outline-line')) {
        delete cfg.layers[layerId];
        configModified = true;
        return;
      }
      const saved = cfg.layers[layerId];
      if (!saved) return;

      const layerExists = !!map.getLayer(layerId);
      const outlineId = `${layerId}-outline-line`;

      // Widoczność
      if (saved.visibility !== undefined) {
        if (layerExists) {
          map.setLayoutProperty(layerId, 'visibility', saved.visibility);
        }
        if (map.getLayer(outlineId)) {
          map.setLayoutProperty(outlineId, 'visibility', saved.visibility);
        }
      }

      // Kolor główny
      if (saved.color && layerExists) {
        const raw = getRawLayer(map, layerId);
        if (raw) {
          try {
            if (raw.type === 'line') map.setPaintProperty(layerId, 'line-color', saved.color);
            else if (raw.type === 'fill') map.setPaintProperty(layerId, 'fill-color', saved.color);
            else if (raw.type === 'circle') {
              if (layerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
                window.updateTrackPaintProperty('circle-color', saved.color);
              } else {
                map.setPaintProperty(layerId, 'circle-color', saved.color);
              }
            }
            else if (raw.type === 'fill-extrusion') map.setPaintProperty(layerId, 'fill-extrusion-color', saved.color);
            else if (raw.type === 'symbol') map.setPaintProperty(layerId, 'text-color', saved.color);
          } catch (e) { }
        }
      }

      // Grubość linii (dla line)
      if (saved.lineWidth !== undefined && layerExists) {
        try {
          map.setPaintProperty(layerId, 'line-width', parseFloat(saved.lineWidth));
          if (map.getLayer(outlineId)) {
            map.setPaintProperty(outlineId, 'line-gap-width', parseFloat(saved.lineWidth));
          }
        } catch (e) { }
      }

      // Przerywana linia główna
      if (saved.isDashed !== undefined && layerExists) {
        updateLineDashArray(map, layerId, saved.isDashed, saved.dashLen || 3, saved.gapLen || 2);
      }

      // Obwódka (outline)
      if (saved.outlineWidth !== undefined || saved.outlineColor || saved.outlineIsDashed !== undefined) {
        const createdOutlineId = ensureOutlineLayer(map, layerId);
        if (createdOutlineId && map.getLayer(createdOutlineId)) {
          try {
            if (saved.outlineColor) {
              map.setPaintProperty(createdOutlineId, 'line-color', saved.outlineColor);
            }
            if (saved.outlineWidth !== undefined) {
              const oWidth = parseFloat(saved.outlineWidth) || 0;
              map.setPaintProperty(createdOutlineId, 'line-width', oWidth);
              map.setPaintProperty(createdOutlineId, 'line-opacity', oWidth > 0 ? 1.0 : 0.0);
            }
            if (saved.outlineIsDashed !== undefined) {
              updateLineDashArray(map, createdOutlineId, saved.outlineIsDashed, saved.outlineDashLen || 3, saved.outlineGapLen || 2);
            }
          } catch (e) { }
        }
      }

      // Punkty (circle-radius, stroke)
      if (saved.circleRadius !== undefined && layerExists) {
        try {
          const r = parseFloat(saved.circleRadius);
          if (layerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
            window.updateTrackPaintProperty('circle-radius', r);
          } else {
            map.setPaintProperty(layerId, 'circle-radius', r);
          }
        } catch (e) { }
      }
      if (saved.strokeColor && layerExists) {
        try {
          if (layerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
            window.updateTrackPaintProperty('circle-stroke-color', saved.strokeColor);
          } else {
            map.setPaintProperty(layerId, 'circle-stroke-color', saved.strokeColor);
          }
        } catch (e) { }
      }
      if (saved.strokeWidth !== undefined && layerExists) {
        try {
          const sw = parseFloat(saved.strokeWidth);
          if (layerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
            window.updateTrackPaintProperty('circle-stroke-width', sw);
          } else {
            map.setPaintProperty(layerId, 'circle-stroke-width', sw);
          }
        } catch (e) { }
      }

      // Tekst (text-size)
      if (saved.textSize !== undefined && layerExists) {
        try {
          map.setLayoutProperty(layerId, 'text-size', parseFloat(saved.textSize));
        } catch (e) { }
      }

      // Krycie / Opacity
      if (saved.opacity !== undefined && layerExists) {
        const raw = getRawLayer(map, layerId);
        if (raw) {
          try {
            const opVal = parseFloat(saved.opacity);
            if (raw.type === 'fill') map.setPaintProperty(layerId, 'fill-opacity', opVal);
            else if (raw.type === 'line') map.setPaintProperty(layerId, 'line-opacity', opVal);
            else if (raw.type === 'circle') map.setPaintProperty(layerId, 'circle-opacity', opVal);
            else if (raw.type === 'fill-extrusion') map.setPaintProperty(layerId, 'fill-extrusion-opacity', opVal);
          } catch (e) { }
        }
      }

      // Halo tekstu
      if (saved.haloColor && layerExists) {
        try { map.setPaintProperty(layerId, 'text-halo-color', saved.haloColor); } catch (e) { }
      }
      if (saved.haloWidth !== undefined && layerExists) {
        try { map.setPaintProperty(layerId, 'text-halo-width', parseFloat(saved.haloWidth)); } catch (e) { }
      }
    });

    // 2. Budynki 3D
    const is3DBld = !!cfg.settings3D?.buildings3D;
    const bldLayerId = 'Budynki/Bryły 3D';
    if (map.getLayer(bldLayerId)) {
      try {
        const curVis = map.getLayoutProperty(bldLayerId, 'visibility');
        const targetVis = is3DBld ? 'visible' : 'none';
        if (curVis !== targetVis) {
          map.setLayoutProperty(bldLayerId, 'visibility', targetVis);
        }
      } catch (e) { }
    }

    // 3. Ukształtowanie terenu 3D
    const is3DMap = !!cfg.settings3D?.map3D;
    try {
      if (is3DMap) {
        map.setTerrain({ source: 'terrain-dem', exaggeration: 0.85 });
      } else {
        if (typeof map.getTerrain === 'function' && map.getTerrain()) {
          map.setTerrain(null);
        }
      }
    } catch (e) { }

    if (configModified) {
      saveStoredConfig(cfg);
    }
  }

  function set3DMap(map, enabled, resetPitch = false) {
    const isEnabled = !!enabled;
    update3DSettings({ map3D: isEnabled });

    try {
      if (isEnabled) {
        map.setTerrain({ source: 'terrain-dem', exaggeration: 0.85 });
        if (resetPitch && map.getPitch() < 15) {
          map.easeTo({ pitch: 45, duration: 600 });
        }
      } else {
        if (typeof map.getTerrain === 'function' && map.getTerrain()) {
          map.setTerrain(null);
        }
        if (resetPitch && map.getPitch() > 0) {
          map.easeTo({ pitch: 0, duration: 600 });
        }
      }
    } catch (err) {
      console.warn('Błąd zmiany trybu terenu 3D:', err);
    }
    sync3DButtonsUI();
  }

  function set3DBuildings(map, enabled) {
    const isEnabled = !!enabled;
    update3DSettings({ buildings3D: isEnabled });

    const bldLayerId = 'Budynki/Bryły 3D';
    if (map.getLayer(bldLayerId)) {
      try {
        map.setLayoutProperty(bldLayerId, 'visibility', isEnabled ? 'visible' : 'none');
      } catch (e) { }
    }
    sync3DButtonsUI();
  }

  function sync3DButtonsUI() {
    const cfg = getStoredConfig();
    const map3D = !!cfg.settings3D?.map3D;
    const bld3D = !!cfg.settings3D?.buildings3D;

    document.querySelectorAll('#btn-toggle-3d-map').forEach(btn => {
      btn.classList.toggle('active', map3D);
      btn.setAttribute('aria-pressed', map3D ? 'true' : 'false');
    });

    document.querySelectorAll('#btn-toggle-3d-buildings').forEach(btn => {
      btn.classList.toggle('active', bld3D);
      btn.setAttribute('aria-pressed', bld3D ? 'true' : 'false');
    });
  }

  function setup3DControls(map, options = {}) {
    sync3DButtonsUI();

    document.querySelectorAll('#btn-toggle-3d-map').forEach(btn => {
      btn.onclick = () => {
        const cfg = getStoredConfig();
        const nextState = !cfg.settings3D?.map3D;
        set3DMap(map, nextState, options.resetPitchOnMap3D ?? false);
      };
    });

    document.querySelectorAll('#btn-toggle-3d-buildings').forEach(btn => {
      btn.onclick = () => {
        const cfg = getStoredConfig();
        const nextState = !cfg.settings3D?.buildings3D;
        set3DBuildings(map, nextState);
      };
    });
  }

  function buildLayerTree(map, containerId = 'tree-container', options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    // Zainicjalizuj inteligentne Studio Stylizacji
    setupStyleStudio(map);

    // Panel akcji na górze drzewa warstw
    const actionBar = document.createElement('div');
    actionBar.className = 'layer-tree-action-bar';
    actionBar.style.cssText = 'padding: 2px 2px 8px 2px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px;';

    const btnOpenStudio = document.createElement('button');
    btnOpenStudio.type = 'button';
    btnOpenStudio.id = 'btn-open-style-studio';
    btnOpenStudio.innerText = 'Dostosuj kolory i styl mapy';
    btnOpenStudio.title = 'Włącz tryb edycji kolorów, obwódek i stylów obiektów na mapie';
    btnOpenStudio.style.cssText = 'width: 100%; padding: 6px 10px; font-size: 11px; font-weight: 600; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); color: #38bdf8; border-radius: 6px; cursor: pointer; transition: all 0.2s ease;';
    btnOpenStudio.onmouseover = () => { btnOpenStudio.style.background = 'rgba(56, 189, 248, 0.22)'; };
    btnOpenStudio.onmouseout = () => { btnOpenStudio.style.background = 'rgba(56, 189, 248, 0.12)'; };
    btnOpenStudio.onclick = () => {
      openStyleStudio();
    };

    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.innerText = '↺ Przywróć domyślne kolory i warstwy';
    btnReset.title = 'Resetuje wszystkie własne kolory, grubości i widoczności warstw do wartości początkowych';
    btnReset.style.cssText = 'width: 100%; padding: 5px 10px; font-size: 10.5px; font-weight: 500; background: rgba(239, 68, 68, 0.10); border: 1px solid rgba(239, 68, 68, 0.25); color: #fca5a5; border-radius: 6px; cursor: pointer; transition: all 0.2s ease;';
    btnReset.onmouseover = () => { btnReset.style.background = 'rgba(239, 68, 68, 0.20)'; };
    btnReset.onmouseout = () => { btnReset.style.background = 'rgba(239, 68, 68, 0.10)'; };
    btnReset.onclick = () => {
      if (confirm('Czy na pewno chcesz przywrócić domyślne kolory i ustawienia warstw?')) {
        if (typeof window.resetAllCustomizations === 'function') {
          window.resetAllCustomizations();
        } else {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem('nnaper_track_color');
          window.location.reload();
        }
      }
    };
    actionBar.appendChild(btnOpenStudio);
    actionBar.appendChild(btnReset);
    container.appendChild(actionBar);

    const cfg = getStoredConfig();
    const layers = map.getStyle().layers || [];
    const groups = {};

    layers.forEach(layer => {
      if (
        layer.id === 'bg' ||
        layer.id.endsWith('-outline-line') ||
        layer.id.startsWith('sat-') ||
        layer.id.startsWith('playback-sat-') ||
        layer.id.startsWith('GPS / Ślad trasy / ') ||
        layer.id.startsWith('osm-traversed-') ||
        layer.id.includes('Zaznaczone drogi') ||
        layer.id.startsWith('Budynki') ||
        (layer.id.startsWith('GPS / ') && layer.id !== 'GPS / Ślad trasy') ||
        layer.id === 'GPS'
      ) return;

      const parts = layer.id.split('/').map(p => p.trim());
      const groupName = parts.length > 1 ? parts[0] : 'Inne';
      const leafTitle = parts.length > 1 ? parts[1] : layer.id.trim();

      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push({ id: layer.id, title: leafTitle, raw: JSON.parse(JSON.stringify(layer)) });
    });

    const sortedGroupNames = Object.keys(groups).sort((a, b) => {
      const aIsGps = a.trim() === 'GPS';
      const bIsGps = b.trim() === 'GPS';
      if (aIsGps && !bIsGps) return -1;
      if (!aIsGps && bIsGps) return 1;
      return 0;
    });

    sortedGroupNames.forEach(groupName => {
      const childList = groups[groupName];
      const node = document.createElement('div');
      node.className = 'tree-node';
      node.dataset.groupName = groupName;

      const header = document.createElement('div');
      header.className = 'node-header';

      const label = document.createElement('div');
      label.className = 'node-label';

      const pCheckbox = document.createElement('input');
      pCheckbox.type = 'checkbox';

      // Ustalenie stanu kategorii
      let initialCatChecked = groupName.trim() === 'GPS' ? false : true;
      if (cfg.categories && cfg.categories[groupName] !== undefined) {
        initialCatChecked = !!cfg.categories[groupName];
      }
      pCheckbox.checked = initialCatChecked;
      pCheckbox.addEventListener('click', (e) => e.stopPropagation());

      const pTitle = document.createElement('span');
      pTitle.innerText = groupName;

      label.appendChild(pCheckbox);
      label.appendChild(pTitle);

      const isGpsGroup = groupName.trim() === 'GPS';
      const arrow = document.createElement('span');
      arrow.className = isGpsGroup ? 'arrow' : 'arrow collapsed';
      arrow.innerHTML = '&#9660;';

      header.appendChild(label);
      header.appendChild(arrow);

      const childrenBox = document.createElement('div');
      childrenBox.className = isGpsGroup ? 'node-children' : 'node-children collapsed';

      if (isGpsGroup) {
        const modeHolder = document.createElement('div');
        modeHolder.className = 'track-mode-holder';
        modeHolder.style.cssText = 'padding: 4px 0 8px 0; border-bottom: 1px dashed #334155; margin-bottom: 6px; display: flex; flex-direction: column; gap: 4px;';

        const modeLabel = document.createElement('label');
        modeLabel.htmlFor = 'select-track-mode';
        modeLabel.style.cssText = 'font-size: 10.5px; color: #94a3b8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;';
        modeLabel.innerText = 'Styl wyświetlania tras:';

        const selectMode = document.createElement('select');
        selectMode.id = 'select-track-mode';
        selectMode.className = 'sidebar-select track-mode-select';
        selectMode.style.cssText = 'cursor: pointer; font-size: 11.5px; padding: 5px 8px; background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 4px; outline: none; width: 100%; box-sizing: border-box;';

        const optRaw = document.createElement('option');
        optRaw.value = 'raw';
        optRaw.innerText = 'Surowe pozycje GPS';

        const optSnapped = document.createElement('option');
        optSnapped.value = 'snapped';
        optSnapped.innerText = 'Zsnapowane pozycje GPS';

        const optOsm = document.createElement('option');
        optOsm.value = 'osm';
        optOsm.innerText = 'Zaznaczone ścieżki OSM';

        selectMode.appendChild(optRaw);
        selectMode.appendChild(optSnapped);
        selectMode.appendChild(optOsm);

        let initialMode = localStorage.getItem('nnaper_track_mode');
        if (!initialMode || !['raw', 'snapped', 'osm'].includes(initialMode)) {
          initialMode = (localStorage.getItem('nnaper_snap_roads') === 'true') ? 'snapped' : 'raw';
        }
        selectMode.value = initialMode;

        selectMode.addEventListener('click', (e) => e.stopPropagation());
        selectMode.addEventListener('change', (e) => {
          e.stopPropagation();
          const newMode = e.target.value;
          if (typeof window.setTrackMode === 'function') {
            window.setTrackMode(newMode);
          }
        });

        modeHolder.appendChild(modeLabel);
        modeHolder.appendChild(selectMode);
        childrenBox.appendChild(modeHolder);
      }

      header.addEventListener('click', (e) => {
        if (pCheckbox && e.target === pCheckbox) return;
        childrenBox.classList.toggle('collapsed');
        arrow.classList.toggle('collapsed');
      });

      const childInputs = [];

      childList.forEach(child => {
        const saved = cfg.layers[child.id] || {};
        const leafBox = document.createElement('div');
        leafBox.className = 'leaf-container';
        leafBox.dataset.layerId = child.id;

        const leaf = document.createElement('div');
        leaf.className = 'leaf-item';

        const leftDiv = document.createElement('div');
        leftDiv.className = 'leaf-left';

        let cCheckbox = null;
        if (child.id !== 'GPS / Ślad trasy') {
          cCheckbox = document.createElement('input');
          cCheckbox.type = 'checkbox';
          cCheckbox.checked = (saved.visibility !== undefined) ? (saved.visibility === 'visible') : initialCatChecked;
          childInputs.push(cCheckbox);
          leftDiv.appendChild(cCheckbox);
        }

        const cTitle = document.createElement('span');
        cTitle.className = 'layer-title-text';
        cTitle.innerText = child.title;
        cTitle.title = child.id;
        if (cCheckbox) {
          cTitle.addEventListener('click', (e) => {
            e.stopPropagation();
            cCheckbox.checked = !cCheckbox.checked;
            cCheckbox.dispatchEvent(new Event('change'));
          });
        }
        leftDiv.appendChild(cTitle);

        leaf.appendChild(leftDiv);
        leafBox.appendChild(leaf);

        // Specjalna sekcja filtrowania czasu dla śladu GPS
        if (child.id === 'GPS / Ślad trasy') {
          if (typeof options.onRenderGps === 'function') {
            const timeSection = document.createElement('div');
            timeSection.className = 'time-filter-section';
            const timeTitle = document.createElement('span');
            timeTitle.className = 'time-filter-title';
            timeTitle.innerText = 'FILTR CZASU:';
            const timeTreeHolder = document.createElement('div');
            timeTreeHolder.innerHTML = '<em style="color:#64748b;font-size:11px;">Ładowanie dat...</em>';
            timeSection.appendChild(timeTitle);
            timeSection.appendChild(timeTreeHolder);
            leafBox.appendChild(timeSection);
            options.onRenderGps(timeTreeHolder);
          }
        }

        childrenBox.appendChild(leafBox);

        if (cCheckbox) {
          cCheckbox.addEventListener('change', () => {
            const vis = cCheckbox.checked ? 'visible' : 'none';
            if (map.getLayer(child.id)) map.setLayoutProperty(child.id, 'visibility', vis);
            if (map.getLayer(`${child.id}-outline-line`)) map.setLayoutProperty(`${child.id}-outline-line`, 'visibility', vis);
            updateLayerProperty(child.id, { visibility: vis });

            if (pCheckbox) {
              const checkedCount = childInputs.filter(i => i.checked).length;
              pCheckbox.checked = checkedCount === childInputs.length;
              pCheckbox.indeterminate = checkedCount > 0 && checkedCount < childInputs.length;
              updateCategoryVisibility(groupName, pCheckbox.checked);
            }

            if (currentStudioLayerId === child.id) {
              const studioVisChk = document.getElementById('studio-layer-vis-chk');
              if (studioVisChk) studioVisChk.checked = cCheckbox.checked;
            }
          });
        }
      });

      // Synchronizacja checkboxa nadrzędnego grupy
      if (groupName.trim() === 'GPS') {
        if (pCheckbox && typeof window.bindGpsMasterCheckbox === 'function') {
          window.bindGpsMasterCheckbox(pCheckbox);
        }
      } else if (pCheckbox && childInputs.length > 0) {
        const checkedCount = childInputs.filter(i => i.checked).length;
        pCheckbox.checked = checkedCount === childInputs.length;
        pCheckbox.indeterminate = checkedCount > 0 && checkedCount < childInputs.length;

        pCheckbox.addEventListener('change', () => {
          const isChecked = pCheckbox.checked;
          pCheckbox.indeterminate = false;
          updateCategoryVisibility(groupName, isChecked);

          childInputs.forEach((ci, idx) => {
            ci.checked = isChecked;
            const targetId = childList[idx].id;
            const vis = isChecked ? 'visible' : 'none';
            if (map.getLayer(targetId)) map.setLayoutProperty(targetId, 'visibility', vis);
            if (map.getLayer(`${targetId}-outline-line`)) map.setLayoutProperty(`${targetId}-outline-line`, 'visibility', vis);
            updateLayerProperty(targetId, { visibility: vis });
          });
        });
      }

      node.appendChild(header);
      node.appendChild(childrenBox);
      container.appendChild(node);
    });
  }

  function syncTreeUI(map, containerId = 'tree-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const cfg = getStoredConfig();

    container.querySelectorAll('.tree-node').forEach(node => {
      const gName = node.dataset.groupName;
      const pCheckbox = node.querySelector('.node-header input[type="checkbox"]');
      const leafBoxes = node.querySelectorAll('.leaf-container');
      const childCbs = [];

      leafBoxes.forEach(leafBox => {
        const layerId = leafBox.dataset.layerId;
        const saved = cfg.layers[layerId] || {};
        const cb = leafBox.querySelector('.leaf-left input[type="checkbox"]');
        if (cb) {
          if (saved.visibility !== undefined) {
            cb.checked = (saved.visibility === 'visible');
          }
          childCbs.push(cb);
        }

        const swatch = leafBox.querySelector('.layer-swatch-badge');
        if (swatch) {
          const raw = getRawLayer(map, layerId);
          swatch.style.backgroundColor = saved.color || getLayerColor(raw);
        }
      });

      if (pCheckbox && childCbs.length > 0) {
        const checkedCount = childCbs.filter(c => c.checked).length;
        pCheckbox.checked = checkedCount === childCbs.length;
        pCheckbox.indeterminate = checkedCount > 0 && checkedCount < childCbs.length;
      }
    });
  }

  /* ==========================================================================
     INTELIGENTNE STUDIO STYLIZACJI WYGLĄDU MAPY (STYLE STUDIO & PIPETTE)
     ========================================================================== */

  const CARTOGRAPHIC_PRESET_COLORS = [
    '#22c55e', '#16a34a', '#15803d', // Zielenie: Lasy, parki, rezerwaty
    '#0ea5e9', '#0284c7', '#2563eb', // Błękity: Rzeki, morza, jeziora
    '#f59e0b', '#d97706', '#ef4444', // Żółcie i czerwienie: Autostrady, ekspresówki
    '#cbd5e1', '#94a3b8', '#64748b', // Szarości: Drogi lokalne, ulice, ścieżki
    '#e2e8f0', '#475569', '#334155', // Budynki, obrysy, ciemne tła
    '#a855f7', '#ec4899', '#ffffff'  // Fiolety, róże, biel kontrastowa
  ];

  let studioMap = null;
  let currentStudioLayerId = null;
  let isPipetteActive = true;
  let isStudioInitialized = false;

  function isStyleStudioOpen() {
    const panel = document.getElementById('style-studio-panel');
    return !!(panel && panel.style.display !== 'none');
  }

  function setPipetteMode(active) {
    isPipetteActive = !!active;
    const btnPipette = document.getElementById('btn-studio-pipette');
    const indicator = document.getElementById('pipette-active-indicator');
    const hint = document.getElementById('studio-pipette-hint');

    if (btnPipette) {
      btnPipette.classList.toggle('active', isPipetteActive);
    }
    if (indicator) {
      indicator.innerText = isPipetteActive ? 'Aktywny' : 'Wyłączony';
      indicator.style.color = isPipetteActive ? '#38bdf8' : '#94a3b8';
    }
    if (hint) {
      hint.innerText = isPipetteActive
        ? 'Kliknij na mapie w dowolny las, drogę, wodę lub budynek, aby natychmiast go edytować.'
        : 'Wybierz warstwę z listy powyżej lub kliknij przycisk, aby włączyć tryb pipety na mapie.';
    }

    document.body.classList.toggle('style-studio-pipette', isPipetteActive && isStyleStudioOpen());
    if (studioMap) {
      try {
        studioMap.getCanvas().style.cursor = (isPipetteActive && isStyleStudioOpen()) ? 'crosshair' : '';
      } catch (e) { }
    }
  }

  function togglePipetteMode() {
    setPipetteMode(!isPipetteActive);
  }

  function populateLayerSelect(map) {
    const select = document.getElementById('studio-layer-select');
    if (!select || !map) return;

    const layers = map.getStyle().layers || [];
    const groups = {};

    layers.forEach(l => {
      if (
        l.id === 'bg' ||
        l.id.endsWith('-outline-line') ||
        l.id.startsWith('sat-') ||
        l.id.startsWith('playback-sat-') ||
        l.id.startsWith('GPS / Ślad trasy / ') ||
        l.id.startsWith('osm-traversed-') ||
        l.id.includes('Zaznaczone drogi') ||
        l.id.startsWith('Budynki') ||
        (l.id.startsWith('GPS / ') && l.id !== 'GPS / Ślad trasy') ||
        l.id === 'GPS'
      ) return;

      const parts = l.id.split('/').map(p => p.trim());
      const gName = parts.length > 1 ? parts[0] : 'Inne';
      const leafTitle = parts.length > 1 ? parts[1] : l.id.trim();
      if (!groups[gName]) groups[gName] = [];
      groups[gName].push({ id: l.id, title: leafTitle });
    });

    select.innerHTML = '';
    const sortedGroupNames = Object.keys(groups).sort((a, b) => {
      if (a === 'GPS') return -1;
      if (b === 'GPS') return 1;
      return a.localeCompare(b);
    });

    sortedGroupNames.forEach(gName => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = gName;
      groups[gName].forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.innerText = item.title;
        optgroup.appendChild(opt);
      });
      select.appendChild(optgroup);
    });
  }

  function highlightActivePresetChip(containerId, color) {
    const box = document.getElementById(containerId);
    if (!box) return;
    const norm = (color || '').toLowerCase();
    box.querySelectorAll('.studio-color-chip').forEach(chip => {
      const chipColor = (chip.dataset.color || '').toLowerCase();
      chip.classList.toggle('active', chipColor === norm);
    });
  }

  function renderPresetChips(containerId, onSelectColor) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = '';
    CARTOGRAPHIC_PRESET_COLORS.forEach(col => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'preset-chip studio-color-chip';
      chip.dataset.color = col;
      chip.style.backgroundColor = col;
      chip.title = `Zastosuj kolor: ${col}`;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        onSelectColor(col);
      });
      box.appendChild(chip);
    });
  }

  function updateLiveColor(col) {
    if (!studioMap || !currentStudioLayerId) return;
    const raw = getRawLayer(studioMap, currentStudioLayerId);
    if (!raw) return;
    const lType = raw.type || 'line';

    try {
      if (lType === 'line') studioMap.setPaintProperty(currentStudioLayerId, 'line-color', col);
      else if (lType === 'fill') studioMap.setPaintProperty(currentStudioLayerId, 'fill-color', col);
      else if (lType === 'circle') {
        if (currentStudioLayerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
          window.updateTrackPaintProperty('circle-color', col);
        } else {
          studioMap.setPaintProperty(currentStudioLayerId, 'circle-color', col);
        }
      }
      else if (lType === 'fill-extrusion') studioMap.setPaintProperty(currentStudioLayerId, 'fill-extrusion-color', col);
      else if (lType === 'symbol') studioMap.setPaintProperty(currentStudioLayerId, 'text-color', col);
    } catch (e) { }

    updateLayerProperty(currentStudioLayerId, { color: col });

    const safeId = (window.CSS && CSS.escape) ? CSS.escape(currentStudioLayerId) : currentStudioLayerId.replace(/["\\]/g, '\\$&');
    const swatch = document.querySelector(`.leaf-container[data-layer-id="${safeId}"] .layer-swatch-badge`);
    if (swatch) swatch.style.backgroundColor = col;

    const picker = document.getElementById('studio-main-color-picker');
    const hexInput = document.getElementById('studio-main-color-hex');
    if (picker && picker.value !== col) picker.value = col;
    if (hexInput && hexInput.value !== col.toUpperCase()) hexInput.value = col.toUpperCase();
    highlightActivePresetChip('studio-preset-chips', col);
  }

  function updateLiveOpacity(pctVal) {
    if (!studioMap || !currentStudioLayerId) return;
    const raw = getRawLayer(studioMap, currentStudioLayerId);
    if (!raw) return;
    const lType = raw.type || 'line';
    const op = Math.max(0, Math.min(1, pctVal / 100));

    try {
      if (lType === 'fill') studioMap.setPaintProperty(currentStudioLayerId, 'fill-opacity', op);
      else if (lType === 'line') studioMap.setPaintProperty(currentStudioLayerId, 'line-opacity', op);
      else if (lType === 'circle') studioMap.setPaintProperty(currentStudioLayerId, 'circle-opacity', op);
      else if (lType === 'fill-extrusion') studioMap.setPaintProperty(currentStudioLayerId, 'fill-extrusion-opacity', op);
      else if (lType === 'symbol') studioMap.setPaintProperty(currentStudioLayerId, 'text-opacity', op);
    } catch (e) { }

    updateLayerProperty(currentStudioLayerId, { opacity: op });
    const lbl = document.getElementById('studio-opacity-val');
    if (lbl) lbl.innerText = `${pctVal}%`;
  }

  function updateLiveLineWidth(val) {
    if (!studioMap || !currentStudioLayerId) return;
    const w = parseFloat(val) || 2.0;
    try {
      studioMap.setPaintProperty(currentStudioLayerId, 'line-width', w);
      const outlineId = `${currentStudioLayerId}-outline-line`;
      if (studioMap.getLayer(outlineId)) {
        studioMap.setPaintProperty(outlineId, 'line-gap-width', w);
      }
    } catch (e) { }

    updateLayerProperty(currentStudioLayerId, { lineWidth: w });
    const lbl = document.getElementById('studio-line-width-val');
    if (lbl) lbl.innerText = `${w} px`;
  }

  function updateLiveLineDash() {
    if (!studioMap || !currentStudioLayerId) return;
    const chk = document.getElementById('studio-line-dash-chk');
    const isDashed = !!(chk && chk.checked);
    const dLen = parseFloat(document.getElementById('studio-dash-len-slider')?.value) || 3;
    const dGap = parseFloat(document.getElementById('studio-dash-gap-slider')?.value) || 2;

    const subParams = document.getElementById('studio-line-dash-params');
    if (subParams) subParams.style.display = isDashed ? 'block' : 'none';

    updateLineDashArray(studioMap, currentStudioLayerId, isDashed, dLen, dGap);
    updateLayerProperty(currentStudioLayerId, { isDashed, dashLen: dLen, gapLen: dGap });

    const lVal = document.getElementById('studio-dash-len-val');
    const gVal = document.getElementById('studio-dash-gap-val');
    if (lVal) lVal.innerText = `${dLen} px`;
    if (gVal) gVal.innerText = `${dGap} px`;
  }

  function updateLiveOutline() {
    if (!studioMap || !currentStudioLayerId) return;
    const chk = document.getElementById('studio-outline-chk');
    const hasOutline = !!(chk && chk.checked);

    const wrapColor = document.getElementById('wrap-outline-color');
    const params = document.getElementById('studio-outline-params');
    if (wrapColor) wrapColor.style.display = hasOutline ? 'flex' : 'none';
    if (params) params.style.display = hasOutline ? 'block' : 'none';

    const col = document.getElementById('studio-outline-color-picker')?.value || '#334155';
    const w = hasOutline ? (parseFloat(document.getElementById('studio-outline-width-slider')?.value) || 1.5) : 0;
    const isDashed = !!document.getElementById('studio-outline-dash-chk')?.checked;
    const dLen = parseFloat(document.getElementById('studio-outline-dash-len-slider')?.value) || 3;
    const dGap = parseFloat(document.getElementById('studio-outline-dash-gap-slider')?.value) || 2;

    const outlineDashParams = document.getElementById('studio-outline-dash-params');
    if (outlineDashParams) outlineDashParams.style.display = isDashed ? 'block' : 'none';

    const outlineId = ensureOutlineLayer(studioMap, currentStudioLayerId);
    if (outlineId && studioMap.getLayer(outlineId)) {
      try {
        studioMap.setPaintProperty(outlineId, 'line-color', col);
        studioMap.setPaintProperty(outlineId, 'line-width', w);
        studioMap.setPaintProperty(outlineId, 'line-opacity', w > 0 ? 1.0 : 0.0);
        updateLineDashArray(studioMap, outlineId, isDashed, dLen, dGap);
      } catch (e) { }
    }

    updateLayerProperty(currentStudioLayerId, {
      outlineColor: col,
      outlineWidth: w,
      outlineIsDashed: isDashed,
      outlineDashLen: dLen,
      outlineGapLen: dGap
    });

    const wVal = document.getElementById('studio-outline-width-val');
    if (wVal) wVal.innerText = `${w} px`;
    const odLenVal = document.getElementById('studio-outline-dash-len-val');
    const odGapVal = document.getElementById('studio-outline-dash-gap-val');
    if (odLenVal) odLenVal.innerText = `${dLen} px`;
    if (odGapVal) odGapVal.innerText = `${dGap} px`;
  }

  function updateLiveCircle() {
    if (!studioMap || !currentStudioLayerId) return;
    const r = parseFloat(document.getElementById('studio-circle-radius-slider')?.value) || 4.5;
    const sw = parseFloat(document.getElementById('studio-circle-stroke-width-slider')?.value) || 0;
    const sc = document.getElementById('studio-circle-stroke-color-picker')?.value || '#ffffff';

    try {
      if (currentStudioLayerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
        window.updateTrackPaintProperty('circle-radius', r);
        window.updateTrackPaintProperty('circle-stroke-width', sw);
        window.updateTrackPaintProperty('circle-stroke-color', sc);
      } else {
        studioMap.setPaintProperty(currentStudioLayerId, 'circle-radius', r);
        studioMap.setPaintProperty(currentStudioLayerId, 'circle-stroke-width', sw);
        studioMap.setPaintProperty(currentStudioLayerId, 'circle-stroke-color', sc);
      }
    } catch (e) { }

    updateLayerProperty(currentStudioLayerId, { circleRadius: r, strokeWidth: sw, strokeColor: sc });

    const rVal = document.getElementById('studio-circle-radius-val');
    const swVal = document.getElementById('studio-circle-stroke-width-val');
    if (rVal) rVal.innerText = `${r} px`;
    if (swVal) swVal.innerText = `${sw} px`;
  }

  function updateLiveSymbol() {
    if (!studioMap || !currentStudioLayerId) return;
    const ts = parseFloat(document.getElementById('studio-text-size-slider')?.value) || 12;
    const hw = parseFloat(document.getElementById('studio-text-halo-slider')?.value) || 1.5;
    const hc = document.getElementById('studio-text-halo-color-picker')?.value || '#020617';

    try {
      studioMap.setLayoutProperty(currentStudioLayerId, 'text-size', ts);
      studioMap.setPaintProperty(currentStudioLayerId, 'text-halo-width', hw);
      studioMap.setPaintProperty(currentStudioLayerId, 'text-halo-color', hc);
    } catch (e) { }

    updateLayerProperty(currentStudioLayerId, { textSize: ts, haloWidth: hw, haloColor: hc });

    const tsVal = document.getElementById('studio-text-size-val');
    const hwVal = document.getElementById('studio-text-halo-val');
    if (tsVal) tsVal.innerText = `${ts} px`;
    if (hwVal) hwVal.innerText = `${hw} px`;
  }

  function loadLayerIntoStudio(layerId) {
    if (!studioMap || !layerId) return;
    const raw = getRawLayer(studioMap, layerId);
    if (!raw) return;

    currentStudioLayerId = layerId;

    const select = document.getElementById('studio-layer-select');
    if (select && select.value !== layerId) {
      select.value = layerId;
    }

    const nameEl = document.getElementById('studio-layer-display-name');
    if (nameEl) nameEl.innerText = layerId;

    const badgeEl = document.getElementById('studio-layer-type-badge');
    const lType = raw.type || 'line';
    if (badgeEl) {
      if (lType === 'fill') badgeEl.innerText = 'Obszar / Wypełnienie (Polygon)';
      else if (lType === 'line') badgeEl.innerText = 'Linia / Droga (LineString)';
      else if (lType === 'circle') badgeEl.innerText = 'Punkt (Circle)';
      else if (lType === 'fill-extrusion') badgeEl.innerText = 'Bryła 3D (Extrusion)';
      else if (lType === 'symbol') badgeEl.innerText = 'Etykieta / Tekst (Symbol)';
      else badgeEl.innerText = `Typ: ${lType}`;
    }

    const cfg = getStoredConfig();
    const saved = cfg.layers[layerId] || {};

    const visChk = document.getElementById('studio-layer-vis-chk');
    if (visChk) {
      const isVis = (saved.visibility !== undefined) ? (saved.visibility === 'visible') : true;
      visChk.checked = isVis;
    }

    const grpMainColor = document.getElementById('group-main-color');
    const grpOpacity = document.getElementById('group-opacity');
    const grpLineWidth = document.getElementById('group-line-width');
    const grpLineDash = document.getElementById('group-line-dash');
    const grpOutline = document.getElementById('group-outline');
    const grpCircle = document.getElementById('group-circle');
    const grpSymbol = document.getElementById('group-symbol');

    if (grpMainColor) grpMainColor.style.display = 'block';
    if (grpOpacity) grpOpacity.style.display = (lType === 'fill' || lType === 'line' || lType === 'fill-extrusion' || lType === 'circle') ? 'block' : 'none';
    if (grpLineWidth) grpLineWidth.style.display = (lType === 'line') ? 'block' : 'none';
    if (grpLineDash) grpLineDash.style.display = (lType === 'line') ? 'block' : 'none';
    if (grpOutline) grpOutline.style.display = (lType === 'fill' || lType === 'line') ? 'block' : 'none';
    if (grpCircle) grpCircle.style.display = (lType === 'circle') ? 'block' : 'none';
    if (grpSymbol) grpSymbol.style.display = (lType === 'symbol') ? 'block' : 'none';

    // 1. Kolor główny
    const mainColor = saved.color || getLayerColor(raw);
    const mainPicker = document.getElementById('studio-main-color-picker');
    const mainHex = document.getElementById('studio-main-color-hex');
    if (mainPicker) mainPicker.value = mainColor;
    if (mainHex) mainHex.value = mainColor.toUpperCase();
    highlightActivePresetChip('studio-preset-chips', mainColor);

    // 2. Przezroczystość
    const opSlider = document.getElementById('studio-opacity-slider');
    const opVal = document.getElementById('studio-opacity-val');
    let currentOpacity = 100;
    if (saved.opacity !== undefined) {
      currentOpacity = Math.round(parseFloat(saved.opacity) * 100);
    } else {
      const paintOp = raw.paint ? (raw.paint[`${lType}-opacity`] ?? 1) : 1;
      currentOpacity = Math.round(paintOp * 100);
    }
    if (opSlider) opSlider.value = currentOpacity;
    if (opVal) opVal.innerText = `${currentOpacity}%`;

    // 3. Grubość i kreskowanie linii
    if (lType === 'line') {
      const lwSlider = document.getElementById('studio-line-width-slider');
      const lwVal = document.getElementById('studio-line-width-val');
      const currentWidth = (saved.lineWidth !== undefined) ? parseFloat(saved.lineWidth) : ((raw.paint && typeof raw.paint['line-width'] === 'number') ? raw.paint['line-width'] : 2.0);
      if (lwSlider) lwSlider.value = currentWidth;
      if (lwVal) lwVal.innerText = `${currentWidth} px`;

      const dashChk = document.getElementById('studio-line-dash-chk');
      const dashParams = document.getElementById('studio-line-dash-params');
      const dashLenSlider = document.getElementById('studio-dash-len-slider');
      const dashLenVal = document.getElementById('studio-dash-len-val');
      const dashGapSlider = document.getElementById('studio-dash-gap-slider');
      const dashGapVal = document.getElementById('studio-dash-gap-val');

      const isDashed = !!saved.isDashed;
      if (dashChk) dashChk.checked = isDashed;
      if (dashParams) dashParams.style.display = isDashed ? 'block' : 'none';
      const dLen = saved.dashLen || 3;
      const dGap = saved.gapLen || 2;
      if (dashLenSlider) dashLenSlider.value = dLen;
      if (dashLenVal) dashLenVal.innerText = `${dLen} px`;
      if (dashGapSlider) dashGapSlider.value = dGap;
      if (dashGapVal) dashGapVal.innerText = `${dGap} px`;
    }

    // 4. Obwódka / Outline
    if (lType === 'fill' || lType === 'line') {
      const outlineChk = document.getElementById('studio-outline-chk');
      const wrapColor = document.getElementById('wrap-outline-color');
      const outlinePicker = document.getElementById('studio-outline-color-picker');
      const outlineHex = document.getElementById('studio-outline-color-hex');
      const outlineParams = document.getElementById('studio-outline-params');
      const outWidthSlider = document.getElementById('studio-outline-width-slider');
      const outWidthVal = document.getElementById('studio-outline-width-val');

      const hasOutline = (saved.outlineWidth !== undefined && parseFloat(saved.outlineWidth) > 0);
      if (outlineChk) outlineChk.checked = hasOutline;
      if (wrapColor) wrapColor.style.display = hasOutline ? 'flex' : 'none';
      if (outlineParams) outlineParams.style.display = hasOutline ? 'block' : 'none';

      const outlineColor = saved.outlineColor || '#334155';
      if (outlinePicker) outlinePicker.value = outlineColor;
      if (outlineHex) outlineHex.value = outlineColor.toUpperCase();
      highlightActivePresetChip('studio-outline-preset-chips', outlineColor);

      const outWidth = (saved.outlineWidth !== undefined) ? parseFloat(saved.outlineWidth) : 1.5;
      if (outWidthSlider) outWidthSlider.value = outWidth;
      if (outWidthVal) outWidthVal.innerText = `${outWidth} px`;

      const outDashChk = document.getElementById('studio-outline-dash-chk');
      const outDashParams = document.getElementById('studio-outline-dash-params');
      const outDashLenSlider = document.getElementById('studio-outline-dash-len-slider');
      const outDashLenVal = document.getElementById('studio-outline-dash-len-val');
      const outDashGapSlider = document.getElementById('studio-outline-dash-gap-slider');
      const outDashGapVal = document.getElementById('studio-outline-dash-gap-val');

      const isOutDashed = !!saved.outlineIsDashed;
      if (outDashChk) outDashChk.checked = isOutDashed;
      if (outDashParams) outDashParams.style.display = isOutDashed ? 'block' : 'none';
      const odLen = saved.outlineDashLen || 3;
      const odGap = saved.outlineGapLen || 2;
      if (outDashLenSlider) outDashLenSlider.value = odLen;
      if (outDashLenVal) outDashLenVal.innerText = `${odLen} px`;
      if (outDashGapSlider) outDashGapSlider.value = odGap;
      if (outDashGapVal) outDashGapVal.innerText = `${odGap} px`;
    }

    // 5. Punkty (circle)
    if (lType === 'circle') {
      const crSlider = document.getElementById('studio-circle-radius-slider');
      const crVal = document.getElementById('studio-circle-radius-val');
      const swSlider = document.getElementById('studio-circle-stroke-width-slider');
      const swVal = document.getElementById('studio-circle-stroke-width-val');
      const scPicker = document.getElementById('studio-circle-stroke-color-picker');

      const cRad = (saved.circleRadius !== undefined) ? parseFloat(saved.circleRadius) : ((raw.paint && typeof raw.paint['circle-radius'] === 'number') ? raw.paint['circle-radius'] : 4.5);
      if (crSlider) crSlider.value = cRad;
      if (crVal) crVal.innerText = `${cRad} px`;

      const sWidth = (saved.strokeWidth !== undefined) ? parseFloat(saved.strokeWidth) : 0;
      if (swSlider) swSlider.value = sWidth;
      if (swVal) swVal.innerText = `${sWidth} px`;

      const sColor = saved.strokeColor || getLayerStrokeColor(raw);
      if (scPicker) scPicker.value = sColor;
    }

    // 6. Etykiety (symbol)
    if (lType === 'symbol') {
      const tsSlider = document.getElementById('studio-text-size-slider');
      const tsVal = document.getElementById('studio-text-size-val');
      const hwSlider = document.getElementById('studio-text-halo-slider');
      const hwVal = document.getElementById('studio-text-halo-val');
      const hcPicker = document.getElementById('studio-text-halo-color-picker');

      const tSize = (saved.textSize !== undefined) ? parseFloat(saved.textSize) : ((raw.layout && raw.layout['text-size']) ? parseFloat(raw.layout['text-size']) : 12);
      if (tsSlider) tsSlider.value = tSize;
      if (tsVal) tsVal.innerText = `${tSize} px`;

      const hWidth = (saved.haloWidth !== undefined) ? parseFloat(saved.haloWidth) : ((raw.paint && raw.paint['text-halo-width']) ? parseFloat(raw.paint['text-halo-width']) : 1.5);
      if (hwSlider) hwSlider.value = hWidth;
      if (hwVal) hwVal.innerText = `${hWidth} px`;

      const hColor = saved.haloColor || (raw.paint && raw.paint['text-halo-color']) || '#020617';
      if (hcPicker) hcPicker.value = hColor;
    }
  }

  function selectLayerInStudio(layerId, fromMapClick = false) {
    if (!layerId) return;
    loadLayerIntoStudio(layerId);

    if (fromMapClick) {
      const hint = document.getElementById('studio-pipette-hint');
      if (hint) {
        hint.innerHTML = `🎯 Wskazano z mapy: <strong style="color:#38bdf8;">${layerId}</strong>. Dopasuj styl poniżej.`;
      }
      const metaCard = document.querySelector('.studio-layer-meta-card');
      if (metaCard) {
        metaCard.style.borderColor = '#38bdf8';
        metaCard.style.boxShadow = '0 0 12px rgba(56, 189, 248, 0.4)';
        setTimeout(() => {
          metaCard.style.borderColor = '';
          metaCard.style.boxShadow = '';
        }, 700);
      }
    }
  }

  function openStyleStudio(layerId) {
    const tree = document.getElementById('tree-container');
    const panel = document.getElementById('style-studio-panel');
    const menuEl = document.getElementById('menu');
    if (!panel) return;

    if (menuEl && menuEl.classList.contains('collapsed')) {
      menuEl.classList.remove('collapsed');
    }
    if (tree) tree.style.display = 'none';
    panel.style.display = 'flex';

    if (studioMap) {
      populateLayerSelect(studioMap);
    }

    const select = document.getElementById('studio-layer-select');
    let targetLayer = layerId;
    if (!targetLayer) {
      if (currentStudioLayerId) targetLayer = currentStudioLayerId;
      else if (select && select.options.length > 0) targetLayer = select.options[0].value;
      else targetLayer = 'Przyroda/Lasy';
    }

    selectLayerInStudio(targetLayer, false);
    setPipetteMode(true);
  }

  function closeStyleStudio() {
    const tree = document.getElementById('tree-container');
    const panel = document.getElementById('style-studio-panel');
    if (panel) panel.style.display = 'none';
    if (tree) tree.style.display = 'block';
    setPipetteMode(false);
  }

  function resetCurrentLayer() {
    if (!currentStudioLayerId || !studioMap) return;
    const layerId = currentStudioLayerId;
    const raw = getRawLayer(studioMap, layerId);
    if (!raw) return;

    if (!confirm(`Czy na pewno chcesz przywrócić domyślny fabryczny styl dla warstwy:\n"${layerId}"?`)) {
      return;
    }

    const cfg = getStoredConfig();
    if (cfg.layers && cfg.layers[layerId]) {
      delete cfg.layers[layerId];
      saveStoredConfig(cfg);
      notifyConfigChanged();
    }

    const lType = raw.type || 'line';
    const defColor = getLayerColor(raw);
    const outlineId = `${layerId}-outline-line`;

    try {
      if (lType === 'fill') {
        studioMap.setPaintProperty(layerId, 'fill-color', defColor);
        const defOp = (raw.paint && raw.paint['fill-opacity'] !== undefined) ? raw.paint['fill-opacity'] : 1.0;
        studioMap.setPaintProperty(layerId, 'fill-opacity', defOp);
      } else if (lType === 'line') {
        studioMap.setPaintProperty(layerId, 'line-color', defColor);
        const defWidth = (raw.paint && typeof raw.paint['line-width'] === 'number') ? raw.paint['line-width'] : 1.5;
        studioMap.setPaintProperty(layerId, 'line-width', defWidth);
        const defOp = (raw.paint && raw.paint['line-opacity'] !== undefined) ? raw.paint['line-opacity'] : 1.0;
        studioMap.setPaintProperty(layerId, 'line-opacity', defOp);
        updateLineDashArray(studioMap, layerId, false, 3, 2);
      } else if (lType === 'circle') {
        studioMap.setPaintProperty(layerId, 'circle-color', defColor);
        const defRad = (raw.paint && typeof raw.paint['circle-radius'] === 'number') ? raw.paint['circle-radius'] : 4.5;
        studioMap.setPaintProperty(layerId, 'circle-radius', defRad);
        studioMap.setPaintProperty(layerId, 'circle-stroke-width', 0);
      } else if (lType === 'fill-extrusion') {
        studioMap.setPaintProperty(layerId, 'fill-extrusion-color', defColor);
      } else if (lType === 'symbol') {
        studioMap.setPaintProperty(layerId, 'text-color', defColor);
        const defSize = (raw.layout && raw.layout['text-size']) ? parseFloat(raw.layout['text-size']) : 12;
        studioMap.setLayoutProperty(layerId, 'text-size', defSize);
        studioMap.setPaintProperty(layerId, 'text-halo-width', (raw.paint && raw.paint['text-halo-width']) || 1.5);
      }

      if (studioMap.getLayer(outlineId)) {
        studioMap.setPaintProperty(outlineId, 'line-width', 0.0);
        studioMap.setPaintProperty(outlineId, 'line-opacity', 0.0);
      }
    } catch (e) {
      console.warn('Błąd przywracania fabrycznego stylu:', e);
    }

    loadLayerIntoStudio(layerId);
    syncTreeUI(studioMap);

    const hint = document.getElementById('studio-pipette-hint');
    if (hint) {
      hint.innerHTML = `↺ Przywrócono domyślny styl dla <strong style="color:#10b981;">${layerId}</strong>.`;
    }
  }

  function handleMapClickPipette(e) {
    if (!isStyleStudioOpen()) return;
    if (!isPipetteActive) return;

    const bbox = [
      [e.point.x - 5, e.point.y - 5],
      [e.point.x + 5, e.point.y + 5]
    ];
    const features = studioMap.queryRenderedFeatures(bbox);
    if (!features || features.length === 0) return;

    for (const f of features) {
      const lid = f.layer && f.layer.id;
      if (!lid) continue;
      if (
        lid === 'bg' ||
        lid.endsWith('-outline-line') ||
        lid.startsWith('sat-') ||
        lid.startsWith('playback-sat-') ||
        lid.startsWith('GPS / Ślad trasy / ') ||
        lid.startsWith('osm-traversed-') ||
        lid.includes('Zaznaczone drogi') ||
        lid.startsWith('Budynki') ||
        (lid.startsWith('GPS / ') && lid !== 'GPS / Ślad trasy') ||
        lid === 'GPS'
      ) {
        continue;
      }
      selectLayerInStudio(lid, true);
      break;
    }
  }

  function setupStyleStudio(map) {
    studioMap = map;

    if (!window._styleStudioLauncherAttached) {
      window._styleStudioLauncherAttached = true;
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('#btn-open-style-studio');
        if (btn) {
          e.preventDefault();
          e.stopPropagation();
          openStyleStudio();
        }
      });
    }

    if (isStudioInitialized) {
      return;
    }
    isStudioInitialized = true;

    map.on('click', handleMapClickPipette);

    map.on('mousemove', () => {
      if (isStyleStudioOpen() && isPipetteActive) {
        map.getCanvas().style.cursor = 'crosshair';
      }
    });

    const btnClose = document.getElementById('btn-close-style-studio');
    if (btnClose) btnClose.addEventListener('click', closeStyleStudio);

    const btnDone = document.getElementById('btn-studio-done');
    if (btnDone) btnDone.addEventListener('click', closeStyleStudio);

    const btnReset = document.getElementById('btn-studio-reset-layer');
    if (btnReset) btnReset.addEventListener('click', resetCurrentLayer);

    const btnPipette = document.getElementById('btn-studio-pipette');
    if (btnPipette) btnPipette.addEventListener('click', togglePipetteMode);

    const layerSelect = document.getElementById('studio-layer-select');
    if (layerSelect) {
      layerSelect.addEventListener('change', (e) => {
        selectLayerInStudio(e.target.value, false);
      });
    }

    const visChk = document.getElementById('studio-layer-vis-chk');
    if (visChk) {
      visChk.addEventListener('change', () => {
        if (!currentStudioLayerId || !studioMap) return;
        const vis = visChk.checked ? 'visible' : 'none';
        if (studioMap.getLayer(currentStudioLayerId)) studioMap.setLayoutProperty(currentStudioLayerId, 'visibility', vis);
        if (studioMap.getLayer(`${currentStudioLayerId}-outline-line`)) studioMap.setLayoutProperty(`${currentStudioLayerId}-outline-line`, 'visibility', vis);
        updateLayerProperty(currentStudioLayerId, { visibility: vis });

        const safeId = (window.CSS && CSS.escape) ? CSS.escape(currentStudioLayerId) : currentStudioLayerId.replace(/["\\]/g, '\\$&');
        const treeCb = document.querySelector(`.leaf-container[data-layer-id="${safeId}"] .leaf-left input[type="checkbox"]`);
        if (treeCb) {
          treeCb.checked = visChk.checked;
          treeCb.dispatchEvent(new Event('change'));
        }
      });
    }

    renderPresetChips('studio-preset-chips', (col) => updateLiveColor(col));
    renderPresetChips('studio-outline-preset-chips', (col) => {
      const picker = document.getElementById('studio-outline-color-picker');
      const hex = document.getElementById('studio-outline-color-hex');
      if (picker) picker.value = col;
      if (hex) hex.value = col.toUpperCase();
      highlightActivePresetChip('studio-outline-preset-chips', col);
      updateLiveOutline();
    });

    const mainPicker = document.getElementById('studio-main-color-picker');
    if (mainPicker) {
      mainPicker.addEventListener('input', (e) => updateLiveColor(e.target.value));
    }
    const mainHex = document.getElementById('studio-main-color-hex');
    if (mainHex) {
      mainHex.addEventListener('input', (e) => {
        let val = e.target.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
          updateLiveColor(val);
        }
      });
    }

    const opSlider = document.getElementById('studio-opacity-slider');
    if (opSlider) {
      opSlider.addEventListener('input', (e) => updateLiveOpacity(parseInt(e.target.value, 10)));
    }

    const lwSlider = document.getElementById('studio-line-width-slider');
    if (lwSlider) {
      lwSlider.addEventListener('input', (e) => updateLiveLineWidth(e.target.value));
    }
    const dashChk = document.getElementById('studio-line-dash-chk');
    if (dashChk) dashChk.addEventListener('change', updateLiveLineDash);
    const dashLenSlider = document.getElementById('studio-dash-len-slider');
    if (dashLenSlider) dashLenSlider.addEventListener('input', updateLiveLineDash);
    const dashGapSlider = document.getElementById('studio-dash-gap-slider');
    if (dashGapSlider) dashGapSlider.addEventListener('input', updateLiveLineDash);

    const outChk = document.getElementById('studio-outline-chk');
    if (outChk) outChk.addEventListener('change', updateLiveOutline);
    const outPicker = document.getElementById('studio-outline-color-picker');
    if (outPicker) {
      outPicker.addEventListener('input', (e) => {
        const hex = document.getElementById('studio-outline-color-hex');
        if (hex) hex.value = e.target.value.toUpperCase();
        highlightActivePresetChip('studio-outline-preset-chips', e.target.value);
        updateLiveOutline();
      });
    }
    const outHex = document.getElementById('studio-outline-color-hex');
    if (outHex) {
      outHex.addEventListener('input', (e) => {
        let val = e.target.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
          const picker = document.getElementById('studio-outline-color-picker');
          if (picker) picker.value = val;
          highlightActivePresetChip('studio-outline-preset-chips', val);
          updateLiveOutline();
        }
      });
    }
    const outWidthSlider = document.getElementById('studio-outline-width-slider');
    if (outWidthSlider) outWidthSlider.addEventListener('input', updateLiveOutline);
    const outDashChk = document.getElementById('studio-outline-dash-chk');
    if (outDashChk) outDashChk.addEventListener('change', updateLiveOutline);
    const outDashLenSlider = document.getElementById('studio-outline-dash-len-slider');
    if (outDashLenSlider) outDashLenSlider.addEventListener('input', updateLiveOutline);
    const outDashGapSlider = document.getElementById('studio-outline-dash-gap-slider');
    if (outDashGapSlider) outDashGapSlider.addEventListener('input', updateLiveOutline);

    const crSlider = document.getElementById('studio-circle-radius-slider');
    if (crSlider) crSlider.addEventListener('input', updateLiveCircle);
    const swSlider = document.getElementById('studio-circle-stroke-width-slider');
    if (swSlider) swSlider.addEventListener('input', updateLiveCircle);
    const scPicker = document.getElementById('studio-circle-stroke-color-picker');
    if (scPicker) scPicker.addEventListener('input', updateLiveCircle);

    const tsSlider = document.getElementById('studio-text-size-slider');
    if (tsSlider) tsSlider.addEventListener('input', updateLiveSymbol);
    const hwSlider = document.getElementById('studio-text-halo-slider');
    if (hwSlider) hwSlider.addEventListener('input', updateLiveSymbol);
    const hcPicker = document.getElementById('studio-text-halo-color-picker');
    if (hcPicker) hcPicker.addEventListener('input', updateLiveSymbol);
  }

  function setupDrawer(menuId = 'menu', toggleBtnId = 'btn-toggle-menu') {
    const menuEl = document.getElementById(menuId);
    const btnToggleMenu = document.getElementById(toggleBtnId);
    if (!menuEl || !btnToggleMenu) return;

    function collapseMenu() {
      menuEl.classList.add('collapsed');
      btnToggleMenu.setAttribute('title', 'Rozwiń wybierak warstw');
      btnToggleMenu.setAttribute('aria-label', 'Rozwiń wybierak warstw');
    }

    function expandMenu() {
      menuEl.classList.remove('collapsed');
      btnToggleMenu.setAttribute('title', 'Zwiń wybierak warstw');
      btnToggleMenu.setAttribute('aria-label', 'Zwiń wybierak warstw');
    }

    function toggleMenu() {
      if (menuEl.classList.contains('collapsed')) {
        expandMenu();
      } else {
        collapseMenu();
      }
    }

    btnToggleMenu.onclick = toggleMenu;
  }

  function setupSync(map, containerId = 'tree-container') {
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        applyCustomizationsToMap(map);
        syncTreeUI(map, containerId);
        sync3DButtonsUI();
      }
    });

    window.addEventListener('nnaper_layer_customizations_changed', () => {
      sync3DButtonsUI();
    });
  }

  window.LayerManager = {
    getStoredConfig,
    saveStoredConfig,
    updateLayerProperty,
    updateCategoryVisibility,
    update3DSettings,
    applyCustomizationsToMap,
    buildLayerTree,
    syncTreeUI,
    setupDrawer,
    setup3DControls,
    setupSync,
    set3DMap,
    set3DBuildings,
    sync3DButtonsUI,
    ensureOutlineLayer,
    setupStyleStudio,
    openStyleStudio,
    closeStyleStudio,
    isStyleStudioOpen,
    selectLayerInStudio,
    setPipetteMode,
    resetCurrentLayer
  };

})(window);
