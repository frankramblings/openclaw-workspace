/* Push-to-talk voice mode for the live chat.
 *
 * Self-contained, DOM-driven (no imports from chat.js). Flow:
 *   hold mic  -> MediaRecorder captures audio
 *   release   -> POST /api/transcribe (local kamino Whisper) -> text
 *              -> drop text into the composer + fire Send
 *   on reply  -> chat.js dispatches `gary:reply-complete`; we click that
 *               message's existing Read-aloud button to auto-speak it.
 *
 * A floating button is used (not injected into the composer) so it survives the
 * redesign render loop rebuilding the composer DOM.
 */
(function () {
  'use strict';
  if (window.__garyPTT) return;
  window.__garyPTT = true;

  var recorder = null, stream = null, chunks = [], recording = false;
  var armSpeak = false, btn = null;

  var MIC = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

  function injectStyles() {
    if (document.getElementById('ptt-styles')) return;
    var s = document.createElement('style');
    s.id = 'ptt-styles';
    s.textContent = [
      '#ptt-btn{position:fixed;right:22px;bottom:96px;z-index:9999;width:52px;height:52px;',
      'border-radius:50%;border:1px solid var(--border,#333);background:var(--panel,#1b1b1f);',
      'color:var(--fg,#eee);display:flex;align-items:center;justify-content:center;cursor:pointer;',
      'box-shadow:0 4px 14px rgba(0,0,0,.35);touch-action:none;user-select:none;transition:transform .08s,background .15s;}',
      '#ptt-btn:hover{transform:scale(1.05);}',
      '#ptt-btn:active{transform:scale(.94);}',
      '#ptt-btn.ptt-live{background:#c0392b;color:#fff;border-color:#c0392b;animation:pttPulse 1s ease-in-out infinite;}',
      '#ptt-btn.ptt-busy{opacity:.7;pointer-events:none;}',
      '#ptt-btn.ptt-busy svg{animation:pttSpin 1s linear infinite;}',
      '@keyframes pttPulse{0%,100%{box-shadow:0 0 0 0 rgba(192,57,43,.5);}50%{box-shadow:0 0 0 10px rgba(192,57,43,0);}}',
      '@keyframes pttSpin{to{transform:rotate(360deg);}}',
      '#ptt-hint{position:fixed;right:20px;bottom:154px;z-index:9999;font:12px/1.3 var(--sans,system-ui);',
      'color:var(--fg,#ddd);background:var(--panel,#1b1b1f);border:1px solid var(--border,#333);',
      'padding:4px 8px;border-radius:8px;max-width:220px;opacity:0;transition:opacity .2s;pointer-events:none;}',
      '#ptt-hint.show{opacity:.95;}'
    ].join('');
    document.head.appendChild(s);
  }

  function hint(msg, ms) {
    var h = document.getElementById('ptt-hint');
    if (!h) { h = document.createElement('div'); h.id = 'ptt-hint'; document.body.appendChild(h); }
    h.textContent = msg;
    h.classList.add('show');
    clearTimeout(h._t);
    if (ms) h._t = setTimeout(function () { h.classList.remove('show'); }, ms);
  }

  function ensureButton() {
    injectStyles();
    if (btn && document.body.contains(btn)) return;
    btn = document.createElement('button');
    btn.id = 'ptt-btn';
    btn.type = 'button';
    btn.title = 'Hold to talk';
    btn.setAttribute('aria-label', 'Hold to talk');
    btn.innerHTML = MIC;
    document.body.appendChild(btn);
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); start(); });
    btn.addEventListener('pointerup', function (e) { e.preventDefault(); stop(false); });
    btn.addEventListener('pointerleave', function () { if (recording) stop(false); });
    btn.addEventListener('pointercancel', function () { if (recording) stop(true); });
  }

  function pickMime() {
    var t = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < t.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t[i])) return { mimeType: t[i] };
    }
    return {};
  }

  async function start() {
    if (recording) return;
    // Granular capability check so the reason is actionable on mobile.
    if (window.isSecureContext === false) {
      hint('Voice needs the https address (open naboo…ts.net:8443, not :8800)', 4000); return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint('This app blocks the mic — open the site in Safari/Chrome, not the home-screen app', 4500); return;
    }
    if (!window.MediaRecorder) { hint('This browser has no audio recorder', 3000); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { hint('Mic blocked — allow microphone access', 3000); return; }
    chunks = [];
    try { recorder = new MediaRecorder(stream, pickMime()); }
    catch (e) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = onStop;
    recorder.start();
    recording = true;
    btn.classList.add('ptt-live');
    hint('Listening… release to send', 0);
  }

  function stop(cancel) {
    if (!recording) return;
    recording = false;
    btn.classList.remove('ptt-live');
    if (cancel) chunks = [];
    try { recorder.stop(); } catch (e) {}
  }

  function stopStream() { if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; } }

  async function onStop() {
    stopStream();
    var type = (recorder && recorder.mimeType) || 'audio/webm';
    var blob = new Blob(chunks, { type: type });
    chunks = [];
    var h = document.getElementById('ptt-hint'); if (h) h.classList.remove('show');
    if (blob.size < 1400) { hint('Too short', 1500); return; }
    btn.classList.add('ptt-busy');
    var text = '';
    try {
      var fd = new FormData();
      var ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      fd.append('audio', blob, 'clip.' + ext);
      var res = await fetch('/api/transcribe', { method: 'POST', credentials: 'same-origin', body: fd });
      if (!res.ok) {
        var err = res.status; try { err = (await res.json()).error || err; } catch (e) {}
        btn.classList.remove('ptt-busy'); hint("Couldn't hear that: " + err, 3000); return;
      }
      text = ((await res.json()).text || '').trim();
    } catch (e) {
      btn.classList.remove('ptt-busy'); hint('Transcribe failed', 2500); return;
    }
    btn.classList.remove('ptt-busy');
    if (!text) { hint('Heard nothing', 1800); return; }
    sendText(text);
  }

  function sendText(text) {
    var ta = document.querySelector('textarea[data-model="draft"]');
    var send = document.querySelector('[data-act="send"]');
    if (!ta || !send) { hint('Composer not ready', 2000); return; }
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    armSpeak = true;               // auto-speak the reply this triggers
    hint('“' + (text.length > 40 ? text.slice(0, 40) + '…' : text) + '”', 2500);
    // let the framework flush the input model, then send
    setTimeout(function () { send.click(); }, 30);
  }

  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

  window.addEventListener('gary:reply-complete', function (ev) {
    if (!armSpeak) return;
    armSpeak = false;
    var id = ev && ev.detail && ev.detail.id;
    if (!id) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var b = document.querySelector('[data-act="speakMessage"][data-arg="' + cssEsc(id) + '"]');
      if (b) { clearInterval(iv); b.click(); }
      else if (tries > 25) { clearInterval(iv); }   // ~2.5s grace for render
    }, 100);
  });

  function boot() {
    ensureButton();
    // re-assert the button if a full re-render ever drops it
    setInterval(function () { if (!btn || !document.body.contains(btn)) ensureButton(); }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
