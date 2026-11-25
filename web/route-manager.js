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
  let routeAvoidMode = 'exclude'; // 'exclude'
  let pickingAvoidPointOnMap = false;
  let routePreferences = {
    aversion_traversed: 0,
    aversion_highways: 0,
    aversion_below_speed: 0,
    avoid_below_speed_kmh: 50,
    avoid_below_speed: false,
    aversion_above_speed: 0,
    avoid_above_speed_kmh: 90,
    avoid_above_speed: false,
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
    target_km: 25,
    target_minutes: 35,
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
    document.getElementById('btn-search-open-planner')?.classList.add('active');
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
    document.getElementById('btn-search-open-planner')?.classList.add('active');
  }

  function openEmptyRoutePlanner() {
    if (typeof window.closePlaybackMode === 'function') window.closePlaybackMode();
    document.getElementById('btn-route-back-to-location').hidden = true;
    inlinePointColorSequence = 0;
    if (!inlineRouteState.points || inlineRouteState.points.length === 0) {
      const p1 = { type: 'start', place: null };
      assignPointColor(p1);
      const p2 = { type: 'destination', place: null };
      assignPointColor(p2, p1);
      inlineRouteState.points = [p1, p2];
    }
    document.getElementById('menu')?.classList.add('route-planner-open');
    window.collapseRightMenu?.();
    routePlannerPanel.classList.remove('collapsed');
    routePlannerPanel.classList.add('active');
    routePlannerPanel.setAttribute('aria-hidden', 'false');
    routePlannerStats.innerText = '';
    renderInlineRouteMarkers();
    document.getElementById('btn-search-open-planner')?.classList.add('active');
  }

  function toggleRoutePlanner() {
    if (routePlannerPanel && routePlannerPanel.classList.contains('active')) {
      closeInlineRoutePlanner();
    } else {
      openEmptyRoutePlanner();
    }
  }

  function closeInlineRoutePlanner() {
    routePlannerPanel.classList.remove('active');
    routePlannerPanel.classList.remove('collapsed');
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
    document.getElementById('btn-search-open-planner')?.classList.remove('active');
  }

  window.addEventListener('nnaper-route-destination-selected', event => {
    openInlineRoutePlanner(event.detail);
  });

  document.getElementById('btn-route-back-to-location').addEventListener('click', () => {
    closeInlineRoutePlanner();
    const place = JSON.parse(localStorage.getItem('nnaper-route-destination') || 'null');
    if (place) displayPlaceDetails(place);
  });

  const btnRouteBackOriginal = document.getElementById('btn-route-back-to-original');
  if (btnRouteBackOriginal) {
    btnRouteBackOriginal.addEventListener('click', () => {
      closeInlineRoutePlanner();
      if (typeof window.restoreOriginalSearchLocation === 'function') {
        window.restoreOriginalSearchLocation();
      }
    });
  }

  const btnRouteClose = document.getElementById('btn-route-close');
  if (btnRouteClose) {
    btnRouteClose.addEventListener('click', (e) => {
      e.stopPropagation();
      closeInlineRoutePlanner();
    });
  }

  const btnToggleRoutePlanner = document.getElementById('btn-toggle-route-planner');
  if (btnToggleRoutePlanner) {
    btnToggleRoutePlanner.addEventListener('click', (e) => {
      e.stopPropagation();
      closeInlineRoutePlanner();
    });
  }

  const btnSearchOpenPlanner = document.getElementById('btn-search-open-planner');
  if (btnSearchOpenPlanner) {
    btnSearchOpenPlanner.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleRoutePlanner();
    });
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && routePlannerPanel.classList.contains('active')) {
      closeInlineRoutePlanner();
    }
  });

  const searchCache = new Map();
  let inlineSearchDebounceTimer = null;

  function selectInlinePlace(point, place, input, suggestions) {
    point.place = place;
    input.value = place.display_name;
    suggestions.innerHTML = '';
    input._searchResults = [];
    input._highlightedIndex = -1;
    routePlannerHint.innerText = 'Punkt wybrany.';
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();

    const nextEmptyPointIndex = inlineRouteState.points.findIndex(p => !p.place);
    if (nextEmptyPointIndex !== -1) {
      const nextInput = routePlannerStops.querySelector(`[data-point-index="${nextEmptyPointIndex}"] input`);
      if (nextInput && nextInput !== input) {
        nextInput.focus();
      }
    }
  }

  function parseInlinePhotonFeature(feature) {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    return {
      ...properties,
      display_name: inlineRoutePlaceLabel(properties),
      lon: coordinates[0],
      lat: coordinates[1]
    };
  }

  async function fetchInlineGeocodeFeatures(query, signal) {
    if (searchCache.has(query)) {
      return searchCache.get(query);
    }
    let response;
    const primaryUrl = `${photonUrl}/api/?q=${encodeURIComponent(query)}&limit=${photonSearchLimit}&bbox=${photonBbox}`;
    try {
      response = await fetch(primaryUrl, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const localUrl = `${apiBaseUrl}/api/geocode/api/?q=${encodeURIComponent(query)}&limit=${photonSearchLimit}&bbox=${photonBbox}`;
      if (primaryUrl !== localUrl) {
        response = await fetch(localUrl, { signal });
      } else {
        throw err;
      }
    }
    if (!response || !response.ok) throw new Error(`Photon returned ${response ? response.status : 'error'}`);
    const data = await response.json();
    const features = Array.isArray(data.features) ? data.features : [];
    searchCache.set(query, features);
    return features;
  }

  function searchInlinePoint(input, point, suggestions) {
    clearTimeout(inlineSearchDebounceTimer);
    const query = input.value.trim();
    const requestId = ++routeStartRequestId;
    if (routeStartAbortController) routeStartAbortController.abort();
    suggestions.innerHTML = '';
    input._searchResults = [];
    input._highlightedIndex = -1;

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
    routeStartAbortController = new AbortController();
    const timeoutId = setTimeout(() => routeStartAbortController.abort(), 4000);

    try {
      const features = await fetchInlineGeocodeFeatures(query, routeStartAbortController.signal);
      clearTimeout(timeoutId);
      if (requestId !== routeStartRequestId) return;
      renderInlineSearchSuggestions(features, input, point, suggestions, requestId);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError' && requestId !== routeStartRequestId) return;
      if (requestId !== routeStartRequestId) return;
      suggestions.innerHTML = '';
      input._searchResults = [];
      input._highlightedIndex = -1;
      routePlannerHint.innerText = 'Nie udało się wyszukać adresu (serwer geokodowania nie odpowiada).';
    }
  }

  function updateInlineSuggestionsHighlight(suggestions, highlightedIndex) {
    [...suggestions.children].forEach((item, index) => {
      item.classList.toggle('active', index === highlightedIndex);
    });
  }

  function renderInlineSearchSuggestions(features, input, point, suggestions, requestId) {
    if (requestId !== routeStartRequestId) return;
    suggestions.innerHTML = '';
    const places = (Array.isArray(features) ? features : [])
      .map(parseInlinePhotonFeature)
      .filter(Boolean)
      .slice(0, 6);

    input._searchResults = places;
    input._highlightedIndex = -1;

    places.forEach((place, index) => {
      const item = document.createElement('div');
      item.className = 'route-start-suggestion';
      item.innerText = place.display_name;
      item.addEventListener('click', () => {
        selectInlinePlace(point, place, input, suggestions);
      });
      item.addEventListener('mouseenter', () => {
        input._highlightedIndex = index;
        updateInlineSuggestionsHighlight(suggestions, input._highlightedIndex);
      });
      suggestions.appendChild(item);
    });
    if (!places.length) {
      routePlannerHint.innerText = 'Nie znaleziono adresu.';
    } else {
      routePlannerHint.innerText = 'Wybierz podpowiedź z listy lub naciśnij Enter.';
    }
  }

  async function handleInlineSearchSubmit(input, point, suggestions) {
    const query = input.value.trim();
    if (!query) {
      input.focus();
      return;
    }

    if (input._searchResults && input._searchResults.length > 0) {
      const chosenIndex = input._highlightedIndex >= 0 ? input._highlightedIndex : 0;
      selectInlinePlace(point, input._searchResults[chosenIndex], input, suggestions);
      return;
    }

    clearTimeout(inlineSearchDebounceTimer);
    routePlannerHint.innerText = 'Wyszukiwanie...';
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), 4000);
      const rawFeatures = await fetchInlineGeocodeFeatures(query, abortCtrl.signal);
      clearTimeout(timer);
      const places = (Array.isArray(rawFeatures) ? rawFeatures : [])
        .map(parseInlinePhotonFeature)
        .filter(Boolean);
      if (places.length > 0) {
        selectInlinePlace(point, places[0], input, suggestions);
        return;
      }
      routePlannerHint.innerText = 'Nie znaleziono adresu.';
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Błąd bezpośredniego wyszukiwania punktu trasy:', err);
      }
      routePlannerHint.innerText = 'Nie udało się wyszukać adresu.';
    }
  }

  function setupRouteInputEvents(input, point, suggestions) {
    input._searchResults = [];
    input._highlightedIndex = -1;

    input.addEventListener('input', () => searchInlinePoint(input, point, suggestions));

    input.addEventListener('keydown', (e) => {
      const results = input._searchResults || [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!results.length) return;
        e.preventDefault();
        const direction = e.key === 'ArrowDown' ? 1 : -1;
        input._highlightedIndex = (input._highlightedIndex + direction + results.length) % results.length;
        updateInlineSuggestionsHighlight(suggestions, input._highlightedIndex);
        suggestions.children[input._highlightedIndex]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleInlineSearchSubmit(input, point, suggestions);
      } else if (e.key === 'Escape') {
        if (suggestions.children.length > 0) {
          e.stopPropagation();
          suggestions.innerHTML = '';
          input._searchResults = [];
          input._highlightedIndex = -1;
        }
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.route-point-row')) {
      const allSuggestions = routePlannerStops.querySelectorAll('.route-point-suggestions');
      allSuggestions.forEach(box => {
        box.innerHTML = '';
      });
    }
  });

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
      item.innerHTML = '';
      item.style.borderLeft = `4px solid ${pointColor}`;
      item.style.background = `linear-gradient(90deg, ${pointColor}26 0%, rgba(30, 41, 59, 0.6) 42px, #1e293b 100%)`;
      item.style.boxShadow = `inset 1px 0 6px -1px ${pointColor}33`;

      const suggestions = document.createElement('div');
      suggestions.className = 'route-point-suggestions';
      const input = document.createElement('input');
      input.type = 'search';
      input.setAttribute('role', 'searchbox');
      input.className = 'route-field';
      if (point.place) {
        input.value = inlineRoutePlaceLabel(place);
        input.placeholder = 'Wpisz adres';
      } else if (point._pendingQuery) {
        input.value = point._pendingQuery;
        input.placeholder = index === 0 ? 'Wpisz miejsce startu' : 'Wpisz punkt trasy';
      } else {
        input.placeholder = index === 0 ? 'Wpisz miejsce startu' : 'Wpisz punkt trasy';
      }
      input.autocomplete = 'off';
      input.name = `route_stop_${index}`;
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-1p-ignore', 'true');
      input.setAttribute('data-bwignore', 'true');
      input.setAttribute('data-form-type', 'other');
      setupRouteInputEvents(input, point, suggestions);
      item.appendChild(input);
      item.appendChild(suggestions);

      const dragHandle = document.createElement('button');
      dragHandle.type = 'button';
      dragHandle.className = 'route-drag-handle';
      dragHandle.setAttribute('aria-label', 'Przeciągnij, aby zmienić kolejność punktu');
      dragHandle.title = 'Przeciągnij, aby zmienić kolejność (lub użyj strzałek góra/dół)';
      dragHandle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg>';
      setupRoutePointDrag(dragHandle, item, index);
      item.appendChild(dragHandle);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'route-point-remove';
      remove.setAttribute('aria-label', 'Usuń punkt trasy');
      remove.title = 'Usuń punkt trasy';
      remove.innerHTML = '&times;';
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

  function setupRoutePointDrag(dragElement, row, index) {
    dragElement.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (index > 0) {
          moveInlinePoint(index, -1);
          setTimeout(() => {
            const nextHandle = routePlannerStops.querySelector(`[data-point-index="${index - 1}"] .route-drag-handle`);
            if (nextHandle) nextHandle.focus();
          }, 0);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (index < inlineRouteState.points.length - 1) {
          moveInlinePoint(index, 1);
          setTimeout(() => {
            const nextHandle = routePlannerStops.querySelector(`[data-point-index="${index + 1}"] .route-drag-handle`);
            if (nextHandle) nextHandle.focus();
          }, 0);
        }
      }
    });

    if (inlineRouteState.points.length <= 1) {
      dragElement.style.opacity = '0.35';
      dragElement.style.cursor = 'default';
      return;
    }

    dragElement.style.cursor = 'grab';

    function onPointerStart(e) {
      if (e.button !== 0) return;
      e.preventDefault();

      const fromIndex = parseInt(row.dataset.pointIndex, 10);
      const rowRect = row.getBoundingClientRect();
      const offsetY = e.clientY - rowRect.top;
      let currentDropSlot = fromIndex;
      let isCanceled = false;

      try {
        if (dragElement.setPointerCapture) dragElement.setPointerCapture(e.pointerId);
      } catch (_) {}

      // Tworzymy element ghost pod kursorem
      const ghost = row.cloneNode(true);
      ghost.classList.add('route-point-ghost');
      const ghostSug = ghost.querySelector('.route-point-suggestions');
      if (ghostSug) ghostSug.remove();
      const origInput = row.querySelector('input');
      const ghostInput = ghost.querySelector('input');
      if (origInput && ghostInput) ghostInput.value = origInput.value;

      ghost.style.position = 'fixed';
      ghost.style.left = `${rowRect.left}px`;
      ghost.style.top = `${rowRect.top}px`;
      ghost.style.width = `${rowRect.width}px`;
      ghost.style.height = `${rowRect.height}px`;
      ghost.style.zIndex = '10000';
      ghost.style.pointerEvents = 'none';
      document.body.appendChild(ghost);

      row.classList.add('route-point-row-dragging');
      dragElement.classList.add('is-dragging');
      document.body.classList.add('route-dragging-active');

      let dropIndicator = routePlannerStops.querySelector('.route-drop-indicator');
      if (!dropIndicator) {
        dropIndicator = document.createElement('div');
        dropIndicator.className = 'route-drop-indicator';
        routePlannerStops.appendChild(dropIndicator);
      }
      dropIndicator.style.display = 'block';

      function updateDropIndicator() {
        const rows = Array.from(routePlannerStops.querySelectorAll('.route-point-row'));
        if (!rows.length) return;
        const stopsRect = routePlannerStops.getBoundingClientRect();
        if (currentDropSlot < rows.length) {
          const targetRect = rows[currentDropSlot].getBoundingClientRect();
          const topOffset = (targetRect.top - stopsRect.top) - 2;
          dropIndicator.style.top = `${topOffset}px`;
        } else {
          const targetRect = rows[rows.length - 1].getBoundingClientRect();
          const topOffset = (targetRect.bottom - stopsRect.top) + 2;
          dropIndicator.style.top = `${topOffset}px`;
        }
      }

      updateDropIndicator();

      function onPointerMove(moveEvent) {
        if (moveEvent.pointerId !== e.pointerId) return;
        moveEvent.preventDefault();
        ghost.style.top = `${moveEvent.clientY - offsetY}px`;
        ghost.style.left = `${rowRect.left}px`;

        const scrollContainer = routePlannerStops.closest('.route-planner-scroll-body') || routePlannerStops.parentElement;
        if (scrollContainer) {
          const containerRect = scrollContainer.getBoundingClientRect();
          if (moveEvent.clientY < containerRect.top + 35) {
            scrollContainer.scrollTop -= 8;
          } else if (moveEvent.clientY > containerRect.bottom - 35) {
            scrollContainer.scrollTop += 8;
          }
        }

        const rows = Array.from(routePlannerStops.querySelectorAll('.route-point-row'));
        let targetSlot = 0;
        for (let i = 0; i < rows.length; i++) {
          const rRect = rows[i].getBoundingClientRect();
          const midY = rRect.top + rRect.height / 2;
          if (moveEvent.clientY > midY) {
            targetSlot = i + 1;
          }
        }
        currentDropSlot = targetSlot;
        updateDropIndicator();
      }

      function onKeyDown(keyEvent) {
        if (keyEvent.key === 'Escape') {
          isCanceled = true;
          cleanup();
        }
      }

      function cleanup() {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        try {
          if (dragElement.hasPointerCapture(e.pointerId)) {
            dragElement.releasePointerCapture(e.pointerId);
          }
        } catch (_) {}

        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
        if (dropIndicator) dropIndicator.style.display = 'none';
        row.classList.remove('route-point-row-dragging');
        dragElement.classList.remove('is-dragging');
        document.body.classList.remove('route-dragging-active');
      }

      function onPointerUp(upEvent) {
        if (upEvent.pointerId !== e.pointerId) return;
        cleanup();
        if (isCanceled) return;

        let newIndex = currentDropSlot > fromIndex ? currentDropSlot - 1 : currentDropSlot;
        if (newIndex >= inlineRouteState.points.length) newIndex = inlineRouteState.points.length - 1;
        if (newIndex < 0) newIndex = 0;
        if (newIndex !== fromIndex) {
          reorderInlinePoints(fromIndex, newIndex);
        }
      }

      function onPointerCancel(cancelEvent) {
        if (cancelEvent.pointerId !== e.pointerId) return;
        isCanceled = true;
        cleanup();
      }

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    }

    dragElement.addEventListener('pointerdown', onPointerStart);
    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, button')) return;
      onPointerStart(e);
    });
  }

  function reorderInlinePoints(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= inlineRouteState.points.length) return;
    if (toIndex < 0 || toIndex >= inlineRouteState.points.length) return;

    const currentInputs = routePlannerStops.querySelectorAll('.route-point-row input.route-field');
    currentInputs.forEach((inp, idx) => {
      if (inlineRouteState.points[idx] && !inlineRouteState.points[idx].place && inp.value) {
        inlineRouteState.points[idx]._pendingQuery = inp.value;
      }
    });

    const [point] = inlineRouteState.points.splice(fromIndex, 1);
    inlineRouteState.points.splice(toIndex, 0, point);
    inlineRouteState.points.forEach((entry, pointIndex) => {
      entry.type = pointIndex === 0 ? 'start' : pointIndex === inlineRouteState.points.length - 1 ? 'destination' : 'stop';
    });
    renderInlineRouteMarkers();
    scheduleInlineRouteCalculation();
  }

  function moveInlinePoint(index, offset) {
    reorderInlinePoints(index, index + offset);
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
        </div>
        <div id="route-avoid-list" style="display:flex; flex-direction:column; gap:4px;"></div>
      </div>

      <details id="route-prefs-details" class="route-advanced-box route-clean-details" open>
        <summary class="route-clean-summary">
          Wagi unikania przeszkód i dróg (0–9)
        </summary>
        <div class="route-clean-sliders-list">
          <div class="route-compact-slider-row" data-avoid-id="rng-av-traversed">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-traversed" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie: Przebyte już drogi" />
            <label for="chk-av-traversed" class="route-compact-slider-label">Przebyte już drogi</label>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-highways">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-highways" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie: Autostrady i ekspresówki" />
            <label for="chk-av-highways" class="route-compact-slider-label">Autostrady i ekspresówki</label>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-slow">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-slow" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie dróg poniżej wybranej prędkości" />
            <div class="route-compact-slider-label route-slider-label-speed" title="Unikaj dróg z dopuszczalną prędkością poniżej wybranej wartości">
              <span>Drogi &lt;</span>
              <input type="number" id="inp-av-min-speed" class="route-inline-speed-input" min="10" max="140" step="5" value="50" title="Wpisz lub przewiń kółkiem próg prędkości (km/h)" />
              <span>km/h</span>
            </div>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-fast">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-fast" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie dróg powyżej wybranej prędkości" />
            <div class="route-compact-slider-label route-slider-label-speed" title="Unikaj dróg z dopuszczalną prędkością powyżej wybranej wartości">
              <span>Drogi &gt;</span>
              <input type="number" id="inp-av-max-speed" class="route-inline-speed-input" min="10" max="140" step="5" value="90" title="Wpisz lub przewiń kółkiem próg prędkości (km/h)" />
              <span>km/h</span>
            </div>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-bumps">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-bumps" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie: Progi zwalniające" />
            <label for="chk-av-bumps" class="route-compact-slider-label">Progi zwalniające</label>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-signals">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-signals" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie: Sygnalizacja świetlna" />
            <label for="chk-av-signals" class="route-compact-slider-label">Sygnalizacja świetlna</label>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-inter">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-inter" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie: Skrzyżowania" />
            <label for="chk-av-inter" class="route-compact-slider-label">Skrzyżowania</label>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-cross">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-cross" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie: Przejścia dla pieszych" />
            <label for="chk-av-cross" class="route-compact-slider-label">Przejścia dla pieszych</label>
          </div>
          <div class="route-compact-slider-row" data-avoid-id="rng-av-round">
            <button type="button" class="route-drag-handle route-avoid-drag-handle" title="Przeciągnij, aby zmienić priorytet (lub użyj strzałek góra/dół)" aria-label="Zmień priorytet"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="16" cy="19" r="2"/></svg></button>
            <input type="checkbox" id="chk-av-round" class="route-avoid-checkbox" title="Włącz lub wyłącz unikanie: Ronda" />
            <label for="chk-av-round" class="route-compact-slider-label">Ronda</label>
          </div>
        </div>
      </details>

      <div class="route-clean-section" id="route-recreation-generator-section" style="margin-top:2px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="color:#38bdf8; font-weight:600; font-size:12px;">Generator trasy rekreacyjnej</span>
          <input type="checkbox" id="chk-route-auto-mode" checked style="display:none;" />
        </div>
        <div id="route-auto-params" style="display:flex; flex-direction:column; gap:8px;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <label class="route-clean-metric-field">
              <span>Długość km</span>
              <input type="number" id="inp-route-target-km" min="1" max="500" step="1" value="25" placeholder="np. 25" class="route-clean-num-input" />
            </label>
            <label class="route-clean-metric-field">
              <span>Czas min</span>
              <input type="number" id="inp-route-target-min" min="1" max="600" step="1" value="35" placeholder="np. 35" class="route-clean-num-input" />
            </label>
          </div>
          <label class="route-clean-subtoggle">
            <input type="checkbox" id="chk-route-auto-loop" checked style="accent-color:#38bdf8;" />
            <span>Pętla powrotna do startu</span>
          </label>
          <button type="button" id="btn-route-generate-auto" class="route-clean-primary-btn" style="margin-top:4px; display:flex; align-items:center; justify-content:center; gap:6px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            <span>Generuj</span>
          </button>
        </div>
      </div>
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
          if (!coords) return;
          const lon = coords.lon !== undefined ? coords.lon : coords.longitude;
          const lat = coords.lat !== undefined ? coords.lat : coords.latitude;
          if (typeof lon === 'number' && typeof lat === 'number') {
            setStartPointFromCoords(lon, lat, 'Moja lokalizacja');
          }
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

    const chkAutoMode = box.querySelector('#chk-route-auto-mode');
    const autoParams = box.querySelector('#route-auto-params');
    const inpKm = box.querySelector('#inp-route-target-km');
    const inpMin = box.querySelector('#inp-route-target-min');
    const chkLoop = box.querySelector('#chk-route-auto-loop');
    const btnGenAuto = box.querySelector('#btn-route-generate-auto');

    if (chkAutoMode) {
      chkAutoMode.addEventListener('change', () => {
        autoRouteConfig.enabled = chkAutoMode.checked;
        if (autoParams) autoParams.style.display = chkAutoMode.checked ? 'flex' : 'none';
      });
    }

    inpKm.addEventListener('input', () => {
      autoRouteConfig.target_km = parseFloat(inpKm.value) || 0;
    });

    inpMin.addEventListener('input', () => {
      autoRouteConfig.target_minutes = parseFloat(inpMin.value) || 0;
    });

    chkLoop.addEventListener('change', () => {
      autoRouteConfig.return_to_start = chkLoop.checked;
    });

    btnGenAuto.addEventListener('click', async () => {
      const km = parseFloat(inpKm.value) || 0;
      const min = parseFloat(inpMin.value) || 0;
      if (km <= 0 && min <= 0) {
        routePlannerStats.innerText = 'Podaj długość (km) lub czas (min) trasy rekreacyjnej.';
        return;
      }
      autoRouteConfig.enabled = true;
      autoRouteConfig.target_km = km;
      autoRouteConfig.target_minutes = min;
      autoRouteConfig.return_to_start = chkLoop.checked;
      if (chkAutoMode) chkAutoMode.checked = true;

      const originalHtml = btnGenAuto.innerHTML;
      btnGenAuto.disabled = true;
      btnGenAuto.innerText = 'Generowanie...';

      try {
        const validPts = inlineRouteState.points.filter(p => p && p.place);
        if (validPts.length === 0) {
          const c = map.getCenter();
          setStartPointFromCoords(c.lng, c.lat, `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`);
        } else {
          // Zostawiamy punkt startowy (i ewentualny punkt docelowy gdy petla jest wylaczona), aby wygenerowac nowe 10 punktow
          if (autoRouteConfig.return_to_start) {
            inlineRouteState.points = [validPts[0]];
          } else if (validPts.length >= 2 && validPts.length !== 10) {
            inlineRouteState.points = [validPts[0], validPts[validPts.length - 1]];
          } else {
            inlineRouteState.points = [validPts[0]];
          }
        }
        await calculateInlineRoute(true);
      } finally {
        btnGenAuto.disabled = false;
        btnGenAuto.innerHTML = originalHtml;
      }
    });

    const aversionSlidersConfig = [
      { rngId: 'rng-av-traversed', valId: 'val-av-traversed', prefKey: 'aversion_traversed', boolKey: 'avoid_traversed' },
      { rngId: 'rng-av-highways', valId: 'val-av-highways', prefKey: 'aversion_highways', boolKey: 'avoid_highways' },
      { rngId: 'rng-av-slow', valId: 'val-av-slow', prefKey: 'aversion_below_speed', boolKey: 'avoid_below_speed' },
      { rngId: 'rng-av-fast', valId: 'val-av-fast', prefKey: 'aversion_above_speed', boolKey: 'avoid_above_speed' },
      { rngId: 'rng-av-bumps', valId: 'val-av-bumps', prefKey: 'aversion_speed_bumps' },
      { rngId: 'rng-av-signals', valId: 'val-av-signals', prefKey: 'aversion_traffic_signals' },
      { rngId: 'rng-av-inter', valId: 'val-av-inter', prefKey: 'aversion_intersections' },
      { rngId: 'rng-av-cross', valId: 'val-av-cross', prefKey: 'aversion_crossings' },
      { rngId: 'rng-av-round', valId: 'val-av-round', prefKey: 'aversion_roundabouts' }
    ];

    const bindInlineSpeedInput = (inputEl, prefKmhKey, aversionKey, avoidKey, defaultVal) => {
      if (!inputEl) return;
      inputEl.value = String(routePreferences[prefKmhKey] || defaultVal);

      inputEl.addEventListener('click', (e) => e.stopPropagation());
      inputEl.addEventListener('keydown', (e) => e.stopPropagation());

      inputEl.addEventListener('input', () => {
        const raw = inputEl.value.trim();
        if (!raw) return;
        const num = parseInt(raw, 10);
        if (!isNaN(num) && num >= 10 && num <= 140) {
          routePreferences[prefKmhKey] = num;
          if (routePreferences[aversionKey] > 0 || routePreferences[avoidKey]) {
            scheduleInlineRouteCalculation();
          }
        }
      });

      const commitValue = () => {
        let val = parseInt(inputEl.value, 10);
        if (isNaN(val) || val < 10) val = 10;
        if (val > 140) val = 140;
        inputEl.value = String(val);
        routePreferences[prefKmhKey] = val;
        if (routePreferences[aversionKey] > 0 || routePreferences[avoidKey]) {
          scheduleInlineRouteCalculation();
        }
      };

      inputEl.addEventListener('change', commitValue);
      inputEl.addEventListener('blur', commitValue);

      inputEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        let val = parseInt(inputEl.value, 10) || defaultVal;
        val += (e.deltaY < 0 ? 5 : -5);
        if (val < 10) val = 10;
        if (val > 140) val = 140;
        inputEl.value = String(val);
        routePreferences[prefKmhKey] = val;
        if (routePreferences[aversionKey] > 0 || routePreferences[avoidKey]) {
          scheduleInlineRouteCalculation();
        }
      }, { passive: false });
    };

    const inpMinSpeed = box.querySelector('#inp-av-min-speed');
    bindInlineSpeedInput(inpMinSpeed, 'avoid_below_speed_kmh', 'aversion_below_speed', 'avoid_below_speed', 50);

    const inpMaxSpeed = box.querySelector('#inp-av-max-speed');
    bindInlineSpeedInput(inpMaxSpeed, 'avoid_above_speed_kmh', 'aversion_above_speed', 'avoid_above_speed', 90);

    // Maksymalny zakres wagi priorytetu max="9"
    const maxAversionObjects = 9;

    function updateAvoidancePreferencesFromUI(shouldRecalculate = true) {
      const listContainer = box.querySelector('.route-clean-sliders-list');
      if (!listContainer) return;
      const rows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
      let currentRankWeight = maxAversionObjects; // 9

      rows.forEach(row => {
        const avoidId = row.dataset.avoidId;
        const chk = row.querySelector('.route-avoid-checkbox');
        const isChecked = chk ? chk.checked : false;
        const cfgItem = aversionSlidersConfig.find(c => c.rngId === avoidId || c.chkId === avoidId);
        if (!cfgItem) return;

        row.classList.toggle('is-active', isChecked);

        if (isChecked) {
          routePreferences[cfgItem.prefKey] = currentRankWeight;
          if (cfgItem.boolKey) {
            routePreferences[cfgItem.boolKey] = true;
          }
          currentRankWeight = Math.max(1, currentRankWeight - 1);
        } else {
          routePreferences[cfgItem.prefKey] = 0;
          if (cfgItem.boolKey) {
            routePreferences[cfgItem.boolKey] = false;
          }
        }
      });

      saveUserAvoidanceSettings();
      if (shouldRecalculate) {
        scheduleInlineRouteCalculation();
      }
    }

    setupAvoidanceSlidersList(box, updateAvoidancePreferencesFromUI);
  }

  function getUserAvoidanceSettingsKey() {
    const user = (typeof window.getAuthUser === 'function') ? window.getAuthUser() : null;
    const profileId = (typeof window.getActiveProfileId === 'function') ? window.getActiveProfileId() : '';
    const userId = user?.user_id || user?.id || user?.username || '';
    if (userId || profileId) {
      return `nnaper_route_avoidance_settings_${userId || 'anon'}${profileId ? '_' + profileId : ''}`;
    }
    return 'nnaper_route_avoidance_settings';
  }

  function getCustomAvoidanceSettings() {
    try {
      const scopedKey = getUserAvoidanceSettingsKey();
      const raw = localStorage.getItem(scopedKey) || localStorage.getItem('nnaper_route_avoidance_settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (e) {}
    return null;
  }

  function saveCustomAvoidanceSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    try {
      const scopedKey = getUserAvoidanceSettingsKey();
      const json = JSON.stringify(settings);
      localStorage.setItem(scopedKey, json);
      localStorage.setItem('nnaper_route_avoidance_settings', json);
      if (Array.isArray(settings.order)) {
        localStorage.setItem('nnaper_route_avoidance_order', JSON.stringify(settings.order));
      }
    } catch (e) {}
  }

  function getCustomAvoidanceOrder() {
    const s = getCustomAvoidanceSettings();
    if (s && Array.isArray(s.order) && s.order.length > 0) return s.order;
    try {
      const raw = localStorage.getItem('nnaper_route_avoidance_order');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return null;
  }

  function saveCustomAvoidanceOrder(order) {
    if (!Array.isArray(order)) return;
    const s = getCustomAvoidanceSettings() || {};
    s.order = order;
    saveCustomAvoidanceSettings(s);
  }

  function saveUserAvoidanceSettings() {
    const list = document.querySelector('.route-clean-sliders-list');
    if (!list) return;
    const rows = Array.from(list.querySelectorAll('.route-compact-slider-row'));
    const order = rows.map(r => r.dataset.avoidId).filter(Boolean);
    const checked = {};
    rows.forEach(r => {
      const id = r.dataset.avoidId;
      const chk = r.querySelector('.route-avoid-checkbox');
      if (id && chk) {
        checked[id] = chk.checked;
      }
    });
    const inpMin = list.querySelector('#inp-av-min-speed');
    const inpMax = list.querySelector('#inp-av-max-speed');
    saveCustomAvoidanceSettings({
      order,
      checked,
      avoid_below_speed_kmh: inpMin ? parseInt(inpMin.value, 10) || 50 : 50,
      avoid_above_speed_kmh: inpMax ? parseInt(inpMax.value, 10) || 90 : 90
    });
  }

  function syncAvoidanceSlidersOrder(listContainer) {
    if (!listContainer) listContainer = document.querySelector('.route-clean-sliders-list');
    if (!listContainer) return;
    const savedOrder = getCustomAvoidanceOrder();
    if (!savedOrder || !savedOrder.length) return;
    const rows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
    const rowMap = new Map();
    rows.forEach(r => {
      if (r.dataset.avoidId) rowMap.set(r.dataset.avoidId, r);
    });
    savedOrder.forEach(id => {
      const r = rowMap.get(id);
      if (r) {
        listContainer.appendChild(r);
        rowMap.delete(id);
      }
    });
    rowMap.forEach(r => {
      listContainer.appendChild(r);
    });
  }

  function syncAvoidanceSlidersChecked(listContainer) {
    if (!listContainer) listContainer = document.querySelector('.route-clean-sliders-list');
    if (!listContainer) return;
    const settings = getCustomAvoidanceSettings();
    if (!settings) return;

    if (settings.checked && typeof settings.checked === 'object') {
      const rows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
      rows.forEach(r => {
        const id = r.dataset.avoidId;
        const chk = r.querySelector('.route-avoid-checkbox');
        if (chk && id && settings.checked[id] !== undefined) {
          chk.checked = !!settings.checked[id];
          r.classList.toggle('is-active', chk.checked);
        }
      });
    }

    if (settings.avoid_below_speed_kmh) {
      const inpMin = listContainer.querySelector('#inp-av-min-speed');
      if (inpMin) inpMin.value = String(settings.avoid_below_speed_kmh);
      routePreferences.avoid_below_speed_kmh = settings.avoid_below_speed_kmh;
    }
    if (settings.avoid_above_speed_kmh) {
      const inpMax = listContainer.querySelector('#inp-av-max-speed');
      if (inpMax) inpMax.value = String(settings.avoid_above_speed_kmh);
      routePreferences.avoid_above_speed_kmh = settings.avoid_above_speed_kmh;
    }
  }

  function setupAvoidanceSlidersList(box, onUpdate) {
    const listContainer = box.querySelector('.route-clean-sliders-list');
    if (!listContainer) return;
    syncAvoidanceSlidersOrder(listContainer);
    syncAvoidanceSlidersChecked(listContainer);

    const rows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
    rows.forEach(row => {
      const handle = row.querySelector('.route-avoid-drag-handle');
      if (handle) {
        setupAvoidanceSliderDrag(handle, row, listContainer, onUpdate);
      }
      const chk = row.querySelector('.route-avoid-checkbox');
      if (chk) {
        chk.addEventListener('change', () => {
          if (typeof onUpdate === 'function') {
            onUpdate(true);
          }
        });
      }
    });

    if (typeof onUpdate === 'function') {
      onUpdate(false);
    }
  }

  function setupAvoidanceSliderDrag(dragElement, row, listContainer, onUpdate) {
    dragElement.addEventListener('keydown', (e) => {
      const rows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
      const index = rows.indexOf(row);
      if (index === -1) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (index > 0) {
          reorderAvoidanceSliders(index, index - 1, listContainer);
          if (typeof onUpdate === 'function') onUpdate(true);
          setTimeout(() => {
            const nextHandle = row.querySelector('.route-avoid-drag-handle');
            if (nextHandle) nextHandle.focus();
          }, 0);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (index < rows.length - 1) {
          reorderAvoidanceSliders(index, index + 1, listContainer);
          if (typeof onUpdate === 'function') onUpdate(true);
          setTimeout(() => {
            const nextHandle = row.querySelector('.route-avoid-drag-handle');
            if (nextHandle) nextHandle.focus();
          }, 0);
        }
      }
    });

    function onPointerStart(e) {
      if (e.button !== 0) return;

      const rows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
      const fromIndex = rows.indexOf(row);
      if (fromIndex === -1 || rows.length <= 1) return;

      const rowRect = row.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const offsetY = e.clientY - rowRect.top;
      let currentDropSlot = fromIndex;
      let isCanceled = false;
      let isDraggingActive = false;
      let ghost = null;
      let dropIndicator = null;

      function initDragVisuals() {
        if (isDraggingActive) return;
        isDraggingActive = true;

        try {
          if (dragElement.setPointerCapture) dragElement.setPointerCapture(e.pointerId);
        } catch (_) {}

        ghost = row.cloneNode(true);
        ghost.classList.add('route-point-ghost', 'route-compact-slider-row-ghost');
        const origChk = row.querySelector('input[type="checkbox"]');
        const ghostChk = ghost.querySelector('input[type="checkbox"]');
        if (origChk && ghostChk) ghostChk.checked = origChk.checked;
        const origNum = row.querySelector('input[type="number"]');
        const ghostNum = ghost.querySelector('input[type="number"]');
        if (origNum && ghostNum) ghostNum.value = origNum.value;

        ghost.style.position = 'fixed';
        ghost.style.left = `${rowRect.left}px`;
        ghost.style.top = `${rowRect.top}px`;
        ghost.style.width = `${rowRect.width}px`;
        ghost.style.height = `${rowRect.height}px`;
        ghost.style.zIndex = '10000';
        ghost.style.pointerEvents = 'none';
        document.body.appendChild(ghost);

        row.classList.add('route-point-row-dragging');
        dragElement.classList.add('is-dragging');
        document.body.classList.add('route-dragging-active');

        dropIndicator = listContainer.querySelector('.route-avoid-drop-indicator');
        if (!dropIndicator) {
          dropIndicator = document.createElement('div');
          dropIndicator.className = 'route-drop-indicator route-avoid-drop-indicator';
          listContainer.appendChild(dropIndicator);
        }
        dropIndicator.style.display = 'block';
        updateDropIndicator();
      }

      function updateDropIndicator() {
        if (!dropIndicator) return;
        const currentRows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
        if (!currentRows.length) return;
        const contRect = listContainer.getBoundingClientRect();
        if (currentDropSlot < currentRows.length) {
          const targetRect = currentRows[currentDropSlot].getBoundingClientRect();
          const topOffset = (targetRect.top - contRect.top) - 2;
          dropIndicator.style.top = `${topOffset}px`;
        } else {
          const targetRect = currentRows[currentRows.length - 1].getBoundingClientRect();
          const topOffset = (targetRect.bottom - contRect.top) + 2;
          dropIndicator.style.top = `${topOffset}px`;
        }
      }

      function onPointerMove(moveEvent) {
        if (moveEvent.pointerId !== e.pointerId) return;
        if (!isDraggingActive) {
          const dist = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
          if (dist < 4) return;
          initDragVisuals();
        }

        moveEvent.preventDefault();
        if (ghost) {
          ghost.style.top = `${moveEvent.clientY - offsetY}px`;
          ghost.style.left = `${rowRect.left}px`;
        }

        const scrollContainer = listContainer.closest('.route-planner-scroll-body') || listContainer.closest('#route-planner-panel') || listContainer.parentElement;
        if (scrollContainer) {
          const sRect = scrollContainer.getBoundingClientRect();
          if (moveEvent.clientY < sRect.top + 35) {
            scrollContainer.scrollTop -= 8;
          } else if (moveEvent.clientY > sRect.bottom - 35) {
            scrollContainer.scrollTop += 8;
          }
        }

        const currentRows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
        let targetSlot = 0;
        for (let i = 0; i < currentRows.length; i++) {
          const rRect = currentRows[i].getBoundingClientRect();
          const midY = rRect.top + rRect.height / 2;
          if (moveEvent.clientY > midY) {
            targetSlot = i + 1;
          }
        }
        currentDropSlot = targetSlot;
        updateDropIndicator();
      }

      function onKeyDown(keyEvent) {
        if (keyEvent.key === 'Escape') {
          isCanceled = true;
          cleanup();
        }
      }

      function cleanup() {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        try {
          if (dragElement.hasPointerCapture(e.pointerId)) {
            dragElement.releasePointerCapture(e.pointerId);
          }
        } catch (_) {}

        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        if (dropIndicator) dropIndicator.style.display = 'none';
        row.classList.remove('route-point-row-dragging');
        dragElement.classList.remove('is-dragging');
        document.body.classList.remove('route-dragging-active');
      }

      function onPointerUp(upEvent) {
        if (upEvent.pointerId !== e.pointerId) return;
        cleanup();
        if (isCanceled || !isDraggingActive) return;

        let newIndex = currentDropSlot > fromIndex ? currentDropSlot - 1 : currentDropSlot;
        const currentRows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
        if (newIndex >= currentRows.length) newIndex = currentRows.length - 1;
        if (newIndex < 0) newIndex = 0;
        if (newIndex !== fromIndex) {
          reorderAvoidanceSliders(fromIndex, newIndex, listContainer);
          if (typeof onUpdate === 'function') onUpdate(true);
        }
      }

      function onPointerCancel(cancelEvent) {
        if (cancelEvent.pointerId !== e.pointerId) return;
        isCanceled = true;
        cleanup();
      }

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    }

    dragElement.addEventListener('pointerdown', onPointerStart);
  }

  function reorderAvoidanceSliders(fromIndex, toIndex, listContainer) {
    if (!listContainer) listContainer = document.querySelector('.route-clean-sliders-list');
    if (!listContainer) return;
    const rows = Array.from(listContainer.querySelectorAll('.route-compact-slider-row'));
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= rows.length || toIndex >= rows.length) return;

    const movingRow = rows[fromIndex];
    if (toIndex >= rows.length - 1) {
      listContainer.appendChild(movingRow);
    } else if (toIndex > fromIndex) {
      listContainer.insertBefore(movingRow, rows[toIndex + 1]);
    } else {
      listContainer.insertBefore(movingRow, rows[toIndex]);
    }

    saveUserAvoidanceSettings();
  }

  window.addEventListener('nnaper_profile_changed', () => {
    const list = document.querySelector('.route-clean-sliders-list');
    if (list) {
      syncAvoidanceSlidersOrder(list);
      syncAvoidanceSlidersChecked(list);
    }
  });

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
        <button type="button" class="btn-route-avoid-jump" title="Pokaż punkt na mapie" style="background:rgba(239,68,68,0.18); border:1px solid rgba(239,68,68,0.35); color:#fca5a5; cursor:pointer; font-size:11px; font-weight:600; padding:2px 7px; border-radius:4px; display:inline-flex; align-items:center; gap:5px; transition:all 0.15s ease;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><line x1="22" y1="12" x2="18" y2="12"></line><line x1="6" y1="12" x2="2" y2="12"></line><line x1="12" y1="6" x2="12" y2="2"></line><line x1="12" y1="22" x2="12" y2="18"></line></svg>
          <span>Punkt #${idx + 1}</span>
        </button>
        <div style="display:flex; align-items:center; gap:4px;">
          <input type="number" min="50" max="5000" step="50" value="${ap.radius_m || 300}" title="Promień unikania (m)" style="width:52px; font-size:10.5px; background:#0f172a; color:#fca5a5; border:1px solid #475569; border-radius:3px; padding:1px 3px; text-align:center;" />
          <span style="font-size:10px;color:#94a3b8;">m</span>
          <button type="button" class="btn-route-avoid-del" style="background:none;border:none;color:#f87171;cursor:pointer;font-weight:bold;padding:0 3px;" title="Usuń punkt unikania">&times;</button>
        </div>
      `;
      const jumpBtn = row.querySelector('.btn-route-avoid-jump');
      jumpBtn.addEventListener('mouseenter', () => {
        jumpBtn.style.background = 'rgba(239, 68, 68, 0.35)';
        jumpBtn.style.color = '#ffffff';
      });
      jumpBtn.addEventListener('mouseleave', () => {
        jumpBtn.style.background = 'rgba(239, 68, 68, 0.18)';
        jumpBtn.style.color = '#fca5a5';
      });
      jumpBtn.addEventListener('click', () => {
        if (typeof map.flyTo === 'function') {
          map.flyTo({
            center: [ap.lon, ap.lat],
            zoom: Math.max(typeof map.getZoom === 'function' ? map.getZoom() : 14, 15),
            duration: 700
          });
        } else if (typeof map.easeTo === 'function') {
          map.easeTo({
            center: [ap.lon, ap.lat],
            zoom: 15,
            duration: 700
          });
        }
      });
      const radInp = row.querySelector('input');
      radInp.addEventListener('change', () => {
        ap.radius_m = Math.max(50, parseFloat(radInp.value) || 300);
        renderAvoidZonesOnMap();
        scheduleInlineRouteCalculation();
      });
      const delBtn = row.querySelector('.btn-route-avoid-del');
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
            // W trybie automatycznym nie generujemy znacznikow posrednich na mapie - trasa jest przeznaczona bezposrednio do GPX
            if (shouldAutoGenerate) {
              if (inlineRouteState.points.length > 1) {
                inlineRouteState.points = [inlineRouteState.points[0]];
              }
              clearInlineRouteMarkers();
            }

            const legs = (shouldAutoGenerate || !Array.isArray(planData.legs) || !planData.legs.length)
              ? [{ distance_m: planData.distance_m, duration_s: planData.duration_s, coordinates: planData.coordinates }]
              : planData.legs;

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
                  'line-color': shouldAutoGenerate ? '#0284c7' : routeSegmentColors[index % routeSegmentColors.length],
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
              duration: planData.duration_s,
              isAuto: Boolean(shouldAutoGenerate)
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
      let targetKm = 25;
      if (autoRouteConfig.target_km > 0 && autoRouteConfig.target_minutes > 0) {
        targetKm = (autoRouteConfig.target_km + autoRouteConfig.target_minutes * 0.72) / 2.0;
      } else if (autoRouteConfig.target_km > 0) {
        targetKm = autoRouteConfig.target_km;
      } else if (autoRouteConfig.target_minutes > 0) {
        targetKm = autoRouteConfig.target_minutes * 0.72;
      }
      targetKm = Math.max(2, targetKm);
      const loopRadiusKm = Math.max(0.5, targetKm / (2 * Math.PI * 1.35));
      const cosLat = Math.max(0.2, Math.cos((sLat * Math.PI) / 180));
      const bearing = 3.92;
      const centerLat = sLat + (Math.cos(bearing) * loopRadiusKm) / 111.32;
      const centerLon = sLon + (Math.sin(bearing) * loopRadiusKm) / (111.32 * cosLat);
      const startAngle = bearing + Math.PI;
      effectivePoints = [p0];
      for (let i = 1; i <= 5; i++) {
        const theta = startAngle + (2 * Math.PI * i) / 6.0;
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
      if (inlineRouteState.points.length > 1) {
        inlineRouteState.points = [inlineRouteState.points[0]];
      }
      clearInlineRouteMarkers();
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
      duration: duration,
      isAuto: Boolean(shouldAutoGenerate)
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
      if (lastCalculatedPlannedRoute && lastCalculatedPlannedRoute.isAuto) {
        routePlannerStats.innerText = 'Trasa automatyczna jest zoptymalizowana pod eksport GPX (1:1). Uzyj przycisku "Pobierz GPX (1:1)".';
        return;
      }
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
${wptsXml ? wptsXml + '\n' : ''}  <trk>
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
    const points = getPlannedRouteDensePoints();
    if (!points || points.length < 2) return null;

    const validPoints = (inlineRouteState.points || []).filter(p => p && p.place);
    const isAuto = Boolean(lastCalculatedPlannedRoute && lastCalculatedPlannedRoute.isAuto);

    let stops = [];
    if (!isAuto && validPoints.length >= 2) {
      stops = validPoints.map(p => ({
        lat: Number(p.place.lat),
        lon: Number(p.place.lon),
        name: inlineRoutePlaceLabel(p.place)
      }));
    } else if (!isAuto && validPoints.length === 1) {
      stops = [
        {
          lat: Number(validPoints[0].place.lat),
          lon: Number(validPoints[0].place.lon),
          name: inlineRoutePlaceLabel(validPoints[0].place)
        }
      ];
    }

    const distKm = lastCalculatedPlannedRoute ? (lastCalculatedPlannedRoute.distance / 1000) : 0;
    const durMin = lastCalculatedPlannedRoute ? Math.round(lastCalculatedPlannedRoute.duration / 60) : 0;

    return {
      points,
      stops,
      distanceKm: distKm,
      durationMin: durMin,
      isAuto
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
  window.openEmptyRoutePlanner = openEmptyRoutePlanner;
  window.closeInlineRoutePlanner = closeInlineRoutePlanner;
  window.toggleRoutePlanner = toggleRoutePlanner;
  window.getPlannedRouteData = getPlannedRouteData;
  window.getCustomAvoidanceOrder = getCustomAvoidanceOrder;
  window.saveCustomAvoidanceOrder = saveCustomAvoidanceOrder;
  window.reorderAvoidanceSliders = reorderAvoidanceSliders;
})();
