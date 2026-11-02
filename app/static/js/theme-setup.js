/**
 * theme-setup.js — the single owner of the theme setting, on every Listen Here! page.
 *
 * Owns: the persisted choice, the `data-theme` attribute, the logo swap, the
 * Theme section's markup, and its radio wiring. Applies the saved theme
 * synchronously (before paint) to avoid a flash of unstyled content.
 *
 * Pages that ship their own settings drawer (listen.html) get only the Theme
 * section injected into `#settings-drawer-content`; they keep ownership of the
 * drawer's open/close behaviour and of their other sections. Pages without one
 * (index.html) get the whole drawer and its pull button injected, using the
 * same ids and classes so both share one set of CSS rules.
 *
 * Every theme application dispatches an `lh-theme-change` CustomEvent on
 * `document` (detail: `{ theme }`). Page-specific side effects belong in a
 * listener for it — listen.js repaints waveforms, grids, and markers there.
 */
(function () {
  const KEY = 'listenTool_theme';
  const DARK_BG = ['dark', 'dracula', 'forest', 'nord'];
  const THEMES = [
    ['light', 'Light'], ['solarized', 'Solarized'], ['sepia', 'Sepia'], ['peach', 'Peach'],
    ['dark', 'Dark'], ['dracula', 'Dracula'], ['forest', 'Forest'], ['nord', 'Nord'],
  ];

  function _getTheme() {
    try { return localStorage.getItem(KEY) || 'light'; } catch (_) { return 'light'; }
  }

  /** Markup for the Theme section — identical wherever the drawer lives. */
  function _themeSectionHTML(theme) {
    const rows = [
      ['Light', THEMES.slice(0, 4)],
      ['Dark',  THEMES.slice(4)],
    ].map(([label, opts]) => {
      const radios = opts.map(([v, l]) =>
        `<label class="settings-theme-option">` +
          `<input type="radio" name="app-theme" value="${v}"${v === theme ? ' checked' : ''}/>` +
          `<span class="settings-theme-swatch theme-swatch-${v}" title="${l}"></span>` +
          `<span>${l}</span>` +
        `</label>`
      ).join('');
      return `<div class="theme-row"><span class="theme-row-label">${label}</span>${radios}</div>`;
    }).join('');

    return `<section class="settings-section">` +
             `<h3 class="settings-section-title">Theme</h3>` +
             `<div class="settings-theme-options">${rows}</div>` +
           `</section>`;
  }

  function _applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    try { localStorage.setItem(KEY, theme); } catch (_) {}

    // Swap logo images: active bat on dark backgrounds, sleeping bat otherwise.
    document.querySelectorAll('.lh-logo-img').forEach(img => {
      img.src = DARK_BG.includes(theme)
        ? '/static/bat/ListenHereBat.svg'
        : '/static/bat/ListenHereBatAsleep.svg';
    });
    // Keep the radios in step, wherever the drawer came from.
    document.querySelectorAll('input[name="app-theme"]').forEach(r => {
      r.checked = r.value === theme;
    });

    // Page-specific repaints hang off this (see listen.js).
    document.dispatchEvent(new CustomEvent('lh-theme-change', { detail: { theme } }));
  }

  // Apply immediately (synchronous) to avoid flash of unstyled content. The
  // <body> does not exist yet at this point, so the logo swap is repeated once
  // the DOM is ready, below.
  _applyTheme(_getTheme());

  // Expose for pages that want to call it programmatically
  window._lhApplyTheme = _applyTheme;

  /** Wire the Theme radios of whichever drawer we are given, by delegation. */
  function _wireThemeRadios(root) {
    root.addEventListener('change', e => {
      if (e.target.name === 'app-theme') _applyTheme(e.target.value);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const theme = _getTheme();
    const hostContent = document.getElementById('settings-drawer-content');

    if (hostContent) {
      // The page ships its own drawer (listen.html): own the Theme section only,
      // ahead of the sections the page declares for itself.
      hostContent.insertAdjacentHTML('afterbegin', _themeSectionHTML(theme));
      _wireThemeRadios(hostContent);
      _applyTheme(theme);
      return;
    }

    // --- No drawer on this page: inject the whole thing ---
    const drawer = document.createElement('div');
    drawer.id = 'settings-drawer';
    drawer.className = 'closed';
    drawer.innerHTML =
      `<div class="drawer-header">` +
        `<h2>Settings</h2>` +
        `<button id="close-settings-drawer" aria-label="Close">&#x2715;</button>` +
      `</div>` +
      `<div id="settings-drawer-content">` +
        _themeSectionHTML(theme) +
        `<section class="settings-section">` +
          `<h3 class="settings-section-title">Language</h3>` +
          `<p class="settings-hint">English (translations coming soon)</p>` +
        `</section>` +
      `</div>`;

    // --- Drawer-pull button ---
    const pullWrap = document.createElement('div');
    pullWrap.className = 'drawer-btns';
    pullWrap.innerHTML =
      `<button id="settings-drawer-btn" title="Settings" aria-label="Settings">` +
        `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
          `<circle cx="12" cy="12" r="3"/>` +
          `<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>` +
        `</svg>` +
      `</button>`;

    document.body.appendChild(drawer);
    document.body.appendChild(pullWrap);

    // .drawer-btns is hidden until the app initialises; there is no app here.
    pullWrap.style.display = 'flex';

    const btn = document.getElementById('settings-drawer-btn');
    const closeBtn = document.getElementById('close-settings-drawer');

    function closeDrawer() {
      drawer.classList.add('closed');
      btn.classList.remove('active');
    }

    btn.addEventListener('click', () => {
      const opening = drawer.classList.contains('closed');
      drawer.classList.toggle('closed', !opening);
      btn.classList.toggle('active', opening);
    });
    closeBtn.addEventListener('click', closeDrawer);

    _wireThemeRadios(drawer);

    // Close on backdrop click
    document.addEventListener('click', e => {
      if (!drawer.classList.contains('closed') &&
          !drawer.contains(e.target) &&
          e.target !== btn && !btn.contains(e.target)) {
        closeDrawer();
      }
    });

    _applyTheme(theme);
  });
})();
