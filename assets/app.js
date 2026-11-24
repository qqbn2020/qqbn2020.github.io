/* tv-date client — search, filters, favourites (localStorage only) */
(function () {
  'use strict';

  var STORE_KEY = 'tvdate:follow';
  var follows = loadFollows();
  var activeFilter = 'all';
  var query = '';

  function loadFollows() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveFollows() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(follows)); } catch (e) {}
  }

  function isFollowed(key) { return follows.indexOf(key) !== -1; }

  function refreshStars() {
    document.querySelectorAll('[data-follow]').forEach(function (btn) {
      var on = isFollowed(btn.getAttribute('data-follow'));
      if (btn.classList.contains('star')) {
        btn.textContent = on ? '★' : '☆';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      } else {
        btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
      }
      btn.classList.toggle('on', on);
    });
  }

  function applyFilters() {
    var items = document.querySelectorAll('[data-item]');
    var shown = 0;
    items.forEach(function (el) {
      var type = el.getAttribute('data-type');
      var key = el.getAttribute('data-key') || '';
      var title = (el.getAttribute('data-title') || '').toLowerCase();
      var ok = true;
      if (query && title.indexOf(query) === -1) ok = false;
      if (activeFilter === 'tv' && type !== 'tv') ok = false;
      if (activeFilter === 'movie' && type !== 'movie') ok = false;
      if (activeFilter === 'follow' && !isFollowed(key)) ok = false;
      el.hidden = !ok;
      if (ok) shown++;
    });
    var empty = document.querySelector('[data-empty]');
    if (empty) empty.hidden = shown > 0 || (!query && activeFilter === 'all');
    // hide empty day blocks
    document.querySelectorAll('.dayblock').forEach(function (block) {
      var any = block.querySelector('[data-item]:not([hidden])');
      block.hidden = !any;
    });
  }

  function bindFollow() {
    document.querySelectorAll('[data-follow]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var key = btn.getAttribute('data-follow');
        var idx = follows.indexOf(key);
        if (idx === -1) follows.push(key); else follows.splice(idx, 1);
        saveFollows();
        refreshStars();
        if (activeFilter === 'follow') applyFilters();
      });
    });
  }

  function bindChips() {
    document.querySelectorAll('[data-filter-value]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        activeFilter = chip.getAttribute('data-filter-value');
        document.querySelectorAll('[data-filter-value]').forEach(function (c) {
          c.classList.toggle('is-on', c === chip);
        });
        applyFilters();
      });
    });
  }

  function bindSearch() {
    var input = document.querySelector('[data-search]');
    if (!input) return;
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var v = input.value.trim().toLowerCase();
      timer = setTimeout(function () { query = v; applyFilters(); }, 120);
    });
  }

  function init() {
    refreshStars();
    bindFollow();
    bindChips();
    bindSearch();
    if (activeFilter !== 'all') applyFilters();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
