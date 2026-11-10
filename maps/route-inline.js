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
  let lastCalculatedPlannedRoute = null;
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
  const apiBaseUrl = (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
  const photonUrl = (window.NNAPER_CONFIG?.PHOTON_URL || `${apiBaseUrl}/api/geocode`).replace(/\/$/, '');
  const photonBbox = window.NNAPER_CONFIG?.PHOTON_BBOX || '14.1,53.9,19.9,55.9';
  const photonSearchLimit = window.NNAPER_CONFIG?.PHOTON_SEARCH_LIMIT || 50;
  const osrmUrl = (window.NNAPER_CONFIG?.OSRM_URL || 'http://localhost:5000').replace(/\/$/, '');
  document.body.appendChild(inlineContextMenu);
  document.body.appendChild(mapContextMenu);

  // Stan punktów unikania oraz preferencji wyznaczania trasy (w tym automatycznego)
  let routeAvoidPoints = []; // [{ lon, lat, radius_m: 300 }]
  let routeAvoidMode = 'high_cost'; // 'high_cost' | 'exclude'
  let pickingAvoidPointOnMap = false;
  let routePreferences = {
    aversion_speed_bumps: 0,
    aversion_intersections: 0,
    aversion_crossings: 0,
    aversion_roundabouts: 0,
    aversion_traffic_signals: 0,
    avoid_traversed: false,
    avoid_highways: false
  };
  let autoRouteConfig = {
    enabled: false,
    target_km: 15,
    target_minutes: 25,
    return_to_start: true
  };

  // Dodajemy przycisk "Dodaj punkt unikania" do menu kontekstowego planera
  const btnInlineContextAvoid = document.createElement('button');
  btnInlineContextAvoid.id = 'inline-context-avoid';
  btnInlineContextAvoid.innerText = 'Dodaj punkt unikania tutaj';
  btnInlineContextAvoid.style.color = '#f87171';
  inlineContextMenu.appendChild(btnInlineContextAvoid);
  btnInlineContextAvoid.addEventListener('click', () => {
    if (!inlineContextLocation) return;
    const loc = inlineContextLocation;
    inlineContextLocation = null;
    inlineContextMenu.classList.remove('active');
    addAvoidPoint(loc.lon, loc.lat, 300);
  });

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
    routePlannerPanel.classList.remove('collapsed');
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
    inlineRouteState = {
      points: [p1],
      mode: null
    };
    document.getElementById('menu')?.classList.add('route-planner-open');
    window.collapseRightMenu?.();
    routePlannerPanel.classList.remove('collapsed');
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
    clearAvoidMarkersAndZones();
    routeAvoidPoints = [];
    pickingAvoidPointOnMap = false;
    inlineRouteState.points = [];
    lastCalculatedPlannedRoute = null;
    inlinePointColorSequence = 0;
    renderInlineRouteMarkers();
    renderAvoidPointsUI();
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

  const btnToggleRoutePlanner = document.getElementById('btn-toggle-route-planner');
  if (btnToggleRoutePlanner) {
    btnToggleRoutePlanner.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCollapsed = routePlannerPanel.classList.toggle('collapsed');
      btnToggleRoutePlanner.setAttribute('title', isCollapsed ? 'Rozwiń panel planowania trasy' : 'Zwiń panel planowania trasy');
      btnToggleRoutePlanner.setAttribute('aria-label', isCollapsed ? 'Rozwiń panel planowania trasy' : 'Zwiń panel planowania trasy');
    });
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

    const emptyPoint = inlineRouteState.points.find(point => !point.place);
    if (emptyPoint) {
      emptyPoint.place = place;
      inlineRouteState.points.forEach((entry, pointIndex) => {
        entry.type = pointIndex === 0 ? 'start' : (pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop');
      });
      renderInlineRouteMarkers();
      scheduleInlineRouteCalculation();
      reverseGeocodeInlinePoint(place);
      return;
    }

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

  const btnMapContextInfo = document.getElementById('map-context-info');
  if (btnMapContextInfo) {
    btnMapContextInfo.addEventListener('click', () => {
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
  }

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

  function createCirclePolygon(lon, lat, radiusM, steps = 36) {
    const coords = [];
    const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * 2 * Math.PI;
      const dLon = (Math.cos(angle) * radiusM) / (111320 * cosLat);
      const dLat = (Math.sin(angle) * radiusM) / 111320;
      coords.push([lon + dLon, lat + dLat]);
    }
    return coords;
  }

  function clearAvoidMarkersAndZones() {
    document.querySelectorAll('.inline-avoid-marker').forEach(m => m.remove());
    if (map.getLayer('inline-avoid-zones-fill')) map.removeLayer('inline-avoid-zones-fill');
    if (map.getLayer('inline-avoid-zones-line')) map.removeLayer('inline-avoid-zones-line');
    if (map.getSource('inline-avoid-zones-src')) map.removeSource('inline-avoid-zones-src');
  }

  function renderAvoidZonesOnMap() {
    clearAvoidMarkersAndZones();
    if (!routeAvoidPoints.length) return;

    const features = routeAvoidPoints.map((ap, idx) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [createCirclePolygon(ap.lon, ap.lat, ap.radius_m || 300)]
      },
      properties: { idx }
    }));

    map.addSource('inline-avoid-zones-src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features }
    });
    map.addLayer({
      id: 'inline-avoid-zones-fill',
      type: 'fill',
      source: 'inline-avoid-zones-src',
      paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.22 }
    });
    map.addLayer({
      id: 'inline-avoid-zones-line',
      type: 'line',
      source: 'inline-avoid-zones-src',
      paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 2] }
    });

    routeAvoidPoints.forEach((ap, idx) => {
      const el = document.createElement('div');
      el.className = 'inline-avoid-marker';
      el.style.cssText = 'width:22px;height:22px;border-radius:50%;background:#ef4444;border:2px solid #fff;color:#fff;font-size:12px;font-weight:bold;display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,0.5);';
      el.innerHTML = '<span style="display:block;width:10px;height:2.5px;background:#fff;border-radius:1px;"></span>';
      el.title = `Punkt unikania #${idx + 1} (promień ${ap.radius_m || 300}m) - przeciągnij aby przesunąć`;

      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([ap.lon, ap.lat])
        .addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        ap.lon = ll.lng;
        ap.lat = ll.lat;
        renderAvoidZonesOnMap();
        renderAvoidPointsUI();
        scheduleInlineRouteCalculation();
      });
    });
  }

  function addAvoidPoint(lon, lat, radiusM = 300) {
    routeAvoidPoints.push({
      lon: Number(lon),
      lat: Number(lat),
      radius_m: Number(radiusM) || 300
    });
    renderAvoidZonesOnMap();
    renderAvoidPointsUI();
    scheduleInlineRouteCalculation();
  }

  function hasCustomRoutingOptions() {
    return true;
  }

  function setupAdvancedRouteControlsUI() {
    if (document.getElementById('route-advanced-controls-box')) return;
    const box = document.createElement('div');
    box.id = 'route-advanced-controls-box';
    box.className = 'route-controls-clean-panel';

    box.innerHTML = `
      <div class="route-quick-actions-row">
        <button type="button" id="btn-route-use-my-loc" class="route-clean-btn route-clean-btn-blue">
          Moja lokalizacja
        </button>
        <button type="button" id="btn-route-pick-avoid" class="route-clean-btn route-clean-btn-red">
          + Punkt unikania
        </button>
      </div>

      <div id="route-avoid-section" class="route-clean-section" style="display:none;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span class="route-clean-section-title" style="color:#f87171; margin:0;">Punkty unikania</span>
          <select id="sel-route-avoid-mode" class="route-clean-select">
            <option value="high_cost">Wysoki koszt</option>
            <option value="exclude">Wyklucz drogę</option>
          </select>
        </div>
        <div id="route-avoid-list" style="display:flex; flex-direction:column; gap:4px;"></div>
      </div>

      <label class="route-clean-toggle-row">
        <span>Unikaj przebytych już dróg</span>
        <input type="checkbox" id="chk-route-avoid-traversed" style="accent-color:#10b981;" />
      </label>

      <label class="route-clean-toggle-row">
        <span>Unikaj autostrad i dróg ekspresowych</span>
        <input type="checkbox" id="chk-route-avoid-highways" style="accent-color:#f59e0b;" />
      </label>

      <div class="route-clean-section">
        <label class="route-clean-toggle-row" style="padding:0; border:none; background:none;">
          <span style="color:#38bdf8; font-weight:600;">Generator trasy automatycznej</span>
          <input type="checkbox" id="chk-route-auto-mode" style="accent-color:#38bdf8;" />
        </label>
        <div id="route-auto-params" style="display:none; flex-direction:column; gap:8px; margin-top:8px; padding-top:8px; border-top:1px solid rgba(148,163,184,0.12);">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <label class="route-clean-metric-field">
              <span>Długość km</span>
              <input type="number" id="inp-route-target-km" min="1" max="500" step="1" value="25" class="route-clean-num-input" />
            </label>
            <label class="route-clean-metric-field">
              <span>Czas min</span>
              <input type="number" id="inp-route-target-min" min="1" max="600" step="5" value="35" class="route-clean-num-input" />
            </label>
          </div>
          <label class="route-clean-subtoggle">
            <input type="checkbox" id="chk-route-auto-loop" checked style="accent-color:#38bdf8;" />
            <span>Pętla powrotna do startu</span>
          </label>
          <button type="button" id="btn-route-generate-auto" class="route-clean-primary-btn">
            Wyznacz trasę automatyczną
          </button>
        </div>
      </div>

      <details id="route-prefs-details" class="route-advanced-box route-clean-details">
        <summary class="route-clean-summary">
          Wagi przeszkód drogowych
        </summary>
        <div style="font-size:10px; color:#94a3b8; margin:4px 0 6px 0; line-height:1.35;">
          Poziom <strong>MAX</strong> na końcu suwaka oznacza <strong>Unikaj zupełnie (Minimum totalne)</strong> — przejazd tylko gdy fizycznie niezbędny.
        </div>
        <div class="route-clean-sliders-list">
          <div class="route-compact-slider-row">
            <span class="route-compact-slider-label">Progi zwalniające</span>
            <input type="range" id="rng-av-bumps" class="route-aversion-range" min="0" max="11" step="1" value="0" />
            <strong id="val-av-bumps" class="route-compact-slider-val">0</strong>
          </div>
          <div class="route-compact-slider-row">
            <span class="route-compact-slider-label">Skrzyżowania</span>
            <input type="range" id="rng-av-inter" class="route-aversion-range" min="0" max="11" step="1" value="0" />
            <strong id="val-av-inter" class="route-compact-slider-val">0</strong>
          </div>
          <div class="route-compact-slider-row">
            <span class="route-compact-slider-label">Przejścia dla pieszych</span>
            <input type="range" id="rng-av-cross" class="route-aversion-range" min="0" max="11" step="1" value="0" />
            <strong id="val-av-cross" class="route-compact-slider-val">0</strong>
          </div>
          <div class="route-compact-slider-row">
            <span class="route-compact-slider-label">Ronda</span>
            <input type="range" id="rng-av-round" class="route-aversion-range" min="0" max="11" step="1" value="0" />
            <strong id="val-av-round" class="route-compact-slider-val">0</strong>
          </div>
          <div class="route-compact-slider-row">
            <span class="route-compact-slider-label">Sygnalizacja świetlna</span>
            <input type="range" id="rng-av-signals" class="route-aversion-range" min="0" max="11" step="1" value="0" />
            <strong id="val-av-signals" class="route-compact-slider-val">0</strong>
          </div>
        </div>
      </details>
    `;

    const listSec = routePlannerPanel.querySelector('.route-list-section');
    if (listSec && listSec.parentNode) {
      listSec.parentNode.insertBefore(box, listSec.nextSibling);
    } else {
      routePlannerPanel.insertBefore(box, routePlannerStats);
    }

    // Obsługa przycisku Moja lokalizacja
    const btnMyLoc = box.querySelector('#btn-route-use-my-loc');
    btnMyLoc.addEventListener('click', () => {
      if (typeof window.locateUserOnMap === 'function') {
        window.locateUserOnMap((coords) => {
          const lon = coords.lon !== undefined ? coords.lon : coords.longitude;
          const lat = coords.lat !== undefined ? coords.lat : coords.latitude;
          setStartPointFromCoords(lon, lat, 'Moja lokalizacja');
        });
      } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
          setStartPointFromCoords(pos.coords.longitude, pos.coords.latitude, 'Moja lokalizacja');
        }, () => {
          alert('Nie udało się odczytać lokalizacji z przeglądarki.');
        });
      }
    });

    // Obsługa trybu klikania punktu unikania na mapie
    const btnPickAvoid = box.querySelector('#btn-route-pick-avoid');
    btnPickAvoid.addEventListener('click', () => {
      pickingAvoidPointOnMap = !pickingAvoidPointOnMap;
      btnPickAvoid.classList.toggle('active', pickingAvoidPointOnMap);
      btnPickAvoid.innerText = pickingAvoidPointOnMap ? 'Kliknij na mapie...' : '+ Punkt unikania';
      routePlannerHint.innerText = pickingAvoidPointOnMap
        ? 'Kliknij lewym przyciskiem na mapie, aby postawić punkt unikania.'
        : 'Punkt unikania można też dodać prawym przyciskiem myszy.';
    });

    map.on('click', (e) => {
      if (!pickingAvoidPointOnMap) return;
      pickingAvoidPointOnMap = false;
      btnPickAvoid.classList.remove('active');
      btnPickAvoid.innerText = '+ Punkt unikania';
      addAvoidPoint(e.lngLat.lng, e.lngLat.lat, 300);
    });

    const selAvoidMode = box.querySelector('#sel-route-avoid-mode');
    selAvoidMode.addEventListener('change', () => {
      routeAvoidMode = selAvoidMode.value;
      scheduleInlineRouteCalculation();
    });

    const chkAvoidTrav = box.querySelector('#chk-route-avoid-traversed');
    chkAvoidTrav.addEventListener('change', () => {
      routePreferences.avoid_traversed = chkAvoidTrav.checked;
      scheduleInlineRouteCalculation();
    });

    const chkAvoidHw = box.querySelector('#chk-route-avoid-highways');
    if (chkAvoidHw) {
      chkAvoidHw.addEventListener('change', () => {
        routePreferences.avoid_highways = chkAvoidHw.checked;
        scheduleInlineRouteCalculation();
      });
    }

    const chkAutoMode = box.querySelector('#chk-route-auto-mode');
    const autoParams = box.querySelector('#route-auto-params');
    const inpKm = box.querySelector('#inp-route-target-km');
    const inpMin = box.querySelector('#inp-route-target-min');
    const chkLoop = box.querySelector('#chk-route-auto-loop');
    const btnGenAuto = box.querySelector('#btn-route-generate-auto');

    chkAutoMode.addEventListener('change', () => {
      autoRouteConfig.enabled = chkAutoMode.checked;
      autoParams.style.display = chkAutoMode.checked ? 'flex' : 'none';
    });
    inpKm.addEventListener('input', () => {
      autoRouteConfig.target_km = parseFloat(inpKm.value) || 0;
      if (autoRouteConfig.target_km > 0) {
        inpMin.value = String(Math.round((autoRouteConfig.target_km / 42) * 60));
        autoRouteConfig.target_minutes = parseFloat(inpMin.value) || 0;
      }
    });
    inpMin.addEventListener('input', () => {
      autoRouteConfig.target_minutes = parseFloat(inpMin.value) || 0;
      if (autoRouteConfig.target_minutes > 0) {
        inpKm.value = String(Math.round(autoRouteConfig.target_minutes * 0.7 * 10) / 10);
        autoRouteConfig.target_km = parseFloat(inpKm.value) || 0;
      }
    });
    chkLoop.addEventListener('change', () => {
      autoRouteConfig.return_to_start = chkLoop.checked;
    });
    btnGenAuto.addEventListener('click', () => {
      autoRouteConfig.enabled = true;
      autoRouteConfig.target_km = parseFloat(inpKm.value) || 25;
      autoRouteConfig.target_minutes = parseFloat(inpMin.value) || 35;
      autoRouteConfig.return_to_start = chkLoop.checked;
      chkAutoMode.checked = true;
      autoParams.style.display = 'flex';
      const validPts = inlineRouteState.points.filter(p => p && p.place);
      if (validPts.length === 0) {
        const c = map.getCenter();
        setStartPointFromCoords(c.lng, c.lat, `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`);
      } else {
        // Zostawiamy punkt startowy (i ewentualny punkt docelowy gdy pętla jest wyłączona), aby wygenerować nowe 10 punktów
        if (autoRouteConfig.return_to_start) {
          inlineRouteState.points = [validPts[0]];
        } else if (validPts.length >= 2 && validPts.length !== 10) {
          inlineRouteState.points = [validPts[0], validPts[validPts.length - 1]];
        } else {
          inlineRouteState.points = [validPts[0]];
        }
        calculateInlineRoute(true);
      }
    });

    const bindAversionSlider = (rngId, valId, prefKey) => {
      const rng = box.querySelector('#' + rngId);
      const val = box.querySelector('#' + valId);
      if (!rng || !val) return;
      rng.addEventListener('input', () => {
        const num = parseFloat(rng.value) || 0;
        if (num >= 11) {
          val.innerText = 'MAX';
          val.style.color = '#f43f5e';
          val.title = 'Unikaj zupełnie (Minimum totalne)';
        } else {
          val.innerText = String(num);
          val.style.color = '';
          val.title = '';
        }
        routePreferences[prefKey] = num;
        scheduleInlineRouteCalculation();
      });
    };
    bindAversionSlider('rng-av-bumps', 'val-av-bumps', 'aversion_speed_bumps');
    bindAversionSlider('rng-av-inter', 'val-av-inter', 'aversion_intersections');
    bindAversionSlider('rng-av-cross', 'val-av-cross', 'aversion_crossings');
    bindAversionSlider('rng-av-round', 'val-av-round', 'aversion_roundabouts');
    bindAversionSlider('rng-av-signals', 'val-av-signals', 'aversion_traffic_signals');
  }

  function setStartPointFromCoords(lon, lat, label) {
    const place = {
      lon: Number(lon),
      lat: Number(lat),
      name: label,
      display_name: label
    };
    if (!inlineRouteState.points.length) {
      const p1 = { type: 'start', place };
      assignPointColor(p1);
      inlineRouteState.points.push(p1);
    } else {
      inlineRouteState.points[0].place = place;
    }
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
    reverseGeocodeInlinePoint(place);
  }

  function renderAvoidPointsUI() {
    setupAdvancedRouteControlsUI();
    const sec = document.getElementById('route-avoid-section');
    const listEl = document.getElementById('route-avoid-list');
    if (!sec || !listEl) return;

    if (!routeAvoidPoints.length) {
      sec.style.display = 'none';
      listEl.innerHTML = '';
      return;
    }
    sec.style.display = 'block';
    listEl.innerHTML = '';

    routeAvoidPoints.forEach((ap, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:4px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:4px; padding:3px 6px; font-size:11px;';
      row.innerHTML = `
        <span>Punkt #${idx + 1} (${ap.lat.toFixed(4)}, ${ap.lon.toFixed(4)})</span>
        <div style="display:flex; align-items:center; gap:4px;">
          <input type="number" min="50" max="5000" step="50" value="${ap.radius_m || 300}" title="Promień unikania (m)" style="width:52px; font-size:10.5px; background:#0f172a; color:#fca5a5; border:1px solid #475569; border-radius:3px; padding:1px 3px; text-align:center;" />
          <span style="font-size:10px;color:#94a3b8;">m</span>
          <button type="button" style="background:none;border:none;color:#f87171;cursor:pointer;font-weight:bold;padding:0 3px;" title="Usuń punkt unikania">&times;</button>
        </div>
      `;
      const radInp = row.querySelector('input');
      radInp.addEventListener('change', () => {
        ap.radius_m = Math.max(50, parseFloat(radInp.value) || 300);
        renderAvoidZonesOnMap();
        scheduleInlineRouteCalculation();
      });
      const delBtn = row.querySelector('button');
      delBtn.addEventListener('click', () => {
        routeAvoidPoints.splice(idx, 1);
        renderAvoidZonesOnMap();
        renderAvoidPointsUI();
        scheduleInlineRouteCalculation();
      });
      listEl.appendChild(row);
    });
  }

  setupAdvancedRouteControlsUI();

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
    const validPointsCount = inlineRouteState.points.filter(point => point && point.place).length;
    if (validPointsCount === 0) {
      routePlannerStats.innerText = '';
    } else if (validPointsCount < 2 && !autoRouteConfig.enabled) {
      routePlannerStats.innerText = 'Wybierz co najmniej dwa punkty trasy (lub włącz tryb automatyczny).';
    } else {
      routePlannerStats.innerText = 'Wyznaczanie trasy...';
    }
    inlineRouteCalculationTimer = setTimeout(() => {
      calculateInlineRoute();
    }, 350);
  }

  async function calculateInlineRoute(forceAutoGenerate = false) {
    const calculationId = ++inlineRouteCalculationId;
    const routePoints = inlineRouteState.points.filter(point => point && point.place);
    const points = routePoints.map(point => point.place);
    const shouldAutoGenerate = forceAutoGenerate || (autoRouteConfig.enabled && points.length === 1);
    if (points.length < 2 && !(shouldAutoGenerate && points.length >= 1)) {
      clearInlineRouteLayer();
      if (points.length === 1) {
        routePlannerStats.innerText = 'Wybierz co najmniej dwa punkty trasy lub użyj generatora trasy.';
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

    // Gdy używane są punkty unikania, preferencje przeszkód, unikanie przebytych dróg lub automatyczny generator trasy —
    // korzystamy z naszego silnika grafowego Go (/api/route/plan)
    if (hasCustomRoutingOptions() || shouldAutoGenerate) {
      try {
        const token = (typeof window.getAuthToken === 'function') ? window.getAuthToken() : '';
        const profileId = (typeof window.getActiveProfileId === 'function') ? window.getActiveProfileId() : '';
        const res = await fetch(`${apiBaseUrl}/api/route/plan?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            points: points.map(p => [Number(p.lon), Number(p.lat)]),
            avoid_points: routeAvoidPoints,
            avoid_mode: routeAvoidMode,
            preferences: routePreferences,
            auto_generate: shouldAutoGenerate,
            target_km: autoRouteConfig.target_km,
            target_minutes: autoRouteConfig.target_minutes,
            return_to_start: autoRouteConfig.return_to_start,
            profile_id: profileId
          })
        });
        if (calculationId !== inlineRouteCalculationId) return;
        if (res.ok) {
          const planData = await res.json();
          if (Array.isArray(planData.coordinates) && planData.coordinates.length >= 2) {
            // Jeśli serwer wygenerował punkty pośrednie (np. 10 punktów w generatorze automatycznym),
            // synchronizujemy je z listą punktów planera i znacznikami na mapie, aby działało "Otwórz w Google"
            if (shouldAutoGenerate && Array.isArray(planData.waypoints) && planData.waypoints.length >= 2) {
              inlinePointColorSequence = 0;
              inlineRouteState.points = planData.waypoints.slice(0, 10).map((wp, idx, arr) => {
                const lon = parseFloat(Number(wp[0]).toFixed(6));
                const lat = parseFloat(Number(wp[1]).toFixed(6));
                const existing = (idx === 0 && points[0]) ? points[0] : null;
                const label = existing && existing.display_name
                  ? existing.display_name
                  : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
                const ptObj = {
                  type: idx === 0 ? 'start' : (idx === arr.length - 1 ? 'destination' : 'stop'),
                  place: {
                    lon,
                    lat,
                    name: label,
                    display_name: label
                  }
                };
                assignPointColor(ptObj);
                return ptObj;
              });
              renderInlineRouteMarkers();
              inlineRouteState.points.forEach((ptObj) => {
                if (ptObj && ptObj.place) {
                  reverseGeocodeInlinePoint(ptObj.place);
                }
              });
            }

            const legs = (Array.isArray(planData.legs) && planData.legs.length)
              ? planData.legs
              : [{ distance_m: planData.distance_m, duration_s: planData.duration_s, coordinates: planData.coordinates }];

            const segmentRoutes = [];
            legs.forEach((leg, index) => {
              const geom = { type: 'LineString', coordinates: leg.coordinates };
              segmentRoutes.push({ distance: leg.distance_m, duration: leg.duration_s, geometry: geom });
              const sourceId = `inline-planned-route-source-${index}`;
              const layerId = `inline-planned-route-${index}`;
              const casingId = `inline-planned-route-casing-${index}`;
              map.addSource(sourceId, {
                type: 'geojson',
                data: { type: 'Feature', geometry: geom, properties: {} }
              });
              map.addLayer({
                id: casingId,
                type: 'line',
                source: sourceId,
                layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': 100000 },
                paint: { 'line-color': '#020617', 'line-width': 9, 'line-opacity': 0.85 }
              });
              map.addLayer({
                id: layerId,
                type: 'line',
                source: sourceId,
                layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': 100001 },
                paint: {
                  'line-color': routeSegmentColors[index % routeSegmentColors.length],
                  'line-width': 5.5,
                  'line-opacity': 1
                }
              });
            });

            bringInlineRouteLayersToFront();
            if (shouldAutoGenerate && planData.coordinates.length >= 2) {
              try {
                const bounds = new maplibregl.LngLatBounds(planData.coordinates[0], planData.coordinates[0]);
                planData.coordinates.forEach(c => bounds.extend(c));
                map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: 750 });
              } catch (e) {}
            }
            const obs = planData.obstacles || {};
            const extraStats = [
              `Przejścia: ${obs.crossings || 0}`,
              `Progi: ${obs.speed_bumps || 0}`,
              `Światła: ${obs.traffic_signals || 0}`,
              `Ronda: ${obs.roundabouts || 0}`,
              `Nowe drogi: ${obs.new_roads_percent !== undefined ? obs.new_roads_percent : 100}%`
            ].join(' | ');
            routePlannerStats.innerHTML = `
              <div><strong>Dystans: ${(planData.distance_m / 1000).toFixed(1)} km | Czas: ${Math.round(planData.duration_s / 60)} min</strong></div>
              <div style="font-size:10.5px; color:#94a3b8; margin-top:3px;">${extraStats}</div>
            `;
            const activePoints = inlineRouteState.points.filter(p => p && p.place);
            lastCalculatedPlannedRoute = {
              points: activePoints.map(p => ({ ...p.place, name: inlineRoutePlaceLabel(p.place) })),
              segmentRoutes,
              distance: planData.distance_m,
              duration: planData.duration_s
            };
            updateGoogleMapsOutputIfVisible();
            return;
          }
        }
      } catch (err) {
        console.warn('Fallback z /api/route/plan do OSRM:', err);
      }
    }

    // Jeśli /api/route/plan nie odpowiedział, a włączono tryb automatyczny, budujemy 10 punktów pętli lokalnie
    let effectivePoints = [...points];
    if (shouldAutoGenerate && effectivePoints.length >= 1) {
      const p0 = effectivePoints[0];
      const sLon = Number(p0.lon);
      const sLat = Number(p0.lat);
      const targetKm = Math.max(2, autoRouteConfig.target_km || (autoRouteConfig.target_minutes || 25) * 0.7);
      const loopRadiusKm = Math.max(0.5, targetKm / (2 * Math.PI * 1.42));
      const cosLat = Math.max(0.2, Math.cos((sLat * Math.PI) / 180));
      const bearing = 0.78;
      const centerLat = sLat + (Math.cos(bearing) * loopRadiusKm) / 111.32;
      const centerLon = sLon + (Math.sin(bearing) * loopRadiusKm) / (111.32 * cosLat);
      const startAngle = bearing + Math.PI;
      effectivePoints = [p0];
      for (let i = 1; i <= 8; i++) {
        const theta = startAngle + (2 * Math.PI * i) / 9.0;
        const wLat = parseFloat((centerLat + (Math.cos(theta) * loopRadiusKm) / 111.32).toFixed(6));
        const wLon = parseFloat((centerLon + (Math.sin(theta) * loopRadiusKm) / (111.32 * cosLat)).toFixed(6));
        effectivePoints.push({
          lon: wLon,
          lat: wLat,
          name: `${wLat.toFixed(5)}, ${wLon.toFixed(5)}`,
          display_name: `${wLat.toFixed(5)}, ${wLon.toFixed(5)}`
        });
      }
      effectivePoints.push({ ...p0 });
      inlinePointColorSequence = 0;
      inlineRouteState.points = effectivePoints.map((pl, idx, arr) => {
        const ptObj = {
          type: idx === 0 ? 'start' : (idx === arr.length - 1 ? 'destination' : 'stop'),
          place: pl
        };
        assignPointColor(ptObj);
        return ptObj;
      });
      renderInlineRouteMarkers();
    }

    const segmentRoutes = [];

    const routeHitsAvoidPoint = (coords, ap) => {
      const rad = Number(ap.radius_m) || 300;
      const cosLat = Math.max(0.2, Math.cos((ap.lat * Math.PI) / 180));
      for (let i = 0; i < coords.length; i++) {
        const dx = (coords[i][0] - ap.lon) * 111320 * cosLat;
        const dy = (coords[i][1] - ap.lat) * 111320;
        if (Math.hypot(dx, dy) <= rad) return true;
      }
      return false;
    };

    for (let index = 0; index < effectivePoints.length - 1; index += 1) {
      try {
        const start = effectivePoints[index];
        const end = effectivePoints[index + 1];
        const coordinates = `${start.lon},${start.lat};${end.lon},${end.lat}`;
        let routes = await requestOsrmRoutes(coordinates, calculationId);
        if (!routes.length) throw new Error(`Brak trasy dla odcinka ${index + 1}`);
        let route = routes[0];
        if (calculationId !== inlineRouteCalculationId) return;

        // Jeśli w fallbacku OSRM trasa przechodzi przez strefę unikania, wyznaczamy objazd prostopadły
        if (routeAvoidPoints.length > 0 && route.geometry && Array.isArray(route.geometry.coordinates)) {
          for (const ap of routeAvoidPoints) {
            if (routeHitsAvoidPoint(route.geometry.coordinates, ap)) {
              const rad = Number(ap.radius_m) || 300;
              const cosLat = Math.max(0.2, Math.cos((ap.lat * Math.PI) / 180));
              const dx = (Number(end.lon) - Number(start.lon)) * cosLat;
              const dy = Number(end.lat) - Number(start.lat);
              const norm = Math.hypot(dx, dy) || 1;
              const nx = -dy / norm;
              const ny = dx / norm;
              for (const mult of [2.0, -2.0, 3.2, -3.2]) {
                const detLon = ap.lon + (nx * rad * mult) / (111320 * cosLat);
                const detLat = ap.lat + (ny * rad * mult) / 111320;
                const detCoords = `${start.lon},${start.lat};${detLon.toFixed(6)},${detLat.toFixed(6)};${end.lon},${end.lat}`;
                const detRoutes = await requestOsrmRoutes(detCoords, calculationId);
                if (detRoutes.length && !routeHitsAvoidPoint(detRoutes[0].geometry.coordinates, ap)) {
                  route = detRoutes[0];
                  break;
                }
              }
            }
          }
        }
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
    lastCalculatedPlannedRoute = {
      points: routePoints.map(p => ({ ...p.place, name: inlineRoutePlaceLabel(p.place) })),
      segmentRoutes: segmentRoutes,
      distance: distance,
      duration: duration
    };
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
    let sourcePlaces = inlineRouteState.points
      .map(point => point && point.place)
      .filter(place => place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)));

    if (sourcePlaces.length < 2 && lastCalculatedPlannedRoute && Array.isArray(lastCalculatedPlannedRoute.points)) {
      sourcePlaces = lastCalculatedPlannedRoute.points.filter(
        place => place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon))
      );
    }

    const validCoords = sourcePlaces
      .slice(0, 10)
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
        setGoogleFeedback('Skopiowano link do schowka!', false);
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
    setImportFeedback(`Wczytano trasę z ${coords.length} punktów.`, false);
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
      if (typeof window.closePlaybackMode === 'function') window.closePlaybackMode();
      document.getElementById('menu')?.classList.add('route-planner-open');
      window.collapseRightMenu?.();
      routePlannerPanel.classList.remove('collapsed');
      routePlannerPanel.classList.add('active');
      routePlannerPanel.setAttribute('aria-hidden', 'false');
      inlineRouteState.points = [];
      inlinePointColorSequence = 0;
      renderInlineRouteMarkers();
      routePlannerStats.innerText = '';
      if (routeImportFeedback) routeImportFeedback.innerText = '';
    });
  }

  const btnRouteDownloadGpx = document.getElementById('btn-route-download-gpx');
  if (btnRouteDownloadGpx) {
    btnRouteDownloadGpx.addEventListener('click', () => {
      const data = getPlannedRouteData();
      if (!data || !Array.isArray(data.points) || data.points.length < 2) {
        routePlannerStats.innerText = 'Zaplanuj najpierw trasę, aby pobrać plik GPX.';
        return;
      }
      const wptsXml = (data.stops || []).map((st, idx) =>
        `  <wpt lat="${Number(st.lat).toFixed(6)}" lon="${Number(st.lon).toFixed(6)}"><name>Punkt ${idx + 1}: ${String(st.name || '').replace(/[<>&"']/g, '')}</name></wpt>`
      ).join('\n');
      const trkptsXml = data.points.map(pt =>
        `      <trkpt lat="${Number(pt.lat).toFixed(6)}" lon="${Number(pt.lon).toFixed(6)}"><time>${pt.timestamp}</time></trkpt>`
      ).join('\n');
      const gpxContent = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NNAPER Route Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Zaplanowana trasa NNAPER (${data.distanceKm.toFixed(1)} km)</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
${wptsXml}
  <trk>
    <name>Trasa NNAPER (${data.distanceKm.toFixed(1)} km, ${data.durationMin} min)</name>
    <trkseg>
${trkptsXml}
    </trkseg>
  </trk>
</gpx>`;
      const blob = new Blob([gpxContent], { type: 'application/gpx+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trasa-nnaper-${Math.round(data.distanceKm)}km.gpx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  function getPlannedRouteDensePoints() {
    if (lastCalculatedPlannedRoute && lastCalculatedPlannedRoute.segmentRoutes && lastCalculatedPlannedRoute.segmentRoutes.length) {
      const dense = [];
      const now = Date.now();
      let ptIdx = 0;
      const totalDistM = lastCalculatedPlannedRoute.distance || 1;
      const totalDurS = lastCalculatedPlannedRoute.duration || 60;
      const avgSpeedKmh = Math.max(10, Math.min(130, (totalDistM / 1000) / (totalDurS / 3600)));

      for (const seg of lastCalculatedPlannedRoute.segmentRoutes) {
        if (seg.geometry && Array.isArray(seg.geometry.coordinates)) {
          for (const [lon, lat] of seg.geometry.coordinates) {
            if (dense.length > 0) {
              const prev = dense[dense.length - 1];
              if (Math.abs(prev.lat - lat) < 1e-7 && Math.abs(prev.lon - lon) < 1e-7) {
                continue;
              }
            }
            dense.push({
              lat: Number(lat),
              lon: Number(lon),
              speed_kmh: Math.round(avgSpeedKmh * 10) / 10,
              altitude: null,
              timestamp: new Date(now + ptIdx * 1000).toISOString()
            });
            ptIdx++;
          }
        }
      }
      if (dense.length >= 2) return dense;
    }

    const validPlaces = (inlineRouteState.points || []).filter(p => p && p.place).map(p => p.place);
    if (validPlaces.length >= 2) {
      return validPlaces.map((pl, i) => ({
        lat: Number(pl.lat),
        lon: Number(pl.lon),
        speed_kmh: 50,
        altitude: null,
        timestamp: new Date(Date.now() + i * 1000).toISOString()
      }));
    }
    return [];
  }

  function getPlannedRouteData() {
    const validPoints = (inlineRouteState.points || []).filter(p => p && p.place);
    if (validPoints.length < 2) return null;

    const points = getPlannedRouteDensePoints();
    if (!points.length) return null;

    const stops = validPoints.map(p => ({
      lat: Number(p.place.lat),
      lon: Number(p.place.lon),
      name: inlineRoutePlaceLabel(p.place)
    }));

    const distKm = lastCalculatedPlannedRoute ? (lastCalculatedPlannedRoute.distance / 1000) : 0;
    const durMin = lastCalculatedPlannedRoute ? Math.round(lastCalculatedPlannedRoute.duration / 60) : 0;

    return {
      points,
      stops,
      distanceKm: distKm,
      durationMin: durMin
    };
  }

  const btnRouteExportPlanned = document.getElementById('btn-route-export-planned');
  if (btnRouteExportPlanned) {
    btnRouteExportPlanned.addEventListener('click', () => {
      const data = getPlannedRouteData();
      if (!data || !data.points || data.points.length < 2) {
        alert('Zaplanuj najpierw trasę z co najmniej dwoma punktami, aby móc ją wyeksportować.');
        return;
      }
      if (typeof window.openExportModal === 'function') {
        window.openExportModal({ scope: 'planned' });
      }
    });
  }

  window.parseGoogleMapsRouteUrl = parseGoogleMapsRouteUrl;
  window.loadRouteFromGoogleMapsUrl = loadRouteFromGoogleMapsUrl;
  window.getGoogleMapsRouteUrl = getGoogleMapsRouteUrl;
  window.openInlineRoutePlanner = openInlineRoutePlanner;
  window.openInlineRoutePlannerFromStart = openInlineRoutePlannerFromStart;
  window.getPlannedRouteData = getPlannedRouteData;
})();
