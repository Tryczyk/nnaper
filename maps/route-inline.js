(() => {
  const routePlannerPanel = document.getElementById('route-planner-panel');
  const routeStartSuggestions = document.getElementById('route-start-suggestions');
  const routePlannerStops = document.getElementById('route-planner-stops');
  const routePlannerStats = document.getElementById('route-planner-stats');
  const routePlannerHint = document.getElementById('route-planner-hint');
  const btnRouteGoogleMaps = document.getElementById('btn-route-google-maps');
  const routeGoogleOutput = document.getElementById('route-google-output');
  const routeGoogleUrl = document.getElementById('route-google-url');
  const btnCopyGoogleUrl = document.getElementById('btn-copy-google-url');
  const btnOpenGoogleUrl = document.getElementById('btn-open-google-url');
  const routeGoogleFeedback = document.getElementById('route-google-feedback');
  let googleFeedbackTimer = null;
  const btnRouteImportClipboard = document.getElementById('btn-route-import-clipboard');
  const routeImportFeedback = document.getElementById('route-import-feedback');
  let importFeedbackTimer = null;
  const btnOpenPlannerMenu = document.getElementById('btn-open-planner-menu');
  let inlineRouteState = { points: [], mode: null };
  let inlineRouteLayerReady = false;
  let inlineContextLocation = null;
  let routeStartRequestId = 0;
  let routeStartAbortController = null;
  let inlineRouteCalculationTimer = null;
  let inlineRouteCalculationId = 0;
  const inlineContextMenu = document.getElementById('inline-route-context-menu');
  const mapContextMenu = document.getElementById('map-context-menu');
  let mapContextLocation = null;
  const routeSegmentColors = [
    '#0284c7', // 0: Niebieski (Sky Blue)
    '#f97316', // 1: Pomarańczowy (Vivid Orange)
    '#10b981', // 2: Szmaragdowy (Emerald Green)
    '#ec4899', // 3: Różowy (Hot Pink)
    '#8b5cf6', // 4: Fioletowy (Purple)
    '#eab308', // 5: Żółty (Bright Yellow)
    '#06b6d4', // 6: Cyjan (Cyan)
    '#ef4444', // 7: Czerwony (Red)
    '#84cc16', // 8: Limonkowy (Lime Green)
    '#d946ef', // 9: Fuksja (Fuchsia)
    '#3b82f6', // 10: Kobaltowy (Royal Blue)
    '#f59e0b', // 11: Bursztynowy (Amber)
    '#14b8a6', // 12: Morski (Teal)
    '#fb7185', // 13: Koralowy (Coral / Rose)
    '#22c55e', // 14: Jasnozielony (Green)
    '#a855f7', // 15: Lawendowy (Violet)
    '#0ea5e9', // 16: Jasnobłękitny (Light Blue)
    '#e11d48', // 17: Rubinowy (Ruby Crimson)
    '#16a34a', // 18: Żywy zielony (Forest Green)
    '#fdba74'  // 19: Brzoskwiniowy (Peach / Apricot)
  ];
  const MAX_ROUTE_SEGMENTS = 100;
  const photonUrl = (window.NNAPER_CONFIG?.PHOTON_URL || 'https://photon.komoot.io').replace(/\/$/, '');
  const photonBbox = window.NNAPER_CONFIG?.PHOTON_BBOX || '14.1,53.9,19.9,55.9';
  const photonSearchLimit = window.NNAPER_CONFIG?.PHOTON_SEARCH_LIMIT || 50;
  const osrmUrl = (window.NNAPER_CONFIG?.OSRM_URL || 'http://localhost:5000').replace(/\/$/, '');
  document.body.appendChild(inlineContextMenu);
  document.body.appendChild(mapContextMenu);

  let inlinePointColorSequence = 0;

  function getNextAvailablePointColor(prevColor = null, nextColor = null) {
    for (let i = 0; i < routeSegmentColors.length; i += 1) {
      const candidateColor = routeSegmentColors[inlinePointColorSequence % routeSegmentColors.length];
      inlinePointColorSequence += 1;
      if (candidateColor !== prevColor && candidateColor !== nextColor) {
        return candidateColor;
      }
    }
    return routeSegmentColors[0];
  }

  function assignPointColor(point, prevPoint = null, nextPoint = null) {
    if (!point) return routeSegmentColors[0];
    if (point.color) return point.color;
    const prevColor = prevPoint && prevPoint.color ? prevPoint.color : null;
    const nextColor = nextPoint && nextPoint.color ? nextPoint.color : null;
    point.color = getNextAvailablePointColor(prevColor, nextColor);
    return point.color;
  }

  function inlineRoutePointColor(pointOrIndex) {
    if (typeof pointOrIndex === 'object' && pointOrIndex !== null) {
      return assignPointColor(pointOrIndex);
    }
    const idx = Math.max(0, parseInt(pointOrIndex, 10) || 0);
    return routeSegmentColors[idx % routeSegmentColors.length];
  }

  function inlineRoutePlaceLabel(place) {
    if (place.display_name) return place.display_name;
    const street = place.street || place.road || place.pedestrian;
    const streetAddress = street && `${street}${place.housenumber ? ` ${place.housenumber}` : place.house_number ? ` ${place.house_number}` : ''}`;
    return [streetAddress, place.city || place.town || place.village, place.state, place.country]
      .filter(Boolean)
      .join(', ') || place.name || 'Nieznane miejsce';
  }

  function openInlineRoutePlanner(destination) {
    document.getElementById('btn-route-back-to-location').hidden = false;
    inlinePointColorSequence = 0;
    const p1 = { type: 'start', place: null };
    assignPointColor(p1);
    const p2 = { type: 'destination', place: destination };
    assignPointColor(p2, p1);
    inlineRouteState = {
      points: [p1, p2],
      mode: null
    };
    document.getElementById('menu')?.classList.add('route-planner-open');
    window.collapseRightMenu?.();
    routePlannerPanel.classList.add('active');
    routePlannerPanel.setAttribute('aria-hidden', 'false');
    routePlannerStats.innerText = '';
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
  }

  function openInlineRoutePlannerFromStart(start) {
    document.getElementById('btn-route-back-to-location').hidden = true;
    inlinePointColorSequence = 0;
    const p1 = { type: 'start', place: start };
    assignPointColor(p1);
    const p2 = { type: 'destination', place: null };
    assignPointColor(p2, p1);
    inlineRouteState = {
      points: [p1, p2],
      mode: null
    };
    document.getElementById('menu')?.classList.add('route-planner-open');
    window.collapseRightMenu?.();
    routePlannerPanel.classList.add('active');
    routePlannerPanel.setAttribute('aria-hidden', 'false');
    routePlannerStats.innerText = '';
    renderInlineRouteMarkers();
  }

  function closeInlineRoutePlanner() {
    routePlannerPanel.classList.remove('active');
    routePlannerPanel.setAttribute('aria-hidden', 'true');
    document.getElementById('menu')?.classList.remove('route-planner-open');

    if (routeStartSuggestions) routeStartSuggestions.innerHTML = '';
    clearInlineRouteLayer();
    clearInlineRouteMarkers();
    inlineRouteState.points = [];
    inlinePointColorSequence = 0;
    renderInlineRouteMarkers();
    routePlannerStats.innerText = '';
    document.getElementById('btn-route-back-to-location').hidden = true;
    if (routeGoogleOutput) {
      routeGoogleOutput.style.display = 'none';
      if (routeGoogleFeedback) routeGoogleFeedback.innerText = '';
      if (routeGoogleUrl) routeGoogleUrl.value = '';
      if (btnOpenGoogleUrl) btnOpenGoogleUrl.removeAttribute('href');
    }
    if (routeImportFeedback) routeImportFeedback.innerText = '';
  }

  window.addEventListener('nnaper-route-destination-selected', event => {
    openInlineRoutePlanner(event.detail);
  });

  document.getElementById('btn-route-back-to-location').addEventListener('click', () => {
    closeInlineRoutePlanner();
    const place = JSON.parse(localStorage.getItem('nnaper-route-destination') || 'null');
    if (place) displayPlaceDetails(place);
  });

  document.getElementById('btn-route-back-to-original').addEventListener('click', () => {
    closeInlineRoutePlanner();
    if (typeof window.restoreOriginalSearchLocation === 'function') {
      window.restoreOriginalSearchLocation();
    }
  });

  const btnRouteClose = document.getElementById('btn-route-close');
  if (btnRouteClose) {
    btnRouteClose.addEventListener('click', closeInlineRoutePlanner);
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && routePlannerPanel.classList.contains('active')) {
      closeInlineRoutePlanner();
    }
  });

  const searchCache = new Map();
  let inlineSearchDebounceTimer = null;

  function searchInlinePoint(input, point, suggestions) {
    clearTimeout(inlineSearchDebounceTimer);
    const query = input.value.trim();
    const requestId = ++routeStartRequestId;
    if (routeStartAbortController) routeStartAbortController.abort();
    suggestions.innerHTML = '';

    if (!query) {
      point.place = null;
      routePlannerHint.innerText = 'Wpisz miejsce startu.';
      renderInlineRouteMarkers();
      scheduleInlineRouteCalculation();
      return;
    }

    routePlannerHint.innerText = 'Wyszukiwanie...';
    inlineSearchDebounceTimer = setTimeout(() => {
      executeInlinePointSearch(input, point, suggestions, query, requestId);
    }, 250);
  }

  async function executeInlinePointSearch(input, point, suggestions, query, requestId) {
    if (searchCache.has(query)) {
      renderInlineSearchSuggestions(searchCache.get(query), input, point, suggestions, requestId);
      return;
    }

    routeStartAbortController = new AbortController();
    const timeoutId = setTimeout(() => routeStartAbortController.abort(), 4000);

    try {
      const response = await fetch(`${photonUrl}/api/?q=${encodeURIComponent(query)}&limit=${photonSearchLimit}&bbox=${photonBbox}`, {
        signal: routeStartAbortController.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`Photon returned ${response.status}`);
      const data = await response.json();
      if (requestId !== routeStartRequestId) return;
      const features = Array.isArray(data.features) ? data.features : [];
      searchCache.set(query, features);
      renderInlineSearchSuggestions(features, input, point, suggestions, requestId);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError' && requestId !== routeStartRequestId) return;
      if (requestId !== routeStartRequestId) return;
      suggestions.innerHTML = '';
      routePlannerHint.innerText = 'Nie udało się wyszukać adresu (serwer geokodowania nie odpowiada).';
    }
  }

  function renderInlineSearchSuggestions(features, input, point, suggestions, requestId) {
    if (requestId !== routeStartRequestId) return;
    suggestions.innerHTML = '';
    features.slice(0, 6).forEach(feature => {
      const properties = feature.properties || {};
      const coordinates = feature.geometry && feature.geometry.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) return;
      const place = { ...properties, display_name: inlineRoutePlaceLabel(properties), lon: coordinates[0], lat: coordinates[1] };
      const item = document.createElement('div');
      item.className = 'route-start-suggestion';
      item.innerText = place.display_name;
      item.addEventListener('click', () => {
        point.place = place;
        input.value = place.display_name;
        suggestions.innerHTML = '';
        routePlannerHint.innerText = 'Punkt wybrany.';
        renderInlineRouteMarkers();
        scheduleInlineRouteCalculation();
      });
      suggestions.appendChild(item);
    });
    if (!suggestions.children.length) {
      routePlannerHint.innerText = 'Nie znaleziono adresu.';
    } else {
      routePlannerHint.innerText = 'Wybierz podpowiedź z listy.';
    }
  }

  map.on('contextmenu', event => {
    event.preventDefault();
    if (event.originalEvent) event.originalEvent.preventDefault();
    if (routePlannerPanel.classList.contains('active')) {
      inlineContextLocation = { lon: event.lngLat.lng, lat: event.lngLat.lat };
      inlineContextMenu.style.left = `${Math.max(8, Math.min(event.point.x, window.innerWidth - 210))}px`;
      inlineContextMenu.style.top = `${Math.max(8, Math.min(event.point.y, window.innerHeight - 80))}px`;
      inlineContextMenu.classList.add('active');
      return;
    }
    mapContextLocation = { lon: event.lngLat.lng, lat: event.lngLat.lat };
    mapContextMenu.style.left = `${Math.max(8, Math.min(event.point.x, window.innerWidth - 250))}px`;
    mapContextMenu.style.top = `${Math.max(8, Math.min(event.point.y, window.innerHeight - 80))}px`;
    mapContextMenu.classList.add('active');
  });

  const reverseGeocodeCache = new Map();

  async function fetchReverseGeocode(place, timeoutMs = 3000) {
    if (!place || !Number.isFinite(Number(place.lon)) || !Number.isFinite(Number(place.lat))) return null;
    const cacheKey = `${Number(place.lat).toFixed(4)},${Number(place.lon).toFixed(4)}`;
    if (reverseGeocodeCache.has(cacheKey)) {
      return reverseGeocodeCache.get(cacheKey);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${photonUrl}/reverse?lon=${encodeURIComponent(place.lon)}&lat=${encodeURIComponent(place.lat)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (!response.ok) return null;
      const data = await response.json();
      const feature = data.features && data.features[0];
      const properties = feature && feature.properties;
      if (properties) {
        const updated = {
          ...place,
          ...properties,
          display_name: inlineRoutePlaceLabel(properties),
          name: inlineRoutePlaceLabel(properties),
          address: {
            road: properties.street,
            house_number: properties.housenumber,
            city: properties.city || properties.town || properties.village,
            state: properties.state,
            country: properties.country,
            postcode: properties.postcode
          }
        };
        reverseGeocodeCache.set(cacheKey, updated);
        return updated;
      }
    } catch (err) {
      clearTimeout(timer);
    }
    return null;
  }

  function addInlineContextPoint(type) {
    if (!inlineContextLocation) return;
    const loc = inlineContextLocation;
    inlineContextLocation = null;
    inlineContextMenu.classList.remove('active');
    const place = {
      name: 'Pobieranie adresu...',
      display_name: `${Number(loc.lat).toFixed(5)}, ${Number(loc.lon).toFixed(5)}`,
      lon: loc.lon,
      lat: loc.lat
    };
    const prevPoint = inlineRouteState.points.length ? inlineRouteState.points[inlineRouteState.points.length - 1] : null;
    const newPoint = { type: 'destination', place };
    assignPointColor(newPoint, prevPoint, null);
    if (inlineRouteState.points.length === 0) {
      newPoint.type = 'start';
      inlineRouteState.points.push(newPoint);
    } else {
      inlineRouteState.points.push(newPoint);
      inlineRouteState.points.forEach((entry, pointIndex) => {
        entry.type = pointIndex === 0 ? 'start' : (pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop');
      });
    }
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
    reverseGeocodeInlinePoint(place);
  }

  async function reverseGeocodeInlinePoint(place) {
    try {
      const updated = await fetchReverseGeocode(place, 3000);
      if (updated) {
        Object.assign(place, updated);
        renderInlineRouteMarkers();
      } else if (!place.display_name || place.display_name === 'Pobieranie adresu...') {
        place.display_name = `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
        place.name = place.display_name;
        renderInlineRouteMarkers();
      }
    } catch (error) {
      place.display_name = `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
      place.name = place.display_name;
      renderInlineRouteMarkers();
    }
  }

  document.getElementById('inline-context-stop').addEventListener('click', () => addInlineContextPoint('stop'));
  inlineContextMenu.addEventListener('click', event => event.stopPropagation());
  mapContextMenu.addEventListener('click', event => event.stopPropagation());

  document.getElementById('map-context-route').addEventListener('click', () => {
    mapContextMenu.classList.remove('active');
    if (!mapContextLocation) return;
    const loc = mapContextLocation;
    mapContextLocation = null;
    const place = {
      lon: loc.lon,
      lat: loc.lat,
      name: 'Pobieranie adresu...',
      display_name: `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`
    };
    openInlineRoutePlannerFromStart(place);
    reverseGeocodeInlinePoint(place);
  });

  document.getElementById('map-context-info').addEventListener('click', () => {
    mapContextMenu.classList.remove('active');
    if (!mapContextLocation) return;
    const loc = mapContextLocation;
    mapContextLocation = null;
    const place = {
      lon: loc.lon,
      lat: loc.lat,
      name: `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`,
      display_name: `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`,
      address: {}
    };
    if (typeof displayPlaceDetails === 'function') {
      displayPlaceDetails(place);
    }
    fetchReverseGeocode(place, 3000).then(updated => {
      if (updated && typeof displayPlaceDetails === 'function') {
        displayPlaceDetails(updated);
      }
    });
  });

  document.addEventListener('click', event => {
    if (!inlineContextMenu.contains(event.target)) inlineContextMenu.classList.remove('active');
    if (!mapContextMenu.contains(event.target)) mapContextMenu.classList.remove('active');
  });

  function renderInlineRouteLists() {
    routePlannerStops.innerHTML = '';
    if (!inlineRouteState.points.length) {
      const emptyBox = document.createElement('div');
      emptyBox.style.padding = '8px 2px';
      emptyBox.style.textAlign = 'center';

      const emptyPlus = document.createElement('button');
      emptyPlus.type = 'button';
      emptyPlus.className = 'menu-action-btn';
      emptyPlus.style.marginTop = '0';
      emptyPlus.innerText = '+ Dodaj punkt startowy';
      emptyPlus.title = 'Dodaj punkt startowy trasy';
      emptyPlus.onclick = () => {
        inlinePointColorSequence = 0;
        const newPoint = { type: 'start', place: null };
        assignPointColor(newPoint);
        inlineRouteState.points.push(newPoint);
        renderInlineRouteMarkers();
        const input = routePlannerStops.querySelector('input');
        if (input) input.focus();
      };
      emptyBox.appendChild(emptyPlus);
      routePlannerStops.appendChild(emptyBox);
    }
    inlineRouteState.points.forEach((point, index) => {
      const item = document.createElement('li');
      item.className = `route-point-row route-${point.type}-row`;
      item.dataset.pointIndex = String(index);
      const place = point.place;
      const pointColor = assignPointColor(point);
      item.innerHTML = `<span class="route-point-icon" style="background-color: ${pointColor};" aria-hidden="true"></span>`;
      const suggestions = document.createElement('div');
      suggestions.className = 'route-point-suggestions';
      if (point.place) {
        const input = document.createElement('input');
        input.className = 'route-field';
        input.value = inlineRoutePlaceLabel(place);
        input.placeholder = 'Wpisz adres';
        input.autocomplete = 'off';
        input.addEventListener('input', () => searchInlinePoint(input, point, suggestions));
        item.appendChild(input);
      } else {
        const input = document.createElement('input');
        input.className = 'route-field';
        input.placeholder = index === 0 ? 'Wpisz miejsce startu' : 'Wpisz punkt trasy';
        input.autocomplete = 'off';
        input.addEventListener('input', () => searchInlinePoint(input, point, suggestions));
        item.appendChild(input);
      }
      item.appendChild(suggestions);
      const up = document.createElement('button');
      up.type = 'button';
      up.innerText = '↑';
      up.title = 'Przenieś wyżej';
      up.disabled = index === 0;
      up.onclick = () => moveInlinePoint(index, -1);
      const down = document.createElement('button');
      down.type = 'button';
      down.innerText = '↓';
      down.title = 'Przenieś niżej';
      down.disabled = index === inlineRouteState.points.length - 1;
      down.onclick = () => moveInlinePoint(index, 1);
      item.append(up, down);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.innerText = 'Usuń';
      remove.onclick = () => {
        inlineRouteState.points.splice(index, 1);
        inlineRouteState.points.forEach((entry, pointIndex) => {
          entry.type = pointIndex === 0 ? 'start' : pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop';
        });
        if (inlineRouteState.points.length === 0) {
          inlinePointColorSequence = 0;
        }
        renderInlineRouteMarkers();
        scheduleInlineRouteCalculation();
      };
      item.appendChild(remove);
      routePlannerStops.appendChild(item);
      if (index <= inlineRouteState.points.length - 1) {
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'route-insert-btn';
        plus.innerText = '+';
        plus.title = 'Dodaj punkt trasy';
        plus.onclick = () => {
          const prevPoint = inlineRouteState.points[index];
          const nextPoint = inlineRouteState.points[index + 1];
          const newPoint = { type: 'stop', place: null };
          assignPointColor(newPoint, prevPoint, nextPoint);
          inlineRouteState.points.splice(index + 1, 0, newPoint);
          inlineRouteState.points.forEach((entry, pointIndex) => {
            entry.type = pointIndex === 0 ? 'start' : pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop';
          });
          renderInlineRouteMarkers();
          scheduleInlineRouteCalculation();
          const newInput = routePlannerStops.querySelector(`[data-point-index="${index + 1}"] input`);
          if (newInput) newInput.focus();
        };
        routePlannerStops.appendChild(plus);
      }
    });
    updateGoogleMapsOutputIfVisible();
  }

  function moveInlinePoint(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= inlineRouteState.points.length) return;
    const [point] = inlineRouteState.points.splice(index, 1);
    inlineRouteState.points.forEach((entry, pointIndex) => {
      entry.type = pointIndex === 0 ? 'start' : pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop';
    });
    inlineRouteState.points.splice(target, 0, point);
    inlineRouteState.points.forEach((entry, pointIndex) => {
      entry.type = pointIndex === 0 ? 'start' : pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop';
    });
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
  }

  function renderInlineRouteMarkers() {
    clearInlineRouteMarkers();
    renderInlineRouteLists();
    const routePoints = inlineRouteState.points.filter(point => point && point.place);
    routePoints.forEach(point => {
      const { place, type } = point;
      const color = assignPointColor(point);
      const marker = new maplibregl.Marker({ color })
        .setLngLat([Number(place.lon), Number(place.lat)])
        .addTo(map);
      marker.getElement().classList.add('inline-route-marker');
      marker.getElement().classList.add(`inline-route-marker-${type}`);
      marker.getElement().title = type === 'start' ? 'Start' : type === 'destination' ? 'Cel' : 'Punkt trasy';
      marker.getElement().style.cursor = 'default';
    });
  }

  function clearInlineRouteMarkers() {
    document.querySelectorAll('.inline-route-marker').forEach(marker => marker.remove());
  }

  function clearInlineRouteLayer() {
    for (let index = 0; index < MAX_ROUTE_SEGMENTS; index += 1) {
      const layerId = `inline-planned-route-${index}`;
      const sourceId = `inline-planned-route-source-${index}`;
      const casingId = `inline-planned-route-casing-${index}`;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getLayer(casingId)) map.removeLayer(casingId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }

  function bringInlineRouteLayersToFront() {
    for (let index = 0; index < MAX_ROUTE_SEGMENTS; index += 1) {
      const casingId = `inline-planned-route-casing-${index}`;
      const layerId = `inline-planned-route-${index}`;
      if (map.getLayer(casingId)) {
        map.moveLayer(casingId);
      }
      if (map.getLayer(layerId)) {
        map.moveLayer(layerId);
      }
    }
  }

  async function requestOsrmRoutes(coordinates, calculationId) {
    const response = await fetch(
      `${osrmUrl}/route/v1/driving/${coordinates}?overview=full&steps=false&geometries=geojson&alternatives=false`
    );
    if (calculationId !== inlineRouteCalculationId) return [];
    if (!response.ok) throw new Error(`OSRM zwrócił ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.routes)
      ? data.routes.filter(route => route.geometry &&
        Array.isArray(route.geometry.coordinates) &&
        route.geometry.coordinates.length >= 2)
      : [];
  }

  function scheduleInlineRouteCalculation() {
    clearTimeout(inlineRouteCalculationTimer);
    inlineRouteCalculationId += 1;
    clearInlineRouteLayer();
    const validPointsCount = inlineRouteState.points.filter(point => point.place).length;
    if (validPointsCount === 0) {
      routePlannerStats.innerText = '';
    } else if (validPointsCount < 2) {
      routePlannerStats.innerText = 'Wybierz co najmniej dwa punkty trasy.';
    } else {
      routePlannerStats.innerText = 'Wyznaczanie trasy...';
    }
    inlineRouteCalculationTimer = setTimeout(() => {
      calculateInlineRoute();
    }, 350);
  }

  async function calculateInlineRoute() {
    const calculationId = ++inlineRouteCalculationId;
    const routePoints = inlineRouteState.points.filter(point => point && point.place);
    const points = routePoints.map(point => point.place);
    if (points.length < 2) {
      clearInlineRouteLayer();
      if (points.length === 1) {
        routePlannerStats.innerText = 'Wybierz co najmniej dwa punkty trasy.';
      } else {
        routePlannerStats.innerText = '';
      }
      return;
    }
    if (points.some(point => !Number.isFinite(Number(point.lon)) || !Number.isFinite(Number(point.lat)))) {
      routePlannerStats.innerText = 'Jeden z punktów ma nieprawidłowe współrzędne.';
      return;
    }
    routePlannerStats.innerText = 'Wyznaczanie trasy...';
    clearInlineRouteLayer();
    const segmentRoutes = [];

    for (let index = 0; index < points.length - 1; index += 1) {
      try {
        const start = points[index];
        const end = points[index + 1];
        const coordinates = `${start.lon},${start.lat};${end.lon},${end.lat}`;
        const routes = await requestOsrmRoutes(coordinates, calculationId);
        if (!routes.length) throw new Error(`Brak trasy dla odcinka ${index + 1}`);
        const route = routes[0];
        if (calculationId !== inlineRouteCalculationId) return;
        if (!route.geometry || !Array.isArray(route.geometry.coordinates) || route.geometry.coordinates.length < 2) {
          throw new Error(`Odcinek ${index + 1} nie posiada geometrii`);
        }
        segmentRoutes.push(route);

        const sourceId = `inline-planned-route-source-${index}`;
        const layerId = `inline-planned-route-${index}`;
        const casingId = `inline-planned-route-casing-${index}`;

        map.addSource(sourceId, {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: route.geometry,
            properties: {}
          }
        });

        map.addLayer({
          id: casingId,
          type: 'line',
          source: sourceId,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-sort-key': 100000
          },
          paint: {
            'line-color': '#020617',
            'line-width': 9,
            'line-opacity': 0.85
          }
        });

        map.addLayer({
          id: layerId,
          type: 'line',
          source: sourceId,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-sort-key': 100001
          },
          paint: {
            'line-color': assignPointColor(routePoints[index]),
            'line-width': 5.5,
            'line-opacity': 1
          }
        });
      } catch (error) {
        clearInlineRouteLayer();
        routePlannerStats.innerText = error.message === 'Nie można bezpiecznie ominąć punktów zakazu - brak alternatywnej drogi'
          ? error.message
          : 'Nie udało się wyznaczyć trasy.';
        console.error(`Nie udało się wyznaczyć odcinka ${index + 1}:`, error);
        return;
      }
    }

    bringInlineRouteLayersToFront();

    const distance = segmentRoutes.reduce((total, item) => total + Number(item.distance || 0), 0);
    const duration = segmentRoutes.reduce((total, item) => total + Number(item.duration || 0), 0);
    routePlannerStats.innerText = `Dystans: ${(distance / 1000).toFixed(1)} km | Czas: ${Math.round(duration / 60)} min`;
    updateGoogleMapsOutputIfVisible();
  }

  const storedInlineDestination = JSON.parse(localStorage.getItem('nnaper-route-destination') || 'null');
  if (storedInlineDestination) {
    localStorage.removeItem('nnaper-route-destination');
    openInlineRoutePlanner(storedInlineDestination);
  }

  function formatCoord(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return parseFloat(num.toFixed(7));
  }

  function getGoogleMapsRouteUrl() {
    const validCoords = inlineRouteState.points
      .map(point => point && point.place)
      .filter(place => place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)))
      .map(place => {
        const lat = formatCoord(place.lat);
        const lon = formatCoord(place.lon);
        return (lat !== null && lon !== null) ? `${lat},${lon}` : null;
      })
      .filter(Boolean);

    if (validCoords.length < 2) return null;
    return `https://www.google.com/maps/dir/${validCoords.join('/')}`;
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (ok) resolve();
        else reject(new Error('Nie udało się skopiować'));
      } catch (err) {
        reject(err);
      }
    });
  }

  function setGoogleFeedback(message, isError = false) {
    if (!routeGoogleFeedback) return;
    clearTimeout(googleFeedbackTimer);
    routeGoogleFeedback.innerText = message;
    if (isError) {
      routeGoogleFeedback.classList.add('error');
    } else {
      routeGoogleFeedback.classList.remove('error');
    }
    if (!isError && message) {
      googleFeedbackTimer = setTimeout(() => {
        if (routeGoogleFeedback) routeGoogleFeedback.innerText = '';
      }, 4000);
    }
  }

  function updateGoogleMapsOutputIfVisible() {
    if (!routeGoogleOutput || routeGoogleOutput.style.display === 'none') return;
    const url = getGoogleMapsRouteUrl();
    if (url) {
      if (routeGoogleUrl) routeGoogleUrl.value = url;
      if (btnOpenGoogleUrl) btnOpenGoogleUrl.href = url;
    } else {
      if (routeGoogleUrl) routeGoogleUrl.value = '';
      if (btnOpenGoogleUrl) btnOpenGoogleUrl.removeAttribute('href');
    }
  }

  if (btnRouteGoogleMaps) {
    btnRouteGoogleMaps.addEventListener('click', () => {
      const url = getGoogleMapsRouteUrl();
      if (!url) {
        routePlannerStats.innerText = 'Wybierz co najmniej 2 punkty trasy z prawidłowymi współrzędnymi.';
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }

  if (btnCopyGoogleUrl) {
    btnCopyGoogleUrl.addEventListener('click', () => {
      const url = routeGoogleUrl ? routeGoogleUrl.value : getGoogleMapsRouteUrl();
      if (!url) return;
      copyTextToClipboard(url).then(() => {
        const originalText = btnCopyGoogleUrl.innerText;
        btnCopyGoogleUrl.innerText = 'Skopiowano!';
        setGoogleFeedback('✓ Skopiowano link do schowka!', false);
        setTimeout(() => {
          btnCopyGoogleUrl.innerText = originalText;
        }, 2000);
      });
    });
  }

  if (routeGoogleUrl) {
    routeGoogleUrl.addEventListener('click', () => {
      routeGoogleUrl.select();
    });
  }

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
    if (urlMatch) {
      input = urlMatch[1];
    }

    try {
      input = decodeURIComponent(input);
    } catch (e) {
      // Keep input as-is
    }

    if (input.includes('origin=') || input.includes('destination=')) {
      try {
        const normalized = input.startsWith('http') ? input : `https://${input}`;
        const urlObj = new URL(normalized);
        const origin = urlObj.searchParams.get('origin');
        const destination = urlObj.searchParams.get('destination');
        const waypoints = urlObj.searchParams.get('waypoints');
        const list = [];
        if (origin) list.push(origin);
        if (waypoints) {
          waypoints.split('|').forEach(wp => {
            if (wp.trim()) list.push(wp.trim());
          });
        }
        if (destination) list.push(destination);

        const parsed = list.map(item => parseCoordPair(item)).filter(Boolean);
        if (parsed.length >= 2) return parsed;
      } catch (e) {
        // Fall through to path parsing
      }
    }

    let pathPart = input;
    if (pathPart.includes('/dir/')) {
      pathPart = pathPart.split('/dir/')[1] || '';
    }

    pathPart = pathPart.split('?')[0].split('#')[0];
    const segments = pathPart.split('/').map(s => s.trim()).filter(Boolean);
    const coords = [];
    for (const seg of segments) {
      if (seg.startsWith('@') || seg.startsWith('data=')) {
        continue;
      }
      const pair = parseCoordPair(seg);
      if (pair) {
        coords.push(pair);
      }
    }

    return coords;
  }

  function setImportFeedback(message, isError = false) {
    if (!routeImportFeedback) return;
    clearTimeout(importFeedbackTimer);
    routeImportFeedback.innerText = message;
    if (isError) {
      routeImportFeedback.classList.add('error');
    } else {
      routeImportFeedback.classList.remove('error');
    }
    if (!isError && message) {
      importFeedbackTimer = setTimeout(() => {
        if (routeImportFeedback) routeImportFeedback.innerText = '';
      }, 4000);
    }
  }

  function loadRouteFromGoogleMapsUrl(rawInput) {
    const coords = parseGoogleMapsRouteUrl(rawInput);
    if (!coords || coords.length < 2) {
      setImportFeedback('Nie znaleziono poprawnych współrzędnych w podanym linku (wymagane min. 2 punkty).', true);
      return false;
    }

    inlinePointColorSequence = 0;
    inlineRouteState = {
      points: coords.map((c, index) => {
        const type = index === 0 ? 'start' : index === coords.length - 1 ? 'destination' : 'stop';
        const lat = parseFloat(Number(c.lat).toFixed(7));
        const lon = parseFloat(Number(c.lon).toFixed(7));
        const newPoint = {
          type,
          place: {
            lon,
            lat,
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            display_name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`
          }
        };
        assignPointColor(newPoint);
        return newPoint;
      }),
      mode: null
    };

    document.getElementById('menu')?.classList.add('route-planner-open');
    window.collapseRightMenu?.();
    routePlannerPanel.classList.add('active');
    routePlannerPanel.setAttribute('aria-hidden', 'false');
    document.getElementById('btn-route-back-to-location').hidden = true;

    if (routeStartSuggestions) routeStartSuggestions.innerHTML = '';
    clearInlineRouteLayer();

    renderInlineRouteMarkers();

    if (typeof map !== 'undefined' && coords.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      coords.forEach(c => bounds.extend([c.lon, c.lat]));
      map.fitBounds(bounds, { padding: 90, maxZoom: 15 });
    }

    inlineRouteState.points.forEach(point => {
      if (point.place) {
        reverseGeocodeInlinePoint(point.place);
      }
    });

    scheduleInlineRouteCalculation();
    updateGoogleMapsOutputIfVisible();
    setImportFeedback(`✓ Wczytano trasę z ${coords.length} punktów.`, false);
    return true;
  }

  async function handleClipboardRouteImport() {
    let clipText = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        clipText = await navigator.clipboard.readText();
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch (err) {
      console.warn('Clipboard readText failed or permission denied:', err);
      clipText = window.prompt('Wklej link do trasy Google Maps:');
    }

    if (!clipText || !clipText.trim()) {
      setImportFeedback('Schowek jest pusty. Skopiuj link do trasy w Google Maps.', true);
      return;
    }

    loadRouteFromGoogleMapsUrl(clipText.trim());
  }

  if (btnRouteImportClipboard) {
    btnRouteImportClipboard.addEventListener('click', handleClipboardRouteImport);
  }

  window.addEventListener('paste', (e) => {
    if (!routePlannerPanel || !routePlannerPanel.classList.contains('active')) return;
    const targetTag = e.target?.tagName?.toLowerCase();
    if (targetTag === 'input' || targetTag === 'textarea') return;

    const pastedText = e.clipboardData?.getData('text');
    if (pastedText && (pastedText.includes('google.') || pastedText.includes('/dir/'))) {
      e.preventDefault();
      loadRouteFromGoogleMapsUrl(pastedText.trim());
    }
  });

  if (btnOpenPlannerMenu) {
    btnOpenPlannerMenu.addEventListener('click', () => {
      document.getElementById('menu')?.classList.add('route-planner-open');
      window.collapseRightMenu?.();
      routePlannerPanel.classList.add('active');
      routePlannerPanel.setAttribute('aria-hidden', 'false');
      inlineRouteState.points = [];
      inlinePointColorSequence = 0;
      renderInlineRouteMarkers();
      routePlannerStats.innerText = '';
      if (routeImportFeedback) routeImportFeedback.innerText = '';
    });
  }

  window.parseGoogleMapsRouteUrl = parseGoogleMapsRouteUrl;
  window.loadRouteFromGoogleMapsUrl = loadRouteFromGoogleMapsUrl;
  window.getGoogleMapsRouteUrl = getGoogleMapsRouteUrl;
  window.openInlineRoutePlanner = openInlineRoutePlanner;
  window.openInlineRoutePlannerFromStart = openInlineRoutePlannerFromStart;
})();
