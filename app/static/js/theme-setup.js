/**
 * theme-setup.js — shared theme persistence for all Listen Here! pages.
 *
 * On every page:
 *   - Restores the saved theme immediately (before paint) to avoid FOUC.
 *   - Swaps the logo image (.lh-logo-img elements) to match the theme.
 *
 * On pages without a full settings drawer (#settings-drawer absent):
 *   - Injects a settings drawer + drawer-pull button on the right edge,
 *     matching the listen.html pattern exactly.
 *
 * The listen.html page already has its own settings drawer; this script
 * skips drawer-injection there but still handles early theme restoration.
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

  function _applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    try { localStorage.setItem(KEY, theme); } catch (_) {}
    // Swap logo images
    document.querySelectorAll('.lh-logo-img').forEach(img => {
      img.src = DARK_BG.includes(theme)
        ? '/static/bat/ListenHereBat.svg'
        : '/static/bat/ListenHereBatAsleep.svg';
    });
    // Sync radio buttons in injected drawer
    document.querySelectorAll('#lh-settings-drawer input[name="lh-theme"]').forEach(r => {
      r.checked = r.value === theme;
    });
  }

  // Apply immediately (synchronous) to avoid flash of unstyled content
  _applyTheme(_getTheme());

  // Expose for pages that want to call it programmatically
  window._lhApplyTheme = _applyTheme;

  document.addEventListener('DOMContentLoaded', () => {
    // listen.html already has a full settings drawer — skip injection
    if (document.getElementById('settings-drawer')) return;

    const theme = _getTheme();

    const themeRows = [
      ['Light', THEMES.slice(0, 4)],
      ['Dark',  THEMES.slice(4)],
    ].map(([label, opts]) => {
      const radios = opts.map(([v, l]) =>
        `<label class="settings-theme-option">` +
          `<input type="radio" name="lh-theme" value="${v}"${v === theme ? ' checked' : ''}/>` +
          `<span class="settings-theme-swatch theme-swatch-${v}" title="${l}"></span>` +
          `<span>${l}</span>` +
        `</label>`
      ).join('');
      return `<div class="theme-row"><span class="theme-row-label">${label}</span>${radios}</div>`;
    }).join('');

    // --- Drawer ---
    const drawer = document.createElement('div');
    drawer.id = 'lh-settings-drawer';
    drawer.className = 'lh-settings-drawer closed';
    drawer.innerHTML =
      `<div class="drawer-header">` +
        `<h2>Settings</h2>` +
        `<button id="lh-close-settings" aria-label="Close">&#x2715;</button>` +
      `</div>` +
      `<div class="settings-drawer-content">` +
        `<section class="settings-section">` +
          `<h3 class="settings-section-title">Theme</h3>` +
          `<div class="settings-theme-options">${themeRows}</div>` +
        `</section>` +
        `<section class="settings-section">` +
          `<h3 class="settings-section-title">Language</h3>` +
          `<p class="settings-hint">English (translations coming soon)</p>` +
        `</section>` +
      `</div>`;

    // --- Drawer-pull button ---
    const pullWrap = document.createElement('div');
    pullWrap.className = 'drawer-btns lh-drawer-btns';
    pullWrap.innerHTML =
      `<button id="lh-settings-btn" title="Settings" aria-label="Settings">` +
        `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
          `<circle cx="12" cy="12" r="3"/>` +
          `<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>` +
        `</svg>` +
      `</button>`;

    document.body.appendChild(drawer);
    document.body.appendChild(pullWrap);

    // Make it visible (mirrors how listen.js shows .drawer-btns)
    pullWrap.style.display = 'flex';

    const btn = document.getElementById('lh-settings-btn');
    const closeBtn = document.getElementById('lh-close-settings');

    function openDrawer() {
      drawer.classList.remove('closed');
      // Inline right avoids needing :has() for the push animation
      pullWrap.style.right = '380px';
    }
    function closeDrawer() {
      drawer.classList.add('closed');
      pullWrap.style.right = '0';
    }

    btn.addEventListener('click', () => {
      drawer.classList.contains('closed') ? openDrawer() : closeDrawer();
    });
    closeBtn.addEventListener('click', closeDrawer);

    // Theme radio changes
    drawer.addEventListener('change', e => {
      if (e.target.name === 'lh-theme') _applyTheme(e.target.value);
    });

    // Close on backdrop click
    document.addEventListener('click', e => {
      if (!drawer.classList.contains('closed') &&
          !drawer.contains(e.target) &&
          e.target !== btn && !btn.contains(e.target)) {
        closeDrawer();
      }
    });
  });
})();
