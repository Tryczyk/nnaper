/**
 * ParserManager - Moduł wieloplikowego importu i parsowania danych telemetrycznych GPS
 * Obsługuje:
 * - Przetwarzanie plik po pliku z asynchronicznym wykonywaniem na serwerze w tle
 * - Wykrywanie i zapamiętywanie wcześniej przetworzonych plików (ochrona przed duplikatami)
 * - Pytanie użytkownika o potwierdzenie ponownego parsowania z opcją pominięcia duplikatów
 * - Ostrzeżenie przed opuszczeniem strony w trakcie trwania operacji (beforeunload)
 * - Płynny, monotoniczny pasek postępu (całkowity i bieżący plik)
 * - Precyzyjną estymację pozostałego czasu (ETA) oraz prędkości przetwarzania
 * - Wznawianie stanu zadania po odświeżeniu strony lub ponownym wejściu
 */

(function (window, document) {
  'use strict';

  const STORAGE_HISTORY_KEY = 'nnaper_parsed_files_registry';

  function getApiBaseUrl() {
    return (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
  }

  // Elementy DOM
  const modalEl = document.getElementById('parser-modal');
  const btnClose = document.getElementById('btn-close-parser');
  const btnCancel = document.getElementById('btn-cancel-parser');
  const btnAbort = document.getElementById('btn-abort-parser');
  const btnStart = document.getElementById('btn-start-parser');
  const btnViewMap = document.getElementById('btn-view-map-parser');
  const btnOpenMenu = document.getElementById('btn-open-parser');

  const dropzoneEl = document.getElementById('parser-dropzone');
  const fileInput = document.getElementById('parser-file-input');
  const folderInput = document.getElementById('parser-folder-input');
  const btnChooseFiles = document.getElementById('btn-choose-files');
  const btnChooseFolder = document.getElementById('btn-choose-folder');

  const authWarningEl = document.getElementById('parser-auth-warning');
  // optSnap removed - snapping is always enabled

  // Sekcja duplikatów
  const dupPromptEl = document.getElementById('parser-duplicates-prompt');
  const dupListEl = document.getElementById('parser-duplicates-list');
  const btnDupSkip = document.getElementById('btn-dup-skip');
  const btnDupReparse = document.getElementById('btn-dup-reparse');
  const btnDupCancel = document.getElementById('btn-dup-cancel');

  // Kolejka
  const queueSection = document.getElementById('parser-queue-section');
  const queueCountBadge = document.getElementById('queue-count-badge');
  const btnClearQueue = document.getElementById('btn-clear-queue');
  const fileListContainer = document.getElementById('parser-file-list');

  // Postęp i paski
  const progressSection = document.getElementById('parser-progress-section');
  const currentStageEl = document.getElementById('parser-current-stage');
  const overallPercentEl = document.getElementById('parser-overall-percent');
  const overallFillEl = document.getElementById('parser-overall-fill');

  const activeFileNameEl = document.getElementById('parser-active-file-name');
  const activeFilePctEl = document.getElementById('parser-active-file-pct');
  const activeFillEl = document.getElementById('parser-active-fill');

  // Metryki
  const metricFiles = document.getElementById('metric-files-progress');
  const metricElapsed = document.getElementById('metric-elapsed-time');
  const metricEta = document.getElementById('metric-eta-time');
  const metricSpeed = document.getElementById('metric-speed');
  const metricEpochs = document.getElementById('metric-epochs-count');
  const metricData = document.getElementById('metric-data-progress');
  const metricDataLabel = document.getElementById('metric-data-label');

  const successBox = document.getElementById('parser-success-box');
  const successDetails = document.getElementById('parser-success-details');
  const csvInfoCard = document.getElementById('parser-csv-info-card');

  // Stan
  let queue = [];
  let isProcessing = false;
  let isUploading = false;
  let activeXhr = null;
  let activeServerJobId = null;
  let timerInterval = null;
  let pollingInterval = null;
  let startTime = 0;
  let liveRemainingSec = 0;
  let totalEpochsAccumulator = 0;
  let processedFilesCount = 0;
  let serverHistoryCache = {};
  let estimatedParsingSpeedMBs = 4.0; // Domyślna/zmierzona szybkość parsowania danych GPS w MB/s

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function formatTime(seconds) {
    if (!seconds || seconds <= 0 || isNaN(seconds)) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Estymuje całkowity czas ukończenia (ETA) w sekundach na bazie megabajtów danych w kolejce
  function estimateQueueRemainingSeconds(currentIndex, currentPhase, loadedBytes, totalFileBytes, parsedBytesRatio, currentUploadSpeed) {
    let totalSec = 0;
    const currItem = queue[currentIndex];
    const fileBytes = totalFileBytes || (currItem?.size || currItem?.file?.size || 0);

    // 1. Szacunek dla bieżącego pliku
    if (currentPhase === 'upload') {
      const upRemaining = Math.max(0, fileBytes - (loadedBytes || 0));
      const upSpeed = Math.max(256 * 1024, currentUploadSpeed || 10 * 1024 * 1024);
      const upSec = upRemaining / upSpeed;
      // Cały plik w MB musi jeszcze zostać sparsowany na serwerze:
      const parseSec = (fileBytes / (1024 * 1024)) / Math.max(0.5, estimatedParsingSpeedMBs);
      totalSec += (upSec + parseSec);
    } else {
      // Faza parsowania na serwerze
      const ratio = typeof parsedBytesRatio === 'number' ? Math.max(0, Math.min(1, parsedBytesRatio)) : 0;
      const bytesLeft = Math.max(0, fileBytes * (1 - ratio));
      const parseSec = (bytesLeft / (1024 * 1024)) / Math.max(0.5, estimatedParsingSpeedMBs);
      totalSec += parseSec;
    }

    // 2. Szacunek dla kolejnych plików oczekujących w kolejce (wielkość w MB / prędkość)
    for (let i = currentIndex + 1; i < queue.length; i++) {
      const item = queue[i];
      if (item.status === 'done') continue;
      const b = item.size || item.file?.size || 0;
      const upSec = b / Math.max(1024 * 1024, currentUploadSpeed || 10 * 1024 * 1024);
      const parseSec = (b / (1024 * 1024)) / Math.max(0.5, estimatedParsingSpeedMBs);
      totalSec += (upSec + parseSec);
    }

    return Math.max(1, Math.round(totalSec));
  }

  // ------------------ REJESTR HISTORII SPARSOWANYCH PLIKÓW ------------------

  function getLocalHistory() {
    try {
      const user = window.getAuthUser?.();
      const userKey = user?.user_id || 'guest';
      const raw = localStorage.getItem(`${STORAGE_HISTORY_KEY}_${userKey}`);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
  }

  function saveLocalHistory(name, size, epochs) {
    try {
      const user = window.getAuthUser?.();
      const userKey = user?.user_id || 'guest';
      const hist = getLocalHistory();
      hist[name] = {
        name,
        size,
        epochs: epochs || 0,
        parsed_at: new Date().toISOString()
      };
      localStorage.setItem(`${STORAGE_HISTORY_KEY}_${userKey}`, JSON.stringify(hist));
      serverHistoryCache[name] = hist[name];
    } catch (e) {}
  }

  function getFileParseRecord(name) {
    if (serverHistoryCache && serverHistoryCache[name]) {
      return serverHistoryCache[name];
    }
    const local = getLocalHistory();
    return local[name] || null;
  }

  // ------------------ OSTRZEŻENIE O OPUSZCZENIU STRONY ------------------

  function setupBeforeUnloadProtection() {
    window.addEventListener('beforeunload', (e) => {
      if (isUploading || (isProcessing && activeXhr)) {
        e.preventDefault();
        const msg = 'Trwa przesyłanie plików GPS na serwer. Nie opuszczaj strony dopóki wszystkie pliki nie zostaną przesłane!';
        e.returnValue = msg;
        return msg;
      }
    });
  }

  // ------------------ MODAL & STAN ------------------

  function updateCsvInfoCardVisibility() {
    if (!csvInfoCard) return;

    // Jezeli wystapil blad w pliku CSV w kolejce lub zadaniu serwera, ZAWSZE pokazujemy specyfikacje
    const hasCsvError = queue.some(q => q.status === 'error' && q.name && q.name.toLowerCase().endsWith('.csv'));
    if (hasCsvError) {
      csvInfoCard.style.display = 'block';
      return;
    }

    // W trakcie trwania aktywnego parsowania komunikat znika
    if (isProcessing) {
      csvInfoCard.style.display = 'none';
      return;
    }

    // Gdy zakonczono parsowanie wszystkich plikow z sukcesem (bez bledow CSV), karta pozostaje ukryta
    if (queue.length > 0 && queue.every(q => q.status === 'done')) {
      csvInfoCard.style.display = 'none';
      return;
    }

    // Jesli strefa upuszczania plikow jest ukryta (np. widok podsumowania bez bledow CSV), ukryj
    if (dropzoneEl && dropzoneEl.style.display === 'none') {
      csvInfoCard.style.display = 'none';
      return;
    }

    // Domyslnie w stanie bezczynnosci / wyboru plikow - widoczna
    csvInfoCard.style.display = 'block';
  }

  function updateMenuButtonRunningState(isRunning, job) {
    const btns = document.querySelectorAll('#btn-open-parser, .btn-trigger-parser');
    if (!btns || !btns.length) return;
    btns.forEach(btn => {
      if (isRunning && job) {
        const pct = job.percent || 0;
        btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><span class="running-dot" style="width:7px;height:7px;border-radius:50%;background:#38bdf8;box-shadow:0 0 8px #38bdf8;display:inline-block;"></span>Parsowanie (${pct}%)</span>`;
      } else {
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Parsowanie plików</span>`;
      }
    });
  }

  function openParserModal() {
    if (!modalEl) return;
    modalEl.style.display = 'flex';
    checkAuthStatus();
    loadProfilesIntoParserSelect();

    if (isProcessing) {
      if (dropzoneEl) dropzoneEl.style.display = 'none';
      const profBox = document.getElementById('parser-profile-box');
      if (profBox) profBox.style.display = 'none';
      if (btnStart) btnStart.style.display = 'none';
      if (btnAbort) btnAbort.style.display = 'inline-flex';
      if (progressSection) progressSection.style.display = 'block';
      if (queueSection) queueSection.style.display = 'block';
    }

    updateCsvInfoCardVisibility();
    syncWithServerJobs();
  }

  async function loadProfilesIntoParserSelect() {
    const targetProfileSelect = document.getElementById('parser-target-profile-select');
    if (!targetProfileSelect) return;
    const subNote = document.querySelector('.parser-profile-sub');
    try {
      const profiles = await window.fetchUserProfiles?.() || [];
      targetProfileSelect.innerHTML = '';
      if (!profiles || profiles.length === 0) {
        targetProfileSelect.innerHTML = '<option value="">Profil Główny (domyślny)</option>';
        if (subNote) {
          subNote.innerText = 'Trasy zostaną automatycznie przypisane do Twojego profilu domyślnego w bazie danych.';
        }
        return;
      }
      const activeId = window.getActiveProfileId?.() || '';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.profile_id;
        opt.innerText = p.name;
        if (p.profile_id === activeId) opt.selected = true;
        targetProfileSelect.appendChild(opt);
      });
      if (!targetProfileSelect.value && profiles.length > 0) {
        targetProfileSelect.value = profiles[0].profile_id;
      }
      if (subNote) {
        const selName = targetProfileSelect.options[targetProfileSelect.selectedIndex]?.text || '';
        subNote.innerText = `Wgrywane trasy zostaną przypisane do profilu: ${selName}`;
      }
    } catch (e) {
      targetProfileSelect.innerHTML = '<option value="">Profil Główny (domyślny)</option>';
    }
  }

  const NMEA_FILTER_STORAGE_KEY = 'nnaper_nmea_filters_config';
  const DEFAULT_NMEA_FILTERS = {
    min_fix_quality: 1,
    min_satellites: 4,
    max_hdop: 5.0,
    max_pdop: 6.0,
    min_altitude: -50,
    max_altitude: 5000,
    max_speed_kmh: 250,
    require_valid_rmc: true
  };

  function getNmeaFilterValues() {
    const fixQ = document.getElementById('flt-min-fix-quality');
    const minSats = document.getElementById('flt-min-satellites');
    const maxHdop = document.getElementById('flt-max-hdop');
    const maxPdop = document.getElementById('flt-max-pdop');
    const minAlt = document.getElementById('flt-min-altitude');
    const maxAlt = document.getElementById('flt-max-altitude');
    const maxSpeed = document.getElementById('flt-max-speed');
    const reqRmc = document.getElementById('flt-require-rmc-valid');

    return {
      min_fix_quality: fixQ ? parseInt(fixQ.value, 10) : DEFAULT_NMEA_FILTERS.min_fix_quality,
      min_satellites: minSats ? parseInt(minSats.value, 10) : DEFAULT_NMEA_FILTERS.min_satellites,
      max_hdop: maxHdop ? parseFloat(maxHdop.value) : DEFAULT_NMEA_FILTERS.max_hdop,
      max_pdop: maxPdop ? parseFloat(maxPdop.value) : DEFAULT_NMEA_FILTERS.max_pdop,
      min_altitude: minAlt ? parseFloat(minAlt.value) : DEFAULT_NMEA_FILTERS.min_altitude,
      max_altitude: maxAlt ? parseFloat(maxAlt.value) : DEFAULT_NMEA_FILTERS.max_altitude,
      max_speed_kmh: maxSpeed ? parseFloat(maxSpeed.value) : DEFAULT_NMEA_FILTERS.max_speed_kmh,
      require_valid_rmc: reqRmc ? reqRmc.checked : DEFAULT_NMEA_FILTERS.require_valid_rmc
    };
  }

  function getNmeaFilterQueryString() {
    const f = getNmeaFilterValues();
    const p = new URLSearchParams();
    if (f.min_fix_quality !== undefined && !isNaN(f.min_fix_quality)) p.set('min_fix_quality', f.min_fix_quality);
    if (f.min_satellites !== undefined && !isNaN(f.min_satellites)) p.set('min_satellites', f.min_satellites);
    if (f.max_hdop !== undefined && !isNaN(f.max_hdop)) p.set('max_hdop', f.max_hdop);
    if (f.max_pdop !== undefined && !isNaN(f.max_pdop)) p.set('max_pdop', f.max_pdop);
    if (f.min_altitude !== undefined && !isNaN(f.min_altitude)) p.set('min_altitude', f.min_altitude);
    if (f.max_altitude !== undefined && !isNaN(f.max_altitude)) p.set('max_altitude', f.max_altitude);
    if (f.max_speed_kmh !== undefined && !isNaN(f.max_speed_kmh)) p.set('max_speed_kmh', f.max_speed_kmh);
    p.set('require_valid_rmc', f.require_valid_rmc ? 'true' : 'false');
    const str = p.toString();
    return str ? `&${str}` : '';
  }

  function restoreNmeaFilters() {
    try {
      const raw = localStorage.getItem(NMEA_FILTER_STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : DEFAULT_NMEA_FILTERS;
      applyNmeaFiltersToDom(data);
    } catch (e) {
      applyNmeaFiltersToDom(DEFAULT_NMEA_FILTERS);
    }
  }

  function applyNmeaFiltersToDom(d) {
    const fixQ = document.getElementById('flt-min-fix-quality');
    const minSats = document.getElementById('flt-min-satellites');
    const maxHdop = document.getElementById('flt-max-hdop');
    const maxPdop = document.getElementById('flt-max-pdop');
    const minAlt = document.getElementById('flt-min-altitude');
    const maxAlt = document.getElementById('flt-max-altitude');
    const maxSpeed = document.getElementById('flt-max-speed');
    const reqRmc = document.getElementById('flt-require-rmc-valid');

    if (fixQ && d.min_fix_quality !== undefined) fixQ.value = String(d.min_fix_quality);
    if (minSats && d.min_satellites !== undefined) minSats.value = String(d.min_satellites);
    if (maxHdop && d.max_hdop !== undefined) maxHdop.value = String(d.max_hdop);
    if (maxPdop && d.max_pdop !== undefined) maxPdop.value = String(d.max_pdop);
    if (minAlt && d.min_altitude !== undefined) minAlt.value = String(d.min_altitude);
    if (maxAlt && d.max_altitude !== undefined) maxAlt.value = String(d.max_altitude);
    if (maxSpeed && d.max_speed_kmh !== undefined) maxSpeed.value = String(d.max_speed_kmh);
    if (reqRmc && d.require_valid_rmc !== undefined) reqRmc.checked = Boolean(d.require_valid_rmc);
  }

  function saveNmeaFilters() {
    try {
      const f = getNmeaFilterValues();
      localStorage.setItem(NMEA_FILTER_STORAGE_KEY, JSON.stringify(f));
    } catch (e) {}
  }

  function closeParserModal() {
    if (isUploading) {
      alert('Trwa przesyłanie plików na serwer. Nie można zamknąć okna ani opuścić strony dopóki wszystkie pliki nie zostaną przesłane!');
      return;
    }
    if (modalEl) {
      modalEl.style.display = 'none';
    }
  }

  function checkAuthStatus() {
    const token = window.getAuthToken?.() || '';
    if (!token) {
      if (authWarningEl) authWarningEl.style.display = 'block';
      if (btnStart) btnStart.disabled = true;
    } else {
      if (authWarningEl) authWarningEl.style.display = 'none';
      if (btnStart && queue.length > 0 && !isProcessing) {
        btnStart.disabled = false;
      }
    }
  }

  // Synchronizacja aktywnych zadań z serwera (np. po odświeżeniu strony)
  async function syncWithServerJobs() {
    const token = window.getAuthToken?.() || '';
    if (!token) return;

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/parser/jobs?token=${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.history) {
        serverHistoryCache = Object.assign({}, getLocalHistory(), data.history);
      }

      const activeJobs = data.active_jobs || [];
      if (activeJobs.length > 0) {
        // Serwer przetwarza zadanie w tle! Odtwórz stan w UI
        const runningJob = activeJobs[0];
        updateMenuButtonRunningState(true, runningJob);
        if (!isProcessing || activeServerJobId !== runningJob.job_id) {
          restoreRunningServerJob(runningJob);
        }
      } else {
        updateMenuButtonRunningState(false);
        if (data.jobs && data.jobs.length > 0 && (!isProcessing || queue.length === 0)) {
          // Jeśli zadanie zakończyło się w tle (np. podczas odświeżania strony)
          const latestJob = data.jobs[0];
          const jobAgeSec = (Date.now() - new Date(latestJob.updated_at || latestJob.created_at).getTime()) / 1000;
          if (jobAgeSec < 1800) {
            restoreFinishedServerJob(latestJob);
          }
        }
      }
    } catch (e) {
      console.warn('Nie udało się pobrać stanu zadań z serwera:', e);
    }
  }

  function restoreFinishedServerJob(job) {
    if (dropzoneEl) dropzoneEl.style.display = 'none';
    const profBox = document.getElementById('parser-profile-box');
    if (profBox) profBox.style.display = 'none';

    queue = [{
      id: 'job_' + job.job_id,
      name: job.filename,
      size: job.file_size || 0,
      status: job.status,
      percent: job.percent || 100,
      message: job.message || (job.status === 'done' ? 'Zakończono pomyślnie' : 'Błąd zadania'),
      epochs: job.epochs || 0,
      satellites: job.satellites || 0,
      error: job.error || null,
    }];
    renderQueueUI();

    if (btnStart) btnStart.style.display = 'none';
    if (btnAbort) btnAbort.style.display = 'none';
    if (progressSection) progressSection.style.display = 'block';

    if (overallFillEl) overallFillEl.style.width = '100%';
    if (overallPercentEl) overallPercentEl.innerText = `${job.percent || 100}%`;
    if (activeFilePctEl) activeFilePctEl.innerText = `${job.percent || 100}%`;
    if (activeFillEl) activeFillEl.style.width = `${job.percent || 100}%`;
    if (metricFiles) metricFiles.innerText = '1 / 1';
    if (metricEta) metricEta.innerText = '00:00';
    if (metricSpeed) metricSpeed.innerText = `${job.speed_mb_s || 0} MB/s`;
    if (metricEpochs) metricEpochs.innerText = (job.epochs || 0).toLocaleString('pl-PL');
    if (metricDataLabel) metricDataLabel.innerText = 'Przetworzono:';
    if (metricData) {
      const curMB = ((job.processed_bytes || job.file_size || 0) / (1024 * 1024)).toFixed(1);
      const totMB = ((job.file_size || 0) / (1024 * 1024)).toFixed(1);
      metricData.innerText = `${curMB} / ${totMB} MB`;
    }

    if (successBox && successDetails) {
      successBox.style.display = 'block';
      const iconEl = successBox.querySelector('.success-icon');
      const titleEl = successBox.querySelector('.success-title');

      if (job.status === 'done') {
        if (iconEl) iconEl.innerText = '';
        if (titleEl) {
          titleEl.innerText = 'Parsowanie zakończone sukcesem!';
          titleEl.style.color = '';
        }
        successDetails.innerHTML = `Pomyślnie przetworzono <strong>1</strong> plik (w tle na serwerze). Zapisano łącznie <strong>${(job.epochs || 0).toLocaleString('pl-PL')}</strong> nowych punktów telemetrycznych GPS.`;
      } else if (job.status === 'error') {
        if (iconEl) iconEl.innerText = '';
        if (titleEl) {
          titleEl.innerText = 'Błąd przetwarzania pliku w tle';
          titleEl.style.color = '#ef4444';
        }
        successDetails.innerHTML = `<span style="color:#f87171;font-weight:600;">Wystąpił błąd:</span><br><span style="font-size:12px;color:#cbd5e1;">${job.error || job.message}</span>`;
      }
    }

    if (btnViewMap) btnViewMap.style.display = job.status === 'done' ? 'inline-flex' : 'none';
    updateMenuButtonRunningState(false);
    updateCsvInfoCardVisibility();
  }

  function restoreRunningServerJob(job) {
    isProcessing = true;
    activeServerJobId = job.job_id;
    startTime = new Date(job.created_at).getTime() || Date.now();

    // Ukryj dropzone i profil docelowy - trwa aktywne zadanie
    if (dropzoneEl) dropzoneEl.style.display = 'none';
    const profBox = document.getElementById('parser-profile-box');
    if (profBox) profBox.style.display = 'none';
    updateCsvInfoCardVisibility();

    const srvPct = Math.min(100, Math.max(0, job.percent || 0));
    const mappedPct = (job.status === 'done') ? 100 : Math.max(18, Math.min(99, Math.round(18 + (srvPct * 0.81))));

    // Dodaj plik do widoku kolejki
    queue = [{
      id: 'job_' + job.job_id,
      name: job.filename,
      size: job.file_size || 0,
      status: job.status === 'running' ? (job.stage || 'parsing') : job.status,
      percent: mappedPct,
      message: job.message || 'Przetwarzanie na serwerze...',
      epochs: job.epochs || 0,
      satellites: job.satellites || 0,
    }];
    renderQueueUI();

    if (btnStart) btnStart.style.display = 'none';
    if (btnAbort) btnAbort.style.display = 'inline-flex';
    if (progressSection) progressSection.style.display = 'block';
    if (successBox) successBox.style.display = 'none';

    // Natychmiast zaktualizuj stan pasków postępu i metryk z danych zadania
    if (activeFileNameEl) activeFileNameEl.innerText = job.filename;
    if (activeFilePctEl) activeFilePctEl.innerText = `${mappedPct}%`;
    if (activeFillEl) activeFillEl.style.width = `${mappedPct}%`;
    if (overallPercentEl) overallPercentEl.innerText = `${mappedPct}%`;
    if (overallFillEl) overallFillEl.style.width = `${mappedPct}%`;
    if (metricFiles) metricFiles.innerText = '1 / 1';
    if (metricSpeed) metricSpeed.innerText = `${job.speed_mb_s || '--'} MB/s`;
    if (metricEpochs) metricEpochs.innerText = (job.epochs || 0).toLocaleString('pl-PL');
    if (metricEta) metricEta.innerText = job.eta_str || '--:--';
    if (metricDataLabel) metricDataLabel.innerText = 'Sparsowano:';
    if (metricData) {
      const curMB = ((job.processed_bytes || 0) / (1024 * 1024)).toFixed(1);
      const totMB = ((job.file_size || 0) / (1024 * 1024)).toFixed(1);
      metricData.innerText = `${curMB} / ${totMB} MB`;
    }
    if (currentStageEl) {
      let stageDesc = 'Odczyt i parsowanie telemetrii GPS';
      if (job.status === 'queued') stageDesc = 'Oczekiwanie w kolejce serwera';
      else if (job.stage === 'matching') stageDesc = 'Dopasowywanie dróg OSRM';
      else if (job.stage === 'saving') stageDesc = 'Zapis do bazy danych PostgreSQL';
      currentStageEl.innerText = `Plik (1/1): ${job.filename} — ${stageDesc} (${srvPct}%, ETA: ~${job.eta_str || '--:--'})`;
    }

    updateMenuButtonRunningState(true, job);
    startTimer();
    pollActiveServerJob(job.job_id);
  }

  // ------------------ REKURSYWNE SKANOWANIE I KOLEJKA ------------------

  async function scanEntry(entry) {
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file((file) => resolve([file]), () => resolve([]));
      });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const entries = await new Promise((resolve) => {
        const result = [];
        function readNext() {
          dirReader.readEntries((batch) => {
            if (!batch || batch.length === 0) {
              resolve(result);
            } else {
              result.push(...batch);
              readNext();
            }
          }, () => resolve(result));
        }
        readNext();
      });

      const files = [];
      for (const child of entries) {
        const subFiles = await scanEntry(child);
        files.push(...subFiles);
      }
      return files;
    }
    return [];
  }

  async function extractFilesFromDataTransfer(dataTransfer) {
    const files = [];
    if (dataTransfer.items && dataTransfer.items.length > 0) {
      const entries = [];
      for (let i = 0; i < dataTransfer.items.length; i++) {
        const item = dataTransfer.items[i];
        if (item.webkitGetAsEntry) {
          const entry = item.webkitGetAsEntry();
          if (entry) entries.push(entry);
        } else if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      for (const entry of entries) {
        const sub = await scanEntry(entry);
        files.push(...sub);
      }
    } else if (dataTransfer.files) {
      files.push(...Array.from(dataTransfer.files));
    }
    return files;
  }

  function addFilesToQueue(newFiles) {
    if (!newFiles || newFiles.length === 0) return;

    let addedCount = 0;
    for (const file of newFiles) {
      if (file.name.startsWith('.') || file.name.toLowerCase() === 'thumbs.db') continue;

      const exists = queue.some(q => q.name === file.name && q.size === file.size);
      if (!exists) {
        const prevRecord = getFileParseRecord(file.name);
        queue.push({
          id: 'file_' + Math.random().toString(36).substring(2, 9),
          file: file,
          name: file.name,
          size: file.size,
          status: 'queued',
          percent: 0,
          message: prevRecord ? `Już w bazie (${prevRecord.epochs} pkt)` : 'Oczekuje w kolejce',
          prevParsed: prevRecord,
          epochs: prevRecord ? prevRecord.epochs : 0,
          satellites: 0,
          error: null
        });
        addedCount++;
      }
    }

    if (addedCount > 0) {
      renderQueueUI();
    }
  }

  function clearQueue() {
    if (isProcessing) return;
    queue = [];
    renderQueueUI();
    if (dupPromptEl) dupPromptEl.style.display = 'none';
    if (progressSection) progressSection.style.display = 'none';
    if (successBox) successBox.style.display = 'none';
    if (btnViewMap) btnViewMap.style.display = 'none';
    if (dropzoneEl) dropzoneEl.style.display = 'block';
    const profBox = document.getElementById('parser-profile-box');
    if (profBox) profBox.style.display = 'block';
    if (btnStart) {
      btnStart.style.display = 'inline-flex';
      btnStart.disabled = true;
    }
    updateMenuButtonRunningState(false);
    updateCsvInfoCardVisibility();
  }

  function renderQueueUI() {
    if (!queueSection || !fileListContainer) return;

    if (queue.length === 0) {
      queueSection.style.display = 'none';
      if (btnStart) btnStart.disabled = true;
      return;
    }

    queueSection.style.display = 'block';

    const totalBytes = queue.reduce((acc, q) => acc + q.size, 0);
    if (queueCountBadge) {
      queueCountBadge.innerText = `${queue.length} ${queue.length === 1 ? 'plik' : (queue.length < 5 ? 'pliki' : 'plików')} (${formatBytes(totalBytes)})`;
    }

    const token = window.getAuthToken?.() || '';
    if (btnStart && !isProcessing) {
      btnStart.disabled = !token;
    }

    fileListContainer.innerHTML = '';
    queue.forEach((item) => {
      const row = document.createElement('div');
      row.className = `parser-file-row status-${item.status}`;
      row.id = `row-${item.id}`;

      let badgeClass = 'badge-queued';
      let badgeText = item.message || 'Oczekuje';

      if (item.status === 'reading' || item.status === 'uploading') {
        badgeClass = 'badge-uploading';
        badgeText = 'Wysyłanie...';
      } else if (item.status === 'writing') {
        badgeClass = 'badge-writing';
        badgeText = 'Zapis na dysku...';
      } else if (item.status === 'queued') {
        badgeClass = 'badge-queued';
        badgeText = 'W kolejce';
      } else if (item.status === 'parsing') {
        badgeClass = 'badge-running';
        badgeText = 'Parsowanie...';
      } else if (item.status === 'matching') {
        badgeClass = 'badge-matching';
        badgeText = 'OSRM Match...';
      } else if (item.status === 'saving') {
        badgeClass = 'badge-saving';
        badgeText = 'Zapis DB...';
      } else if (item.status === 'done') {
        badgeClass = 'badge-done';
        badgeText = `${item.epochs} pkt`;
      } else if (item.status === 'error') {
        badgeClass = 'badge-error';
        badgeText = 'Błąd';
      } else if (item.prevParsed && item.status === 'queued') {
        badgeClass = 'badge-parsed';
        badgeText = 'W bazie';
      }

      row.innerHTML = `
        <div class="file-row-main">
          <div class="file-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
          <div class="file-info-block">
            <div class="file-name" title="${item.name}">${item.name}</div>
            <div class="file-meta">
              <span class="file-size">${formatBytes(item.size)}</span>
              <span class="file-step-msg" id="msg-${item.id}">${item.message}</span>
            </div>
          </div>
          <div class="file-badge ${badgeClass}" id="badge-${item.id}">${badgeText}</div>
        </div>
        <div class="file-row-progress">
          <div class="file-progress-bar" id="fill-${item.id}" style="width: ${item.percent}%;"></div>
        </div>
      `;

      fileListContainer.appendChild(row);
    });
  }

  function updateFileRow(item) {
    const row = document.getElementById(`row-${item.id}`);
    const badge = document.getElementById(`badge-${item.id}`);
    const msg = document.getElementById(`msg-${item.id}`);
    const fill = document.getElementById(`fill-${item.id}`);

    if (row) row.className = `parser-file-row status-${item.status}`;
    if (msg) msg.innerText = item.message;
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, item.percent))}%`;

    if (badge) {
      let badgeClass = 'badge-queued';
      let badgeText = item.message;

      if (item.status === 'reading' || item.status === 'uploading') {
        badgeClass = 'badge-uploading';
        badgeText = 'Wysyłanie...';
      } else if (item.status === 'writing') {
        badgeClass = 'badge-writing';
        badgeText = 'Zapis na dysku...';
      } else if (item.status === 'queued') {
        badgeClass = 'badge-queued';
        badgeText = 'W kolejce';
      } else if (item.status === 'parsing') {
        badgeClass = 'badge-running';
        badgeText = 'Parsowanie...';
      } else if (item.status === 'matching') {
        badgeClass = 'badge-matching';
        badgeText = 'OSRM Match...';
      } else if (item.status === 'saving') {
        badgeClass = 'badge-saving';
        badgeText = 'Zapis DB...';
      } else if (item.status === 'done') {
        badgeClass = 'badge-done';
        badgeText = `${item.epochs} pkt`;
      } else if (item.status === 'error') {
        badgeClass = 'badge-error';
        badgeText = 'Błąd';
      } else if (item.prevParsed && item.status === 'queued') {
        badgeClass = 'badge-parsed';
        badgeText = 'W bazie';
      }

      badge.className = `file-badge ${badgeClass}`;
      badge.innerText = badgeText;
    }
  }

  // ------------------ OBSŁUGA DUPLIKATÓW PRZED STARTEM ------------------

  function checkForDuplicatesBeforeStart() {
    const duplicates = queue.filter(item => {
      const prev = getFileParseRecord(item.name);
      return prev !== null && item.status !== 'done';
    });

    if (duplicates.length === 0) {
      startSequentialProcessing();
      return;
    }

    // Wyświetl monit z listą zduplikowanych plików
    if (!dupPromptEl || !dupListEl) {
      startSequentialProcessing();
      return;
    }

    dupListEl.innerHTML = '';
    duplicates.forEach(d => {
      const rec = getFileParseRecord(d.name);
      const parsedDate = rec?.parsed_at ? new Date(rec.parsed_at).toLocaleString('pl-PL') : 'wcześniej';
      const itemEl = document.createElement('div');
      itemEl.className = 'dup-item';
      itemEl.innerHTML = `
        <span class="dup-item-name">${d.name} (${formatBytes(d.size)})</span>
        <span class="dup-item-meta">Zapisano: ${parsedDate} • ${rec?.epochs || 0} pkt</span>
      `;
      dupListEl.appendChild(itemEl);
    });

    dupPromptEl.style.display = 'block';

    btnDupSkip.onclick = () => {
      dupPromptEl.style.display = 'none';
      // Oznacz duplikaty jako pominięte
      duplicates.forEach(d => {
        d.status = 'done';
        d.percent = 100;
        d.message = 'Pominięto (już w bazie danych)';
        updateFileRow(d);
      });
      startSequentialProcessing();
    };

    btnDupReparse.onclick = () => {
      dupPromptEl.style.display = 'none';
      // Wymuś ponowne parsowanie
      startSequentialProcessing();
    };

    btnDupCancel.onclick = () => {
      dupPromptEl.style.display = 'none';
    };
  }

  // ------------------ PRZETWARZANIE PLIK PO PLIKU NA SERWERZE ------------------

  function startTimer() {
    clearInterval(timerInterval);
    let writingPulse = 0;
    timerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      if (metricElapsed) metricElapsed.innerText = formatTime(elapsedSec);

      // Płynne odliczanie sekunda po sekundzie (ETA)
      if (liveRemainingSec > 0) {
        liveRemainingSec--;
        if (metricEta) metricEta.innerText = formatTime(liveRemainingSec);
      }

      // Wizualny heartbeat gdy serwer zapisuje przesłany plik na dysku i rejestruje zadanie
      const currentItem = queue[processedFilesCount];
      if (currentItem && currentItem.status === 'writing') {
        writingPulse = (writingPulse + 1) % 4;
        const dots = '.'.repeat(writingPulse);
        if (currentStageEl) {
          currentStageEl.innerText = `Plik (${processedFilesCount + 1}/${queue.length}): ${currentItem.name} — Zapisywanie na dysku serwera i kolejkowanie zadania${dots}`;
        }
        if (metricSpeed) {
          metricSpeed.innerText = `Zapis na dysku${dots}`;
        }
      }
    }, 1000);
  }

  // Łączy wiele plików w jedną dużą całość (Blob) przed wysłaniem na serwer
  async function combineFilesIntoSingleBlob(items) {
    if (items.length === 1) {
      return {
        blob: items[0].file,
        name: items[0].name,
        count: 1
      };
    }

    const isAllGpx = items.every(it => it.name && it.name.toLowerCase().endsWith('.gpx'));
    const isAllCsv = items.every(it => it.name && it.name.toLowerCase().endsWith('.csv'));

    if (isAllGpx) {
      let combinedTracksXml = '';
      for (let i = 0; i < items.length; i++) {
        const text = await items[i].file.text();
        const trkMatches = text.match(/<trk[\s\S]*?<\/trk>/gi) || [];
        const wptMatches = text.match(/<wpt[\s\S]*?<\/wpt>/gi) || [];
        combinedTracksXml += trkMatches.join('\n') + '\n' + wptMatches.join('\n') + '\n';
      }
      const fullGpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="NNAPER">\n${combinedTracksXml}\n</gpx>`;
      return {
        blob: new Blob([fullGpx], { type: 'application/gpx+xml' }),
        name: `zbiorczy_import_${items.length}_tras_${Date.now()}.gpx`,
        count: items.length
      };
    }

    if (isAllCsv) {
      const parts = [];
      for (let i = 0; i < items.length; i++) {
        const file = items[i].file;
        if (i === 0) {
          parts.push(file);
        } else {
          // Pobierz fragment nagłówka, aby pominąć zduplikowaną pierwszą linię
          const headerChunk = await file.slice(0, 4096).text();
          const firstNl = headerChunk.indexOf('\n');
          if (firstNl !== -1) {
            parts.push('\n');
            parts.push(file.slice(firstNl + 1));
          } else {
            parts.push('\n');
            parts.push(file);
          }
        }
      }
      return {
        blob: new Blob(parts, { type: 'text/csv' }),
        name: `zbiorczy_import_${items.length}_plikow_${Date.now()}.csv`,
        count: items.length
      };
    }

    // Domyślny format: NMEA / pliki tekstowe / logi telemetryczne (.nmea, .txt, .log)
    // Bezpośrednie łączenie deskryptorów Blob bez narzutu na pamięć RAM przeglądarki
    const parts = [];
    for (let i = 0; i < items.length; i++) {
      parts.push(items[i].file);
      parts.push('\n');
    }
    return {
      blob: new Blob(parts, { type: 'text/plain' }),
      name: `zbiorczy_import_${items.length}_plikow_${Date.now()}.txt`,
      count: items.length
    };
  }

  async function startSequentialProcessing() {
    const token = window.getAuthToken?.() || '';
    if (!token) {
      alert('Musisz być zalogowany, aby importować trasy GPS.');
      return;
    }

    const itemsToProcess = queue.filter(q => q.status !== 'done');
    if (itemsToProcess.length === 0) {
      finishAllSuccess();
      return;
    }

    isProcessing = true;
    isUploading = true;
    startTime = Date.now();
    startTimer();

    const totalRemainingBytes = itemsToProcess.reduce((acc, q) => acc + (q.size || q.file?.size || 0), 0);
    const initialEtaSec = Math.max(1, Math.round((totalRemainingBytes / (1024 * 1024)) / estimatedParsingSpeedMBs));
    if (metricEta) metricEta.innerText = formatTime(initialEtaSec);
    if (metricSpeed) metricSpeed.innerText = '-- MB/s';

    if (btnStart) btnStart.style.display = 'none';
    if (btnAbort) btnAbort.style.display = 'inline-flex';
    if (btnCancel) btnCancel.disabled = true;
    if (btnClose) {
      btnClose.disabled = true;
      btnClose.setAttribute('title', 'Nie można zamknąć okna w trakcie wysyłania plików na serwer');
    }
    if (btnClearQueue) btnClearQueue.disabled = true;
    if (btnViewMap) btnViewMap.style.display = 'none';
    if (successBox) successBox.style.display = 'none';
    if (progressSection) progressSection.style.display = 'block';
    if (dropzoneEl) dropzoneEl.style.display = 'none';
    const profBox = document.getElementById('parser-profile-box');
    if (profBox) profBox.style.display = 'none';
    updateCsvInfoCardVisibility();

    const snap = true; // Zawsze dociągaj do dróg OSM

    try {
      // 1. Etap łączenia: Jeśli jest wiele plików, łączymy je w jedną dużą całość przed wysłaniem
      if (itemsToProcess.length > 1) {
        if (currentStageEl) {
          currentStageEl.innerText = `Pobieranie i łączenie ${itemsToProcess.length} plików w jedną całość przed wysłaniem...`;
        }
        if (activeFileNameEl) {
          activeFileNameEl.innerText = `Zbiorcza paczka (${itemsToProcess.length} plików)`;
        }
        itemsToProcess.forEach(it => {
          it.status = 'reading';
          it.percent = 1;
          it.message = 'Łączenie w jedną całość...';
          updateFileRow(it);
        });
      } else {
        if (activeFileNameEl) activeFileNameEl.innerText = itemsToProcess[0].name;
      }

      const combined = await combineFilesIntoSingleBlob(itemsToProcess);

      // 2. Etap wysyłania i przetwarzania połączonej całości
      await processCombinedFilesOnServer(combined.blob, combined.name, itemsToProcess, snap);
    } catch (err) {
      if (err.name === 'AbortError') {
        itemsToProcess.forEach(it => {
          if (it.status !== 'done') {
            it.status = 'error';
            it.message = 'Przerwano przez użytkownika';
            updateFileRow(it);
          }
        });
      } else {
        itemsToProcess.forEach(it => {
          if (it.status !== 'done') {
            it.status = 'error';
            it.error = err.message;
            it.message = `Błąd: ${err.message}`;
            updateFileRow(it);
          }
        });
        if (itemsToProcess.some(it => it.name && it.name.toLowerCase().endsWith('.csv'))) {
          updateCsvInfoCardVisibility();
        }
      }
    } finally {
      isUploading = false;
      if (btnClose) {
        btnClose.disabled = false;
        btnClose.removeAttribute('title');
      }
      if (btnCancel) btnCancel.disabled = false;
    }

    finishAllSuccess();
  }

  // Wysyła połączony plik i monitoruje zadanie w tle na serwerze
  function processCombinedFilesOnServer(combinedBlob, combinedName, items, snap) {
    return new Promise((resolve, reject) => {
      const token = window.getAuthToken?.() || '';
      const targetProfileSelect = document.getElementById('parser-target-profile-select');
      const targetProfileId = targetProfileSelect ? targetProfileSelect.value : (window.getActiveProfileId?.() || '');
      const profParam = targetProfileId ? `&profile_id=${encodeURIComponent(targetProfileId)}` : '';
      const filterParams = getNmeaFilterQueryString();
      const url = `${getApiBaseUrl()}/api/parser/upload?token=${encodeURIComponent(token)}&snap=${snap ? 'true' : 'false'}&filename=${encodeURIComponent(combinedName)}${profParam}${filterParams}`;

      const xhr = new XMLHttpRequest();
      activeXhr = xhr;
      isUploading = true;

      items.forEach(it => {
        it.status = 'uploading';
        it.percent = 1;
        it.message = items.length > 1 ? `Wysyłanie połączonej paczki (${items.length} plików)...` : 'Wysyłanie na serwer...';
        updateFileRow(it);
      });

      if (btnClose) {
        btnClose.disabled = true;
        btnClose.setAttribute('title', 'Nie można zamknąć okna w trakcie wysyłania plików na serwer');
      }
      if (btnCancel) btnCancel.disabled = true;

      let uploadStartTime = Date.now();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          const uploadPct = Math.min(100, Math.round((e.loaded / e.total) * 100));
          const elapsedUploadSec = Math.max(0.1, (Date.now() - uploadStartTime) / 1000);
          const uploadSpeed = e.loaded / elapsedUploadSec;

          // Upload mapujemy na zakres 1% - 15% całkowitego postępu
          const mappedUploadPct = Math.max(1, Math.min(15, Math.round(uploadPct * 0.15)));

          const remainingUploadBytes = Math.max(0, e.total - e.loaded);
          const remainingUploadSec = uploadSpeed > 0 ? (remainingUploadBytes / uploadSpeed) : 0;
          const estimatedParsingSec = (e.total / (1024 * 1024)) / Math.max(0.5, estimatedParsingSpeedMBs);
          const totalRemainingSec = Math.max(1, Math.round(remainingUploadSec + estimatedParsingSec));

          if (uploadPct < 100) {
            isUploading = true;
            items.forEach(it => {
              it.status = 'uploading';
              it.percent = mappedUploadPct;
              it.message = `Wysyłanie na serwer: ${formatBytes(e.loaded)} / ${formatBytes(e.total)} (${uploadPct}%)`;
              updateFileRow(it);
            });
          } else {
            isUploading = false;
            items.forEach(it => {
              it.status = 'writing';
              it.percent = 15;
              it.message = 'Transfer 100% zakończony. Zapisywanie na dysku serwera i kolejkowanie...';
              updateFileRow(it);
            });
          }

          if (activeFilePctEl) activeFilePctEl.innerText = `${mappedUploadPct}%`;
          if (activeFillEl) activeFillEl.style.width = `${mappedUploadPct}%`;
          if (metricSpeed) {
            if (uploadPct < 100) {
              const upMB = (uploadSpeed / (1024 * 1024)).toFixed(1);
              metricSpeed.innerText = `${upMB} MB/s (upload)`;
            } else {
              metricSpeed.innerText = 'Zapis na dysku...';
            }
          }
          liveRemainingSec = totalRemainingSec;
          if (metricEta) metricEta.innerText = formatTime(liveRemainingSec);
          if (metricDataLabel) {
            metricDataLabel.innerText = uploadPct < 100 ? 'Wysyłanie:' : 'Zapis na dysku:';
          }
          if (metricData) {
            const curMB = (e.loaded / (1024 * 1024)).toFixed(1);
            const totMB = (e.total / (1024 * 1024)).toFixed(1);
            metricData.innerText = `${curMB} / ${totMB} MB`;
          }

          if (currentStageEl) {
            const curMB = (e.loaded / (1024 * 1024)).toFixed(1);
            const totMB = (e.total / (1024 * 1024)).toFixed(1);
            if (uploadPct < 100) {
              const upMB = (uploadSpeed / (1024 * 1024)).toFixed(1);
              const filesLabel = items.length > 1 ? `Połączona paczka (${items.length} plików)` : items[0].name;
              currentStageEl.innerText = `${filesLabel} — Wysyłanie: ${curMB}/${totMB} MB (${uploadPct}%, ${upMB} MB/s) — Szacowane ETA: ~${formatTime(totalRemainingSec)}`;
            } else {
              currentStageEl.innerText = `Paczka przesłana w 100%. Trwa zapisywanie i uruchamianie parsowania w tle...`;
            }
          }
          updateOverallProgress(mappedUploadPct);
        }
      };

      xhr.onload = async () => {
        activeXhr = null;
        isUploading = false;
        if (btnClose) {
          btnClose.disabled = false;
          btnClose.removeAttribute('title');
        }
        if (btnCancel) btnCancel.disabled = false;

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const resp = JSON.parse(xhr.responseText);
            activeServerJobId = resp.job_id;

            items.forEach(it => {
              it.status = 'queued';
              it.percent = 18;
              it.message = 'Pliki zapisane na serwerze. Uruchamianie parsowania w tle...';
              updateFileRow(it);
            });

            if (activeFilePctEl) activeFilePctEl.innerText = '18%';
            if (activeFillEl) activeFillEl.style.width = '18%';
            if (metricSpeed) metricSpeed.innerText = 'Inicjalizacja...';
            if (currentStageEl) {
              const filesLabel = items.length > 1 ? `Połączona paczka (${items.length} plików)` : items[0].name;
              currentStageEl.innerText = `${filesLabel} — Zadanie serwera zarejestrowane. Rozpoczynanie parsowania w tle...`;
            }
            updateOverallProgress(18);

            await pollServerJobUntilDone(resp.job_id, items, combinedBlob.size);
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          let errDetail = `Błąd serwera (HTTP ${xhr.status})`;
          try {
            const errJson = JSON.parse(xhr.responseText);
            if (errJson.detail) errDetail = errJson.detail;
          } catch (e) {}
          reject(new Error(errDetail));
        }
      };

      xhr.onerror = () => {
        activeXhr = null;
        isUploading = false;
        if (btnClose) {
          btnClose.disabled = false;
          btnClose.removeAttribute('title');
        }
        if (btnCancel) btnCancel.disabled = false;
        reject(new Error('Błąd połączenia z serwerem'));
      };

      xhr.onabort = () => {
        activeXhr = null;
        isUploading = false;
        if (btnClose) {
          btnClose.disabled = false;
          btnClose.removeAttribute('title');
        }
        if (btnCancel) btnCancel.disabled = false;
        const err = new Error('Przerwano');
        err.name = 'AbortError';
        reject(err);
      };

      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(combinedName));
      xhr.send(combinedBlob);
    });
  }

  // Odpytuje serwer co 1s o stan trwającego zadania
  function pollServerJobUntilDone(jobId, items, combinedTotalBytes) {
    const itemList = Array.isArray(items) ? items : [items];
    return new Promise((resolve, reject) => {
      const token = window.getAuthToken?.() || '';

      const check = async () => {
        if (!isProcessing) {
          clearInterval(pollingInterval);
          reject(new Error('Przerwano'));
          return;
        }

        try {
          const res = await fetch(`${getApiBaseUrl()}/api/parser/jobs?token=${encodeURIComponent(token)}`);
          if (!res.ok) return;
          const data = await res.json();
          const job = (data.jobs || []).find(j => j.job_id === jobId);

          if (!job) return;

          // Aktualizacja wygładzonej średniej prędkości parsowania serwera (MB/s)
          if (job.speed_mb_s && job.speed_mb_s > 0) {
            estimatedParsingSpeedMBs = job.speed_mb_s;
          }

          // Rzeczywisty postęp parsowania danych z serwera (na bazie przetworzonych MB)
          const srvPct = Math.min(100, Math.max(0, job.percent || 0));
          // Parsowanie na serwerze mapujemy na zakres 18% - 99% (lub 100% gdy gotowe)
          const actualPct = (job.status === 'done') ? 100 : Math.max(18, Math.min(99, Math.round(18 + (srvPct * 0.81))));

          const fileTotalBytes = combinedTotalBytes || job.file_size || 0;
          const processedBytes = job.processed_bytes || Math.round(fileTotalBytes * (srvPct / 100));

          // Szacowanie pozostałego czasu w sekundach
          let serverSec = (job.eta_seconds !== undefined && job.eta_seconds > 0) ? job.eta_seconds : 0;
          if (serverSec === 0 && fileTotalBytes > processedBytes && estimatedParsingSpeedMBs > 0) {
            serverSec = Math.round((fileTotalBytes - processedBytes) / (estimatedParsingSpeedMBs * 1024 * 1024));
          }

          if (liveRemainingSec <= 0 || Math.abs(liveRemainingSec - serverSec) > 10) {
            liveRemainingSec = serverSec;
          } else {
            liveRemainingSec = Math.round((liveRemainingSec * 0.3) + (serverSec * 0.7));
          }

          itemList.forEach(it => {
            it.percent = actualPct;
            it.status = job.status === 'running' ? (job.stage || 'parsing') : job.status;
            it.message = job.message || 'Przetwarzanie na serwerze...';
            it.epochs = job.epochs || it.epochs || 0;
            if (job.status === 'error') {
              it.error = job.error || job.message;
            }
            updateFileRow(it);
          });

          if (activeFilePctEl) activeFilePctEl.innerText = `${actualPct}%`;
          if (activeFillEl) activeFillEl.style.width = `${actualPct}%`;
          if (metricEta) metricEta.innerText = formatTime(liveRemainingSec);
          const displaySpeed = (job.speed_mb_s !== undefined && job.speed_mb_s > 0) ? job.speed_mb_s : estimatedParsingSpeedMBs;
          if (metricSpeed) {
            metricSpeed.innerText = `${displaySpeed} MB/s`;
          }
          if (metricEpochs) metricEpochs.innerText = (totalEpochsAccumulator + (job.epochs || 0)).toLocaleString('pl-PL');
          if (metricDataLabel) metricDataLabel.innerText = (job.status === 'done') ? 'Przetworzono:' : 'Sparsowano:';
          if (metricData) {
            const curMB = (processedBytes / (1024 * 1024)).toFixed(1);
            const totMB = (fileTotalBytes / (1024 * 1024)).toFixed(1);
            metricData.innerText = `${curMB} / ${totMB} MB`;
          }

          if (currentStageEl) {
            let stageDesc = 'Odczyt i parsowanie telemetrii GPS';
            if (job.status === 'queued') stageDesc = 'Oczekiwanie w kolejce serwera';
            else if (job.stage === 'matching') stageDesc = 'Dopasowywanie dróg OSRM';
            else if (job.stage === 'saving') stageDesc = 'Zapis do bazy danych PostgreSQL';
            else if (job.stage === 'done' || job.status === 'done') stageDesc = 'Zakończono pomyślnie';
            const curMB = (processedBytes / (1024 * 1024)).toFixed(1);
            const totMB = (fileTotalBytes / (1024 * 1024)).toFixed(1);
            const filesLabel = itemList.length > 1 ? `Zbiorcza paczka (${itemList.length} plików)` : itemList[0].name;
            currentStageEl.innerText = `${filesLabel} — ${stageDesc} (${srvPct}%, ${curMB}/${totMB} MB, ${displaySpeed} MB/s, ETA: ~${formatTime(liveRemainingSec)})`;
          }

          updateOverallProgress(actualPct);

          if (job.status === 'done') {
            clearInterval(pollingInterval);
            totalEpochsAccumulator += (job.epochs || 0);
            itemList.forEach(it => {
              it.status = 'done';
              it.percent = 100;
              it.message = 'Pomyślnie zaimportowano';
              updateFileRow(it);
              saveLocalHistory(it.name, it.size, job.epochs || 0);
            });
            resolve();
          } else if (job.status === 'error') {
            clearInterval(pollingInterval);
            itemList.forEach(it => {
              it.status = 'error';
              it.error = job.error || job.message;
              it.message = `Błąd: ${job.error || job.message}`;
              updateFileRow(it);
            });
            reject(new Error(job.error || job.message || 'Błąd zadania serwera'));
          }
        } catch (err) {
          console.warn('Błąd odpytywania serwera:', err);
        }
      };

      check();
      pollingInterval = setInterval(check, 1000);
    });
  }

  function pollActiveServerJob(jobId) {
    const queueItem = queue[0];
    if (queueItem) {
      pollServerJobUntilDone(jobId, queueItem).then(() => {
        finishAllSuccess();
      }).catch(err => {
        queueItem.status = 'error';
        queueItem.message = err.message;
        updateFileRow(queueItem);
        if (queueItem.name && queueItem.name.toLowerCase().endsWith('.csv')) {
          updateCsvInfoCardVisibility();
        }
        cleanupProcessingState();
      });
    }
  }

  function updateOverallProgress(currentFilePct = 0) {
    if (!queue.length) return;
    const completedWeight = processedFilesCount;
    const currentWeight = (currentFilePct / 100);
    const overallPct = Math.min(100, Math.max(0, Math.round(((completedWeight + currentWeight) / queue.length) * 100)));

    if (overallFillEl) overallFillEl.style.width = `${overallPct}%`;
    if (overallPercentEl) overallPercentEl.innerText = `${overallPct}%`;
    if (metricFiles) metricFiles.innerText = `${Math.min(queue.length, processedFilesCount + (currentFilePct === 100 ? 1 : 0))} / ${queue.length}`;
  }

  function finishAllSuccess() {
    cleanupProcessingState();
    const successfulFiles = queue.filter(q => q.status === 'done').length;
    const failedFiles = queue.filter(q => q.status === 'error').length;

    if (currentStageEl) {
      if (successfulFiles > 0 && failedFiles === 0) {
        currentStageEl.innerText = 'Wszystkie zadania zostały ukończone sukcesem.';
      } else if (successfulFiles === 0 && failedFiles > 0) {
        currentStageEl.innerText = 'Wystąpił błąd podczas przetwarzania plików.';
      } else {
        currentStageEl.innerText = 'Przetwarzanie zakończone (część plików z błędami).';
      }
    }
    if (overallFillEl) overallFillEl.style.width = '100%';
    if (overallPercentEl) overallPercentEl.innerText = '100%';
    if (metricEta) metricEta.innerText = '00:00';

    if (successBox && successDetails) {
      successBox.style.display = 'block';
      const iconEl = successBox.querySelector('.success-icon');
      const titleEl = successBox.querySelector('.success-title');

      if (successfulFiles === 0 && failedFiles > 0) {
        if (iconEl) iconEl.innerText = '';
        if (titleEl) {
          titleEl.innerText = 'Błąd przetwarzania plików';
          titleEl.style.color = '#ef4444';
        }
        const firstErr = queue.find(q => q.error)?.error || 'Szczegóły błędu w liście plików powyżej.';
        successDetails.innerHTML = `<span style="color:#f87171;font-weight:600;">Nie udało się zaimportować żadnego pliku.</span><br><span style="font-size:12px;color:#cbd5e1;">Powód: ${firstErr}</span>`;
      } else {
        if (iconEl) iconEl.innerText = '';
        if (titleEl) {
          titleEl.innerText = failedFiles > 0 ? 'Zakończono z ostrzeżeniami' : 'Parsowanie zakończone sukcesem!';
          titleEl.style.color = failedFiles > 0 ? '#f59e0b' : '';
        }
        let summaryText = `Pomyślnie przetworzono <strong>${successfulFiles}</strong> z ${queue.length} plików.`;
        summaryText += ` Zapisano łącznie <strong>${totalEpochsAccumulator.toLocaleString('pl-PL')}</strong> nowych punktów telemetrycznych GPS.`;
        if (failedFiles > 0) {
          summaryText += ` <span style="color:#f87171;">(${failedFiles} z błędami)</span>.`;
        }
        successDetails.innerHTML = summaryText;
      }
    }

    if (btnViewMap) btnViewMap.style.display = 'inline-flex';

    try {
      window.dispatchEvent(new CustomEvent('nnaper_auth_changed'));
      if (typeof window.updateTrackTilesSource === 'function') {
        window.updateTrackTilesSource();
      }
    } catch (e) {}

    updateCsvInfoCardVisibility();
  }

  function abortProcessing() {
    isProcessing = false;
    clearInterval(pollingInterval);
    clearInterval(timerInterval);

    if (activeXhr) {
      try { activeXhr.abort(); } catch (e) {}
      activeXhr = null;
    }

    if (activeServerJobId) {
      const token = window.getAuthToken?.() || '';
      fetch(`${getApiBaseUrl()}/api/parser/job/${activeServerJobId}/abort?token=${encodeURIComponent(token)}`, {
        method: 'POST'
      }).catch(() => {});
      activeServerJobId = null;
    }

    if (currentStageEl) currentStageEl.innerText = 'Przetwarzanie zostało przerwane.';
    cleanupProcessingState();
    updateCsvInfoCardVisibility();
  }

  function cleanupProcessingState() {
    isProcessing = false;
    isUploading = false;
    clearInterval(timerInterval);
    clearInterval(pollingInterval);
    activeXhr = null;
    activeServerJobId = null;

    if (btnClose) {
      btnClose.disabled = false;
      btnClose.removeAttribute('title');
    }
    if (btnStart) {
      btnStart.style.display = 'inline-flex';
      btnStart.disabled = queue.length === 0 || !(window.getAuthToken?.());
    }
    if (btnAbort) btnAbort.style.display = 'none';
    if (btnCancel) btnCancel.disabled = false;
    if (btnClearQueue) btnClearQueue.disabled = false;
  }

  // ------------------ PODPIĘCIE ZDARZEŃ ------------------

  function setupEventListeners() {
    setupBeforeUnloadProtection();
    restoreNmeaFilters();

    const fltInputs = [
      'flt-min-fix-quality', 'flt-min-satellites', 'flt-max-hdop', 'flt-max-pdop',
      'flt-min-altitude', 'flt-max-altitude', 'flt-max-speed', 'flt-require-rmc-valid'
    ];
    fltInputs.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', saveNmeaFilters);
        el.addEventListener('change', saveNmeaFilters);
      }
    });

    const btnResetFlt = document.getElementById('btn-flt-reset-defaults');
    if (btnResetFlt) {
      btnResetFlt.addEventListener('click', (e) => {
        e.preventDefault();
        applyNmeaFiltersToDom(DEFAULT_NMEA_FILTERS);
        saveNmeaFilters();
      });
    }

    const selTargetProfile = document.getElementById('parser-target-profile-select');
    if (selTargetProfile) {
      selTargetProfile.addEventListener('change', () => {
        const subNote = document.querySelector('.parser-profile-sub');
        if (subNote) {
          const selName = selTargetProfile.options[selTargetProfile.selectedIndex]?.text || '';
          subNote.innerText = `Wgrywane trasy zostaną przypisane do profilu: ${selName}`;
        }
      });
    }

    if (btnOpenMenu) btnOpenMenu.addEventListener('click', openParserModal);
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('#btn-open-parser, .btn-trigger-parser');
      if (trigger) {
        e.stopPropagation();
        openParserModal();
      }
    });
    if (btnClose) btnClose.addEventListener('click', closeParserModal);
    if (btnCancel) btnCancel.addEventListener('click', closeParserModal);
    if (btnAbort) btnAbort.addEventListener('click', abortProcessing);
    if (btnStart) btnStart.addEventListener('click', checkForDuplicatesBeforeStart);
    if (btnClearQueue) btnClearQueue.addEventListener('click', clearQueue);

    // Natychmiastowa synchronizacja z serwerem po odświeżeniu strony
    syncWithServerJobs();

    if (btnViewMap) {
      btnViewMap.addEventListener('click', () => {
        closeParserModal();
      });
    }

    // Wybór plików i folderów
    if (btnChooseFiles && fileInput) {
      btnChooseFiles.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
      });
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          addFilesToQueue(Array.from(e.target.files));
          fileInput.value = '';
        }
      });
    }

    if (btnChooseFolder && folderInput) {
      btnChooseFolder.addEventListener('click', (e) => {
        e.stopPropagation();
        folderInput.click();
      });
      folderInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          addFilesToQueue(Array.from(e.target.files));
          folderInput.value = '';
        }
      });
    }

    // Obsługa dodawania nowego profilu z poziomu okna parsowania
    const btnParserNewProfile = document.getElementById('btn-parser-new-profile');
    if (btnParserNewProfile) {
      btnParserNewProfile.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (window.AuthManager?.showCreateProfileModal) {
          window.AuthManager.showCreateProfileModal((newP) => {
            loadProfilesIntoParserSelect().then(() => {
              const targetProfileSelect = document.getElementById('parser-target-profile-select');
              if (targetProfileSelect && newP?.profile_id) {
                targetProfileSelect.value = newP.profile_id;
              }
            });
          });
        }
      });
    }

    // Drag & Drop
    if (dropzoneEl) {
      dropzoneEl.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('#parser-csv-info-card')) {
          return;
        }
        if (fileInput) fileInput.click();
      });

      ['dragenter', 'dragover'].forEach(eventName => {
        dropzoneEl.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzoneEl.classList.add('dragover');
        });
      });

      ['dragleave', 'dragend'].forEach(eventName => {
        dropzoneEl.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzoneEl.classList.remove('dragover');
        });
      });

      dropzoneEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.remove('dragover');

        if (e.dataTransfer) {
          const files = await extractFilesFromDataTransfer(e.dataTransfer);
          if (files && files.length > 0) {
            addFilesToQueue(files);
          }
        }
      });
    }

    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          closeParserModal();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalEl && modalEl.style.display !== 'none') {
        if (isUploading) {
          e.preventDefault();
          e.stopPropagation();
          alert('Trwa przesyłanie plików na serwer. Nie można zamknąć okna dopóki wszystkie pliki nie zostaną przesłane!');
          return;
        }
        closeParserModal();
      }
    });

    window.addEventListener('nnaper_auth_changed', () => {
      checkAuthStatus();
      syncWithServerJobs();
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    window.addEventListener('drop', async (e) => {
      if (e.target && e.target.closest && e.target.closest('#parser-dropzone')) return;
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        openParserModal();
        const files = await extractFilesFromDataTransfer(e.dataTransfer);
        if (files && files.length > 0) {
          addFilesToQueue(files);
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupEventListeners);
  } else {
    setupEventListeners();
  }

  window.openParserModal = openParserModal;
  window.ParserManager = {
    open: openParserModal,
    close: closeParserModal,
    addFiles: addFilesToQueue
  };

})(window, document);
