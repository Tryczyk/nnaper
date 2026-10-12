const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const TRACK_TILES_URL = 'http://localhost:8000/api/track/{z}/{x}/{y}.pbf';
const trackMonthLayers = new Map();
const trackLayerIds = new Set(['GPS / Ślad trasy']);

const map = new maplibregl.Map({
  container: 'map',
  center: [18.6466, 54.3520],
  zoom: 13,
  minZoom: 1,
  maxZoom: 18,
  pitch: 42,
  bearing: -15,
  maxPitch: 60,
  fadeDuration: 0,
  attributionControl: false,
  style: MAP_STYLE
});

let navControl = new maplibregl.NavigationControl({ showCompass: true });
map.addControl(navControl, 'top-right');

function getLayerColor(layer) {
  if (!layer.paint) return '#94a3b8';
  const c = layer.paint['fill-color'] || layer.paint['line-color'] || layer.paint['circle-color'] || layer.paint['fill-extrusion-color'] || layer.paint['text-color'];
  return (typeof c === 'string' && c.startsWith('#')) ? c : '#94a3b8';
}

function getLayerStrokeColor(layer) {
  if (!layer.paint) return getLayerColor(layer);
  const c = layer.paint['circle-stroke-color'];
  return (typeof c === 'string' && c.startsWith('#')) ? c : getLayerColor(layer);
}

function updateLineDashArray(layerId, isDashed, dashLen, gapLen) {
  if (!map.getLayer(layerId)) return;
  if (isDashed) {
    map.setPaintProperty(layerId, 'line-dasharray', [parseFloat(dashLen), parseFloat(gapLen)]);
  } else {
    map.setPaintProperty(layerId, 'line-dasharray', [1, 0]);
  }
}

function createDashControls(targetLayerId, initialDashed = false) {
  const box = document.createElement('div');
  box.className = 'control-row';
  box.style.borderTop = '1px dotted #334155';
  box.style.paddingTop = '4px';

  const checkLabel = document.createElement('label');
  checkLabel.style.display = 'flex';
  checkLabel.style.alignItems = 'center';
  checkLabel.style.gap = '4px';
  checkLabel.style.cursor = 'pointer';

  const dashCheck = document.createElement('input');
  dashCheck.type = 'checkbox';
  dashCheck.checked = initialDashed;
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
  inDash.type = 'range'; inDash.min = '0.5'; inDash.max = '15'; inDash.step = '0.5'; inDash.value = '3';

  const lGap = document.createElement('span'); lGap.innerText = 'P:';
  const inGap = document.createElement('input');
  inGap.type = 'range'; inGap.min = '0.5'; inGap.max = '15'; inGap.step = '0.5'; inGap.value = '2';

  const apply = () => {
    updateLineDashArray(targetLayerId, dashCheck.checked, inDash.value, inGap.value);
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

/* ------------------- FILTR CZASU & JEDYNY PRZEŁĄCZNIK ŚLADU GPS ------------------- */
const MONTH_NAMES = {
  "01": "Styczeń", "02": "Luty", "03": "Marzec", "04": "Kwiecień",
  "05": "Maj", "06": "Czerwiec", "07": "Lipiec", "08": "Sierpień",
  "09": "Wrzesień", "10": "Październik", "11": "Listopad", "12": "Grudzień"
};

function createFilterTreeNode(title, checked = true) {
  const header = document.createElement('div');
  header.className = 'node-header';
  header.style.padding = '3px 6px';

  const label = document.createElement('div');
  label.className = 'node-label';
  label.style.fontSize = '11.5px';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;

  const text = document.createElement('span');
  text.innerText = title;

  label.appendChild(checkbox);
  label.appendChild(text);

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';

  header.appendChild(label);
  header.appendChild(arrow);

  return { element: header, checkbox, arrow };
}

function bindFilterCollapse(nodeObj, childrenBox) {
  nodeObj.element.addEventListener('click', (e) => {
    if (e.target === nodeObj.checkbox) return;
    childrenBox.classList.toggle('collapsed');
    nodeObj.arrow.classList.toggle('collapsed');
  });
}

function syncFilterCheckbox(parentCheckbox, childCheckboxes) {
  const checked = childCheckboxes.filter(c => c.checked).length;
  parentCheckbox.checked = checked === childCheckboxes.length;
  parentCheckbox.indeterminate = checked > 0 && checked < childCheckboxes.length;
}

function setTrackLayerVisibility(visibleDays) {
  trackMonthLayers.forEach(({ layerId, days }) => {
    if (map.getLayer(layerId)) {
      const activeDays = days.filter(day => visibleDays.has(day));
      map.setLayoutProperty(layerId, 'visibility', activeDays.length ? 'visible' : 'none');
      map.setFilter(layerId, [
        'match',
        ['get', 'day'],
        activeDays,
        true,
        false
      ]);
    }
  });
}

function applyTrackDateFilter(dayCheckboxes, isEverythingActive) {
  if (!isEverythingActive) {
    setTrackLayerVisibility(new Set());
    return;
  }

  const selectedDays = dayCheckboxes.filter(c => c.checked).map(c => c.value);
  setTrackLayerVisibility(new Set(selectedDays));
}

function buildTrackTilesUrl(days) {
  return `${TRACK_TILES_URL}?days=${encodeURIComponent(days)}`;
}

function updateTrackPaintProperty(property, value) {
  trackLayerIds.forEach(layerId => {
    if (map.getLayer(layerId)) map.setPaintProperty(layerId, property, value);
  });
}

function bindTrackLayerInteractions(layerId) {
  map.on('click', layerId, (e) => {
    const feat = e.features && e.features[0];
    if (feat && feat.properties && feat.properties.epoch_id) {
      loadPointFullDetails(feat.properties.epoch_id);
    }
  });
  map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
}

function addTrackMonthLayers(months) {
  months.forEach(({ key, days }) => {
    if (trackMonthLayers.has(key)) return;

    const suffix = key.replaceAll('-', '_');
    const sourceId = `gps-track-${suffix}`;
    const layerId = `GPS / Ślad trasy / ${key}`;

    map.addSource(sourceId, {
      type: 'vector',
      tiles: [buildTrackTilesUrl(days.join(','))],
      minzoom: 0,
      maxzoom: 18
    });
    map.addLayer({
      id: layerId,
      source: sourceId,
      'source-layer': 'gps-track',
      type: 'circle',
      layout: { visibility: 'none' },
      paint: {
        'circle-color': '#06b6d4',
        'circle-radius': 4.5,
        'circle-stroke-width': 0,
        'circle-stroke-color': '#06b6d4',
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport'
      }
    });
    trackMonthLayers.set(key, { layerId, days });
    trackLayerIds.add(layerId);
    bindTrackLayerInteractions(layerId);
  });
}

async function buildInlineTimeFilter(container) {
  try {
    const res = await fetch('http://localhost:8000/api/dates-tree');
    if (!res.ok) throw new Error('Błąd API');
    const data = await res.json();

    if (Object.keys(data).length === 0) {
      container.innerHTML = '<span style="color:#64748b;font-size:11px;">Brak danych czasowych.</span>';
      return;
    }

    const months = [];
    Object.keys(data).forEach(year => {
      Object.keys(data[year]).forEach(month => {
        months.push({
          key: `${year}-${month}`,
          days: data[year][month].map(day => `${year}-${month}-${day}`)
        });
      });
    });
    addTrackMonthLayers(months);

    container.innerHTML = '';
    const allDayCheckboxes = [];

    const rootNode = document.createElement('div');
    rootNode.className = 'tree-node';
    const rootHeader = createFilterTreeNode('Wszystko', true);
    const rootChildren = document.createElement('div');
    rootChildren.className = 'node-children';
    rootChildren.style.marginLeft = '8px';

    bindFilterCollapse(rootHeader, rootChildren);

    // Główny przełącznik śladu GPS
    rootHeader.checkbox.addEventListener('change', () => {
      const isChecked = rootHeader.checkbox.checked;
      rootHeader.checkbox.indeterminate = false;
      allDayCheckboxes.forEach(cb => { cb.checked = isChecked; });
      container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = isChecked;
        cb.indeterminate = false;
      });
      applyTrackDateFilter(allDayCheckboxes, isChecked);
    });

    Object.keys(data).sort().reverse().forEach(year => {
      const yearNode = document.createElement('div');
      yearNode.className = 'tree-node';
      const yearHeader = createFilterTreeNode(`Rok: ${year}`, true);
      const yearChildren = document.createElement('div');
      yearChildren.className = 'node-children';
      yearChildren.style.marginLeft = '8px';
      bindFilterCollapse(yearHeader, yearChildren);

      const yearDayCheckboxes = [];

      Object.keys(data[year]).sort().reverse().forEach(month => {
        const monthNode = document.createElement('div');
        monthNode.className = 'tree-node';
        const monthName = MONTH_NAMES[month] || month;
        const monthHeader = createFilterTreeNode(`Miesiąc: ${monthName} (${month})`, true);
        const monthChildren = document.createElement('div');
        monthChildren.className = 'node-children';
        monthChildren.style.marginLeft = '8px';
        bindFilterCollapse(monthHeader, monthChildren);

        const monthDayCheckboxes = [];

        data[year][month].sort().reverse().forEach(day => {
          const dateStr = `${year}-${month}-${day}`;
          const leaf = document.createElement('label');
          leaf.className = 'leaf-item';
          leaf.style.padding = '2px 4px';
          leaf.style.cursor = 'pointer';

          const dayCheckbox = document.createElement('input');
          dayCheckbox.type = 'checkbox';
          dayCheckbox.checked = true;
          dayCheckbox.value = dateStr;
          dayCheckbox.style.accentColor = '#38bdf8';
          dayCheckbox.style.marginRight = '6px';

          monthDayCheckboxes.push(dayCheckbox);
          yearDayCheckboxes.push(dayCheckbox);
          allDayCheckboxes.push(dayCheckbox);

          dayCheckbox.addEventListener('change', () => {
            syncFilterCheckbox(monthHeader.checkbox, monthDayCheckboxes);
            syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
            syncFilterCheckbox(rootHeader.checkbox, allDayCheckboxes);
            applyTrackDateFilter(allDayCheckboxes, rootHeader.checkbox.checked || rootHeader.checkbox.indeterminate);
          });

          const dayLabel = document.createElement('span');
          dayLabel.innerText = `Dzień: ${day}`;

          leaf.appendChild(dayCheckbox);
          leaf.appendChild(dayLabel);
          monthChildren.appendChild(leaf);
        });

        monthHeader.checkbox.addEventListener('change', () => {
          const isChecked = monthHeader.checkbox.checked;
          monthHeader.checkbox.indeterminate = false;
          monthDayCheckboxes.forEach(cb => { cb.checked = isChecked; });
          syncFilterCheckbox(yearHeader.checkbox, yearDayCheckboxes);
          syncFilterCheckbox(rootHeader.checkbox, allDayCheckboxes);
          applyTrackDateFilter(allDayCheckboxes, rootHeader.checkbox.checked || rootHeader.checkbox.indeterminate);
        });

        monthNode.appendChild(monthHeader.element);
        monthNode.appendChild(monthChildren);
        yearChildren.appendChild(monthNode);
      });

      yearHeader.checkbox.addEventListener('change', () => {
        const isChecked = yearHeader.checkbox.checked;
        yearHeader.checkbox.indeterminate = false;
        yearDayCheckboxes.forEach(cb => { cb.checked = isChecked; });
        yearChildren.querySelectorAll('.node-header input[type="checkbox"]').forEach(cb => {
          cb.checked = isChecked;
          cb.indeterminate = false;
        });
        syncFilterCheckbox(rootHeader.checkbox, allDayCheckboxes);
        applyTrackDateFilter(allDayCheckboxes, rootHeader.checkbox.checked || rootHeader.checkbox.indeterminate);
      });

      yearNode.appendChild(yearHeader.element);
      yearNode.appendChild(yearChildren);
      rootChildren.appendChild(yearNode);
    });

    rootNode.appendChild(rootHeader.element);
    rootNode.appendChild(rootChildren);
    container.appendChild(rootNode);
    applyTrackDateFilter(allDayCheckboxes, true);

  } catch (err) {
    container.innerHTML = `<span style="color:#ef4444;font-size:11px;">Brak połączenia z API dat.</span>`;
  }
}

/* ------------------- GENEROWANIE DRZEWKA WARSTW ------------------- */
function autoBuildTree() {
  const container = document.getElementById('tree-container');
  container.innerHTML = '';

  const layers = map.getStyle().layers || [];
  const groups = {};

  layers.forEach(layer => {
    if (
      layer.id === 'bg' ||
      layer.id.endsWith('-outline-line') ||
      layer.id.startsWith('sat-') ||
      layer.id.startsWith('GPS / Ślad trasy / ')
    ) return;

    const parts = layer.id.split('/');
    const groupName = parts.length > 1 ? parts[0] : 'Inne';
    const leafTitle = parts.length > 1 ? parts[1] : layer.id;

    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push({ id: layer.id, title: leafTitle, raw: JSON.parse(JSON.stringify(layer)) });
  });

  Object.keys(groups).forEach(groupName => {
    const childList = groups[groupName];
    const node = document.createElement('div');
    node.className = 'tree-node';

    const header = document.createElement('div');
    header.className = 'node-header';

    const label = document.createElement('label');
    label.className = 'node-label';

    const pCheckbox = groupName === 'GPS'
      ? null
      : document.createElement('input');
    if (pCheckbox) {
      pCheckbox.type = 'checkbox';
      pCheckbox.checked = true;
    }

    const pTitle = document.createElement('span');
    pTitle.innerText = groupName;

    if (pCheckbox) {
      label.appendChild(pCheckbox);
    }
    label.appendChild(pTitle);

    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.innerHTML = '&#9660;';

    header.appendChild(label);
    header.appendChild(arrow);

    const childrenBox = document.createElement('div');
    childrenBox.className = 'node-children';

    header.addEventListener('click', (e) => {
      if (pCheckbox && e.target === pCheckbox) return;
      childrenBox.classList.toggle('collapsed');
      arrow.classList.toggle('collapsed');
    });

    const childInputs = [];

    childList.forEach(child => {
      const leafBox = document.createElement('div');
      leafBox.className = 'leaf-container';

      const leaf = document.createElement('div');
      leaf.className = 'leaf-item';

      const leftDiv = document.createElement('div');
      leftDiv.className = 'leaf-left';

      const cCheckbox = child.id === 'GPS / Ślad trasy'
        ? null
        : document.createElement('input');
      if (cCheckbox) {
        cCheckbox.type = 'checkbox';
        cCheckbox.checked = true;
      }

      if (cCheckbox) {
        childInputs.push(cCheckbox);
        leftDiv.appendChild(cCheckbox);
      }

      const initialColor = getLayerColor(child.raw);
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
          if (child.id === 'GPS / Ślad trasy') updateTrackPaintProperty('circle-color', col);
          else map.setPaintProperty(child.id, 'circle-color', col);
        }
        else if (child.raw.type === 'fill-extrusion') map.setPaintProperty(child.id, 'fill-extrusion-color', col);
        else if (child.raw.type === 'symbol') map.setPaintProperty(child.id, 'text-color', col);
      });

      const cTitle = document.createElement('span');
      cTitle.innerText = child.title;

      leftDiv.appendChild(mainColorPicker);
      leftDiv.appendChild(cTitle);
      leaf.appendChild(leftDiv);
      leafBox.appendChild(leaf);

      const ctrlDiv = document.createElement('div');
      ctrlDiv.className = 'leaf-controls';

      // Linie
      if (child.raw.type === 'line') {
        const lineOutlineId = `${child.id}-outline-line`;
        if (!map.getLayer(lineOutlineId) &&
            typeof child.raw.source === 'string' &&
            typeof child.raw['source-layer'] === 'string') {
          map.addLayer({
            id: lineOutlineId,
            source: child.raw.source,
            'source-layer': child.raw['source-layer'],
            type: 'line',
            filter: child.raw.filter || ['all'],
            paint: {
              'line-color': initialColor,
              'line-width': 0.0,
              'line-gap-width': (child.raw.paint && child.raw.paint['line-width']) ? child.raw.paint['line-width'] : 1.5,
              'line-opacity': 0.0
            }
          }, child.id);
        }

        const row = document.createElement('div');
        row.className = 'control-row';
        const sizeLabel = document.createElement('span'); sizeLabel.innerText = 'Grubość:';
        const sizeInput = document.createElement('input');
        sizeInput.type = 'range'; sizeInput.min = '0.5'; sizeInput.max = '15'; sizeInput.step = '0.5';
        sizeInput.value = (child.raw.paint && child.raw.paint['line-width']) ? child.raw.paint['line-width'] : '2.0';
        sizeInput.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          map.setPaintProperty(child.id, 'line-width', val);
          if (map.getLayer(lineOutlineId)) map.setPaintProperty(lineOutlineId, 'line-gap-width', val);
        });
        row.appendChild(sizeLabel); row.appendChild(sizeInput);
        ctrlDiv.appendChild(row);

        ctrlDiv.appendChild(createDashControls(child.id, false));

        const rowOut = document.createElement('div');
        rowOut.className = 'control-row';
        const outLabel = document.createElement('span'); outLabel.innerText = 'Obwódka:';
        const outColor = document.createElement('input'); outColor.type = 'color'; outColor.className = 'color-picker'; outColor.value = initialColor;
        outColor.addEventListener('input', (e) => map.setPaintProperty(lineOutlineId, 'line-color', e.target.value));

        const outWidth = document.createElement('input'); outWidth.type = 'range'; outWidth.min = '0'; outWidth.max = '6'; outWidth.step = '0.5'; outWidth.value = '0';
        outWidth.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          map.setPaintProperty(lineOutlineId, 'line-width', val);
          map.setPaintProperty(lineOutlineId, 'line-opacity', val > 0 ? 1.0 : 0.0);
        });
        rowOut.appendChild(outLabel); rowOut.appendChild(outColor); rowOut.appendChild(outWidth);
        ctrlDiv.appendChild(rowOut);

        ctrlDiv.appendChild(createDashControls(lineOutlineId, false));
      }

      // Punkty
      if (child.raw.type === 'circle') {
        const rowSize = document.createElement('div');
        rowSize.className = 'control-row';
        const sizeLabel = document.createElement('span'); sizeLabel.innerText = 'Rozmiar:';
        const sizeInput = document.createElement('input');
        sizeInput.type = 'range'; sizeInput.min = '1'; sizeInput.max = '20'; sizeInput.step = '0.5';
        sizeInput.value = (child.raw.paint && typeof child.raw.paint['circle-radius'] === 'number') ? child.raw.paint['circle-radius'] : '4.5';
        sizeInput.addEventListener('input', (e) => {
          const value = parseFloat(e.target.value);
          if (child.id === 'GPS / Ślad trasy') updateTrackPaintProperty('circle-radius', value);
          else map.setPaintProperty(child.id, 'circle-radius', value);
        });
        rowSize.appendChild(sizeLabel); rowSize.appendChild(sizeInput);
        ctrlDiv.appendChild(rowSize);

        const rowStroke = document.createElement('div');
        rowStroke.className = 'control-row';
        const strokeLabel = document.createElement('span'); strokeLabel.innerText = 'Obwódka:';
        const strokeColorPicker = document.createElement('input'); strokeColorPicker.type = 'color'; strokeColorPicker.className = 'color-picker'; strokeColorPicker.value = getLayerStrokeColor(child.raw);
        strokeColorPicker.addEventListener('input', (e) => {
          if (child.id === 'GPS / Ślad trasy') updateTrackPaintProperty('circle-stroke-color', e.target.value);
          else map.setPaintProperty(child.id, 'circle-stroke-color', e.target.value);
        });
        const strokeWidthInput = document.createElement('input'); strokeWidthInput.type = 'range'; strokeWidthInput.min = '0'; strokeWidthInput.max = '8'; strokeWidthInput.step = '0.5'; strokeWidthInput.value = '0';
        strokeWidthInput.addEventListener('input', (e) => {
          const value = parseFloat(e.target.value);
          if (child.id === 'GPS / Ślad trasy') updateTrackPaintProperty('circle-stroke-width', value);
          else map.setPaintProperty(child.id, 'circle-stroke-width', value);
        });
        rowStroke.appendChild(strokeLabel); rowStroke.appendChild(strokeColorPicker); rowStroke.appendChild(strokeWidthInput);
        ctrlDiv.appendChild(rowStroke);

        if (child.id === 'GPS / Ślad trasy') {
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
          buildInlineTimeFilter(timeTreeHolder);
        }
      }

      // Obszary
      if (child.raw.type === 'fill') {
        const outlineLayerId = `${child.id}-outline-line`;
        if (!map.getLayer(outlineLayerId) &&
            typeof child.raw.source === 'string' &&
            typeof child.raw['source-layer'] === 'string') {
          map.addLayer({
            id: outlineLayerId,
            source: child.raw.source,
            'source-layer': child.raw['source-layer'],
            type: 'line',
            filter: child.raw.filter || ['all'],
            paint: {
              'line-color': initialColor,
              'line-width': 0.0,
              'line-opacity': 0.0
            }
          });
        }

        const row = document.createElement('div');
        row.className = 'control-row';
        const outlineLabel = document.createElement('span'); outlineLabel.innerText = 'Obwódka:';
        const outlineColor = document.createElement('input'); outlineColor.type = 'color'; outlineColor.className = 'color-picker'; outlineColor.value = initialColor;
        outlineColor.addEventListener('input', (e) => map.setPaintProperty(outlineLayerId, 'line-color', e.target.value));
        const outlineWidth = document.createElement('input'); outlineWidth.type = 'range'; outlineWidth.min = '0'; outlineWidth.max = '8'; outlineWidth.step = '0.5'; outlineWidth.value = '0';
        outlineWidth.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          map.setPaintProperty(outlineLayerId, 'line-width', val);
          map.setPaintProperty(outlineLayerId, 'line-opacity', val > 0 ? 1.0 : 0.0);
        });
        row.appendChild(outlineLabel); row.appendChild(outlineColor); row.appendChild(outlineWidth);
        ctrlDiv.appendChild(row);

        ctrlDiv.appendChild(createDashControls(outlineLayerId, false));
      }

      // Etykiety
      if (child.raw.type === 'symbol') {
        const rowSize = document.createElement('div');
        rowSize.className = 'control-row';
        const sizeLabel = document.createElement('span'); sizeLabel.innerText = 'Wielkość:';
        const textSizeInput = document.createElement('input');
        textSizeInput.type = 'range'; textSizeInput.min = '8'; textSizeInput.max = '28'; textSizeInput.step = '1';
        textSizeInput.value = (child.raw.layout && child.raw.layout['text-size']) ? child.raw.layout['text-size'] : '12';
        textSizeInput.addEventListener('input', (e) => map.setLayoutProperty(child.id, 'text-size', parseFloat(e.target.value)));
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
          const checkedCount = childInputs.filter(i => i.checked).length;
          pCheckbox.checked = checkedCount === childInputs.length;
          pCheckbox.indeterminate = checkedCount > 0 && checkedCount < childInputs.length;
        });
      }
    });

    if (pCheckbox) {
      pCheckbox.addEventListener('change', () => {
        const isChecked = pCheckbox.checked;
        pCheckbox.indeterminate = false;
        childInputs.forEach((ci, idx) => {
          ci.checked = isChecked;
          const targetId = childList[idx].id;
          const vis = isChecked ? 'visible' : 'none';
          if (map.getLayer(targetId)) map.setLayoutProperty(targetId, 'visibility', vis);
          if (map.getLayer(`${targetId}-outline-line`)) map.setLayoutProperty(`${targetId}-outline-line`, 'visibility', vis);
        });
      });
    }

    node.appendChild(header);
    node.appendChild(childrenBox);
    container.appendChild(node);
  });
}

/* ------------------- INTERFEJS OKNA ------------------- */
const menuEl = document.getElementById('menu');
const btnMin = document.getElementById('btn-minimize');
const pointPanelEl = document.getElementById('point-panel');
const btnClosePoint = document.getElementById('btn-close-point');
const btnBackLocation = document.getElementById('btn-back-location');
const btnCloseLocation = document.getElementById('btn-close-location');
const menuTitle = menuEl.querySelector('.menu-header h3');
const menuBody = menuEl.querySelector('.menu-body');
const layerMenuBodyHTML = menuBody.innerHTML;
const layerMenuTitle = menuTitle.innerText;
let previousSearchCamera = null;
btnBackLocation.style.display = 'none';
btnCloseLocation.style.display = 'none';

function restoreLayerMenu() {
  menuTitle.innerText = layerMenuTitle;
  menuBody.innerHTML = layerMenuBodyHTML;
  btnSwitch.style.display = '';
  btnMin.style.display = '';
  btnBackLocation.style.display = 'none';
  btnCloseLocation.style.display = 'none';
  autoBuildTree();
}

function minimizeMenu() {
  menuEl.classList.add('minimized');
  btnMin.innerText = '+';
}

function expandMenu() {
  menuEl.classList.remove('minimized');
  btnMin.innerText = '–';
}

btnMin.addEventListener('click', () => {
  if (menuEl.classList.contains('minimized')) expandMenu();
  else minimizeMenu();
});

const btnSwitch = document.getElementById('btn-switch-side');
btnSwitch.addEventListener('click', () => {
  const isLeft = menuEl.classList.contains('dock-left');
  menuEl.classList.toggle('dock-left', !isLeft);
  menuEl.classList.toggle('dock-right', isLeft);

  pointPanelEl.classList.toggle('dock-left', isLeft);
  pointPanelEl.classList.toggle('dock-right', !isLeft);

  map.removeControl(navControl);
  navControl = new maplibregl.NavigationControl({ showCompass: true });
  map.addControl(navControl, isLeft ? 'top-left' : 'top-right');
});

function closeLocation(restoreCamera) {
  restoreLayerMenu();
  if (searchMarker) {
    searchMarker.remove();
    searchMarker = null;
  }
  if (restoreCamera && previousSearchCamera) {
    map.easeTo(previousSearchCamera);
  }
  previousSearchCamera = null;
  searchInput.value = '';
  searchCompleted = false;
  searchResults = [];
  suggestionsBox.innerHTML = '';
  suggestionsBox.style.display = 'none';
}

window.restoreOriginalSearchLocation = () => closeLocation(true);

btnBackLocation.addEventListener('click', () => closeLocation(true));
btnCloseLocation.addEventListener('click', () => closeLocation(false));

btnClosePoint.addEventListener('click', () => {
  pointPanelEl.classList.remove('active');
  clearSatelliteLayers();
  expandMenu();
});

/* ------------------- WIZUALIZACJA SATELITÓW ------------------- */
let activeSatelliteContext = null;
let currentSatMode = 'local';

function clearSatelliteLayers() {
  activeSatelliteContext = null;
  const satLines = map.getSource('satellites-lines-source');
  if (satLines) satLines.setData({ type: 'FeatureCollection', features: [] });
  const satPoints = map.getSource('satellites-points-source');
  if (satPoints) satPoints.setData({ type: 'FeatureCollection', features: [] });
}

function computeSubSatellitePoint(userLon, userLat, azimuthDeg, elevationDeg) {
  const R_E = 6371.0;
  const H_SAT = 20200.0;
  const R_SAT = R_E + H_SAT;

  const elRad = (Math.max(0.1, elevationDeg) * Math.PI) / 180.0;
  const azRad = (azimuthDeg * Math.PI) / 180.0;
  const latRad = (userLat * Math.PI) / 180.0;
  const lonRad = (userLon * Math.PI) / 180.0;

  const cosArg = (R_E / R_SAT) * Math.cos(elRad);
  const alpha = Math.acos(Math.min(1.0, Math.max(-1.0, cosArg)));
  const gamma = alpha - elRad;

  const sinLat2 = Math.sin(latRad) * Math.cos(gamma) + Math.cos(latRad) * Math.sin(gamma) * Math.cos(azRad);
  const lat2 = Math.asin(Math.min(1.0, Math.max(-1.0, sinLat2)));

  const y = Math.sin(azRad) * Math.sin(gamma) * Math.cos(latRad);
  const x = Math.cos(gamma) - Math.sin(latRad) * Math.sin(lat2);
  const lon2 = lonRad + Math.atan2(y, x);

  let satLat = (lat2 * 180.0) / Math.PI;
  let satLon = (lon2 * 180.0) / Math.PI;
  satLon = ((satLon + 540.0) % 360.0) - 180.0;

  return { lon: satLon, lat: satLat };
}

function renderSatelliteRays() {
  if (!activeSatelliteContext) return;
  const { pointLon, pointLat, satellitesList } = activeSatelliteContext;

  const lineFeatures = [];
  const pointFeatures = [];
  const bounds = new maplibregl.LngLatBounds();
  bounds.extend([pointLon, pointLat]);

  const RAY_DISTANCE_DEG_LOCAL = 0.045;

  satellitesList.forEach(sat => {
    if (sat.azimuth === null || sat.azimuth === undefined) return;
    let satLon, satLat, label;

    if (currentSatMode === 'local') {
      const azRad = (sat.azimuth * Math.PI) / 180.0;
      const el = sat.elevation !== null && sat.elevation !== undefined ? sat.elevation : 45;
      const dist = RAY_DISTANCE_DEG_LOCAL * Math.cos((el * Math.PI) / 180.0);
      satLon = pointLon + dist * Math.sin(azRad) * 1.5;
      satLat = pointLat + dist * Math.cos(azRad);
      label = `PRN ${sat.prn}\n(${sat.elevation || 0}°, ${sat.snr || 0}dB)`;
    } else {
      const sub = computeSubSatellitePoint(pointLon, pointLat, sat.azimuth, sat.elevation || 0);
      satLon = sub.lon;
      satLat = sub.lat;
      label = `PRN ${sat.prn} (Sub-Sat)\nEl: ${sat.elevation || 0}°`;
    }

    bounds.extend([satLon, satLat]);

    lineFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [[pointLon, pointLat], [satLon, satLat]]
      },
      properties: { prn: sat.prn, snr: sat.snr, elevation: sat.elevation }
    });

    pointFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [satLon, satLat]
      },
      properties: { label, prn: sat.prn, snr: sat.snr }
    });
  });

  const satLines = map.getSource('satellites-lines-source');
  if (satLines) satLines.setData({ type: 'FeatureCollection', features: lineFeatures });

  const satPoints = map.getSource('satellites-points-source');
  if (satPoints) satPoints.setData({ type: 'FeatureCollection', features: pointFeatures });

  if (currentSatMode === 'subpoint' && lineFeatures.length > 0) {
    map.fitBounds(bounds, { padding: 80, maxZoom: 6, duration: 1000 });
  } else if (currentSatMode === 'local') {
    map.easeTo({ center: [pointLon, pointLat], zoom: 13, duration: 800 });
  }
}

/* ------------------- POBIERANIE PEŁNYCH DANYCH Z BAZY ------------------- */
async function loadPointFullDetails(epochId) {
  minimizeMenu();
  pointPanelEl.classList.add('active');

  const content = document.getElementById('pp-content');
  content.innerHTML = '<div style="color:#94a3b8;">Odpytywanie bazy danych...</div>';

  try {
    const res = await fetch(`http://localhost:8000/api/epoch/${epochId}`);
    if (!res.ok) throw new Error('Błąd odpytania serwera');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const e = data.epoch || {};
    const p = data.profile || {};
    const u = data.user || {};
    const sentences = data.sentences || [];

    const allSatellites = [];
    sentences.forEach(s => {
      if (s.gpgsv && s.gpgsv.satellites) {
        s.gpgsv.satellites.forEach(sat => {
          if (!allSatellites.some(item => item.prn === sat.prn)) {
            allSatellites.push(sat);
          }
        });
      }
    });

    if (e.longitude && e.latitude) {
      activeSatelliteContext = {
        pointLon: parseFloat(e.longitude),
        pointLat: parseFloat(e.latitude),
        satellitesList: allSatellites
      };
      renderSatelliteRays();
    }

    let html = `
      <div class="sat-mode-switch">
        <span>Tryb wizualizacji satelitów:</span>
        <select id="sel-sat-mode">
          <option value="local" ${currentSatMode === 'local' ? 'selected' : ''}>1. Lokalny / Skyplot (Nieboskłon)</option>
          <option value="subpoint" ${currentSatMode === 'subpoint' ? 'selected' : ''}>2. Model Sferyczny (Orbita MEO 20 200 km)</option>
        </select>
      </div>

      <div class="section-box">
        <h4>Tabela EPOCHS</h4>
        <table class="kv-table">
          <tr><td>epoch_id</td><td>${e.epoch_id}</td></tr>
          <tr><td>is_active</td><td>${e.is_active ? '<span class="badge badge-ok">TRUE</span>' : '<span class="badge badge-err">FALSE</span>'}</td></tr>
          <tr><td>inactive_reasons</td><td>${(e.inactive_reasons && e.inactive_reasons.length) ? JSON.stringify(e.inactive_reasons) : '[]'}</td></tr>
          <tr><td>timestamp</td><td>${e.timestamp || 'NULL'}</td></tr>
          <tr><td>latitude / longitude</td><td>${e.latitude}, ${e.longitude}</td></tr>
          <tr><td>terminator</td><td>${e.terminator || 'NULL'}</td></tr>
          <tr><td>time_diff</td><td>${e.time_diff ?? 'NULL'} s</td></tr>
          <tr><td>distance</td><td>${e.distance ?? 'NULL'} m</td></tr>
        </table>
      </div>

      <div class="section-box">
        <h4>Satelity w zasięgu (${allSatellites.length})</h4>
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
    `;

    if (allSatellites.length > 0) {
      allSatellites.forEach(sat => {
        html += `
          <span class="sat-badge">
            <strong style="color:#38bdf8;">PRN ${sat.prn}:</strong> El: ${sat.elevation}°, Az: ${sat.azimuth}°, SNR: ${sat.snr}dB
          </span>
        `;
      });
    } else {
      html += `<span style="color:#64748b;">Brak wpisów satelitów w tej epoce.</span>`;
    }

    html += `
        </div>
      </div>

      <div class="section-box">
        <h4>Tabela PROFILES & USERS</h4>
        <table class="kv-table">
          <tr><td>profile_id / Nazwa</td><td>${p.profile_id} (<strong>${p.name}</strong>)</td></tr>
          <tr><td>user_id / Użytkownik</td><td>${u.user_id} (<strong>${u.username}</strong>)</td></tr>
          <tr><td>Email</td><td>${u.email}</td></tr>
        </table>
      </div>
    `;

    if (sentences.length > 0) {
      html += `<div class="section-box"><h4>Ramki NMEA i Sensory (${sentences.length})</h4>`;
      sentences.forEach((s, idx) => {
        html += `
          <div style="margin-bottom:8px; border-bottom:1px dashed #334155; padding-bottom:6px;">
            <div style="font-family:monospace; color:#38bdf8; font-size:11px; word-break:break-all;">#${idx+1}: ${s.raw || ''}</div>
            <div style="font-size:10px; color:#64748b;">Checksum: ${s.checksum} | Parts: ${s.parts_count} | sentence_id: ${s.sentence_id}</div>
        `;

        if (s.gsensord) {
          html += `<table class="kv-table">
            <tr><td>GSENSORD</td><td>X: ${s.gsensord.g_x}, Y: ${s.gsensord.g_y}, Z: ${s.gsensord.g_z}</td></tr>
          </table>`;
        }
        if (s.gprmc) {
          html += `<table class="kv-table">
            <tr><td>GPRMC</td><td>Date: ${s.gprmc.date}, Time: ${s.gprmc.time_utc}, Status: ${s.gprmc.status}, Speed: ${s.gprmc.speed_knots}kt, Course: ${s.gprmc.course}°, Mode: ${s.gprmc.mode}</td></tr>
          </table>`;
        }
        if (s.gpgga) {
          html += `<table class="kv-table">
            <tr><td>GPGGA</td><td>Time: ${s.gpgga.time_utc}, Fix: ${s.gpgga.fix_quality}, Sats: ${s.gpgga.satellites_used}, HDOP: ${s.gpgga.hdop}, Alt: ${s.gpgga.altitude}${s.gpgga.altitude_units}, Geoid: ${s.gpgga.geoid_separation}${s.gpgga.geoid_separation_units}</td></tr>
          </table>`;
        }
        if (s.gpvtg) {
          html += `<table class="kv-table">
            <tr><td>GPVTG</td><td>True: ${s.gpvtg.course_true}°, Mag: ${s.gpvtg.course_magnetic}°, Spd: ${s.gpvtg.speed_kmh}km/h (${s.gpvtg.speed_knots}kt), Mode: ${s.gpvtg.mode}</td></tr>
          </table>`;
        }
        if (s.gpgsa) {
          html += `<table class="kv-table">
            <tr><td>GPGSA</td><td>Mode1: ${s.gpgsa.mode1}, Mode2: ${s.gpgsa.mode2}, PDOP: ${s.gpgsa.pdop}, HDOP: ${s.gpgsa.hdop}, VDOP: ${s.gpgsa.vdop}</td></tr>
          </table>`;
        }
        if (s.gpgsv && s.gpgsv.meta) {
          html += `<table class="kv-table">
            <tr><td>GPGSV</td><td>Msg ${s.gpgsv.meta.message_number}/${s.gpgsv.meta.total_messages}, In view: ${s.gpgsv.meta.satellites_in_view}</td></tr>
          </table>`;
        }

        html += `</div>`;
      });
      html += `</div>`;
    }

    content.innerHTML = html;

    const selMode = document.getElementById('sel-sat-mode');
    if (selMode) {
      selMode.addEventListener('change', (e) => {
        currentSatMode = e.target.value;
        renderSatelliteRays();
      });
    }

  } catch (err) {
    content.innerHTML = `<span style="color:#ef4444;">Błąd pobierania danych: ${err.message}</span>`;
  }
}

/* ------------------- INICJALIZACJA ------------------- */
map.on('load', () => {
  map.addSource('satellites-lines-source', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('satellites-points-source', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: 'sat-rays-outline',
    source: 'satellites-lines-source',
    type: 'line',
    paint: {
      'line-color': '#000000',
      'line-width': 0.0,
      'line-opacity': 0.0
    }
  });

  map.addLayer({
    id: 'Satelity / Promienie wektorowe',
    source: 'satellites-lines-source',
    type: 'line',
    paint: {
      'line-color': '#f59e0b',
      'line-width': 2.0,
      'line-dasharray': [3, 2]
    }
  });

  map.addLayer({
    id: 'Satelity / Punkty nieboskłonu',
    source: 'satellites-points-source',
    type: 'circle',
    paint: {
      'circle-color': '#f59e0b',
      'circle-radius': 5.5,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff'
    }
  });

  map.addLayer({
    id: 'Satelity / Etykiety PRN',
    source: 'satellites-points-source',
    type: 'symbol',
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 11,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-font': ['Open Sans Bold']
    },
    paint: {
      'text-color': '#fef08a',
      'text-halo-color': '#020617',
      'text-halo-width': 2
    }
  });

  // Ślad GPS
  map.addSource('gps-track', {
    type: 'vector',
    tiles: [buildTrackTilesUrl('none')],
    minzoom: 0,
    maxzoom: 18
  });

  map.addLayer({
    id: 'GPS / Ślad trasy',
    source: 'gps-track',
    'source-layer': 'gps-track',
    type: 'circle',
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#06b6d4',
      'circle-radius': 4.5,
      'circle-stroke-width': 0,
      'circle-stroke-color': '#06b6d4',
      'circle-pitch-alignment': 'map',
      'circle-pitch-scale': 'viewport'
    }
  });

  map.on('click', 'GPS / Ślad trasy', (e) => {
    const feat = e.features[0];
    if (feat && feat.properties && feat.properties.epoch_id) {
      loadPointFullDetails(feat.properties.epoch_id);
    }
  });

  map.on('mouseenter', 'GPS / Ślad trasy', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'GPS / Ślad trasy', () => { map.getCanvas().style.cursor = ''; });

  map.setTerrain({ source: 'terrain-dem', exaggeration: 0.85 });

  autoBuildTree();
});

/* ------------------- WYSZUKIWARKA MIEJSC I GEODECODROWANIE ------------------- */
const searchInput = document.getElementById('search-input');
const suggestionsBox = document.getElementById('search-suggestions');
let searchMarker = null;
let searchTimeout = null;
let searchRequestId = 0;
let searchAbortController = null;
let searchResults = [];
let highlightedSearchIndex = -1;
let searchCompleted = false;

function getPolishPlaceLabel(value) {
  if (!value) return value;
  return String(value)
    .replace(/\bPomeranian Voivodeship\b/gi, 'Pomorskie')
    .replace(/\bPomeranian Province\b/gi, 'Pomorskie')
    .replace(/\bwojewództwo pomorskie\b/gi, 'Pomorskie')
    .replace(/\bPoland\b/gi, 'Polska');
}

function renderSearchResults(results) {
  suggestionsBox.innerHTML = '';
  searchResults = results.slice(0, 6);
  highlightedSearchIndex = -1;

  searchResults.forEach((place, index) => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.innerText = place.display_name;
    div.addEventListener('click', () => selectPlace(place));
    div.addEventListener('mouseenter', () => {
      highlightedSearchIndex = index;
      updateHighlightedSearchResult();
    });
    suggestionsBox.appendChild(div);
  });

  suggestionsBox.style.display = searchResults.length ? 'block' : 'none';
}

function updateHighlightedSearchResult() {
  [...suggestionsBox.children].forEach((item, index) => {
    item.classList.toggle('active', index === highlightedSearchIndex);
  });
}

searchInput.addEventListener('focus', () => {
  if (searchCompleted) {
    searchInput.value = '';
    suggestionsBox.innerHTML = '';
    suggestionsBox.style.display = 'none';
    searchResults = [];
    highlightedSearchIndex = -1;
    searchCompleted = false;
    restoreLayerMenu();
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!searchResults.length) return;
    e.preventDefault();
    const direction = e.key === 'ArrowDown' ? 1 : -1;
    highlightedSearchIndex = (highlightedSearchIndex + direction + searchResults.length) % searchResults.length;
    updateHighlightedSearchResult();
    suggestionsBox.children[highlightedSearchIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && searchResults.length) {
    e.preventDefault();
    selectPlace(searchResults[highlightedSearchIndex >= 0 ? highlightedSearchIndex : 0]);
  } else if (e.key === 'Escape') {
    suggestionsBox.style.display = 'none';
  }
});

// Debounce dla podpowiedzi (żeby nie odpytywać API przy każdym wciśnięciu klawisza)
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const requestId = ++searchRequestId;
  if (searchAbortController) searchAbortController.abort();
  const query = e.target.value.trim();

  if (query.length < 1) {
    suggestionsBox.style.display = 'none';
    suggestionsBox.innerHTML = '';
    return;
  }

  searchTimeout = setTimeout(async () => {
    try {
      const query = searchInput.value.trim();
      if (query.length < 1) {
        suggestionsBox.style.display = 'none';
        suggestionsBox.innerHTML = '';
        return;
      }

      const pomorskieBbox = '14.1,53.9,19.9,55.9';
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=50&bbox=${pomorskieBbox}`;
      searchAbortController = new AbortController();
      const response = await fetch(url, { signal: searchAbortController.signal });
      if (!response.ok) throw new Error(`Błąd wyszukiwania: ${response.status}`);
      const data = await response.json();
      if (requestId !== searchRequestId) return;
      const uniqueResults = new Map();
      (Array.isArray(data.features) ? data.features : []).forEach(feature => {
        const properties = feature.properties || {};
        const coordinates = feature.geometry && feature.geometry.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return;
        const addressParts = [
          properties.street && `${properties.street}${properties.housenumber ? ` ${properties.housenumber}` : ''}`,
          properties.city || properties.town || properties.village,
          getPolishPlaceLabel(properties.state),
          getPolishPlaceLabel(properties.country)
        ].filter(Boolean);

        const place = {
          ...properties,
          state: getPolishPlaceLabel(properties.state),
          country: getPolishPlaceLabel(properties.country),
          name: properties.name || '',
          display_name: [properties.name, ...addressParts]
            .filter((value, index, values) => value && values.indexOf(value) === index)
            .join(', '),
          lon: coordinates[0],
          lat: coordinates[1],
          address: {
            road: properties.street,
            house_number: properties.housenumber,
            city: properties.city || properties.town || properties.village,
            state: getPolishPlaceLabel(properties.state),
            country: getPolishPlaceLabel(properties.country),
            postcode: properties.postcode
          }
        };
        const key = `${place.osm_type || ''}/${place.osm_id || ''}/${place.lat}/${place.lon}`;
        uniqueResults.set(key, place);
      });
      const exactQueryParts = query.toLocaleLowerCase('pl-PL').split(/\s+/).filter(Boolean);
      const results = [...uniqueResults.values()].filter(place =>
        String(place.countrycode || place.country_code || '').toLocaleUpperCase('pl-PL') === 'PL' &&
        /pomorsk|pomeranian/.test(String(place.state || '').toLocaleLowerCase('pl-PL')) &&
        exactQueryParts.every(part => place.display_name.toLocaleLowerCase('pl-PL').includes(part))
      );

      if (results.length === 0) {
        searchResults = [];
        suggestionsBox.style.display = 'none';
        return;
      }

      renderSearchResults(results);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Błąd wyszukiwania miejsca:', err);
    }
  }, 300);
});

// Ukrywanie podpowiedzi po kliknięciu poza wyszukiwarkę
document.addEventListener('click', (e) => {
  if (!document.getElementById('search-container').contains(e.target)) {
    suggestionsBox.style.display = 'none';
    searchCompleted = Boolean(searchInput.value.trim());
  }
});

function selectPlace(place) {
  searchInput.value = place.display_name;
  suggestionsBox.style.display = 'none';
  searchCompleted = true;

  const lon = parseFloat(place.lon);
  const lat = parseFloat(place.lat);

  if (!previousSearchCamera) {
    previousSearchCamera = {
      center: map.getCenter().toArray(),
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      duration: 1200
    };
  }

  // Przesunięcie kamery na wybrane miejsce
  map.flyTo({
    center: [lon, lat],
    zoom: 16,
    duration: 1200
  });

  // Dodanie lub aktualizacja pinezki wyszukiwania
  if (searchMarker) {
    searchMarker.setLngLat([lon, lat]);
  } else {
    searchMarker = new maplibregl.Marker({ color: '#f59e0b' })
      .setLngLat([lon, lat])
      .addTo(map);
  }

  // Wyświetlenie pełnych informacji w panelu bocznym (wykorzystujemy ten sam panel detali)
  displayPlaceDetails(place);
}

function displayPlaceDetails(place) {
  const addr = place.address || {};
  const street = addr.road || addr.street || addr.pedestrian;
  const streetAddress = street && `${street}${addr.house_number ? ` ${addr.house_number}` : ''}`;
  const locationName = streetAddress || place.name || place.display_name;
  const city = addr.city || addr.town || addr.village || addr.municipality;
  const details = [
    ['Miejscowość', city],
    ['Województwo', addr.state || addr.province],
    ['Państwo', addr.country],
    ['Kod pocztowy', addr.postcode],
    ['Szerokość', place.lat],
    ['Długość', place.lon],
    ['Typ obiektu', place.type || place.osm_value],
    ['OSM ID', place.osm_id]
  ].filter(([, value]) => {
    if (value === undefined || value === null || value === '') return false;
    return !/^(brak|nieznany|unknown|n\/a)$/i.test(String(value).trim());
  });

  menuTitle.innerText = locationName;
  menuBody.innerHTML = '';
  btnSwitch.style.display = 'none';
  btnMin.style.display = 'none';
  btnBackLocation.style.display = '';
  btnCloseLocation.style.display = '';
  const table = document.createElement('table');
  table.className = 'kv-table';
  details.forEach(([label, value]) => {
    const row = table.insertRow();
    row.insertCell().innerText = label;
    row.insertCell().innerText = String(value);
  });
  menuBody.appendChild(table);
  const routeButton = document.createElement('button');
  routeButton.className = 'route-action-btn';
  routeButton.innerText = 'Wyznacz trasę';
  routeButton.addEventListener('click', () => {
    localStorage.setItem('nnaper-route-destination', JSON.stringify(place));
    menuEl.classList.add('route-planner-open');
    window.dispatchEvent(new CustomEvent('nnaper-route-destination-selected', { detail: place }));
  });
  menuBody.appendChild(routeButton);
  pointPanelEl.classList.remove('active');
  expandMenu();
}