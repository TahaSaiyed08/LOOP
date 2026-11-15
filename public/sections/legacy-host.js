// Section host: shows teammate-owned pages (Feed: index.html + feed.js, Portfolio: portfolio.*) inside the
// THESIS shell WITHOUT editing them. Each page runs in its own same-origin iframe (its globals, DOM ids and CSS
// stay isolated); this adapter only hides the legacy header/footer, sizes the frame to its content (no nested
// scrolling), routes internal links back to THESIS, and opens article links in a new tab.
//
// Teammates: keep editing your own files as before. THESIS picks them up automatically. If a page is renamed or
// moved, change its `src` below. Nothing else here holds Feed/Portfolio business logic.
(function () {
  'use strict';
  const SECTIONS = {
    portfolio: {
      src: '/portfolio.html',
      eyebrow: 'Paper portfolio',
      title: 'Practice with virtual money',
      lead: 'A $10,000 paper account for learning. No real money is used, no real orders are placed and you own none of these positions.',
      pill: 'Virtual money · not real investments',
    },
    feed: {
      src: '/index.html',
      eyebrow: 'Feed',
      title: 'Market news, in perspective',
      lead: 'A daily list ranked by a fixed scoring model, with news and a plain-language case for and against each one. Candidates to research, not recommendations.',
      pill: 'Candidates, not recommendations',
      boot: unlockFeed,
    },
  };
  // Legacy links -> THESIS routes (anything else on this site opens normally inside the frame).
  const ROUTES = { '/': '#/feed', '/index.html': '#/feed', '/portfolio.html': '#/portfolio', '/thesis.html': '#/', '/app.html': '#/' };

  // The legacy feed asks for an email/passcode (stored only in localStorage) before showing the list. In THESIS
  // there is no login: skip that screen by calling the page's own showDash(). No account, email or thesis is
  // written; the feed's own risk-level picker (localStorage "tier", default "low") stays the filter.
  function unlockFeed(win, doc) {
    const dash = doc.getElementById('dashboard');
    if (!dash || !dash.classList.contains('hidden')) return;
    if (typeof win.showDash !== 'function') return; // a future version without it: leave the page as it is
    for (const id of ['auth', 'setup', 'profilePage']) { const el = doc.getElementById(id); if (el) el.classList.add('hidden'); }
    win.showDash();
  }

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) n.append(k);
    return n;
  }

  // Keep a fixed-position element (the Feed's detail panel/overlay) inside the part of the frame you can see.
  function pinToViewport(frame, node) {
    const r = frame.getBoundingClientRect();
    const top = Math.max(0, -r.top);
    const height = Math.max(200, Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top));
    node.style.top = `${top}px`; node.style.bottom = 'auto'; node.style.height = `${height}px`;
  }

  function mount(root, name) {
    const cfg = SECTIONS[name];
    if (!cfg) throw new Error(`Unknown section "${name}"`);
    const status = el('p', { class: 'sectionstatus quiet', role: 'status' }, 'Loading…');
    const frame = el('iframe', { class: 'sectionframe', title: cfg.title, src: `${cfg.src}${cfg.src.includes('?') ? '&' : '?'}embed=1`, loading: 'eager' });
    const host = el('section', { class: `sectionhost section-${name}` },
      el('header', { class: 'sectionhead' },
        el('div', {}, el('p', { class: 'eyebrow' }, cfg.eyebrow), el('h1', {}, cfg.title), el('p', { class: 'lead' }, cfg.lead)),
        el('span', { class: 'pill sectionpill' }, cfg.pill)),
      status, frame);
    root.replaceChildren(host);

    let ro = null; let mo = null; let panelOpen = false;
    const cleanup = () => { if (ro) ro.disconnect(); if (mo) mo.disconnect(); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); document.body.style.overflow = ''; };
    const onScroll = () => {
      const doc = frame.contentDocument; if (!doc || !panelOpen) return;
      for (const id of ['panel', 'overlay']) { const n = doc.getElementById(id); if (n) pinToViewport(frame, n); }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('hashchange', cleanup, { once: true });

    frame.addEventListener('load', () => {
      let doc; let win;
      try { doc = frame.contentDocument; win = frame.contentWindow; } catch { doc = null; }
      if (!doc || !doc.body) { status.textContent = 'This section could not be shown here.'; return; }
      const css = doc.createElement('link');
      css.rel = 'stylesheet'; css.href = '/sections/legacy-embed.css';
      doc.head.append(css);
      doc.documentElement.classList.add('in-thesis');

      // Links: internal pages -> THESIS routes, external articles -> new tab.
      doc.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a || e.defaultPrevented) return;
        const url = new URL(a.getAttribute('href'), win.location.href);
        if (url.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
        const to = ROUTES[url.pathname];
        if (to) { e.preventDefault(); location.hash = to; }
      }, true);

      try { if (cfg.boot) cfg.boot(win, doc); } catch (err) { console.warn(`[${name}] boot failed`, err); }

      // Size the frame to its content: one page scroll, never a scroll area inside a scroll area.
      const size = () => { frame.style.height = `${Math.ceil(doc.documentElement.scrollHeight)}px`; };
      ro = new ResizeObserver(size); ro.observe(doc.body); size();

      // The Feed's detail panel is position:fixed inside the frame: keep it in view and lock the outer scroll.
      const panel = doc.getElementById('panel');
      if (panel) {
        mo = new MutationObserver(() => {
          panelOpen = !panel.classList.contains('hidden');
          document.body.style.overflow = panelOpen ? 'hidden' : '';
          if (panelOpen) onScroll();
        });
        mo.observe(panel, { attributes: true, attributeFilter: ['class'] });
      }
      status.remove();
    });
    frame.addEventListener('error', () => { status.textContent = 'This section could not be loaded.'; });
    return host;
  }

  window.LegacySections = { SECTIONS, mount };
})();
