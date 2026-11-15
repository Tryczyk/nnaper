/**
 * NNAPER Features Manager
 * Obsługuje:
 * 1. Manualną i batchową edycję punktów GPS (zaznaczanie ramką jak na pulpicie, usuwanie, przesuwanie o wektor)
 * 2. Inspekcję POI oraz infrastruktury drogowej po kliknięciu/najechaniu (dane z .osm.pbf)
 * 3. Zczytywanie lokalizacji użytkownika (Geolocation API)
 * 4. Kafelkową Heatmapę (0 = przezroczysty, 1 = zielony, max = czerwony)
 * 5. Odkrywanie mapy (Mgła wojny z deterministycznymi trójkątnymi działkami przydrożnymi)
 * 6. Timelapse zapełniania się mapy
 * 7. Rysowanie po mapie (wielokąty i ścieżki z polem powierzchni, obwodem i długością; zapis w cookies/localStorage lub na serwerze)
 * 8. Panel Ustawień (zmiana nicku, hasła, emaila, presety warstw, widoczność przełączników/sliderów)
 */
(function () {
  const apiBase = (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

  function getAuthTokenSafe() {
    return (typeof window.getAuthToken === 'function') ? window.getAuthToken() : (localStorage.getItem('nnaper_auth_token') || '');
  }

  function getActiveProfileIdSafe() {
    return (typeof window.getActiveProfileId === 'function') ? window.getActiveProfileId() : (localStorage.getItem('nnaper_active_profile_id') || '');
  }

  // Usunieto manualna i batchowa edycje punktow
  window.bindManualEpochEditor = function () {};
  window.toggleBatchEditMode = function () {};

  /* ============================================================================
   * 3. INSPEKCJA PUNKTÓW POI PO KLIKNIĘCIU / NAJECHANIU (WYŁĄCZNIE WARSTWY POI)
   * ============================================================================ */
  const POI_LAYERS_ONLY = [
    'Punkty POI/Miejsca kultu',
    'Punkty POI/Gastronomia',
    'Punkty POI/Opieka zdrowotna',
    'Punkty POI/Sklepy i usługi'
  ];

  const CATEGORY_PL_LABELS = {
    restaurant: 'Gastronomia',
    fast_food: 'Gastronomia',
    cafe: 'Kawiarnia',
    bar: 'Gastronomia',
    pub: 'Gastronomia',
    food_court: 'Gastronomia',
    ice_cream: 'Lodziarnia',
    culture: 'Kultura i turystyka',
    place_of_worship: 'Miejsce kultu',
    museum: 'Muzeum',
    theatre: 'Teatr',
    cinema: 'Kino',
    arts_centre: 'Centrum kultury',
    library: 'Biblioteka',
    attraction: 'Atrakcja',
    viewpoint: 'Punkt widokowy',
    memorial: 'Pomnik / Miejsce pamięci',
    monument: 'Pomnik',
    castle: 'Zamek',
    health: 'Opieka zdrowotna',
    hospital: 'Szpital',
    clinic: 'Przychodnia',
    doctors: 'Gabinet lekarski',
    dentist: 'Stomatolog',
    pharmacy: 'Apteka',
    veterinary: 'Weterynarz',
    shop: 'Sklep i usługi',
    supermarket: 'Supermarket',
    convenience: 'Sklep spożywczy',
    bakery: 'Piekarnia',
    butcher: 'Sklep mięsny',
    clothes: 'Sklep odzieżowy',
    mall: 'Centrum handlowe',
    marketplace: 'Targowisko',
    hairdresser: 'Fryzjer',
    beauty: 'Salon kosmetyczny',
    car_repair: 'Warsztat samochodowy',
    car_wash: 'Myjnia',
    fuel: 'Stacja paliw',
    bank: 'Bank',
    atm: 'Bankomat',
    post_office: 'Poczta',
    hotel: 'Hotel',
    guest_house: 'Pensjonat'
  };

  function getPoiPolishCategory(props, layerId) {
    if (!props) return 'Punkt użyteczności';
    const rawKey = String(props.subcategory || props.subclass || props.category || props.class || props.type || '').toLowerCase();
    if (CATEGORY_PL_LABELS[rawKey]) return CATEGORY_PL_LABELS[rawKey];
    if (layerId) {
      if (layerId.includes('Gastronomia')) return 'Gastronomia';
      if (layerId.includes('Miejsca kultu')) return 'Miejsce kultu';
      if (layerId.includes('Opieka zdrowotna')) return 'Opieka zdrowotna';
      if (layerId.includes('Sklepy i usługi')) return 'Sklep i usługi';
    }
    return 'Punkt użyteczności';
  }

  let poiHoverPopup = null;
  let poiClickPopup = null;

  function setupPoiAndInfraInspector() {
    if (!window.map) return;

    poiHoverPopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
      className: 'nnaper-poi-hover-popup'
    });

    poiClickPopup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: '320px',
      offset: 12,
      className: 'nnaper-poi-click-popup'
    });

    function getActivePoiLayers() {
      return POI_LAYERS_ONLY.filter(id => {
        try {
          return window.map.getLayer(id) && window.map.getLayoutProperty(id, 'visibility') !== 'none';
        } catch (e) {
          return false;
        }
      });
    }

    window.map.on('mousemove', (e) => {
      if (drawingModeActive) return;
      const activeLayers = getActivePoiLayers();
      if (activeLayers.length === 0) {
        poiHoverPopup.remove();
        return;
      }
      const bbox = [[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]];
      const features = window.map.queryRenderedFeatures(bbox, { layers: activeLayers });
      if (!features || features.length === 0) {
        poiHoverPopup.remove();
        return;
      }
      const f = features[0];
      const props = f.properties || {};
      const catLabel = getPoiPolishCategory(props, f.layer?.id);
      const title = props.name || props['name:pl'] || catLabel;
      const hours = props.opening_hours ? `<div style="color:#34d399;font-size:11px;margin-top:2px;">Godziny: ${props.opening_hours}</div>` : '';

      poiHoverPopup
        .setLngLat(e.lngLat)
        .setHTML(`
          <div style="font-size:12px; color:#f8fafc; line-height:1.35;">
            <strong style="color:#38bdf8;">${title}</strong>
            ${title !== catLabel ? `<div style="color:#94a3b8; font-size:11px;">${catLabel}</div>` : ''}
            ${hours}
          </div>
        `)
        .addTo(window.map);
    });

    window.map.on('click', async (e) => {
      if (drawingModeActive) return;
      const routePlanner = document.getElementById('route-planner-panel');
      if (routePlanner && routePlanner.classList.contains('active')) return;
      if (document.body.classList.contains('playback-mode')) return;
      if (window.LayerManager && typeof window.LayerManager.isStyleStudioOpen === 'function' && window.LayerManager.isStyleStudioOpen()) return;

      const activeLayers = getActivePoiLayers();
      if (activeLayers.length === 0) return;

      const bbox = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
      const features = window.map.queryRenderedFeatures(bbox, { layers: activeLayers });
      if (!features || features.length === 0) return;

      const f = features[0];
      const props = f.properties || {};
      const coords = (f.geometry && f.geometry.type === 'Point') ? f.geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];

      poiHoverPopup.remove();

      try {
        const q = new URLSearchParams({
          lat: String(coords[1]),
          lon: String(coords[0])
        });
        if (props.id) q.set('id', String(props.id));
        const res = await fetch(`${apiBase}/api/poi/details?${q.toString()}`);
        let details = props;
        if (res.ok) {
          const fetched = await res.json();
          if (fetched && fetched.category !== 'speed_camera' && fetched.category !== 'avg_speed_camera' && fetched.category !== 'speed_bump' && fetched.category !== 'crossing' && fetched.category !== 'traffic_signals') {
            details = { ...props, ...fetched };
          }
        }
        const catLabel = getPoiPolishCategory(details, f.layer?.id);
        const name = details.name || props.name || catLabel;
        const rows = [];
        if (details.opening_hours) rows.push(['Godziny otwarcia', details.opening_hours]);
        if (details.address) rows.push(['Adres', details.address]);
        if (details.phone) rows.push(['Telefon', details.phone]);
        if (details.website) rows.push(['Strona WWW', `<a href="${details.website}" target="_blank" rel="noopener" style="color:#38bdf8;">${details.website}</a>`]);
        if (details.cuisine) rows.push(['Kuchnia', details.cuisine]);
        if (details.operator) rows.push(['Operator', details.operator]);
        const tags = details.tags || {};
        if (tags.denomination || tags.religion) rows.push(['Wyznanie', [tags.religion, tags.denomination].filter(Boolean).join(' / ')]);
        if (tags.wheelchair) rows.push(['Dostępność', tags.wheelchair]);
        rows.push(['Współrzędne', `${Number(coords[1]).toFixed(5)}, ${Number(coords[0]).toFixed(5)}`]);

        const rowsHtml = rows.map(([k, v]) => `
          <tr>
            <td style="color:#94a3b8; padding:3px 6px 3px 0; font-size:11px; vertical-align:top;">${k}:</td>
            <td style="color:#f1f5f9; padding:3px 0; font-size:11.5px; font-weight:500;">${v}</td>
          </tr>
        `).join('');

        poiClickPopup
          .setLngLat(coords)
          .setHTML(`
            <div style="color:#f8fafc; font-family:inherit;">
              <div style="font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; color:#38bdf8; font-weight:700;">${catLabel}</div>
              <div style="font-size:14px; font-weight:700; margin:2px 0 6px;">${name}</div>
              <table style="width:100%; border-collapse:collapse;">${rowsHtml}</table>
              <div style="margin-top:8px; display:flex; gap:6px;">
                <button type="button" id="btn-poi-route-to" class="route-action-btn" style="width:100%; padding:5px 8px; font-size:11.5px; background:#0284c7; color:#fff; border:none; border-radius:5px; cursor:pointer; font-weight:600;">Wyznacz trasę tutaj</button>
              </div>
            </div>
          `)
          .addTo(window.map);

        setTimeout(() => {
          const btnRouteTo = document.getElementById('btn-poi-route-to');
          if (btnRouteTo) {
            btnRouteTo.addEventListener('click', () => {
              const place = {
                name,
                display_name: name,
                lat: coords[1],
                lon: coords[0]
              };
              localStorage.setItem('nnaper-route-destination', JSON.stringify(place));
              window.dispatchEvent(new CustomEvent('nnaper-route-destination-selected', { detail: place }));
              poiClickPopup.remove();
            });
          }
        }, 30);
      } catch (err) {
        const catLabel = getPoiPolishCategory(props, f.layer?.id);
        poiClickPopup
          .setLngLat(coords)
          .setHTML(`<div style="color:#f8fafc; font-size:12px;"><strong>${props.name || catLabel}</strong><div style="color:#94a3b8; font-size:11px; margin-top:2px;">${catLabel}</div></div>`)
          .addTo(window.map);
      }
    });
  }

  /* ============================================================================
   * 4. ZCZYTYWANIE LOKALIZACJI UŻYTKOWNIKA (GEOLOCATION API)
   * ============================================================================ */
  let userLocationMarker = null;
  let userLocationWatchId = null;
  let lastUserLocation = null;

  function updateUserLocationOnMap(lat, lon, accuracy = 25, fly = true) {
    lastUserLocation = { lat, lon, accuracy };
    if (!window.map) return;

    if (!userLocationMarker) {
      const el = document.createElement('div');
      el.className = 'nnaper-user-location-dot';
      el.title = 'Twoja aktualna lokalizacja GPS';
      userLocationMarker = new maplibregl.Marker({ element: el })
        .setLngLat([lon, lat])
        .addTo(window.map);
    } else {
      userLocationMarker.setLngLat([lon, lat]);
    }

    if (!window.map.getSource('user-location-accuracy-source')) {
      window.map.addSource('user-location-accuracy-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      window.map.addLayer({
        id: 'user-location-accuracy-layer',
        type: 'circle',
        source: 'user-location-accuracy-source',
        paint: {
          'circle-radius': 24,
          'circle-color': 'rgba(56, 189, 248, 0.18)',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#38bdf8'
        }
      });
    }
    const accSrc = window.map.getSource('user-location-accuracy-source');
    if (accSrc) {
      accSrc.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: { accuracy }
        }]
      });
    }

    if (fly) {
      window.map.flyTo({ center: [lon, lat], zoom: Math.max(window.map.getZoom(), 15), duration: 1000 });
    }
  }

  window.locateUserOnMap = function (callback) {
    if (!navigator.geolocation) {
      alert('Twoja przeglądarka nie obsługuje usługi lokalizacji.');
      if (typeof callback === 'function') callback(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        updateUserLocationOnMap(latitude, longitude, accuracy || 20, true);
        if (typeof callback === 'function') callback({ lat: latitude, lon: longitude, accuracy });

        if (userLocationWatchId === null) {
          userLocationWatchId = navigator.geolocation.watchPosition(
            (watchPos) => {
              updateUserLocationOnMap(watchPos.coords.latitude, watchPos.coords.longitude, watchPos.coords.accuracy || 20, false);
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 10000 }
          );
        }
      },
      (err) => {
        console.warn('Geolocation API niedostępne lub odrzucone:', err.message);
        let msg = 'Nie udało się ustalić Twojej lokalizacji.';
        if (err.code === 1) { // PERMISSION_DENIED
          msg = 'Dostęp do lokalizacji jest zablokowany. Zezwól na dostęp w przeglądarce.';
        } else if (err.code === 2) { // POSITION_UNAVAILABLE
          msg = 'Nie można ustalić aktualnej pozycji urządzenia.';
        } else if (err.code === 3) { // TIMEOUT
          msg = 'Przekroczono czas oczekiwania na ustalenie pozycji.';
        }
        alert(msg);
        if (typeof callback === 'function') callback(null);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
    );
  };

  /* ============================================================================
   * 5. HEATMAPA KAFELKOWA (0 = przezroczysty, 1 = zielony, max = czerwony)
   * ============================================================================ */
  let heatmapActive = false;

  async function toggleHeatmap(forceState) {
    heatmapActive = typeof forceState === 'boolean' ? forceState : !heatmapActive;
    const btn = document.getElementById('btn-toggle-heatmap');
    if (btn) {
      btn.classList.toggle('active', heatmapActive);
      btn.setAttribute('aria-pressed', heatmapActive ? 'true' : 'false');
    }
    const legend = document.getElementById('nnaper-heatmap-legend');

    if (!window.map) return;

    if (!heatmapActive) {
      if (window.map.getLayer('nnaper-heatmap-raster-layer')) {
        window.map.setLayoutProperty('nnaper-heatmap-raster-layer', 'visibility', 'none');
      }
      if (legend) legend.style.display = 'none';
      return;
    }

    const token = getAuthTokenSafe();
    const profileId = getActiveProfileIdSafe();
    const tileUrl = `${apiBase}/api/heatmap/tiles/{z}/{x}/{y}.png?token=${encodeURIComponent(token)}&profile_id=${encodeURIComponent(profileId)}&v=${Date.now()}`;

    if (window.map.getLayer('nnaper-heatmap-raster-layer')) {
      window.map.removeLayer('nnaper-heatmap-raster-layer');
    }
    if (window.map.getSource('nnaper-heatmap-raster-source')) {
      window.map.removeSource('nnaper-heatmap-raster-source');
    }

    window.map.addSource('nnaper-heatmap-raster-source', {
      type: 'raster',
      tiles: [tileUrl],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 18
    });

    window.map.addLayer({
      id: 'nnaper-heatmap-raster-layer',
      type: 'raster',
      source: 'nnaper-heatmap-raster-source',
      paint: {
        'raster-opacity': 0.85,
        'raster-resampling': 'nearest'
      }
    });

    if (legend) {
      legend.style.display = 'flex';
      try {
        const b = window.map.getBounds();
        const bboxStr = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
        const res = await fetch(`${apiBase}/api/heatmap/grid?token=${encodeURIComponent(token)}&profile_id=${encodeURIComponent(profileId)}&bbox=${encodeURIComponent(bboxStr)}&cols=64&rows=64`);
        if (res.ok) {
          const data = await res.json();
          const maxEl = document.getElementById('heatmap-legend-max');
          if (maxEl) maxEl.innerText = `Max: ${data.max_count || 1} pkt/px (Czerwony)`;
        }
      } catch (e) {}
    }
  }
  window.toggleHeatmap = toggleHeatmap;

  /* ============================================================================
   * 6. ODKRYWANIE MAPY (MGŁA WOJNY - ZASŁANIAJĄCE TRÓJKĄTY DZIAŁEK)
   * ============================================================================ */
  let fogOfWarActive = false;
  let fogMoveListenerAttached = false;

  async function refreshFogOfWarData() {
    if (!fogOfWarActive || !window.map) return;
    const token = getAuthTokenSafe();
    const profileId = getActiveProfileIdSafe();
    try {
      const b = window.map.getBounds();
      const bboxStr = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      const res = await fetch(`${apiBase}/api/fog-of-war?token=${encodeURIComponent(token)}&profile_id=${encodeURIComponent(profileId)}&bbox=${encodeURIComponent(bboxStr)}`);
      if (!res.ok) return;
      const data = await res.json();

      const unvisitedParcels = data.parcels || [];
      const parcelsGeoJSON = {
        type: 'FeatureCollection',
        features: unvisitedParcels
      };

      if (!window.map.getSource('nnaper-fog-parcels-source')) {
        window.map.addSource('nnaper-fog-parcels-source', {
          type: 'geojson',
          data: parcelsGeoJSON
        });
        window.map.addLayer({
          id: 'nnaper-fog-mask-layer',
          type: 'fill',
          source: 'nnaper-fog-parcels-source',
          paint: {
            'fill-color': '#020617',
            'fill-opacity': 0.84
          }
        });
        window.map.addLayer({
          id: 'nnaper-fog-parcels-outline',
          type: 'line',
          source: 'nnaper-fog-parcels-source',
          paint: {
            'line-color': '#0284c7',
            'line-width': 1.0,
            'line-opacity': 0.50
          }
        });
      } else {
        window.map.getSource('nnaper-fog-parcels-source').setData(parcelsGeoJSON);
      }

      const badge = document.getElementById('nnaper-fog-stats-badge');
      if (badge) {
        badge.style.display = 'flex';
        badge.innerHTML = `
          <span>Odkryte działki: <strong style="color:#38bdf8;">${data.discovered_count || 0}</strong></span>
          <span>Odkryty obszar: <strong style="color:#34d399;">${Number(data.discovered_area_km2 || 0).toFixed(2)} km²</strong></span>
        `;
      }
    } catch (err) {
      console.error('Błąd pobierania mgły odkrywania mapy:', err);
    }
  }

  window.toggleFogOfWar = async function (forceState) {
    fogOfWarActive = typeof forceState === 'boolean' ? forceState : !fogOfWarActive;
    const btn = document.getElementById('btn-toggle-fog');
    if (btn) {
      btn.classList.toggle('active', fogOfWarActive);
      btn.setAttribute('aria-pressed', fogOfWarActive ? 'true' : 'false');
    }
    const badge = document.getElementById('nnaper-fog-stats-badge');

    if (!fogOfWarActive) {
      if (window.map?.getLayer('nnaper-fog-mask-layer')) {
        window.map.setLayoutProperty('nnaper-fog-mask-layer', 'visibility', 'none');
      }
      if (window.map?.getLayer('nnaper-fog-parcels-outline')) {
        window.map.setLayoutProperty('nnaper-fog-parcels-outline', 'visibility', 'none');
      }
      if (badge) badge.style.display = 'none';
      return;
    }

    if (window.map && !fogMoveListenerAttached) {
      fogMoveListenerAttached = true;
      window.map.on('moveend', () => {
        if (fogOfWarActive) refreshFogOfWarData();
      });
    }

    if (window.map?.getLayer('nnaper-fog-mask-layer')) {
      window.map.setLayoutProperty('nnaper-fog-mask-layer', 'visibility', 'visible');
    }
    if (window.map?.getLayer('nnaper-fog-parcels-outline')) {
      window.map.setLayoutProperty('nnaper-fog-parcels-outline', 'visibility', 'visible');
    }
    await refreshFogOfWarData();
  };

  /* ============================================================================
   * 7. TIMELAPSE ZAPEŁNIANIA SIĘ MAPY
   * ============================================================================ */
  let timelapseDays = [];
  let timelapseTimer = null;
  let timelapseIndex = 0;
  let timelapsePlaying = false;

  function applyTimelapseIndex(idx) {
    if (!timelapseDays.length) return;
    timelapseIndex = Math.max(0, Math.min(idx, timelapseDays.length - 1));
    const activeSet = new Set(timelapseDays.slice(0, timelapseIndex + 1).map(d => d.day));

    if (window.dayNodesRegistry) {
      window.dayNodesRegistry.forEach((dayItem, dateStr) => {
        if (dayItem.dayHeader?.checkbox) {
          dayItem.dayHeader.checkbox.checked = activeSet.has(dateStr);
          dayItem.dayHeader.checkbox.indeterminate = false;
        }
      });
    }
    if (typeof window.updateTrackFilters === 'function') {
      window.updateTrackFilters();
    }

    const cur = timelapseDays[timelapseIndex];
    const slider = document.getElementById('timelapse-slider');
    const lblDate = document.getElementById('timelapse-current-date');
    const lblKm = document.getElementById('timelapse-cumulative-km');
    if (slider) slider.value = String(timelapseIndex);
    if (lblDate) lblDate.innerText = `${cur.day} (${timelapseIndex + 1}/${timelapseDays.length})`;
    if (lblKm) lblKm.innerText = `${Number(cur.cumulative_km || 0).toFixed(1)} km łącznie`;
  }

  function stopTimelapsePlayback() {
    timelapsePlaying = false;
    if (timelapseTimer) {
      clearInterval(timelapseTimer);
      timelapseTimer = null;
    }
    const btnPlay = document.getElementById('btn-timelapse-play');
    if (btnPlay) btnPlay.innerText = 'Odtwarzaj';
  }

  function startTimelapsePlayback() {
    if (!timelapseDays.length) return;
    timelapsePlaying = true;
    const btnPlay = document.getElementById('btn-timelapse-play');
    if (btnPlay) btnPlay.innerText = 'Pauza';
    const speedSel = document.getElementById('timelapse-speed-select');
    const intervalMs = parseInt(speedSel?.value || '350', 10);

    if (timelapseIndex >= timelapseDays.length - 1) {
      timelapseIndex = 0;
    }
    applyTimelapseIndex(timelapseIndex);

    if (timelapseTimer) clearInterval(timelapseTimer);
    timelapseTimer = setInterval(() => {
      if (timelapseIndex < timelapseDays.length - 1) {
        applyTimelapseIndex(timelapseIndex + 1);
      } else {
        stopTimelapsePlayback();
      }
    }, intervalMs);
  }

  window.openTimelapsePanel = async function () {
    const bar = document.getElementById('nnaper-timelapse-bar');
    if (!bar) return;
    const token = getAuthTokenSafe();
    if (!token) {
      alert('Zaloguj się, aby uruchomić timelapse zapełniania się mapy.');
      return;
    }
    const profileId = getActiveProfileIdSafe();
    try {
      const res = await fetch(`${apiBase}/api/timelapse?token=${encodeURIComponent(token)}&profile_id=${encodeURIComponent(profileId)}`);
      if (!res.ok) throw new Error('Błąd pobierania danych timelapse');
      const data = await res.json();
      timelapseDays = Array.isArray(data.days) ? data.days : [];
      if (timelapseDays.length === 0) {
        alert('Brak zarejestrowanych dni z trasami dla wybranego profilu.');
        return;
      }
      bar.style.display = 'flex';
      const slider = document.getElementById('timelapse-slider');
      if (slider) {
        slider.min = '0';
        slider.max = String(timelapseDays.length - 1);
        slider.value = '0';
      }
      applyTimelapseIndex(0);
    } catch (err) {
      alert('Nie udało się załadować timelapse: ' + err.message);
    }
  };

  /* ============================================================================
   * 8. RYSOWANIE PO MAPIE (WIELOKĄTY I ŚCIEŻKI + COOKIES / SERWER)
   * ============================================================================ */
  const GUEST_DRAWINGS_KEY = 'nnaper_guest_drawings';
  let drawingModeActive = false;
  let currentDrawType = 'polygon'; // 'polygon' | 'path'
  let currentDrawColor = '#38bdf8';
  let currentDrawPoints = [];
  let savedDrawings = [];

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function computeDrawingMetrics(points, drawType) {
    if (!Array.isArray(points) || points.length < 2) {
      return { area_m2: 0, perimeter_m: 0, length_m: 0 };
    }
    let lengthM = 0;
    for (let i = 1; i < points.length; i++) {
      lengthM += haversineMeters(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]);
    }
    if (drawType !== 'polygon' || points.length < 3) {
      return { area_m2: 0, perimeter_m: lengthM, length_m: lengthM };
    }
    const closedPerimeter = lengthM + haversineMeters(points[points.length - 1][1], points[points.length - 1][0], points[0][1], points[0][0]);
    const refLat = points[0][1] * Math.PI / 180;
    const refLon = points[0][0] * Math.PI / 180;
    const R = 6371000;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      const x1 = (points[i][0] * Math.PI / 180 - refLon) * R * Math.cos(refLat);
      const y1 = (points[i][1] * Math.PI / 180 - refLat) * R;
      const x2 = (points[j][0] * Math.PI / 180 - refLon) * R * Math.cos(refLat);
      const y2 = (points[j][1] * Math.PI / 180 - refLat) * R;
      sum += (x1 * y2 - x2 * y1);
    }
    return { area_m2: Math.abs(sum) / 2, perimeter_m: closedPerimeter, length_m: closedPerimeter };
  }

  function formatMetricsLabel(d) {
    const dtype = d.draw_type || d.drawing_type;
    if (dtype === 'polygon') {
      const area = Number(d.area_m2 || 0);
      const areaStr = area >= 1000000
        ? `${(area / 1000000).toFixed(2)} km²`
        : area >= 10000
          ? `${(area / 10000).toFixed(2)} ha`
          : `${area.toFixed(0)} m²`;
      const perim = Number(d.perimeter_m || 0);
      const perimStr = perim >= 1000 ? `${(perim / 1000).toFixed(2)} km` : `${perim.toFixed(0)} m`;
      return `${d.name || 'Wielokąt'}\nPole: ${areaStr} | Obwód: ${perimStr}`;
    }
    const len = Number(d.length_m || 0);
    const lenStr = len >= 1000 ? `${(len / 1000).toFixed(2)} km` : `${len.toFixed(0)} m`;
    return `${d.name || 'Ścieżka'}\nDługość: ${lenStr}`;
  }

  function saveGuestDrawingsToCookieAndStorage(list) {
    try {
      const raw = JSON.stringify(list);
      localStorage.setItem(GUEST_DRAWINGS_KEY, raw);
      document.cookie = `${GUEST_DRAWINGS_KEY}=${encodeURIComponent(raw.substring(0, 3500))}; path=/; max-age=31536000; SameSite=Lax`;
    } catch (e) {}
  }

  function loadGuestDrawingsFromCookieOrStorage() {
    try {
      const raw = localStorage.getItem(GUEST_DRAWINGS_KEY);
      if (raw) return JSON.parse(raw);
      const match = document.cookie.match(new RegExp('(?:^|; )' + GUEST_DRAWINGS_KEY + '=([^;]*)'));
      if (match && match[1]) return JSON.parse(decodeURIComponent(match[1]));
    } catch (e) {}
    return [];
  }

  function ensureDrawingMapLayers() {
    if (!window.map) return;
    if (!window.map.getSource('nnaper-drawings-source')) {
      window.map.addSource('nnaper-drawings-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      window.map.addLayer({
        id: 'nnaper-drawings-fill',
        type: 'fill',
        source: 'nnaper-drawings-source',
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], '#38bdf8'],
          'fill-opacity': 0.28
        }
      });
      window.map.addLayer({
        id: 'nnaper-drawings-line',
        type: 'line',
        source: 'nnaper-drawings-source',
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#38bdf8'],
          'line-width': 3
        }
      });
      window.map.addLayer({
        id: 'nnaper-drawings-labels',
        type: 'symbol',
        source: 'nnaper-drawings-source',
        filter: ['==', ['get', 'is_label'], true],
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11.5,
          'text-font': ['Open Sans Bold'],
          'text-anchor': 'center'
        },
        paint: {
          'text-color': '#f8fafc',
          'text-halo-color': '#020617',
          'text-halo-width': 2
        }
      });
    }
  }

  function renderDrawingsOnMap() {
    if (!window.map) return;
    ensureDrawingMapLayers();
    const src = window.map.getSource('nnaper-drawings-source');
    if (!src) return;

    const features = [];
    const allToRender = [...savedDrawings];
    if (currentDrawPoints.length >= 2) {
      const m = computeDrawingMetrics(currentDrawPoints, currentDrawType);
      allToRender.push({
        id: 'draft',
        name: 'Szkic...',
        draw_type: currentDrawType,
        color: currentDrawColor,
        show_metrics: true,
        coordinates: currentDrawPoints,
        ...m
      });
    }

    allToRender.forEach(d => {
      const pts = Array.isArray(d.coordinates) ? d.coordinates : [];
      if (pts.length < 2) return;
      const dtype = d.draw_type || d.drawing_type;
      const itemId = d.id || d.drawing_id;
      if (dtype === 'polygon' && pts.length >= 3) {
        const ring = [...pts, pts[0]];
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { color: d.color || '#38bdf8', id: itemId }
        });
      } else {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: pts },
          properties: { color: d.color || '#38bdf8', id: itemId }
        });
      }

      if (d.show_metrics !== false) {
        const cx = pts.reduce((acc, p) => acc + p[0], 0) / pts.length;
        const cy = pts.reduce((acc, p) => acc + p[1], 0) / pts.length;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [cx, cy] },
          properties: {
            is_label: true,
            label: formatMetricsLabel(d)
          }
        });
      }
    });

    src.setData({ type: 'FeatureCollection', features });
    renderSavedDrawingsListUI();
  }

  function renderSavedDrawingsListUI() {
    const listEl = document.getElementById('drawing-saved-list');
    if (!listEl) return;
    if (savedDrawings.length === 0) {
      listEl.innerHTML = '<div style="color:#64748b; font-size:11px;">Brak zapisanych kształtów. Klikaj na mapie, aby narysować wielokąt lub ścieżkę.</div>';
      return;
    }
    listEl.innerHTML = '';
    savedDrawings.forEach((d, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:6px; padding:5px 7px; background:rgba(15,23,42,0.7); border:1px solid rgba(148,163,184,0.18); border-radius:6px; font-size:11.5px;';
      const info = document.createElement('div');
      info.style.cssText = 'display:flex; align-items:center; gap:6px; overflow:hidden;';
      const dot = document.createElement('span');
      dot.style.cssText = `width:10px; height:10px; border-radius:50%; background:${d.color || '#38bdf8'}; flex-shrink:0;`;
      const txt = document.createElement('span');
      txt.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#e2e8f0;';
      txt.innerText = formatMetricsLabel(d).replace('\n', ' • ');
      info.appendChild(dot);
      info.appendChild(txt);

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.style.cssText = 'background:transparent; border:none; color:#ef4444; cursor:pointer; font-weight:700; padding:2px 5px;';
      btnDel.innerText = '×';
      btnDel.title = 'Usuń rysunek';
      btnDel.addEventListener('click', async () => {
        const token = getAuthTokenSafe();
        const itemId = d.drawing_id || d.id;
        if (token && itemId && !String(itemId).startsWith('local_')) {
          await fetch(`${apiBase}/api/drawings/${encodeURIComponent(itemId)}?token=${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => {});
        }
        savedDrawings.splice(idx, 1);
        if (!token) saveGuestDrawingsToCookieAndStorage(savedDrawings);
        renderDrawingsOnMap();
      });

      row.appendChild(info);
      row.appendChild(btnDel);
      listEl.appendChild(row);
    });
  }

  async function loadDrawings() {
    const token = getAuthTokenSafe();
    if (token) {
      try {
        const res = await fetch(`${apiBase}/api/drawings?token=${encodeURIComponent(token)}`);
        if (res.ok) {
          const data = await res.json();
          savedDrawings = Array.isArray(data.drawings) ? data.drawings : [];
          renderDrawingsOnMap();
          return;
        }
      } catch (e) {}
    }
    savedDrawings = loadGuestDrawingsFromCookieOrStorage();
    renderDrawingsOnMap();
  }

  async function finishCurrentDrawing() {
    const minPts = currentDrawType === 'polygon' ? 3 : 2;
    if (currentDrawPoints.length < minPts) {
      alert(`Dodaj co najmniej ${minPts} punkty na mapie, aby zapisać kształt.`);
      return;
    }
    const nameInp = document.getElementById('drawing-name-input');
    const colorInp = document.getElementById('drawing-color-input');
    const chkMetrics = document.getElementById('drawing-show-metrics-chk');
    const name = (nameInp?.value || '').trim() || (currentDrawType === 'polygon' ? 'Wielokąt' : 'Ścieżka');
    const color = colorInp?.value || currentDrawColor;
    const showMetrics = chkMetrics ? chkMetrics.checked : true;
    const metrics = computeDrawingMetrics(currentDrawPoints, currentDrawType);

    const newItem = {
      id: 'local_' + Date.now(),
      name,
      draw_type: currentDrawType,
      drawing_type: currentDrawType === 'polygon' ? 'polygon' : 'polyline',
      color,
      show_metrics: showMetrics,
      coordinates: [...currentDrawPoints],
      ...metrics
    };

    const token = getAuthTokenSafe();
    if (token) {
      try {
        const res = await fetch(`${apiBase}/api/drawings?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newItem)
        });
        if (res.ok) {
          const saved = await res.json();
          const srvId = saved.drawing?.drawing_id || saved.id;
          if (srvId) {
            newItem.id = srvId;
            newItem.drawing_id = srvId;
          }
        }
      } catch (e) {}
    }

    savedDrawings.unshift(newItem);
    if (!token) {
      saveGuestDrawingsToCookieAndStorage(savedDrawings);
    }
    currentDrawPoints = [];
    if (nameInp) nameInp.value = '';
    renderDrawingsOnMap();
  }

  window.toggleDrawingStudio = function (forceState) {
    drawingModeActive = typeof forceState === 'boolean' ? forceState : !drawingModeActive;
    const panel = document.getElementById('nnaper-drawing-panel');
    if (panel) panel.style.display = drawingModeActive ? 'flex' : 'none';
    const btn = document.getElementById('btn-open-drawing');
    if (btn) btn.classList.toggle('active', drawingModeActive);
    const mapBtn = document.getElementById('btn-map-draw-control');
    if (mapBtn) mapBtn.classList.toggle('active', drawingModeActive);
    if (!drawingModeActive) {
      currentDrawPoints = [];
      renderDrawingsOnMap();
    }
  };

  /* ============================================================================
   * 9. PANEL USTAWIEŃ (NICK, HASŁO, EMAIL, PRESETY WARSTW, WIDOCZNOŚĆ PRZEŁĄCZNIKÓW)
   * ============================================================================ */
  const UI_VISIBILITY_KEY = 'nnaper_ui_visibility_settings';
  const TOGGLEABLE_UI_ELEMENTS = [
    { key: 'show_3d_map', label: 'Mapa 3D', selector: '#btn-toggle-3d-map' },
    { key: 'show_3d_buildings', label: 'Budynki 3D', selector: '#btn-toggle-3d-buildings' },
    { key: 'show_heatmap', label: 'Heatmapa punktów', selector: '#btn-toggle-heatmap' },
    { key: 'show_fog', label: 'Odkrywanie mapy', selector: '#btn-toggle-fog' },
    { key: 'show_timelapse', label: 'Timelapse eksploracji', selector: '#btn-open-timelapse' },
    { key: 'show_drawing', label: 'Rysowanie po mapie', selector: '#btn-open-drawing' },
    { key: 'show_route_sliders', label: 'Suwaki przeszkód w planerze', selector: '.route-advanced-box' },
    { key: 'show_map_scale', label: 'Dynamiczna skala mapy', selector: '.maplibregl-ctrl-scale' }
  ];

  function getStoredUiVisibility() {
    try {
      const raw = localStorage.getItem(UI_VISIBILITY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
  }

  function applyUiVisibilitySettings(settingsObj) {
    const cfg = settingsObj || getStoredUiVisibility();
    TOGGLEABLE_UI_ELEMENTS.forEach(item => {
      const isVisible = cfg[item.key] !== false;
      document.querySelectorAll(item.selector).forEach(el => {
        el.style.display = isVisible ? '' : 'none';
      });
    });
  }

  window.openSettingsModal = async function () {
    const modal = document.getElementById('nnaper-settings-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    const token = getAuthTokenSafe();
    const inpUsername = document.getElementById('settings-username');
    const inpEmail = document.getElementById('settings-email');
    const feedback = document.getElementById('settings-save-feedback');
    if (feedback) feedback.innerText = '';

    if (token) {
      try {
        const res = await fetch(`${apiBase}/api/auth/settings?token=${encodeURIComponent(token)}`);
        if (res.ok) {
          const data = await res.json();
          if (inpUsername) inpUsername.value = data.username || '';
          if (inpEmail) inpEmail.value = data.email || '';
          if (data.ui_settings && typeof data.ui_settings === 'object') {
            localStorage.setItem(UI_VISIBILITY_KEY, JSON.stringify(data.ui_settings));
          }
        }
      } catch (e) {}
    }

    // Wypełnij listę przełączników widoczności UI w czystej siatce 2-kolumnowej
    const visContainer = document.getElementById('settings-ui-toggles-list');
    if (visContainer) {
      const curVis = getStoredUiVisibility();
      visContainer.innerHTML = '';
      TOGGLEABLE_UI_ELEMENTS.forEach(item => {
        const lbl = document.createElement('label');
        lbl.className = 'settings-ui-toggle-card';
        const span = document.createElement('span');
        span.innerText = item.label;
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = curVis[item.key] !== false;
        chk.dataset.uiKey = item.key;
        chk.style.accentColor = '#38bdf8';
        chk.addEventListener('change', () => {
          const updated = getStoredUiVisibility();
          updated[item.key] = chk.checked;
          localStorage.setItem(UI_VISIBILITY_KEY, JSON.stringify(updated));
          applyUiVisibilitySettings(updated);
        });
        lbl.appendChild(span);
        lbl.appendChild(chk);
        visContainer.appendChild(lbl);
      });
    }

    // Wypełnij sekcję presetów warstw w ustawieniach
    renderSettingsPresetsList();
  };

  function renderSettingsPresetsList() {
    const container = document.getElementById('settings-presets-list');
    if (!container || !window.LayerManager || typeof window.LayerManager.getAllPresets !== 'function') return;
    const all = window.LayerManager.getAllPresets();
    container.innerHTML = '';

    all.forEach((p) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'settings-preset-chip';
      chip.innerText = String(p.name || '').replace(/\s*\([^)]*\)/g, '');
      chip.addEventListener('click', () => {
        window.LayerManager.applyPresetById(window.map, p.preset_id);
      });
      container.appendChild(chip);
    });
  }

  /* ============================================================================
   * 10. INICJALIZACJA ELEMENTÓW DOM I BINDOWANIE ZDARZEŃ
   * ============================================================================ */
  function injectFloatingUiPanels() {
    // 1. Legenda Heatmapy
    const heatLegend = document.createElement('div');
    heatLegend.id = 'nnaper-heatmap-legend';
    heatLegend.className = 'nnaper-floating-badge';
    heatLegend.style.display = 'none';
    heatLegend.innerHTML = `
      <span style="font-weight:700; color:#f8fafc;">Heatmapa:</span>
      <span style="color:#94a3b8;">0 = przezroczysty</span>
      <span style="color:#00dc3c; font-weight:600;">1 pkt = zielony</span>
      <div style="width:70px; height:8px; border-radius:4px; background:linear-gradient(90deg, #00dc3c, #facc15, #ff1e1e);"></div>
      <span id="heatmap-legend-max" style="color:#ff4d4d; font-weight:600;">Max = czerwony</span>
    `;
    document.body.appendChild(heatLegend);

    // 3. Odznaka statystyk Mgły Odkrywania Mapy
    const fogBadge = document.createElement('div');
    fogBadge.id = 'nnaper-fog-stats-badge';
    fogBadge.className = 'nnaper-floating-badge';
    fogBadge.style.display = 'none';
    fogBadge.style.bottom = '52px';
    document.body.appendChild(fogBadge);

    // 4. Pasek Timelapse zapełniania się mapy
    const timelapseBar = document.createElement('div');
    timelapseBar.id = 'nnaper-timelapse-bar';
    timelapseBar.className = 'nnaper-floating-bar';
    timelapseBar.style.display = 'none';
    timelapseBar.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; width:100%; gap:10px;">
        <strong style="color:#38bdf8; font-size:12.5px;">Timelapse zapełniania się mapy</strong>
        <span id="timelapse-current-date" style="font-size:12px; color:#f8fafc; font-weight:600;">--</span>
        <span id="timelapse-cumulative-km" style="font-size:12px; color:#34d399; font-weight:700;">0.0 km</span>
        <button type="button" id="btn-timelapse-close" style="background:transparent; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">&times;</button>
      </div>
      <input type="range" id="timelapse-slider" min="0" max="10" value="0" style="width:100%; accent-color:#38bdf8;" />
      <div style="display:flex; align-items:center; justify-content:space-between; width:100%; gap:8px;">
        <button type="button" id="btn-timelapse-play" class="route-action-btn" style="padding:4px 12px; background:#0284c7; color:#fff; border:none; font-weight:600;">Odtwarzaj</button>
        <label style="font-size:11.5px; color:#94a3b8; display:flex; align-items:center; gap:6px;">
          Tempo kroku:
          <select id="timelapse-speed-select" style="background:#0f172a; color:#38bdf8; border:1px solid #334155; border-radius:4px; padding:3px 6px; font-size:11.5px;">
            <option value="800">Wolno</option>
            <option value="350" selected>Normalnie</option>
            <option value="120">Szybko</option>
            <option value="40">Ultra</option>
          </select>
        </label>
      </div>
    `;
    document.body.appendChild(timelapseBar);

    // 5. Studio rysowania po mapie
    const drawPanel = document.createElement('div');
    drawPanel.id = 'nnaper-drawing-panel';
    drawPanel.className = 'nnaper-floating-bar';
    drawPanel.style.display = 'none';
    drawPanel.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
        <strong style="color:#38bdf8; font-size:12.5px;">Rysowanie po mapie</strong>
        <button type="button" id="btn-drawing-close" style="background:transparent; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; width:100%;">
        <select id="drawing-type-select" style="background:#0f172a; color:#f8fafc; border:1px solid #334155; border-radius:5px; padding:4px 7px; font-size:11.5px;">
          <option value="polygon">Wielokąt</option>
          <option value="path">Ścieżka</option>
        </select>
        <input type="text" id="drawing-name-input" placeholder="Nazwa kształtu..." style="flex:1; min-width:110px; background:#0f172a; color:#f8fafc; border:1px solid #334155; border-radius:5px; padding:4px 7px; font-size:11.5px;" />
        <input type="hidden" id="drawing-color-input" value="#38bdf8" />
        <label style="font-size:11px; color:#cbd5e1; display:flex; align-items:center; gap:4px; cursor:pointer;">
          <input type="checkbox" id="drawing-show-metrics-chk" checked style="accent-color:#38bdf8;" /> Wymiary
        </label>
      </div>
      <div style="display:flex; gap:6px; width:100%;">
        <button type="button" id="btn-drawing-finish" class="route-action-btn" style="flex:1; padding:5px 10px; background:#0284c7; color:#fff; border:none; font-weight:600;">Zapisz kształt</button>
        <button type="button" id="btn-drawing-undo" class="route-action-btn" style="padding:5px 10px;">Cofnij pkt</button>
        <button type="button" id="btn-drawing-clear-draft" class="route-action-btn" style="padding:5px 10px;">Wyczyść szkic</button>
      </div>
      <div id="drawing-saved-list" style="width:100%; max-height:130px; overflow-y:auto; display:flex; flex-direction:column; gap:4px;"></div>
    `;
    document.body.appendChild(drawPanel);

    // 6. Modal Ustawień Konta i Interfejsu
    const settingsModal = document.createElement('div');
    settingsModal.id = 'nnaper-settings-modal';
    settingsModal.className = 'export-modal-backdrop';
    settingsModal.style.display = 'none';
    settingsModal.innerHTML = `
      <div class="export-modal settings-modal-card">
        <div class="settings-modal-header">
          <div>
            <h3 class="settings-modal-title">Ustawienia</h3>
            <p class="settings-modal-subtitle">Konto użytkownika i dane logowania</p>
          </div>
          <button type="button" id="btn-close-settings-modal" class="export-close-btn">&times;</button>
        </div>
        <div class="settings-modal-body">
          <div class="settings-card-section">
            <div class="settings-section-heading">Konto użytkownika</div>
            <div class="settings-form-grid">
              <label class="settings-field-label">
                <span>Nazwa użytkownika</span>
                <input type="text" id="settings-username" class="settings-dark-input" placeholder="Twój nick..." />
              </label>
              <label class="settings-field-label">
                <span>Adres e-mail</span>
                <input type="email" id="settings-email" class="settings-dark-input" placeholder="email@domena.pl" />
              </label>
              <label class="settings-field-label">
                <span>Obecne hasło</span>
                <input type="password" id="settings-current-password" class="settings-dark-input" placeholder="••••••" />
              </label>
              <label class="settings-field-label">
                <span>Nowe hasło</span>
                <input type="password" id="settings-new-password" class="settings-dark-input" placeholder="Nowe hasło..." />
              </label>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; margin-top:10px;">
              <span id="settings-save-feedback" style="font-size:11.5px; color:#38bdf8;"></span>
              <button type="button" id="btn-save-account-settings" class="export-btn-primary" style="padding:6px 14px; font-size:12px;">Zapisz konto</button>
            </div>
          </div>

          <div class="settings-card-section" style="border-top: 1px solid rgba(239, 68, 68, 0.2); margin-top: 16px; padding-top: 14px;">
            <div class="settings-section-heading" style="color: #f87171;">Strefa niebezpieczna</div>
            <p style="font-size: 11.5px; color: #94a3b8; margin: 4px 0 10px 0;">
              Usunięcie konta bezpowrotnie kasuje Twoje dane logowania, wszystkie profile, zapisane rysunki oraz trasy GPS.
            </p>
            <div style="display:flex; justify-content: flex-end;">
              <button type="button" id="btn-delete-account" class="export-btn-danger" style="padding: 6px 14px; font-size: 12px; background: #991b1b; color: #fecaca; border: 1px solid #ef4444; border-radius: 5px; cursor: pointer; font-weight: 600;">
                Usuń konto
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(settingsModal);

    // Bindowanie akcji paska Timelapse
    document.getElementById('btn-timelapse-close')?.addEventListener('click', () => {
      stopTimelapsePlayback();
      timelapseBar.style.display = 'none';
    });
    document.getElementById('btn-timelapse-play')?.addEventListener('click', () => {
      if (timelapsePlaying) stopTimelapsePlayback();
      else startTimelapsePlayback();
    });
    document.getElementById('timelapse-slider')?.addEventListener('input', (e) => {
      stopTimelapsePlayback();
      applyTimelapseIndex(parseInt(e.target.value || '0', 10));
    });
    document.getElementById('timelapse-speed-select')?.addEventListener('change', () => {
      if (timelapsePlaying) startTimelapsePlayback();
    });

    // Bindowanie akcji paska Rysowania
    document.getElementById('btn-drawing-close')?.addEventListener('click', () => window.toggleDrawingStudio(false));
    document.getElementById('drawing-type-select')?.addEventListener('change', (e) => {
      currentDrawType = e.target.value;
      renderDrawingsOnMap();
    });
    document.getElementById('drawing-color-input')?.addEventListener('input', (e) => {
      currentDrawColor = e.target.value;
      renderDrawingsOnMap();
    });
    document.getElementById('btn-drawing-finish')?.addEventListener('click', finishCurrentDrawing);
    document.getElementById('btn-drawing-undo')?.addEventListener('click', () => {
      currentDrawPoints.pop();
      renderDrawingsOnMap();
    });
    document.getElementById('btn-drawing-clear-draft')?.addEventListener('click', () => {
      currentDrawPoints = [];
      renderDrawingsOnMap();
    });

    // Bindowanie akcji modala Ustawień
    document.getElementById('btn-close-settings-modal')?.addEventListener('click', () => {
      settingsModal.style.display = 'none';
    });
    document.getElementById('btn-settings-create-preset')?.addEventListener('click', async () => {
      const inp = document.getElementById('settings-new-preset-name');
      const name = (inp?.value || '').trim();
      if (!name || !window.LayerManager || typeof window.LayerManager.createCustomPreset !== 'function') return;
      const created = await window.LayerManager.createCustomPreset(name, window.map);
      if (inp) inp.value = '';
      renderSettingsPresetsList();
      if (created && created.preset_id) {
        window.LayerManager.applyPresetById(window.map, created.preset_id);
      }
    });
    document.getElementById('btn-save-account-settings')?.addEventListener('click', async () => {
      const token = getAuthTokenSafe();
      const feedback = document.getElementById('settings-save-feedback');
      if (!token) {
        if (feedback) feedback.innerText = 'Zaloguj się, aby zmienić dane konta.';
        return;
      }
      const payload = {
        username: (document.getElementById('settings-username')?.value || '').trim(),
        email: (document.getElementById('settings-email')?.value || '').trim(),
        current_password: document.getElementById('settings-current-password')?.value || '',
        new_password: document.getElementById('settings-new-password')?.value || '',
        ui_settings: getStoredUiVisibility()
      };
      if (feedback) feedback.innerText = 'Zapisywanie...';
      try {
        const res = await fetch(`${apiBase}/api/auth/settings?token=${encodeURIComponent(token)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Błąd zapisu ustawień');
        if (data.username) localStorage.setItem('nnaper_auth_user', data.username);
        if (feedback) feedback.innerText = 'Zapisano zmiany konta!';
        window.dispatchEvent(new CustomEvent('nnaper_auth_changed', { detail: { username: data.username } }));
      } catch (err) {
        if (feedback) feedback.innerText = 'Błąd: ' + err.message;
      }
    });

    document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
      const token = getAuthTokenSafe();
      if (!token) {
        alert('Musisz być zalogowany, aby usunąć konto.');
        return;
      }
      if (!confirm('Czy na pewno chcesz BEZPOWROTNIE usunąć swoje konto oraz WSZYSTKIE profile i trasy GPS?\n\nTej operacji NIE MOŻNA cofnąć!')) {
        return;
      }
      const btn = document.getElementById('btn-delete-account');
      if (btn) {
        btn.disabled = true;
        btn.innerText = 'Usuwanie konta...';
      }
      try {
        const res = await fetch(`${apiBase}/api/auth/account?token=${encodeURIComponent(token)}`, {
          method: 'DELETE'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || data.error || 'Błąd podczas usuwania konta.');
        alert('Twoje konto oraz wszystkie dane zostały bezpowrotnie usunięte.');
        if (window.AuthManager && typeof window.AuthManager.logout === 'function') {
          window.AuthManager.logout();
        } else {
          localStorage.clear();
          location.reload();
        }
      } catch (err) {
        alert('Błąd usuwania konta: ' + err.message);
        if (btn) {
          btn.disabled = false;
          btn.innerText = 'Usuń konto';
        }
      }
    });

    // Bindowanie przycisków w prawym menu
    document.getElementById('btn-locate-user')?.addEventListener('click', () => window.locateUserOnMap());
    document.getElementById('btn-open-timelapse')?.addEventListener('click', () => window.openTimelapsePanel());
    document.getElementById('btn-open-drawing')?.addEventListener('click', () => window.toggleDrawingStudio());
    document.getElementById('btn-open-settings')?.addEventListener('click', () => window.openSettingsModal());
    document.getElementById('btn-toggle-heatmap')?.addEventListener('click', () => toggleHeatmap());
    document.getElementById('btn-toggle-fog')?.addEventListener('click', () => window.toggleFogOfWar());
  }

  function initMapFeatures() {
    injectFloatingUiPanels();
    applyUiVisibilitySettings();

    if (!window.map) return;

    const onMapReady = () => {
      setupPoiAndInfraInspector();
      loadDrawings();

      window.map.on('click', (e) => {
        if (!drawingModeActive) return;
        currentDrawPoints.push([e.lngLat.lng, e.lngLat.lat]);
        renderDrawingsOnMap();
      });
    };

    if (window.map.loaded()) {
      onMapReady();
    } else {
      window.map.on('load', onMapReady);
    }

    window.addEventListener('nnaper_auth_changed', () => {
      loadDrawings();
      if (fogOfWarActive) refreshFogOfWarData();
      if (heatmapActive) toggleHeatmap(true);
    });
    window.addEventListener('nnaper_profile_changed', () => {
      if (fogOfWarActive) refreshFogOfWarData();
      if (heatmapActive) toggleHeatmap(true);
    });
    window.addEventListener('nnaper_epochs_deleted', () => {
      if (fogOfWarActive) refreshFogOfWarData();
      if (heatmapActive) toggleHeatmap(true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMapFeatures);
  } else {
    initMapFeatures();
  }
})();
