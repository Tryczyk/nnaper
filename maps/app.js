const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

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
  style: MAP_STYLE
});

let navControl = new maplibregl.NavigationControl({ visualizePitch: true });
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

  const label = document.createElement('label');
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

function applyTrackDateFilter(dayCheckboxes, isEverythingActive) {
  const source = map.getSource('gps-track');
  if (!source) return;

  if (!isEverythingActive) {
    if (map.getLayer('GPS / Ślad trasy')) map.setLayoutProperty('GPS / Ślad trasy', 'visibility', 'none');
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }

  const selectedDays = dayCheckboxes.filter(c => c.checked).map(c => c.value);
  if (selectedDays.length === 0) {
    if (map.getLayer('GPS / Ślad trasy')) map.setLayoutProperty('GPS / Ślad trasy', 'visibility', 'none');
    source.setData({ type: 'FeatureCollection', features: [] });
  } else {
    if (map.getLayer('GPS / Ślad trasy')) map.setLayoutProperty('GPS / Ślad trasy', 'visibility', 'visible');
    source.setData(`http://localhost:8000/api/track?days=${selectedDays.join(',')}`);
  }
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
    if (layer.id === 'bg' || layer.id.endsWith('-outline-line') || layer.id.startsWith('sat-')) return;

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

    const pCheckbox = document.createElement('input');
    pCheckbox.type = 'checkbox';
    pCheckbox.checked = true;

    const pTitle = document.createElement('span');
    pTitle.innerText = groupName;

    // DLA GPS: Ukrywamy nadrzędny checkbox, zostawiając samą nazwę
    if (groupName === 'GPS') {
      pCheckbox.style.display = 'none';
    } else {
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
      if (e.target === pCheckbox) return;
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

      const cCheckbox = document.createElement('input');
      cCheckbox.type = 'checkbox';
      cCheckbox.checked = true;

      // DLA GPS: Ukrywamy checkbox przy "Ślad trasy"
      if (child.id === 'GPS / Ślad trasy') {
        cCheckbox.style.display = 'none';
      } else {
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
        else if (child.raw.type === 'circle') map.setPaintProperty(child.id, 'circle-color', col);
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
        if (!map.getLayer(lineOutlineId)) {
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
        sizeInput.addEventListener('input', (e) => map.setPaintProperty(child.id, 'circle-radius', parseFloat(e.target.value)));
        rowSize.appendChild(sizeLabel); rowSize.appendChild(sizeInput);
        ctrlDiv.appendChild(rowSize);

        const rowStroke = document.createElement('div');
        rowStroke.className = 'control-row';
        const strokeLabel = document.createElement('span'); strokeLabel.innerText = 'Obwódka:';
        const strokeColorPicker = document.createElement('input'); strokeColorPicker.type = 'color'; strokeColorPicker.className = 'color-picker'; strokeColorPicker.value = getLayerStrokeColor(child.raw);
        strokeColorPicker.addEventListener('input', (e) => map.setPaintProperty(child.id, 'circle-stroke-color', e.target.value));
        const strokeWidthInput = document.createElement('input'); strokeWidthInput.type = 'range'; strokeWidthInput.min = '0'; strokeWidthInput.max = '8'; strokeWidthInput.step = '0.5'; strokeWidthInput.value = '0';
        strokeWidthInput.addEventListener('input', (e) => map.setPaintProperty(child.id, 'circle-stroke-width', parseFloat(e.target.value)));
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
        if (!map.getLayer(outlineLayerId)) {
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

      if (child.id !== 'GPS / Ślad trasy') {
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

    if (groupName !== 'GPS') {
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
  navControl = new maplibregl.NavigationControl({ visualizePitch: true });
  map.addControl(navControl, isLeft ? 'top-left' : 'top-right');
});

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
  map.addSource('gps-track', { type: 'geojson', data: 'http://localhost:8000/api/track' });

  map.addLayer({
    id: 'GPS / Ślad trasy',
    source: 'gps-track',
    type: 'circle',
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