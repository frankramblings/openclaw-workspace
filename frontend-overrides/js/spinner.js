// static/js/spinner.js
// WORKSPACE OVERRIDE (full file — re-merge when upstream spinner.js changes).
// All text-style AI-thinking spinners ('spinner'/'wave'/'sinewave' + default)
// now render the animated "fortress crystals" SVG instead of ASCII/canvas.
// The SVG markup lives in FORTRESS_BODY below (fl-* classes, namespaced from
// frontend-overrides/fortress-loading-48.svg); its animation CSS is in
// workspace.css (fl-grow / fl-shard keyframes). Canvas whirlpool helpers are
// untouched — they serve list/image loading, not AI thinking.

/**
 * ASCII Spinner Module for AI thinking/processing status
 */

// Namespaced fortress-crystals SVG (no internal <style> — the source asset's
// <style> has a :root rule + generic .crystal/.shard classes that would leak
// into the page when inlined; workspace.css carries the fl-* animations).
const FORTRESS_BODY = `
  <ellipse cx="24" cy="38.5" rx="15" ry="3.5" fill="currentColor" opacity=".14"/>
  <g stroke-linejoin="round">
    <path class="fl-crystal fl-c1" d="M23.6 38 L20.8 16 L24 6 L27.2 16 L24.4 38 Z" fill="currentColor" fill-opacity=".82" stroke="currentColor" stroke-opacity="1" stroke-width=".9"/>
    <path class="fl-crystal fl-c2" d="M17.5 38 L15.2 23 L18.4 12 L21.1 26 L20 38 Z" fill="currentColor" fill-opacity=".62" stroke="currentColor" stroke-opacity=".9" stroke-width=".8"/>
    <path class="fl-crystal fl-c3" d="M29 38 L27.4 25 L31.5 10 L34.4 24 L32.4 38 Z" fill="currentColor" fill-opacity=".62" stroke="currentColor" stroke-opacity=".9" stroke-width=".8"/>
    <path class="fl-crystal fl-c4" d="M12.7 39 L11.5 29 L14.6 20 L17 31 L16 39 Z" fill="currentColor" fill-opacity=".44" stroke="currentColor" stroke-opacity=".74" stroke-width=".75"/>
    <path class="fl-crystal fl-c5" d="M35.2 39 L33.7 30 L37.6 19 L40.1 31 L38.7 39 Z" fill="currentColor" fill-opacity=".44" stroke="currentColor" stroke-opacity=".74" stroke-width=".75"/>
    <path class="fl-crystal fl-c6" d="M20.3 39 L19.3 28 L22.1 19 L24.2 30 L23.2 39 Z" fill="currentColor" fill-opacity=".7" stroke="currentColor" stroke-opacity=".82" stroke-width=".65"/>
    <path class="fl-crystal fl-c7" d="M26.5 39 L25.8 29 L28.3 18 L30.7 30 L29.5 39 Z" fill="currentColor" fill-opacity=".7" stroke="currentColor" stroke-opacity=".82" stroke-width=".65"/>
  </g>
  <g fill="currentColor">
    <path class="fl-shard fl-s1" style="--dx:-8px;--dy:-12px" d="M15 18 l2 -3 l1 4 z"/>
    <path class="fl-shard fl-s2" style="--dx:9px;--dy:-15px" d="M32 16 l3 -2 l-1 4 z"/>
    <path class="fl-shard fl-s3" style="--dx:2px;--dy:-18px" d="M24 11 l2 -2 l1 3 z"/>
  </g>`;

function fortressSvgElement(sizePx) {
  const holder = document.createElement('span');
  holder.innerHTML = `<svg class="fl-svg" viewBox="0 0 48 48" width="${sizePx}" height="${sizePx}" role="img" aria-label="Loading">${FORTRESS_BODY}</svg>`;
  return holder.firstElementChild;
}

class Spinner {
  constructor(message = "AI is processing", style = "right", animation = "spinner") {
    // Different animation frames
    this.animations = {
      spinner: ['|', '/', '-', '\\'],
      wave: ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▅', '▆▅▄', '▅▄▃', '▄▃▂', '▃▂▁']
    };

    this.animation = animation;
    this.frames = this.animations[animation] || this.animations.spinner;
    this.message = message;
    this.style = style; // "left", "right", or "clean"
    this.isRunning = false;
    this.currentFrame = 0;
    this.intervalId = null;
    this.rafId = null;
    this.element = null;
  }

  /**
   * Create and return the spinner HTML element
   */
  createElement() {
    if (this.animation === 'whirlpool') {
      return this._createWhirlpoolElement();
    }
    // Everything else ('spinner'/'wave'/'sinewave'/default) — i.e. every
    // AI-thinking spinner — renders the fortress crystals.
    return this._createFortressElement();
  }

  _createFortressElement() {
    const wrapper = document.createElement('span');
    wrapper.className = 'ai-spinner ai-spinner-fortress';
    wrapper.style.cssText = 'display: inline-flex; align-items: center; gap: 6px;';

    const svg = fortressSvgElement(this._flSize || 18);

    const msgSpan = document.createElement('span');
    msgSpan.textContent = this.message;
    this._msgSpan = msgSpan;

    if (this.style === 'left') {
      wrapper.appendChild(svg);
      wrapper.appendChild(msgSpan);
    } else if (this.style === 'right') {
      wrapper.appendChild(msgSpan);
      wrapper.appendChild(svg);
    } else { // clean
      wrapper.appendChild(svg);
    }

    this.element = wrapper;
    return wrapper;
  }

  _createSineWaveElement() {
    const wrapper = document.createElement('span');
    wrapper.className = 'ai-spinner ai-spinner-sinewave';
    wrapper.style.cssText = 'font-family: monospace; white-space: pre; display: inline-flex; align-items: center; gap: 6px;';

    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 18;
    canvas.style.cssText = 'display: inline-block; vertical-align: middle;';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = this.message;
    this._msgSpan = msgSpan;

    if (this.style === 'left') {
      wrapper.appendChild(canvas);
      wrapper.appendChild(msgSpan);
    } else if (this.style === 'right') {
      wrapper.appendChild(msgSpan);
      wrapper.appendChild(canvas);
    } else {
      wrapper.appendChild(msgSpan);
    }

    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._waveT = 0;
    this._wavePrev = performance.now();
    this.element = wrapper;
    return wrapper;
  }

  _drawSineWave() {
    const ctx = this._ctx;
    const W = this._canvas.width;
    const H = this._canvas.height;
    const midY = H / 2;
    const AMP = 7;
    const CYCLES = 2.5;
    const PAD = 3;
    const trackW = W - 2 * PAD;
    const BASE_SPEED = 0.44;
    const MIN_SPEED = 0.4;
    const MAX_SPEED = 2.5;

    const now = performance.now();
    const dt = (now - this._wavePrev) / 1000;
    this._wavePrev = now;

    const dotPhase = 0.5 * CYCLES * 2 * Math.PI + this._waveT;
    const norm = (1 + Math.sin(dotPhase)) / 2;
    const speedMul = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.pow(norm, 1.3);
    this._waveT += dt * BASE_SPEED * speedMul * CYCLES * 2 * Math.PI;

    ctx.clearRect(0, 0, W, H);

    // wave line
    ctx.beginPath();
    for (let i = 0; i <= 80; i++) {
      const frac = i / 80;
      const x = PAD + frac * trackW;
      const phase = frac * CYCLES * 2 * Math.PI + this._waveT;
      const y = midY + Math.sin(phase) * AMP;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(156, 222, 242, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // dot
    const cx = W / 2;
    const cPhase = 0.5 * CYCLES * 2 * Math.PI + this._waveT;
    const cy = midY + Math.sin(cPhase) * AMP;
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(156, 222, 242, 0.9)';
    ctx.fill();

    if (this.isRunning) {
      this.rafId = requestAnimationFrame(() => this._drawSineWave());
    }
  }

  _createWhirlpoolElement() {
    const wrapper = document.createElement('span');
    wrapper.className = 'ai-spinner ai-spinner-whirlpool';
    wrapper.style.cssText = 'font-family: monospace; white-space: pre; display: inline-flex; align-items: center; gap: 6px;';

    const size = this._wpSize || 18;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.cssText = 'display: inline-block; vertical-align: middle;';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = this.message;
    this._msgSpan = msgSpan;

    if (this.style === 'left') {
      wrapper.appendChild(canvas);
      wrapper.appendChild(msgSpan);
    } else if (this.style === 'right') {
      wrapper.appendChild(msgSpan);
      wrapper.appendChild(canvas);
    } else {
      wrapper.appendChild(canvas);
    }

    this._wpCanvas = canvas;
    this._wpCtx = canvas.getContext('2d');
    this._wpFrame = 60;
    this.element = wrapper;
    return wrapper;
  }

  _drawWhirlpool() {
    const ctx = this._wpCtx;
    const W = this._wpCanvas.width;
    const H = this._wpCanvas.height;
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) / 2 - 1;
    const lw = W > 30 ? 3 : W > 20 ? 2 : 1.5;
    const TOTAL_TURNS = 4;
    const TAIL_LEN = 0.45;
    const SPIN_SPEED = 0.08;
    const LAYERS = 12;
    const STEPS = 50;
    const t = this._wpFrame;

    // Colors from CSS vars — read ONCE and cache. Calling getComputedStyle every
    // frame forces a full style recalc per frame, which janks/freezes the canvas
    // animation badly when it's painting over a heavy photo. (Theme changes are
    // rare; the spinner is short-lived, so a stale cache is fine.)
    if (!this._wpColors) {
      const s = getComputedStyle(document.documentElement);
      this._wpColors = {
        fg: s.getPropertyValue('--red').trim() || s.getPropertyValue('--fg').trim() || '#9cdef2',
        track: s.getPropertyValue('--border').trim() || '#355a66',
      };
    }
    const fg = this._wpColors.fg;
    const track = this._wpColors.track;

    function spiralPoint(frac, rot) {
      const r = maxR * (1 - frac);
      const angle = frac * TOTAL_TURNS * Math.PI * 2 + rot;
      return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
    }

    ctx.clearRect(0, 0, W, H);

    // track ring
    ctx.beginPath();
    ctx.arc(cx, cy, maxR - lw / 2, 0, Math.PI * 2);
    ctx.strokeStyle = track;
    ctx.lineWidth = lw;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;

    const headPos = (t * 0.008) % 1;

    // overlapping sub-paths for smooth fade
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let layer = LAYERS - 1; layer >= 0; layer--) {
      const endFrac = (layer + 1) / LAYERS;
      const stepsForLayer = Math.ceil(STEPS * endFrac);
      const alpha = Math.pow(1 - endFrac, 2) * 0.7;

      ctx.beginPath();
      let started = false;
      let prevPos = -1;
      for (let i = 0; i <= stepsForLayer; i++) {
        const frac = i / STEPS;
        let pos = headPos - frac * TAIL_LEN;
        if (pos < 0) pos += 1;
        if (started && prevPos < 0.3 && pos > 0.7) {
          ctx.stroke();
          ctx.beginPath();
          started = false;
        }
        const pt = spiralPoint(pos, t * SPIN_SPEED);
        if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
        else ctx.lineTo(pt.x, pt.y);
        prevPos = pos;
      }
      ctx.strokeStyle = fg;
      ctx.lineWidth = lw * 0.8;
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }

    // bright dot at head
    const head = spiralPoint(headPos, t * SPIN_SPEED);
    ctx.beginPath();
    ctx.arc(head.x, head.y, Math.max(1, lw * 0.45), 0, Math.PI * 2);
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;

    this._wpFrame++;
    if (!this.isRunning) return;
    // Leak-safe self-terminate: stop once our element WAS in the DOM and then
    // got removed (e.g. a loading row replaced by results). But keep spinning
    // before it's first appended — start() runs synchronously, before the
    // caller inserts the element, so it isn't connected on frame 1.
    const connected = !!(this.element && this.element.isConnected);
    if (connected) this._wpWasConnected = true;
    if (connected || !this._wpWasConnected) {
      this.rafId = requestAnimationFrame(() => this._drawWhirlpool());
    } else {
      this.isRunning = false;
    }
  }

  /**
   * Update the spinner display
   */
  updateDisplay() {
    if (!this.element) return;

    const frame = this.frames[this.currentFrame % this.frames.length];

    let display = '';
    if (this.style === "left") {
      display = `${frame} ${this.message}`;
    } else if (this.style === "right") {
      display = `${this.message} ${frame}`;
    } else { // clean
      display = this.message;
    }

    this.element.innerHTML = display;
  }

  /**
   * Start the spinner animation
   */
  start(speed = 150) {  // eslint-disable-line no-unused-vars
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.animation === 'whirlpool') {
      this._wpFrame = 60;
      this._drawWhirlpool();
      return;
    }
    // Fortress (everything else): CSS keyframes animate it — no JS timer.
    // (The old ASCII interval would clobber the SVG via updateDisplay()'s
    // innerHTML writes, so deliberately do nothing here.)
  }

  /**
   * Stop the spinner
   */
  stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Update the message while spinner is running
   */
  updateMessage(newMessage) {
    this.message = newMessage;
    if (this._msgSpan) {  // fortress/canvas spinners carry a dedicated label span
      this._msgSpan.textContent = newMessage;
    } else {
      this.updateDisplay();
    }
  }

  /**
   * Update the spinner label text
   */
  updateLabel(newMessage) {
    this.message = newMessage;
    if (this._msgSpan) {
      this._msgSpan.textContent = newMessage;
    } else {
      this.updateDisplay();
    }
  }

  /**
   * Destroy the spinner and clean up
   */
  destroy() {
    this.stop();
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
  }
}

/**
 * Create a new spinner instance
 */
export function create(message, style = "right", animation = "wave") {
  return new Spinner(message, style, animation);
}

/**
 * Create a standalone whirlpool circle spinner (replaces CSS .spinner)
 * Returns { element, start(), stop(), destroy() }
 */
export function createWhirlpool(size = 24) {
  const sp = new Spinner('', 'clean', 'whirlpool');
  sp._wpSize = size;
  const el = sp.createElement();
  // wrap in a div matching .spinner layout
  const wrap = document.createElement('div');
  wrap.className = 'spinner-whirlpool';
  wrap.style.cssText = `width:${size}px;height:${size}px;margin:8px auto;`;
  wrap.appendChild(el);
  sp.start();
  return { element: wrap, stop: () => sp.stop(), destroy: () => sp.destroy() };
}

/**
 * A consistent inline loading row for list/library empty-states: a label plus
 * the whirlpool spinner. Returns a detached element; the spinner self-stops
 * once the element leaves the DOM (see _drawWhirlpool), so callers can just
 * replace it with results — no manual cleanup needed.
 */
export function createLoadingRow(text = 'Loading…', size = 16) {
  const sp = new Spinner('', 'clean', 'whirlpool');
  sp._wpSize = size;
  const canvas = sp.createElement();
  const row = document.createElement('div');
  row.className = 'lib-loading-row';
  const label = document.createElement('span');
  label.textContent = text;
  row.appendChild(label);
  row.appendChild(canvas);
  sp.start();
  return row;
}

/**
 * Standalone fortress loader at a given pixel size — same return shape as
 * createWhirlpool ({element, stop, destroy}) so chat.js call sites that show
 * AI activity (live-think header, reconnect placeholder) can swap 1:1.
 */
export function createFortress(size = 18) {
  const sp = new Spinner('', 'clean', 'fortress');
  sp._flSize = size;
  const el = sp.createElement();
  const wrap = document.createElement('span');
  wrap.className = 'spinner-fortress';
  wrap.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;`;
  wrap.appendChild(el);
  sp.start();
  return { element: wrap, stop: () => sp.stop(), destroy: () => sp.destroy() };
}

export { Spinner };

const spinnerModule = { create, createWhirlpool, createLoadingRow, createFortress, Spinner };
export default spinnerModule;
