/**
 * LayerManager - Zsynchronizowany moduł zarządzania warstwami, stylami i trybem 3D dla NNAPER
 * Obsługuje:
 * - Persystencję w localStorage (współdzielona konfiguracja między tile_map.html a playback.html)
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
    } catch (e) {}

    if (window.MAP_STYLE && Array.isArray(window.MAP_STYLE.layers)) {
      return window.MAP_STYLE.layers.find(l => l.id === layerId) || null;
    }
    return null;
  }

  function ensureOutlineLayer(map, layerId) {
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
    } catch (e) {}
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
    const cfg = getStoredConfig();

    // 1. Zastosowanie styli poszczególnych warstw
    Object.keys(cfg.layers || {}).forEach(layerId => {
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
          } catch (e) {}
        }
      }

      // Grubość linii (dla line)
      if (saved.lineWidth !== undefined && layerExists) {
        try {
          map.setPaintProperty(layerId, 'line-width', parseFloat(saved.lineWidth));
          if (map.getLayer(outlineId)) {
            map.setPaintProperty(outlineId, 'line-gap-width', parseFloat(saved.lineWidth));
          }
        } catch (e) {}
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
          } catch (e) {}
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
        } catch (e) {}
      }
      if (saved.strokeColor && layerExists) {
        try {
          if (layerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
            window.updateTrackPaintProperty('circle-stroke-color', saved.strokeColor);
          } else {
            map.setPaintProperty(layerId, 'circle-stroke-color', saved.strokeColor);
          }
        } catch (e) {}
      }
      if (saved.strokeWidth !== undefined && layerExists) {
        try {
          const sw = parseFloat(saved.strokeWidth);
          if (layerId === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
            window.updateTrackPaintProperty('circle-stroke-width', sw);
          } else {
            map.setPaintProperty(layerId, 'circle-stroke-width', sw);
          }
        } catch (e) {}
      }

      // Tekst (text-size)
      if (saved.textSize !== undefined && layerExists) {
        try {
          map.setLayoutProperty(layerId, 'text-size', parseFloat(saved.textSize));
        } catch (e) {}
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
      } catch (e) {}
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
    } catch (e) {}
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
      } catch (e) {}
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
        layer.id.startsWith('Budynki')
      ) return;

      const parts = layer.id.split('/').map(p => p.trim());
      const groupName = parts.length > 1 ? parts[0] : 'Inne';
      const leafTitle = parts.length > 1 ? parts[1] : layer.id.trim();

      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push({ id: layer.id, title: leafTitle, raw: JSON.parse(JSON.stringify(layer)) });
    });

    Object.keys(groups).forEach(groupName => {
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

      const arrow = document.createElement('span');
      arrow.className = 'arrow collapsed';
      arrow.innerHTML = '&#9660;';

      header.appendChild(label);
      header.appendChild(arrow);

      const childrenBox = document.createElement('div');
      childrenBox.className = 'node-children collapsed';

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

        const initialColor = saved.color || getLayerColor(child.raw);
        const mainColorPicker = document.createElement('input');
        mainColorPicker.type = 'color';
        mainColorPicker.className = 'color-picker';
        mainColorPicker.value = initialColor;
        mainColorPicker.title = 'Kolor obiektu';

        mainColorPicker.addEventListener('input', (e) => {
          const col = e.target.value;
          if (child.raw.type === 'line') map.setPaintProperty(child.id, 'line-color', col);
          else if (child.raw.type === 'fill') map.setPaintProperty(child.id, 'fill-color', col);
          else if (child.raw.type === 'circle') {
            if (child.id === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
              window.updateTrackPaintProperty('circle-color', col);
            } else {
              map.setPaintProperty(child.id, 'circle-color', col);
            }
          }
          else if (child.raw.type === 'fill-extrusion') map.setPaintProperty(child.id, 'fill-extrusion-color', col);
          else if (child.raw.type === 'symbol') map.setPaintProperty(child.id, 'text-color', col);

          updateLayerProperty(child.id, { color: col });
        });

        const cTitle = document.createElement('span');
        cTitle.innerText = child.title;

        leftDiv.appendChild(mainColorPicker);
        leftDiv.appendChild(cTitle);
        leaf.appendChild(leftDiv);
        leafBox.appendChild(leaf);

        const ctrlDiv = document.createElement('div');
        ctrlDiv.className = 'leaf-controls';

        // 1. Linie
        if (child.raw.type === 'line') {
          const lineOutlineId = ensureOutlineLayer(map, child.id) || `${child.id}-outline-line`;

          const row = document.createElement('div');
          row.className = 'control-row';
          const sizeLabel = document.createElement('span'); sizeLabel.innerText = 'Grubość:';
          const sizeInput = document.createElement('input');
          sizeInput.type = 'range'; sizeInput.min = '0.5'; sizeInput.max = '15'; sizeInput.step = '0.5';
          sizeInput.value = (saved.lineWidth !== undefined) ? String(saved.lineWidth) : ((child.raw.paint && child.raw.paint['line-width']) ? String(child.raw.paint['line-width']) : '2.0');

          sizeInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            map.setPaintProperty(child.id, 'line-width', val);
            if (map.getLayer(lineOutlineId)) map.setPaintProperty(lineOutlineId, 'line-gap-width', val);
            updateLayerProperty(child.id, { lineWidth: val });
          });
          row.appendChild(sizeLabel); row.appendChild(sizeInput);
          ctrlDiv.appendChild(row);

          ctrlDiv.appendChild(createDashControls(
            map, child.id,
            saved.isDashed || false,
            saved.dashLen,
            saved.gapLen,
            (isDashed, dashLen, gapLen) => updateLayerProperty(child.id, { isDashed, dashLen, gapLen })
          ));

          const rowOut = document.createElement('div');
          rowOut.className = 'control-row';
          const outLabel = document.createElement('span'); outLabel.innerText = 'Obwódka:';
          const outColor = document.createElement('input'); outColor.type = 'color'; outColor.className = 'color-picker';
          outColor.value = saved.outlineColor || initialColor;
          outColor.addEventListener('input', (e) => {
            const col = e.target.value;
            ensureOutlineLayer(map, child.id);
            if (map.getLayer(lineOutlineId)) map.setPaintProperty(lineOutlineId, 'line-color', col);
            updateLayerProperty(child.id, { outlineColor: col });
          });

          const outWidth = document.createElement('input'); outWidth.type = 'range'; outWidth.min = '0'; outWidth.max = '6'; outWidth.step = '0.5';
          outWidth.value = (saved.outlineWidth !== undefined) ? String(saved.outlineWidth) : '0';
          outWidth.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            ensureOutlineLayer(map, child.id);
            if (map.getLayer(lineOutlineId)) {
              map.setPaintProperty(lineOutlineId, 'line-width', val);
              map.setPaintProperty(lineOutlineId, 'line-opacity', val > 0 ? 1.0 : 0.0);
            }
            updateLayerProperty(child.id, { outlineWidth: val });
          });
          rowOut.appendChild(outLabel); rowOut.appendChild(outColor); rowOut.appendChild(outWidth);
          ctrlDiv.appendChild(rowOut);

          ctrlDiv.appendChild(createDashControls(
            map, lineOutlineId,
            saved.outlineIsDashed || false,
            saved.outlineDashLen,
            saved.outlineGapLen,
            (outlineIsDashed, outlineDashLen, outlineGapLen) => {
              ensureOutlineLayer(map, child.id);
              updateLayerProperty(child.id, { outlineIsDashed, outlineDashLen, outlineGapLen });
            }
          ));
        }

        // 2. Punkty (circle)
        if (child.raw.type === 'circle') {
          const rowSize = document.createElement('div');
          rowSize.className = 'control-row';
          const sizeLabel = document.createElement('span'); sizeLabel.innerText = 'Rozmiar:';
          const sizeInput = document.createElement('input');
          sizeInput.type = 'range'; sizeInput.min = '1'; sizeInput.max = '20'; sizeInput.step = '0.5';
          sizeInput.value = (saved.circleRadius !== undefined) ? String(saved.circleRadius) : ((child.raw.paint && typeof child.raw.paint['circle-radius'] === 'number') ? String(child.raw.paint['circle-radius']) : '4.5');

          sizeInput.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            if (child.id === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
              window.updateTrackPaintProperty('circle-radius', value);
            } else {
              map.setPaintProperty(child.id, 'circle-radius', value);
            }
            updateLayerProperty(child.id, { circleRadius: value });
          });
          rowSize.appendChild(sizeLabel); rowSize.appendChild(sizeInput);
          ctrlDiv.appendChild(rowSize);

          const rowStroke = document.createElement('div');
          rowStroke.className = 'control-row';
          const strokeLabel = document.createElement('span'); strokeLabel.innerText = 'Obwódka:';
          const strokeColorPicker = document.createElement('input'); strokeColorPicker.type = 'color'; strokeColorPicker.className = 'color-picker';
          strokeColorPicker.value = saved.strokeColor || getLayerStrokeColor(child.raw);
          strokeColorPicker.addEventListener('input', (e) => {
            const col = e.target.value;
            if (child.id === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
              window.updateTrackPaintProperty('circle-stroke-color', col);
            } else {
              map.setPaintProperty(child.id, 'circle-stroke-color', col);
            }
            updateLayerProperty(child.id, { strokeColor: col });
          });

          const strokeWidthInput = document.createElement('input'); strokeWidthInput.type = 'range'; strokeWidthInput.min = '0'; strokeWidthInput.max = '8'; strokeWidthInput.step = '0.5';
          strokeWidthInput.value = (saved.strokeWidth !== undefined) ? String(saved.strokeWidth) : '0';
          strokeWidthInput.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            if (child.id === 'GPS / Ślad trasy' && typeof window.updateTrackPaintProperty === 'function') {
              window.updateTrackPaintProperty('circle-stroke-width', value);
            } else {
              map.setPaintProperty(child.id, 'circle-stroke-width', value);
            }
            updateLayerProperty(child.id, { strokeWidth: value });
          });
          rowStroke.appendChild(strokeLabel); rowStroke.appendChild(strokeColorPicker); rowStroke.appendChild(strokeWidthInput);
          ctrlDiv.appendChild(rowStroke);

          if (child.id === 'GPS / Ślad trasy' && typeof options.onRenderGps === 'function') {
            const timeSection = document.createElement('div');
            timeSection.className = 'time-filter-section';
            const timeTitle = document.createElement('span');
            timeTitle.className = 'time-filter-title';
            timeTitle.innerText = 'FILTR CZASU:';
            const timeTreeHolder = document.createElement('div');
            timeTreeHolder.innerHTML = '<em style="color:#64748b;font-size:11px;">Ładowanie dat...</em>';
            timeSection.appendChild(timeTitle);
            timeSection.appendChild(timeTreeHolder);
            ctrlDiv.appendChild(timeSection);
            options.onRenderGps(timeTreeHolder);
          }
        }

        // 3. Obszary (fill)
        if (child.raw.type === 'fill') {
          const outlineLayerId = ensureOutlineLayer(map, child.id) || `${child.id}-outline-line`;

          const row = document.createElement('div');
          row.className = 'control-row';
          const outlineLabel = document.createElement('span'); outlineLabel.innerText = 'Obwódka:';
          const outlineColor = document.createElement('input'); outlineColor.type = 'color'; outlineColor.className = 'color-picker';
          outlineColor.value = saved.outlineColor || initialColor;
          outlineColor.addEventListener('input', (e) => {
            const col = e.target.value;
            ensureOutlineLayer(map, child.id);
            if (map.getLayer(outlineLayerId)) map.setPaintProperty(outlineLayerId, 'line-color', col);
            updateLayerProperty(child.id, { outlineColor: col });
          });

          const outlineWidth = document.createElement('input'); outlineWidth.type = 'range'; outlineWidth.min = '0'; outlineWidth.max = '8'; outlineWidth.step = '0.5';
          outlineWidth.value = (saved.outlineWidth !== undefined) ? String(saved.outlineWidth) : '0';
          outlineWidth.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            ensureOutlineLayer(map, child.id);
            if (map.getLayer(outlineLayerId)) {
              map.setPaintProperty(outlineLayerId, 'line-width', val);
              map.setPaintProperty(outlineLayerId, 'line-opacity', val > 0 ? 1.0 : 0.0);
            }
            updateLayerProperty(child.id, { outlineWidth: val });
          });
          row.appendChild(outlineLabel); row.appendChild(outlineColor); row.appendChild(outlineWidth);
          ctrlDiv.appendChild(row);

          ctrlDiv.appendChild(createDashControls(
            map, outlineLayerId,
            saved.outlineIsDashed || false,
            saved.outlineDashLen,
            saved.outlineGapLen,
            (outlineIsDashed, outlineDashLen, outlineGapLen) => {
              ensureOutlineLayer(map, child.id);
              updateLayerProperty(child.id, { outlineIsDashed, outlineDashLen, outlineGapLen });
            }
          ));
        }

        // 4. Etykiety (symbol)
        if (child.raw.type === 'symbol') {
          const rowSize = document.createElement('div');
          rowSize.className = 'control-row';
          const sizeLabel = document.createElement('span'); sizeLabel.innerText = 'Wielkość:';
          const textSizeInput = document.createElement('input');
          textSizeInput.type = 'range'; textSizeInput.min = '8'; textSizeInput.max = '28'; textSizeInput.step = '1';
          textSizeInput.value = (saved.textSize !== undefined) ? String(saved.textSize) : ((child.raw.layout && child.raw.layout['text-size']) ? String(child.raw.layout['text-size']) : '12');

          textSizeInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            map.setLayoutProperty(child.id, 'text-size', val);
            updateLayerProperty(child.id, { textSize: val });
          });
          rowSize.appendChild(sizeLabel); rowSize.appendChild(textSizeInput);
          ctrlDiv.appendChild(rowSize);
        }

        leafBox.appendChild(ctrlDiv);
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
          });
        }
      });

      // Synchronizacja checkboxa nadrzędnego grupy
      if (pCheckbox && childInputs.length > 0) {
        const checkedCount = childInputs.filter(i => i.checked).length;
        pCheckbox.checked = checkedCount === childInputs.length;
        pCheckbox.indeterminate = checkedCount > 0 && checkedCount < childInputs.length;

        if (groupName.trim() === 'GPS') {
          if (typeof window.bindGpsMasterCheckbox === 'function') {
            window.bindGpsMasterCheckbox(pCheckbox);
          }
        } else {
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

        const colorInput = leafBox.querySelector('.leaf-left input[type="color"]');
        if (colorInput && saved.color) {
          colorInput.value = saved.color;
        }

        const rangeInputs = leafBox.querySelectorAll('input[type="range"]');
        rangeInputs.forEach(rng => {
          // Grubość
          if (rng.min === '0.5' && rng.max === '15' && saved.lineWidth !== undefined) {
            rng.value = String(saved.lineWidth);
          }
          // Obwódka
          if ((rng.max === '6' || rng.max === '8') && rng.min === '0' && saved.outlineWidth !== undefined) {
            rng.value = String(saved.outlineWidth);
          }
          // Rozmiar punktu
          if (rng.min === '1' && rng.max === '20' && saved.circleRadius !== undefined) {
            rng.value = String(saved.circleRadius);
          }
          // Wielkość tekstu
          if (rng.min === '8' && rng.max === '28' && saved.textSize !== undefined) {
            rng.value = String(saved.textSize);
          }
        });
      });

      if (pCheckbox && childCbs.length > 0) {
        const checkedCount = childCbs.filter(c => c.checked).length;
        pCheckbox.checked = checkedCount === childCbs.length;
        pCheckbox.indeterminate = checkedCount > 0 && checkedCount < childCbs.length;
      }
    });
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
    ensureOutlineLayer
  };

})(window);
