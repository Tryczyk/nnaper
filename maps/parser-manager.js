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
  const optSnap = document.getElementById('parser-opt-snap');

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
  const metricSats = document.getElementById('metric-sats-count');

  const successBox = document.getElementById('parser-success-box');
  const successDetails = document.getElementById('parser-success-details');

  // Stan
  let queue = [];
  let isProcessing = false;
  let activeXhr = null;
  let activeServerJobId = null;
  let timerInterval = null;
  let pollingInterval = null;
  let startTime = 0;
  let totalEpochsAccumulator = 0;
  let totalSatsAccumulator = 0;
  let processedFilesCount = 0;
  let serverHistoryCache = {};

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function formatTime(seconds) {
    if (!seconds || seconds <= 0 || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
      if (isProcessing) {
        e.preventDefault();
        e.returnValue = 'Trwa przesyłanie i przetwarzanie plików GPS na serwerze. Czy na pewno chcesz opuścić stronę?';
        return e.returnValue;
      }
    });
  }

  // ------------------ MODAL & STAN ------------------

  function openParserModal() {
    if (!modalEl) return;
    modalEl.style.display = 'flex';
    checkAuthStatus();
    loadProfilesIntoParserSelect();
    syncWithServerJobs();
  }

  async function loadProfilesIntoParserSelect() {
    const targetProfileSelect = document.getElementById('parser-target-profile-select');
    if (!targetProfileSelect) return;
    try {
      const profiles = await window.fetchUserProfiles?.() || [];
      targetProfileSelect.innerHTML = '';
      if (!profiles || profiles.length === 0) {
        targetProfileSelect.innerHTML = '<option value="">Domyślny profil</option>';
        return;
      }
      const activeId = window.getActiveProfileId?.() || '';
      profiles.forEach(p => {
        const icon = window.getProfileIcon ? window.getProfileIcon(p.name) : '🏷️';
        const opt = document.createElement('option');
        opt.value = p.profile_id;
        opt.innerText = `${icon} ${p.name}`;
        if (p.profile_id === activeId) opt.selected = true;
        targetProfileSelect.appendChild(opt);
      });
      if (!targetProfileSelect.value && profiles.length > 0) {
        targetProfileSelect.value = profiles[0].profile_id;
      }
    } catch (e) {
      targetProfileSelect.innerHTML = '<option value="">Domyślny profil</option>';
    }
  }

  function closeParserModal() {
    if (isProcessing) {
      if (!confirm('Trwa przetwarzanie plików GPS. Zamknięcie okna nie przerwie pracy serwera w tle, ale czy chcesz zamknąć widok?')) {
        return;
      }
    }
    if (modalEl) {
      modalEl.style.display = 'none';
    }
    const csvInfoCard = document.getElementById('parser-csv-info-card');
    if (csvInfoCard) csvInfoCard.style.display = 'none';
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
      if (activeJobs.length > 0 && !isProcessing) {
        // Serwer przetwarza zadanie w tle! Odtwórz stan w UI
        const runningJob = activeJobs[0];
        restoreRunningServerJob(runningJob);
      }
    } catch (e) {
      console.warn('Nie udało się pobrać stanu zadań z serwera:', e);
    }
  }

  function restoreRunningServerJob(job) {
    isProcessing = true;
    activeServerJobId = job.job_id;
    startTime = new Date(job.created_at).getTime() || Date.now();

    // Dodaj plik do widoku kolejki
    queue = [{
      id: 'job_' + job.job_id,
      name: job.filename,
      size: job.file_size || 0,
      status: job.status,
      percent: job.percent || 10,
      message: job.message || 'Przetwarzanie na serwerze...',
      epochs: job.epochs || 0,
      satellites: job.satellites || 0,
    }];
    renderQueueUI();

    if (btnStart) btnStart.style.display = 'none';
    if (btnAbort) btnAbort.style.display = 'inline-flex';
    if (progressSection) progressSection.style.display = 'block';
    if (successBox) successBox.style.display = 'none';

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

      if (item.status === 'reading' || item.status === 'parsing') {
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
        badgeText = `✓ ${item.epochs} pkt`;
      } else if (item.status === 'error') {
        badgeClass = 'badge-error';
        badgeText = '✕ Błąd';
      } else if (item.prevParsed && item.status === 'queued') {
        badgeClass = 'badge-parsed';
        badgeText = '⏱️ W bazie';
      }

      row.innerHTML = `
        <div class="file-row-main">
          <div class="file-icon">${item.status === 'done' ? '✅' : (item.status === 'error' ? '❌' : (item.prevParsed ? '🔁' : '📄'))}</div>
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

      if (item.status === 'reading' || item.status === 'parsing') {
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
        badgeText = `✓ ${item.epochs} pkt`;
      } else if (item.status === 'error') {
        badgeClass = 'badge-error';
        badgeText = '✕ Błąd';
      } else if (item.prevParsed && item.status === 'queued') {
        badgeClass = 'badge-parsed';
        badgeText = '⏱️ W bazie';
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
        <span class="dup-item-name">📄 ${d.name} (${formatBytes(d.size)})</span>
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
    timerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      if (metricElapsed) metricElapsed.innerText = formatTime(elapsedSec);
    }, 1000);
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
    startTime = Date.now();
    startTimer();

    if (btnStart) btnStart.style.display = 'none';
    if (btnAbort) btnAbort.style.display = 'inline-flex';
    if (btnCancel) btnCancel.disabled = true;
    if (btnClearQueue) btnClearQueue.disabled = true;
    if (btnViewMap) btnViewMap.style.display = 'none';
    if (successBox) successBox.style.display = 'none';
    if (progressSection) progressSection.style.display = 'block';

    const snap = optSnap ? optSnap.checked : true;

    for (let i = 0; i < queue.length; i++) {
      if (!isProcessing) break;
      const item = queue[i];
      if (item.status === 'done') continue; // pominięty duplikat

      processedFilesCount = i;
      updateOverallProgress(0);

      if (activeFileNameEl) activeFileNameEl.innerText = item.name;

      try {
        await processSingleFileOnServer(item, snap);
      } catch (err) {
        if (err.name === 'AbortError') {
          item.status = 'error';
          item.message = 'Przerwano przez użytkownika';
          updateFileRow(item);
          break;
        }
        item.status = 'error';
        item.error = err.message;
        item.message = `Błąd: ${err.message}`;
        updateFileRow(item);
      }
    }

    finishAllSuccess();
  }

  // Wysyła plik i monitoruje zadanie w tle na serwerze
  function processSingleFileOnServer(queueItem, snap) {
    return new Promise((resolve, reject) => {
      const token = window.getAuthToken?.() || '';
      const targetProfileSelect = document.getElementById('parser-target-profile-select');
      const targetProfileId = targetProfileSelect ? targetProfileSelect.value : (window.getActiveProfileId?.() || '');
      const profParam = targetProfileId ? `&profile_id=${encodeURIComponent(targetProfileId)}` : '';
      const url = `${getApiBaseUrl()}/api/parser/upload?token=${encodeURIComponent(token)}&snap=${snap ? 'true' : 'false'}&filename=${encodeURIComponent(queueItem.name)}${profParam}`;

      const xhr = new XMLHttpRequest();
      activeXhr = xhr;

      queueItem.status = 'reading';
      queueItem.percent = 2;
      queueItem.message = 'Wysyłanie na serwer...';
      updateFileRow(queueItem);

      let uploadStartTime = Date.now();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          const uploadPct = Math.min(100, Math.round((e.loaded / e.total) * 100));
          const elapsedUploadSec = Math.max(0.1, (Date.now() - uploadStartTime) / 1000);
          const uploadSpeed = e.loaded / elapsedUploadSec;
          const remainingSec = Math.round((e.total - e.loaded) / Math.max(1, uploadSpeed));

          queueItem.status = 'reading';
          queueItem.message = `Wysyłanie: ${formatBytes(e.loaded)} / ${formatBytes(e.total)} (${uploadPct}%)`;
          // Wysyłanie to pierwsze 20% postępu pliku
          queueItem.percent = Math.max(2, Math.round(uploadPct * 0.2));
          updateFileRow(queueItem);

          if (activeFilePctEl) activeFilePctEl.innerText = `${queueItem.percent}%`;
          if (activeFillEl) activeFillEl.style.width = `${queueItem.percent}%`;
          if (metricSpeed) metricSpeed.innerText = `${(uploadSpeed / (1024 * 1024)).toFixed(1)} MB/s`;
          if (metricEta) metricEta.innerText = formatTime(remainingSec);

          if (currentStageEl) {
            currentStageEl.innerText = `Plik (${processedFilesCount + 1}/${queue.length}): ${queueItem.name} — Wysyłanie: ${uploadPct}% (ETA: ~${formatTime(remainingSec)})`;
          }
          updateOverallProgress(queueItem.percent);
        }
      };

      xhr.onload = async () => {
        activeXhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const resp = JSON.parse(xhr.responseText);
            activeServerJobId = resp.job_id;

            queueItem.percent = 20;
            queueItem.message = 'Plik na serwerze. Rozpoczynanie parsowania...';
            updateFileRow(queueItem);

            // Przejdź do odpytywania stanu zadania serwera
            await pollServerJobUntilDone(resp.job_id, queueItem);
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
        reject(new Error('Błąd połączenia z serwerem'));
      };

      xhr.onabort = () => {
        activeXhr = null;
        const err = new Error('Przerwano');
        err.name = 'AbortError';
        reject(err);
      };

      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(queueItem.name));
      xhr.send(queueItem.file);
    });
  }

  // Odpytuje serwer co 1s o stan trwającego zadania
  function pollServerJobUntilDone(jobId, queueItem) {
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

          // Aktualizacja metryk i pasków postępu
          const srvPct = Math.min(100, Math.max(0, job.percent || 0));
          // Postęp parsowania na serwerze zajmuje 20% - 100%
          const mappedPct = Math.max(queueItem.percent, Math.round(20 + (srvPct * 0.8)));

          queueItem.percent = (job.status === 'done') ? 100 : mappedPct;
          queueItem.status = job.status === 'running' ? (job.stage || 'parsing') : job.status;
          queueItem.message = job.message || 'Przetwarzanie na serwerze...';
          queueItem.epochs = job.epochs || queueItem.epochs;
          queueItem.satellites = job.satellites || queueItem.satellites;
          updateFileRow(queueItem);

          if (activeFilePctEl) activeFilePctEl.innerText = `${queueItem.percent}%`;
          if (activeFillEl) activeFillEl.style.width = `${queueItem.percent}%`;
          if (metricEta && job.eta_str) metricEta.innerText = job.eta_str;
          if (metricSpeed && job.speed_mb_s !== undefined) metricSpeed.innerText = `${job.speed_mb_s} MB/s`;
          if (metricEpochs) metricEpochs.innerText = (totalEpochsAccumulator + (job.epochs || 0)).toLocaleString('pl-PL');
          if (metricSats) metricSats.innerText = (totalSatsAccumulator + (job.satellites || 0)).toLocaleString('pl-PL');

          if (currentStageEl) {
            currentStageEl.innerText = `Plik (${processedFilesCount + 1}/${queue.length}): ${queueItem.name} — ${job.message}`;
          }

          updateOverallProgress(queueItem.percent);

          if (job.status === 'done') {
            clearInterval(pollingInterval);
            totalEpochsAccumulator += (job.epochs || 0);
            totalSatsAccumulator += (job.satellites || 0);
            saveLocalHistory(queueItem.name, queueItem.size, job.epochs || 0);
            resolve();
          } else if (job.status === 'error') {
            clearInterval(pollingInterval);
            reject(new Error(job.error || job.message || 'Błąd zadania serwera'));
          }
        } catch (err) {
          console.warn('Błąd odpytywania serwera:', err);
        }
      };

      clearInterval(pollingInterval);
      pollingInterval = setInterval(check, 1000);
      check(); // natychmiastowe pierwsze wywołanie
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

    if (currentStageEl) currentStageEl.innerText = 'Wszystkie zadania zostały ukończone.';
    if (overallFillEl) overallFillEl.style.width = '100%';
    if (overallPercentEl) overallPercentEl.innerText = '100%';
    if (metricEta) metricEta.innerText = '00:00';

    if (successBox && successDetails) {
      successBox.style.display = 'block';
      let summaryText = `Pomyślnie przetworzono <strong>${successfulFiles}</strong> z ${queue.length} plików.`;
      summaryText += ` Zapisano łącznie <strong>${totalEpochsAccumulator.toLocaleString('pl-PL')}</strong> nowych punktów telemetrycznych GPS`;
      if (totalSatsAccumulator > 0) {
        summaryText += ` oraz <strong>${totalSatsAccumulator.toLocaleString('pl-PL')}</strong> rekordów satelitów`;
      }
      summaryText += '.';
      if (failedFiles > 0) {
        summaryText += ` <span style="color:#f87171;">(${failedFiles} z błędami)</span>.`;
      }
      successDetails.innerHTML = summaryText;
    }

    if (btnViewMap) btnViewMap.style.display = 'inline-flex';

    try {
      window.dispatchEvent(new CustomEvent('nnaper_auth_changed'));
      if (typeof window.updateTrackTilesSource === 'function') {
        window.updateTrackTilesSource();
      }
    } catch (e) {}
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
  }

  function cleanupProcessingState() {
    isProcessing = false;
    clearInterval(timerInterval);
    clearInterval(pollingInterval);
    activeXhr = null;
    activeServerJobId = null;

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

    if (btnOpenMenu) btnOpenMenu.addEventListener('click', openParserModal);
    if (btnClose) btnClose.addEventListener('click', closeParserModal);
    if (btnCancel) btnCancel.addEventListener('click', closeParserModal);
    if (btnAbort) btnAbort.addEventListener('click', abortProcessing);
    if (btnStart) btnStart.addEventListener('click', checkForDuplicatesBeforeStart);
    if (btnClearQueue) btnClearQueue.addEventListener('click', clearQueue);

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

    // Obsługa okna pomocy formatu CSV
    const btnCsvInfo = document.getElementById('btn-csv-info');
    const csvInfoCard = document.getElementById('parser-csv-info-card');
    const btnCloseCsvInfo = document.getElementById('btn-close-csv-info');

    if (btnCsvInfo && csvInfoCard) {
      btnCsvInfo.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isHidden = csvInfoCard.style.display === 'none';
        csvInfoCard.style.display = isHidden ? 'block' : 'none';
      });
    }

    if (btnCloseCsvInfo && csvInfoCard) {
      btnCloseCsvInfo.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        csvInfoCard.style.display = 'none';
      });
    }

    // Drag & Drop
    if (dropzoneEl) {
      dropzoneEl.addEventListener('click', (e) => {
        if (e.target && e.target.closest && (e.target.closest('#btn-csv-info') || e.target.closest('#parser-csv-info-card'))) {
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

  window.ParserManager = {
    open: openParserModal,
    close: closeParserModal,
    addFiles: addFilesToQueue
  };

})(window, document);
