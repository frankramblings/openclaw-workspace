/*
 * stream-manager.js — resumable streaming chat tail.
 *
 * Plain (non-module) script: attaches a `StreamManager` singleton to `window`
 * so the ES-module chat.js / sessions.js can reach it without an import cycle.
 *
 * EVERY code path here is gated behind streamResumeEnabled()
 * (localStorage.openclaw_stream_resume === '1'). With the flag off, all public
 * methods are no-ops and the existing POST-based chat is untouched.
 *
 * SHARED CONTRACT (backend provides exactly these):
 *   GET /api/chat/events/resume?session=<id>&last_event_id=<id|empty>
 *       -> JSON { events:[{id, data:"data: {...}\n\n"}], last_event_id }
 *   GET /api/chat/stream?session=<id>&last_event_id=<id|empty>
 *       -> SSE stream (EventSource): replays backlog from cursor, then live.
 *          Each record carries an `id:` line -> e.lastEventId is the cursor.
 *          The `data:` payload is the same inner content the POST stream sends.
 */
(function () {
  'use strict';

  var CURSOR_KEY = 'openclaw_stream_cursors';
  var RECONNECT_MS = 1500;

  /** Feature flag — the single gate for the whole feature.
   *  Default ON: active unless explicitly disabled with
   *  localStorage.openclaw_stream_resume === '0'. */
  function streamResumeEnabled() {
    try {
      return localStorage.getItem('openclaw_stream_resume') !== '0';
    } catch (_e) {
      return false;
    }
  }
  // Expose globally so chat.js / sessions.js / activity-tree.js can gate too.
  window.streamResumeEnabled = streamResumeEnabled;

  function loadCursors() {
    try {
      var raw = localStorage.getItem(CURSOR_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (_e) {
      return {};
    }
  }

  function StreamManager() {
    this.cursors = loadCursors(); // sessionKey -> lastEventId
    this._live = null;            // { es, key, onEvent, badge, timer, closed }
  }

  StreamManager.prototype._persistCursors = function () {
    try {
      localStorage.setItem(CURSOR_KEY, JSON.stringify(this.cursors));
    } catch (_e) { /* quota / private mode — cursor is best-effort */ }
  };

  StreamManager.prototype._cursorFor = function (key) {
    var c = this.cursors[key];
    return (c === undefined || c === null) ? '' : String(c);
  };

  StreamManager.prototype._setCursor = function (key, id) {
    if (id === undefined || id === null || id === '') return;
    this.cursors[key] = id;
    this._persistCursors();
  };

  function showBadge(badge, on) {
    if (!badge) return;
    if (on) badge.removeAttribute('hidden');
    else badge.setAttribute('hidden', '');
  }

  /**
   * Open a live EventSource for `sessionKey`. On each message, update the
   * cursor from e.lastEventId and call onEvent(e.data). Auto-reconnects on
   * error with a fixed ~1.5s backoff. Returns a handle with `.close()`.
   *
   * No-op (returns inert handle) when the flag is off.
   */
  StreamManager.prototype.connect = function (sessionKey, onEvent, badge) {
    if (!streamResumeEnabled() || !sessionKey) {
      return { close: function () {} };
    }
    var self = this;
    var state = { es: null, key: sessionKey, onEvent: onEvent, badge: badge,
                  timer: null, closed: false };

    function open() {
      if (state.closed) return;
      var cursor = self._cursorFor(sessionKey);
      var url = '/api/chat/stream?session=' + encodeURIComponent(sessionKey) +
                '&last_event_id=' + encodeURIComponent(cursor);
      var es;
      try {
        es = new EventSource(url);
      } catch (_e) {
        // Schedule a retry rather than dying — gateway may be cold-booting.
        state.timer = setTimeout(open, RECONNECT_MS);
        return;
      }
      state.es = es;

      es.onmessage = function (e) {
        if (state.closed) return;
        if (e.lastEventId) self._setCursor(sessionKey, e.lastEventId);
        // Backend replays then goes live; once we hear anything we are caught up.
        showBadge(state.badge, false);
        try {
          if (state.onEvent) state.onEvent(e.data);
        } catch (err) {
          if (window.console) console.warn('[stream-manager] onEvent error:', err);
        }
      };

      es.onerror = function () {
        if (state.closed) return;
        // EventSource auto-reconnects on its own, but on hard failures it can
        // get stuck in CLOSED — force a clean reopen with the latest cursor.
        if (es.readyState === EventSource.CLOSED) {
          try { es.close(); } catch (_e) {}
          if (state.timer) clearTimeout(state.timer);
          state.timer = setTimeout(open, RECONNECT_MS);
        }
      };
    }

    open();

    return {
      close: function () {
        state.closed = true;
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        if (state.es) { try { state.es.close(); } catch (_e) {} state.es = null; }
        showBadge(state.badge, false);
      }
    };
  };

  /**
   * One-shot backlog drain via the JSON /resume endpoint. Used by the
   * ActivityTree hydration path and the "catching up" state. Replays each
   * stored event through onEvent and advances the cursor. Resolves when drained.
   *
   * No-op (resolves immediately) when the flag is off.
   */
  StreamManager.prototype.resume = function (sessionKey, onEvent) {
    if (!streamResumeEnabled() || !sessionKey) return Promise.resolve();
    var self = this;
    var cursor = this._cursorFor(sessionKey);
    var url = '/api/chat/events/resume?session=' + encodeURIComponent(sessionKey) +
              '&last_event_id=' + encodeURIComponent(cursor);
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        if (!payload) return;
        var events = payload.events || [];
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          if (!ev) continue;
          if (ev.id) self._setCursor(sessionKey, ev.id);
          if (onEvent && ev.data !== undefined) {
            try { onEvent(ev.data); }
            catch (err) {
              if (window.console) console.warn('[stream-manager] resume onEvent error:', err);
            }
          }
        }
        if (payload.last_event_id) self._setCursor(sessionKey, payload.last_event_id);
      })
      .catch(function (err) {
        if (window.console) console.warn('[stream-manager] resume fetch error:', err);
      });
  };

  /**
   * Thread-switch entry point. Closes any prior live connection, shows the
   * "Catching up…" badge, drains backlog, then keeps a single live pipe open
   * for the center view. Only ONE active live connection at a time.
   *
   * The GET stream already replays backlog at its start, so the live connect()
   * alone is sufficient; we additionally do a one-shot resume() first so the
   * ActivityTree can hydrate immediately even before the SSE socket opens.
   *
   * No-op when the flag is off.
   */
  StreamManager.prototype.activate = function (newKey, onEvent, badge) {
    if (!streamResumeEnabled() || !newKey) {
      return { close: function () {} };
    }
    var self = this;
    // Close any prior live connection — single center connection invariant.
    if (this._live) { try { this._live.close(); } catch (_e) {} this._live = null; }

    showBadge(badge, true);

    // Drain backlog one-shot (hydrate tree / "catching up"), THEN open live.
    // The live GET also replays from the (now-advanced) cursor; backend dedups
    // by id and our cursor moved past drained events, so no double-render.
    this.resume(newKey, onEvent).then(function () {
      // If the user switched away again while resuming, abort.
      if (self._live && self._live.key !== newKey) return;
      self._live = self.connect(newKey, onEvent, badge);
      self._live.key = newKey;
    });

    // Return a handle immediately so callers can close even mid-resume.
    var handle = {
      key: newKey,
      close: function () {
        if (self._live) { try { self._live.close(); } catch (_e) {} self._live = null; }
        showBadge(badge, false);
      }
    };
    this._live = handle;
    return handle;
  };

  window.StreamManager = window.StreamManager || new StreamManager();
})();
