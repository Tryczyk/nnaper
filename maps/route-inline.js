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
  const routeImportInput = document.getElementById('route-import-input');
  const btnRouteImport = document.getElementById('btn-route-import');
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
  const routeSegmentColors = ['#0284c7', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#e11d48'];
  const photonUrl = (window.NNAPER_CONFIG?.PHOTON_URL || 'https://photon.komoot.io').replace(/\/$/, '');
  const photonBbox = window.NNAPER_CONFIG?.PHOTON_BBOX || '14.1,53.9,19.9,55.9';
  const photonSearchLimit = window.NNAPER_CONFIG?.PHOTON_SEARCH_LIMIT || 50;
  const osrmUrl = (window.NNAPER_CONFIG?.OSRM_URL || 'http://localhost:5000').replace(/\/$/, '');
  document.body.appendChild(inlineContextMenu);
  document.body.appendChild(mapContextMenu);

  function inlineRoutePointColor(index, type = 'stop') {
    if (type === 'destination') return '#dc2626';
    return routeSegmentColors[Math.max(0, index) % routeSegmentColors.length];
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
    inlineRouteState = {
      points: [
        { type: 'start', place: null },
        { type: 'destination', place: destination }
      ],
      mode: null
    };
    document.getElementById('menu')?.classList.add('route-planner-open');
    document.getElementById('menu-right')?.classList.add('route-planner-open');
    routePlannerPanel.classList.add('active');
    routePlannerPanel.setAttribute('aria-hidden', 'false');
    routePlannerStats.innerText = '';
    renderInlineRouteLists();
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
  }

  function openInlineRoutePlannerFromStart(start) {
    document.getElementById('btn-route-back-to-location').hidden = true;
    inlineRouteState = {
      points: [
        { type: 'start', place: start },
        { type: 'destination', place: null }
      ],
      mode: null
    };
    document.getElementById('menu')?.classList.add('route-planner-open');
    document.getElementById('menu-right')?.classList.add('route-planner-open');
    routePlannerPanel.classList.add('active');
    routePlannerPanel.setAttribute('aria-hidden', 'false');
    routePlannerStats.innerText = '';
    renderInlineRouteLists();
    renderInlineRouteMarkers();
  }

  function closeInlineRoutePlanner() {
    routePlannerPanel.classList.remove('active');
    routePlannerPanel.setAttribute('aria-hidden', 'true');
    document.getElementById('menu')?.classList.remove('route-planner-open');
    document.getElementById('menu-right')?.classList.remove('route-planner-open');
    if (routeStartSuggestions) routeStartSuggestions.innerHTML = '';
    clearInlineRouteLayer();
    clearInlineRouteMarkers();
    document.getElementById('btn-route-back-to-location').hidden = true;
    if (routeGoogleOutput) {
      routeGoogleOutput.style.display = 'none';
      if (routeGoogleFeedback) routeGoogleFeedback.innerText = '';
      if (routeGoogleUrl) routeGoogleUrl.value = '';
      if (btnOpenGoogleUrl) btnOpenGoogleUrl.removeAttribute('href');
    }
    if (routeImportInput) routeImportInput.value = '';
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
        renderInlineRouteLists();
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
    inlineRouteState.points.splice(inlineRouteState.points.length - 1, 0, { type: 'stop', place });
    renderInlineRouteLists();
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
    reverseGeocodeInlinePoint(place);
  }

  async function reverseGeocodeInlinePoint(place) {
    try {
      const updated = await fetchReverseGeocode(place, 3000);
      if (updated) {
        Object.assign(place, updated);
        renderInlineRouteLists();
      } else if (!place.display_name || place.display_name === 'Pobieranie adresu...') {
        place.display_name = `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
        place.name = place.display_name;
        renderInlineRouteLists();
      }
    } catch (error) {
      place.display_name = `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
      place.name = place.display_name;
      renderInlineRouteLists();
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
      const emptyPlus = document.createElement('button');
      emptyPlus.type = 'button';
      emptyPlus.className = 'route-insert-btn';
      emptyPlus.innerText = '+';
      emptyPlus.title = 'Dodaj punkt trasy';
      emptyPlus.onclick = () => {
        inlineRouteState.points.push({ type: 'start', place: null });
        renderInlineRouteLists();
        const input = routePlannerStops.querySelector('input');
        if (input) input.focus();
      };
      routePlannerStops.appendChild(emptyPlus);
    }
    inlineRouteState.points.forEach((point, index) => {
      const item = document.createElement('li');
      item.className = `route-point-row route-${point.type}-row`;
      item.dataset.pointIndex = String(index);
      const place = point.place;
      const icon = index === 0 ? '○' : index === inlineRouteState.points.length - 1 ? '●' : '●';
      const pointColor = point.type === 'destination'
        ? '#dc2626'
        : routeSegmentColors[index % routeSegmentColors.length];
      item.innerHTML = `<span class="route-point-icon ${index === inlineRouteState.points.length - 1 ? 'destination' : ''}" style="color: ${pointColor}">${icon}</span>`;
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
        input.placeholder = 'Wpisz miejsce startu';
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
        renderInlineRouteLists();
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
          inlineRouteState.points.splice(index + 1, 0, { type: 'stop', place: null });
          inlineRouteState.points.forEach((entry, pointIndex) => {
            entry.type = pointIndex === 0 ? 'start' : pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop';
          });
          renderInlineRouteLists();
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
    renderInlineRouteLists();
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
  }

  function renderInlineRouteMarkers() {
    clearInlineRouteMarkers();
    const routePoints = inlineRouteState.points.filter(point => point.place);
    inlineRouteState.points.filter(point => point.place).forEach(({ place, type }) => {
      const pointIndex = routePoints.findIndex(point => point.place === place);
      const color = inlineRoutePointColor(pointIndex, type);
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
    for (let index = 0; index < 20; index += 1) {
      const layerId = `inline-planned-route-${index}`;
      const sourceId = `inline-planned-route-source-${index}`;
      const casingId = `inline-planned-route-casing-${index}`;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getLayer(casingId)) map.removeLayer(casingId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }

  function bringInlineRouteLayersToFront() {
    // Przenosimy warstwy trasy na absolutny wierzch stosu renderowania
    for (let index = 0; index < 20; index += 1) {
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
    if (inlineRouteState.points.filter(point => point.place).length < 2) {
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
    const points = inlineRouteState.points.map(point => point.place).filter(Boolean);
    if (points.length < 2) {
      clearInlineRouteLayer();
      routePlannerStats.innerText = 'Wybierz co najmniej dwa punkty trasy.';
      return;
    }
    if (points.some(point => !Number.isFinite(Number(point.lon)) || !Number.isFinite(Number(point.lat)))) {
      routePlannerStats.innerText = 'Jeden z punktów ma nieprawidłowe współrzędne.';
      return;
    }
    routePlannerStats.innerText = 'Wyznaczanie trasy...';
    clearInlineRouteLayer();
    const routePoints = inlineRouteState.points.filter(point => point.place);
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
            'line-color': inlineRoutePointColor(index, routePoints[index]?.type),
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
        if (routeGoogleOutput) routeGoogleOutput.style.display = 'block';
        if (routeGoogleUrl) routeGoogleUrl.value = '';
        if (btnOpenGoogleUrl) btnOpenGoogleUrl.removeAttribute('href');
        setGoogleFeedback('Wybierz co najmniej 2 punkty trasy z prawidłowymi współrzędnymi.', true);
        return;
      }

      if (routeGoogleUrl) routeGoogleUrl.value = url;
      if (btnOpenGoogleUrl) btnOpenGoogleUrl.href = url;
      if (routeGoogleOutput) routeGoogleOutput.style.display = 'block';

      copyTextToClipboard(url)
        .then(() => {
          setGoogleFeedback('✓ Skopiowano link do schowka! Możesz też kliknąć Otwórz ↗', false);
        })
        .catch(() => {
          setGoogleFeedback('Link wygenerowany! Możesz go skopiować lub otworzyć.', false);
        });
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

    inlineRouteState = {
      points: coords.map((c, index) => {
        const type = index === 0 ? 'start' : index === coords.length - 1 ? 'destination' : 'stop';
        const lat = parseFloat(Number(c.lat).toFixed(7));
        const lon = parseFloat(Number(c.lon).toFixed(7));
        return {
          type,
          place: {
            lon,
            lat,
            name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            display_name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`
          }
        };
      }),
      mode: null
    };

    document.getElementById('menu')?.classList.add('route-planner-open');
    document.getElementById('menu-right')?.classList.add('route-planner-open');
    routePlannerPanel.classList.add('active');
    routePlannerPanel.setAttribute('aria-hidden', 'false');
    document.getElementById('btn-route-back-to-location').hidden = true;

    if (routeStartSuggestions) routeStartSuggestions.innerHTML = '';
    clearInlineRouteLayer();
    renderInlineRouteLists();
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

  function handleRouteImport() {
    if (!routeImportInput) return;
    const input = routeImportInput.value.trim();
    if (!input) {
      setImportFeedback('Wklej link do trasy Google Maps.', true);
      return;
    }
    const success = loadRouteFromGoogleMapsUrl(input);
    if (success) {
      routeImportInput.value = '';
    }
  }

  if (btnRouteImport) {
    btnRouteImport.addEventListener('click', handleRouteImport);
  }

  if (routeImportInput) {
    routeImportInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRouteImport();
      }
    });
    routeImportInput.addEventListener('paste', () => {
      setTimeout(handleRouteImport, 20);
    });
  }

  if (btnOpenPlannerMenu) {
    btnOpenPlannerMenu.addEventListener('click', () => {
      document.getElementById('menu')?.classList.add('route-planner-open');
      document.getElementById('menu-right')?.classList.add('route-planner-open');
      routePlannerPanel.classList.add('active');
      routePlannerPanel.setAttribute('aria-hidden', 'false');
      if (!inlineRouteState.points.length) {
        inlineRouteState.points = [
          { type: 'start', place: null },
          { type: 'destination', place: null }
        ];
        renderInlineRouteLists();
        renderInlineRouteMarkers();
      }
      if (routeImportInput) {
        setTimeout(() => routeImportInput.focus(), 50);
      }
    });
  }

  window.parseGoogleMapsRouteUrl = parseGoogleMapsRouteUrl;
  window.loadRouteFromGoogleMapsUrl = loadRouteFromGoogleMapsUrl;
  window.getGoogleMapsRouteUrl = getGoogleMapsRouteUrl;
  window.openInlineRoutePlanner = openInlineRoutePlanner;
  window.openInlineRoutePlannerFromStart = openInlineRoutePlannerFromStart;
})();