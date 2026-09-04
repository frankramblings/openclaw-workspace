// Extracted from landing.html so the page is clean under the enforced CSP
// (script-src 'self'): no inline <script>, no nonce placeholder.
// Typewriter for the origin terminal: type line 1, pause 2s, line 2, pause
// 2s, line 3, hold 4s, then reset and loop. Blinking "|" cursor throughout.
(function () {
  var pre = document.getElementById('term-pre');
  if (!pre) return;
  var lines = [
    { p: '<span class="cs">&gt;</span> ', t: 'idk what to make can you write it for me?' },
    { p: '  ', t: 'actually make an ai chat, but make it good' },
    { p: '  ', t: 'and also make it better' }
  ];
  var CURSOR = '<span class="term-cursor">|</span>';
  var TYPE_MS = 40;
  var done = [], li = 0, timer = null;

  function render(partial) {
    pre.innerHTML = done.join('\n') + (done.length ? '\n' : '') + partial + CURSOR;
  }
  function typeLine() {
    var ln = lines[li], i = 0;
    (function step() {
      if (i <= ln.t.length) {
        render(ln.p + ln.t.slice(0, i));
        i++; timer = setTimeout(step, TYPE_MS);
      } else {
        done.push(ln.p + ln.t);
        li++;
        if (li >= lines.length) timer = setTimeout(reset, 4000);  // hold last line 4s
        else timer = setTimeout(typeLine, 2000);                  // pause 2s before next
      }
    })();
  }
  function reset() { clearTimeout(timer); done = []; li = 0; typeLine(); }

  // Start typing only when the terminal scrolls into view (and replay each
  // time you return to it).
  if ('IntersectionObserver' in window) {
    var io2 = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) reset(); });
    }, { threshold: 0.45 });
    io2.observe(pre);
  } else {
    reset();
  }
})();

// Previews: hovering a panel expands it (CSS) and plays its video; the
// video only becomes visible once it actually starts playing, so missing
// files just leave the labeled placeholder.
(function () {
  document.querySelectorAll('.preview-panel').forEach(function (p) {
    var v = p.querySelector('video');
    if (!v) return;
    v.addEventListener('playing', function () { p.classList.add('has-video'); });
    v.addEventListener('pause', function () { /* keep last frame */ });
    var play = function () { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); };
    p.addEventListener('mouseenter', play);
    p.addEventListener('focus', play);
    p.addEventListener('mouseleave', function () { v.pause(); });
    p.addEventListener('blur', function () { v.pause(); });
    p.addEventListener('click', function () { if (v.paused) play(); else v.pause(); });
  });
})();

// Domino reveal: fade/slide each section in as it scrolls into view.
(function () {
  var els = document.querySelectorAll('.hero, section');
  if (!('IntersectionObserver' in window)) {
    els.forEach(function (e) { e.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  els.forEach(function (e) { io.observe(e); });
})();

// Fake terminal window buttons — minimize, maximize, close (and reopen).
(function () {
  var term = document.querySelector('.term');
  var reopen = document.querySelector('.term-reopen');
  if (!term) return;
  term.querySelectorAll('.winbtns [data-term]').forEach(function (b) {
    b.addEventListener('click', function () {
      var act = b.getAttribute('data-term');
      if (act === 'min') term.classList.toggle('term-min');
      else if (act === 'close') {
        term.classList.add('term-closed');
        if (reopen) reopen.classList.add('show');
      }
    });
  });
  if (reopen) reopen.addEventListener('click', function () {
    term.classList.remove('term-closed', 'term-min');
    reopen.classList.remove('show');
  });
})();

// Mobile testimonial carousel: tap or swipe to advance; the kaiju shakes ~1s.
(function () {
  var carousel = document.getElementById('tcarousel');
  var nav = document.getElementById('tnav');
  if (!carousel || !nav) return;
  var cards = [].slice.call(carousel.querySelectorAll('.tcard'));
  if (!cards.length) return;
  var idx = 0;

  var dots = cards.map(function (_, k) {
    var d = document.createElement('span');
    d.className = 'tdot';
    d.addEventListener('click', function (e) { e.stopPropagation(); show(k); });
    nav.appendChild(d);
    return d;
  });
  var hint = document.createElement('div');
  hint.className = 'thint';
  hint.textContent = 'tap or swipe for the next satisfied customer →';
  nav.appendChild(hint);

  function show(i) {
    idx = (i + cards.length) % cards.length;
    cards.forEach(function (c, k) { c.classList.toggle('active', k === idx); c.classList.remove('shake'); });
    dots.forEach(function (d, k) { d.classList.toggle('on', k === idx); });
    var cur = cards[idx];
    if (cur.getAttribute('data-shake') === '1') {
      void cur.offsetWidth;
      cur.classList.add('shake');
      setTimeout(function () { cur.classList.remove('shake'); }, 1000);
    }
  }

  carousel.addEventListener('click', function () { show(idx + 1); });

  var _prev = document.querySelector('.tarrow.prev');
  var _next = document.querySelector('.tarrow.next');
  if (_prev) _prev.addEventListener('click', function (e) { e.stopPropagation(); show(idx - 1); });
  if (_next) _next.addEventListener('click', function (e) { e.stopPropagation(); show(idx + 1); });

  var sx = null;
  carousel.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
  carousel.addEventListener('touchend', function (e) {
    if (sx === null) return;
    var dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 30) { show(idx + (dx < 0 ? 1 : -1)); }
    sx = null;
  });

  show(0);
})();
