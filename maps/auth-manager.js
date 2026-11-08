/**
 * AuthManager - Moduł logowania, rejestracji i profilu użytkownika dla NNAPER
 * Obsługuje:
 * - Formularz logowania i rejestracji w prawym panelu
 * - Wyświetlanie awatara (klasyczny szaro-biały ludek FB w SVG gdy brak profilowego)
 * - Wyświetlanie nazwy konta pod ludkiem
 * - Przesyłanie własnego zdjęcia profilowego po kliknięciu w awatar
 * - Zapis sesji w localStorage i autoryzację z backendem FastAPI
 */

(function (window) {
  'use strict';

  const STORAGE_KEY = 'nnaper_auth_session';

  function getApiBaseUrl() {
    return (window.NNAPER_CONFIG?.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
  }

  function getStoredSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('Błąd odczytu sesji z localStorage:', e);
    }
    return null;
  }

  function saveStoredSession(session) {
    try {
      if (!session) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      }
    } catch (e) {
      console.warn('Błąd zapisu sesji do localStorage:', e);
    }
    window.dispatchEvent(new CustomEvent('nnaper_auth_changed', { detail: session }));
  }

  /**
   * Generuje ikonę SVG klasycznego szaro-białego ludka FB (domyślny awatar bez profilowego)
   */
  function getFacebookDefaultAvatarSvg() {
    return `
      <svg class="fb-default-avatar-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-label="Domyślne zdjęcie profilowe">
        <circle cx="50" cy="50" r="50" fill="#cbd5e1" />
        <circle cx="50" cy="38" r="17.5" fill="#ffffff" />
        <path d="M15 97 C15 72 32 63.5 50 63.5 C68 63.5 85 72 85 97 Z" fill="#ffffff" />
      </svg>
    `;
  }

  function getProfileIcon(name) {
    const lower = (name || '').toLowerCase();
    if (lower.includes('samochód') || lower.includes('samochod') || lower.includes('auto') || lower.includes('car')) return '🚗';
    if (lower.includes('lot') || lower.includes('samolot') || lower.includes('plane') || lower.includes('awiacja')) return '✈️';
    if (lower.includes('rower') || lower.includes('bike') || lower.includes('kolar') || lower.includes('cycling')) return '🚲';
    if (lower.includes('bieg') || lower.includes('run') || lower.includes('jogging')) return '🏃';
    if (lower.includes('piesz') || lower.includes('walk') || lower.includes('hike') || lower.includes('spacer') || lower.includes('gór')) return '🥾';
    if (lower.includes('żegl') || lower.includes('lodz') || lower.includes('łódź') || lower.includes('żeglarsk') || lower.includes('boat') || lower.includes('sail')) return '⛵';
    if (lower.includes('motocykl') || lower.includes('moto') || lower.includes('motor')) return '🏍️';
    if (lower.includes('pociąg') || lower.includes('kolej') || lower.includes('train')) return '🚆';
    return '🏷️';
  }

  /**
   * Kompresuje/skaluje obraz do maksymalnej rozdzielczości 512px przy użyciu Canvas
   */
  function processAndResizeImage(file, maxSize = 512) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxSize) {
              height = Math.round((height * maxSize) / width);
              width = maxSize;
            }
          } else {
            if (height > maxSize) {
              width = Math.round((width * maxSize) / height);
              height = maxSize;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
          resolve(dataUrl);
        };
        img.onerror = () => reject(new Error('Nie udało się załadować grafiki.'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Błąd odczytu pliku.'));
      reader.readAsDataURL(file);
    });
  }

  class AuthManager {
    constructor() {
      this.currentMode = 'login'; // 'login' | 'register'
      this.containerId = 'auth-panel-container';
      this.isSubmitting = false;
    }

    init(containerId = 'auth-panel-container') {
      this.containerId = containerId;
      this.render();
      this.verifySessionWithBackend();

      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
          this.render();
        }
      });
    }

    async verifySessionWithBackend() {
      const session = getStoredSession();
      if (!session || !session.token) return;

      try {
        const res = await fetch(`${getApiBaseUrl()}/api/auth/me?token=${encodeURIComponent(session.token)}`);
        if (!res.ok) throw new Error('Błąd API');
        const data = await res.json();
        if (data.authenticated && data.user) {
          session.user = data.user;
          saveStoredSession(session);
          this.render();
        } else {
          saveStoredSession(null);
          this.render();
        }
      } catch (err) {
        console.warn('Nie udało się zweryfikować sesji z serwerem:', err);
      }
    }

    render() {
      const container = document.getElementById(this.containerId);
      if (!container) return;

      const session = getStoredSession();
      container.innerHTML = '';

      if (session && session.user) {
        this.renderLoggedInView(container, session.user, session.token);
      } else {
        this.renderLoggedOutView(container);
      }
    }

    renderLoggedInView(container, user, token) {
      const card = document.createElement('div');
      card.className = 'auth-card auth-profile-card';

      // 1. Awatar profilowy (kliknięcie pozwala wybrać nowe zdjęcie)
      const avatarWrapper = document.createElement('div');
      avatarWrapper.className = 'auth-avatar-wrapper';
      avatarWrapper.title = 'Kliknij w profilowe, aby przesłać własne zdjęcie';
      avatarWrapper.setAttribute('role', 'button');
      avatarWrapper.setAttribute('tabindex', '0');

      const avatarBox = document.createElement('div');
      avatarBox.className = 'auth-avatar-box';

      if (user.avatar_url) {
        const img = document.createElement('img');
        img.className = 'auth-avatar-img';
        img.src = user.avatar_url;
        img.alt = user.username || 'Profil';
        avatarBox.appendChild(img);
      } else {
        avatarBox.innerHTML = getFacebookDefaultAvatarSvg();
      }

      // Nakładka z ikonką aparatu przy najechaniu
      const overlay = document.createElement('div');
      overlay.className = 'auth-avatar-overlay';
      overlay.innerHTML = '<span class="overlay-icon">📷</span><span class="overlay-text">Zmień</span>';
      avatarBox.appendChild(overlay);

      avatarWrapper.appendChild(avatarBox);

      // Ukryty input pliku
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.className = 'auth-file-input';
      fileInput.style.display = 'none';

      const triggerUpload = () => fileInput.click();
      avatarWrapper.onclick = triggerUpload;
      avatarWrapper.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerUpload();
        }
      };

      fileInput.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
          alert('Wybierz poprawny plik graficzny (np. JPG, PNG, WEBP).');
          return;
        }

        try {
          avatarWrapper.classList.add('loading');
          const dataUrl = await processAndResizeImage(file, 512);

          const res = await fetch(`${getApiBaseUrl()}/api/auth/avatar`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ avatar_url: dataUrl })
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || 'Błąd zapisu zdjęcia profilowego');
          }

          const resData = await res.json();
          user.avatar_url = resData.avatar_url || dataUrl;
          const session = getStoredSession() || {};
          session.user = user;
          saveStoredSession(session);
          this.render();
        } catch (err) {
          console.error('Błąd wgrywania profilowego:', err);
          alert('Nie udało się wgrać zdjęcia: ' + err.message);
        } finally {
          avatarWrapper.classList.remove('loading');
          fileInput.value = '';
        }
      };

      card.appendChild(avatarWrapper);
      card.appendChild(fileInput);

      // 2. Nazwa konta pod ludkiem
      const userDetails = document.createElement('div');
      userDetails.className = 'auth-user-details';

      const usernameEl = document.createElement('div');
      usernameEl.className = 'auth-username-label';
      usernameEl.innerText = user.username || 'Użytkownik';
      usernameEl.title = user.username || '';

      const hintEl = document.createElement('div');
      hintEl.className = 'auth-avatar-hint';
      hintEl.innerText = 'Kliknij w profilowe, aby zmienić';

      userDetails.appendChild(usernameEl);
      userDetails.appendChild(hintEl);
      card.appendChild(userDetails);

      // 2.5. Profile aktywności wewnątrz konta
      const profilesContainer = document.createElement('div');
      profilesContainer.className = 'auth-profiles-box';
      card.appendChild(profilesContainer);
      this.populateProfilesUI(profilesContainer, token);

      // 3. Przycisk wylogowania
      const logoutBtn = document.createElement('button');
      logoutBtn.type = 'button';
      logoutBtn.className = 'auth-btn-logout';
      logoutBtn.innerText = 'Wyloguj się';
      logoutBtn.title = 'Wyloguj się z konta';
      logoutBtn.onclick = async () => {
        try {
          await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
        } catch (e) { }
        saveStoredSession(null);
        this.render();
      };

      card.appendChild(logoutBtn);
      container.appendChild(card);
    }

    renderLoggedOutView(container) {
      const card = document.createElement('div');
      card.className = 'auth-card auth-guest-card';

      // 1. Podgląd domyślnego ludka FB na górze panelu logowania
      const previewWrapper = document.createElement('div');
      previewWrapper.className = 'auth-avatar-wrapper preview-only';
      previewWrapper.innerHTML = `
        <div class="auth-avatar-box">
          ${getFacebookDefaultAvatarSvg()}
        </div>
      `;
      card.appendChild(previewWrapper);

      // 2. Przełącznik zakładek (Logowanie / Rejestracja)
      const tabs = document.createElement('div');
      tabs.className = 'auth-tabs';

      const tabLogin = document.createElement('button');
      tabLogin.type = 'button';
      tabLogin.className = 'auth-tab-btn' + (this.currentMode === 'login' ? ' active' : '');
      tabLogin.innerText = 'Logowanie';
      tabLogin.onclick = () => {
        this.currentMode = 'login';
        this.render();
      };

      const tabRegister = document.createElement('button');
      tabRegister.type = 'button';
      tabRegister.className = 'auth-tab-btn' + (this.currentMode === 'register' ? ' active' : '');
      tabRegister.innerText = 'Rejestracja';
      tabRegister.onclick = () => {
        this.currentMode = 'register';
        this.render();
      };

      tabs.appendChild(tabLogin);
      tabs.appendChild(tabRegister);
      card.appendChild(tabs);

      // 3. Formularz
      const form = document.createElement('form');
      form.className = 'auth-form';

      const errorBox = document.createElement('div');
      errorBox.className = 'auth-error-box';
      errorBox.style.display = 'none';

      if (this.currentMode === 'login') {
        form.innerHTML = `
          <div class="auth-field">
            <label for="auth-input-login-user">Nazwa konta lub e-mail</label>
            <input type="text" id="auth-input-login-user" name="username" placeholder="Wpisz nazwę konta" required autocomplete="username" />
          </div>
          <div class="auth-field">
            <label for="auth-input-login-pass">Hasło</label>
            <input type="password" id="auth-input-login-pass" name="password" placeholder="Wpisz hasło" required autocomplete="current-password" />
          </div>
        `;

        form.appendChild(errorBox);

        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.className = 'auth-btn-primary';
        submitBtn.innerText = 'Zaloguj się';
        form.appendChild(submitBtn);

        const switchLink = document.createElement('div');
        switchLink.className = 'auth-switch-link';
        switchLink.innerHTML = 'Nie masz konta? <span>Zarejestruj się</span>';
        switchLink.onclick = () => {
          this.currentMode = 'register';
          this.render();
        };
        form.appendChild(switchLink);

        form.onsubmit = async (e) => {
          e.preventDefault();
          if (this.isSubmitting) return;

          const username = form.username.value.trim();
          const password = form.password.value;

          if (!username || !password) {
            this.showError(errorBox, 'Wypełnij wszystkie pola.');
            return;
          }

          this.setSubmitting(submitBtn, true, 'Logowanie...');
          this.hideError(errorBox);

          try {
            const res = await fetch(`${getApiBaseUrl()}/api/auth/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password })
            });

            const data = await res.json();
            if (!res.ok) {
              throw new Error(data.detail || 'Błąd logowania');
            }

            saveStoredSession({ token: data.token, user: data.user });
            this.render();
          } catch (err) {
            this.showError(errorBox, err.message);
          } finally {
            this.setSubmitting(submitBtn, false, 'Zaloguj się');
          }
        };

      } else {
        // Rejestracja
        form.innerHTML = `
          <div class="auth-field">
            <label for="auth-input-reg-user">Nazwa konta</label>
            <input type="text" id="auth-input-reg-user" name="username" placeholder="Wpisz nazwę konta" required autocomplete="username" />
          </div>
          <div class="auth-field">
            <label for="auth-input-reg-pass">Hasło</label>
            <input type="password" id="auth-input-reg-pass" name="password" placeholder="Wpisz hasło (min. 4 znaki)" required autocomplete="new-password" />
          </div>
          <div class="auth-field">
            <label for="auth-input-reg-pass2">Powtórz hasło</label>
            <input type="password" id="auth-input-reg-pass2" name="password_repeat" placeholder="Powtórz hasło" required autocomplete="new-password" />
          </div>
        `;

        form.appendChild(errorBox);

        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.className = 'auth-btn-primary';
        submitBtn.innerText = 'Zarejestruj się';
        form.appendChild(submitBtn);

        const switchLink = document.createElement('div');
        switchLink.className = 'auth-switch-link';
        switchLink.innerHTML = 'Masz już konto? <span>Zaloguj się</span>';
        switchLink.onclick = () => {
          this.currentMode = 'login';
          this.render();
        };
        form.appendChild(switchLink);

        form.onsubmit = async (e) => {
          e.preventDefault();
          if (this.isSubmitting) return;

          const username = form.username.value.trim();
          const password = form.password.value;
          const passwordRepeat = form.password_repeat.value;

          if (username.length < 3) {
            this.showError(errorBox, 'Nazwa konta musi mieć min. 3 znaki.');
            return;
          }
          if (password.length < 4) {
            this.showError(errorBox, 'Hasło musi mieć co najmniej 4 znaki.');
            return;
          }
          if (password !== passwordRepeat) {
            this.showError(errorBox, 'Hasła nie są identyczne.');
            return;
          }

          this.setSubmitting(submitBtn, true, 'Rejestrowanie...');
          this.hideError(errorBox);

          try {
            const res = await fetch(`${getApiBaseUrl()}/api/auth/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password })
            });

            const data = await res.json();
            if (!res.ok) {
              throw new Error(data.detail || 'Błąd rejestracji');
            }

            saveStoredSession({ token: data.token, user: data.user });
            this.render();
          } catch (err) {
            this.showError(errorBox, err.message);
          } finally {
            this.setSubmitting(submitBtn, false, 'Zarejestruj się');
          }
        };
      }

      card.appendChild(form);
      container.appendChild(card);
    }

    showError(box, text) {
      box.innerText = text;
      box.style.display = 'block';
    }

    hideError(box) {
      box.innerText = '';
      box.style.display = 'none';
    }

    setSubmitting(btn, isSubmitting, text) {
      this.isSubmitting = isSubmitting;
      btn.disabled = isSubmitting;
      btn.innerText = text;
    }

    async populateProfilesUI(container, token) {
      container.innerHTML = '<div class="auth-profiles-loading">Ładowanie profili...</div>';
      try {
        const profiles = await window.fetchUserProfiles();
        container.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'auth-profiles-head';

        const title = document.createElement('span');
        title.className = 'auth-profiles-title';
        title.innerText = 'Aktywny profil:';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'auth-btn-add-profile';
        addBtn.innerText = '➕ Nowy profil';
        addBtn.title = 'Utwórz nowy profil (np. Samochodowy, Rowerowy, Lotniczy, Do biegu)';
        addBtn.onclick = () => {
          this.showCreateProfileModal(() => this.populateProfilesUI(container, token));
        };

        head.appendChild(title);
        head.appendChild(addBtn);
        container.appendChild(head);

        const currentActive = window.getActiveProfileId();
        const selectWrap = document.createElement('div');
        selectWrap.className = 'auth-profiles-select-wrap';

        const select = document.createElement('select');
        select.className = 'auth-profiles-select';

        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.innerText = '🌐 Wszystkie profile (zsumowane)';
        if (!currentActive) allOpt.selected = true;
        select.appendChild(allOpt);

        let activeFound = false;
        profiles.forEach(p => {
          const icon = getProfileIcon(p.name);
          const opt = document.createElement('option');
          opt.value = p.profile_id;
          opt.innerText = `${icon} ${p.name} (${p.epochs_count || 0} pkt)`;
          if (p.profile_id === currentActive) {
            opt.selected = true;
            activeFound = true;
          }
          select.appendChild(opt);
        });

        if (currentActive && !activeFound) {
          // Jeśli zapisany profil już nie istnieje
          window.setActiveProfileId('');
          allOpt.selected = true;
        }

        select.onchange = (e) => {
          window.setActiveProfileId(e.target.value);
        };

        selectWrap.appendChild(select);
        container.appendChild(selectWrap);

        // Zarządzanie bieżącym profilem (np. usuwanie jeśli profil wybrany)
        const activeProfileObj = profiles.find(p => p.profile_id === currentActive);
        if (activeProfileObj && profiles.length > 1) {
          const deleteRow = document.createElement('div');
          deleteRow.className = 'auth-profile-delete-row';
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'auth-btn-del-profile';
          delBtn.innerText = `Usuń profil "${activeProfileObj.name}"`;
          delBtn.onclick = async () => {
            if (confirm(`Czy na pewno chcesz usunąć profil "${activeProfileObj.name}" oraz WSZYSTKIE przypisane do niego trasy?`)) {
              try {
                await window.deleteUserProfile(activeProfileObj.profile_id);
                window.setActiveProfileId('');
                this.populateProfilesUI(container, token);
              } catch (err) {
                alert('Błąd usuwania profilu: ' + err.message);
              }
            }
          };
          deleteRow.appendChild(delBtn);
          container.appendChild(deleteRow);
        }

      } catch (err) {
        console.warn('Błąd renderowania profili:', err);
        container.innerHTML = '<div class="auth-profiles-error">Nie udało się załadować profili</div>';
      }
    }

    showCreateProfileModal(onCreated) {
      let modal = document.getElementById('nnaper-create-profile-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'nnaper-create-profile-modal';
        modal.className = 'export-modal-backdrop';
        modal.style.zIndex = '10005';
        modal.innerHTML = `
          <div class="create-profile-dialog">
            <div class="create-profile-header">
              <span style="font-size: 20px;">🏷️</span>
              <div>
                <h4 style="margin: 0; color: #38bdf8;">Nowy profil aktywności</h4>
                <p style="margin: 2px 0 0; font-size: 11px; color: #94a3b8;">Przypisuj ślady do różnych kategorii (samochód, rower, lot, bieg...)</p>
              </div>
              <button type="button" class="create-profile-close-btn" id="btn-close-create-profile">✕</button>
            </div>
            <div class="create-profile-body">
              <label style="font-size: 11.5px; color: #cbd5e1; display: block; margin-bottom: 6px; font-weight: 600;">Szybki wybór gotowego profilu:</label>
              <div class="profile-presets-grid">
                <button type="button" class="profile-preset-pill" data-name="Samochodowy">🚗 Samochodowy</button>
                <button type="button" class="profile-preset-pill" data-name="Lotniczy">✈️ Lotniczy</button>
                <button type="button" class="profile-preset-pill" data-name="Rowerowy">🚲 Rowerowy</button>
                <button type="button" class="profile-preset-pill" data-name="Do biegu">🏃 Do biegu</button>
                <button type="button" class="profile-preset-pill" data-name="Pieszy">🥾 Pieszy</button>
                <button type="button" class="profile-preset-pill" data-name="Żeglarski">⛵ Żeglarski</button>
              </div>
              <label for="create-profile-name-input" style="font-size: 11.5px; color: #cbd5e1; display: block; margin: 12px 0 6px; font-weight: 600;">Wpisz lub zmodyfikuj nazwę:</label>
              <input type="text" id="create-profile-name-input" placeholder="Wpisz nazwę profilu..." maxlength="64" class="create-profile-input" autocomplete="off" />
              <div id="create-profile-error" class="auth-error-box" style="display: none; margin-top: 8px;"></div>
            </div>
            <div class="create-profile-footer">
              <button type="button" id="btn-cancel-create-profile" class="btn-cancel-create-profile">Anuluj</button>
              <button type="button" id="btn-confirm-create-profile" class="btn-confirm-create-profile">Utwórz profil</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
      }

      const input = modal.querySelector('#create-profile-name-input');
      const errBox = modal.querySelector('#create-profile-error');
      const confirmBtn = modal.querySelector('#btn-confirm-create-profile');
      const cancelBtn = modal.querySelector('#btn-cancel-create-profile');
      const closeBtn = modal.querySelector('#btn-close-create-profile');
      const pills = modal.querySelectorAll('.profile-preset-pill');

      input.value = '';
      errBox.style.display = 'none';
      confirmBtn.disabled = false;
      modal.style.display = 'flex';
      setTimeout(() => input.focus(), 50);

      const closeModal = () => {
        modal.style.display = 'none';
      };

      cancelBtn.onclick = closeModal;
      closeBtn.onclick = closeModal;
      modal.onclick = (e) => {
        if (e.target === modal) closeModal();
      };

      pills.forEach(pill => {
        pill.onclick = () => {
          input.value = pill.getAttribute('data-name');
          errBox.style.display = 'none';
          input.focus();
        };
      });

      const handleConfirm = async () => {
        const val = input.value.trim();
        if (!val) {
          errBox.innerText = 'Podaj nazwę profilu.';
          errBox.style.display = 'block';
          return;
        }
        confirmBtn.disabled = true;
        confirmBtn.innerText = 'Tworzenie...';
        try {
          const res = await window.createUserProfile(val);
          const newProfile = res.profile;
          if (newProfile && newProfile.profile_id) {
            window.setActiveProfileId(newProfile.profile_id);
          }
          closeModal();
          if (typeof onCreated === 'function') onCreated(newProfile);
        } catch (err) {
          errBox.innerText = err.message || 'Błąd tworzenia profilu';
          errBox.style.display = 'block';
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.innerText = 'Utwórz profil';
        }
      };

      confirmBtn.onclick = handleConfirm;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleConfirm();
        } else if (e.key === 'Escape') {
          closeModal();
        }
      };
    }
  }

  window.getAuthToken = function () {
    const s = getStoredSession();
    return s?.token || '';
  };

  window.getAuthUser = function () {
    const s = getStoredSession();
    return s?.user || null;
  };

  window.getActiveProfileId = function () {
    return localStorage.getItem('nnaper_active_profile_id') || '';
  };

  window.setActiveProfileId = function (profileId) {
    if (!profileId) {
      localStorage.removeItem('nnaper_active_profile_id');
    } else {
      localStorage.setItem('nnaper_active_profile_id', profileId);
    }
    window.dispatchEvent(new CustomEvent('nnaper_profile_changed', { detail: { profile_id: profileId || '' } }));
  };

  window.getProfileIcon = getProfileIcon;

  window.fetchUserProfiles = async function () {
    const token = window.getAuthToken?.() || '';
    if (!token) return [];
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/auth/profiles?token=${encodeURIComponent(token)}`);
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      console.warn('Błąd pobierania profili:', e);
      return [];
    }
  };

  window.createUserProfile = async function (name) {
    const token = window.getAuthToken?.() || '';
    if (!token) throw new Error('Wymagane logowanie');
    const res = await fetch(`${getApiBaseUrl()}/api/auth/profiles?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Błąd tworzenia profilu');
    }
    return await res.json();
  };

  window.deleteUserProfile = async function (profileId) {
    const token = window.getAuthToken?.() || '';
    if (!token) throw new Error('Wymagane logowanie');
    const res = await fetch(`${getApiBaseUrl()}/api/auth/profiles/${encodeURIComponent(profileId)}?token=${encodeURIComponent(token)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Błąd usuwania profilu');
    }
    return await res.json();
  };

  window.AuthManager = new AuthManager();

  // Autostart po załadowaniu drzewa DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.AuthManager.init();
    });
  } else {
    window.AuthManager.init();
  }

})(window);

