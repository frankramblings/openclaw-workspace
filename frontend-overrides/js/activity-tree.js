/*
 * activity-tree.js — collapsible activity timeline for a chat turn.
 *
 * Plain (non-module) script: exposes `window.ActivityTree`.
 * Mounted on a container; handleEvent(rawData) parses one SSE `data:` payload
 * (the inner content delivered by both the POST stream and the GET tail) and
 * renders agent activity as collapsed-by-default nested <details> timeline
 * groups.
 *
 * Event types (from backend/bridge.py) and their tree group:
 *   {delta:"…"}                       -> "Streaming answer"  (grouped chunks)
 *   {delta:"…", thinking:true}        -> "Thinking"          (grouped chunks)
 *   {type:"tool_start", tool, tool_id, command}
 *                                     -> "Calling tool: <tool>" (active group)
 *   {type:"tool_output", tool, tool_id, output, exit_code}
 *                                     -> closes its tool_id group (or its own)
 *   {type:"agent_step"}               -> step boundary: collapse the open group
 *   {type:"stall_retry"}              -> status substep "Retrying (stalled)"
 *   {type:"stall", silent_for}        -> status substep "Waiting…"
 *   {type:"run_alive"}                -> status substep "Model working"
 *   {image_url:"…", image_prompt:"…"} -> media substep "Image"
 *   "[DONE]"  (raw)                   -> finalize: collapse everything
 *
 * Three levels of <details>:
 *   level 1: step group (e.g. "Calling tool: search_code")
 *   level 2: event detail (input / output / chunk summary)
 *   level 3: raw JSON of the event (debugging)
 */
(function () {
  'use strict';

  function enabled() {
    return typeof window.streamResumeEnabled === 'function' &&
           window.streamResumeEnabled();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ActivityTree(container) {
    this.el = container || null;
    this._steps = [];           // ordered group records
    this._toolGroups = {};      // tool_id -> group record
    this._active = null;        // currently-open streaming/thinking group
    this._t0 = Date.now();      // turn start, for relative timing
    if (this.el) {
      this.el.classList.add('activity-tree');
      this.el.setAttribute('role', 'tree');
    }
  }

  ActivityTree.prototype.reset = function () {
    this._steps = [];
    this._toolGroups = {};
    this._active = null;
    this._t0 = Date.now();
    if (this.el) this.el.innerHTML = '';
  };

  /** Seconds since turn start, 1-decimal. */
  ActivityTree.prototype._elapsed = function (group) {
    var base = group && group.t0 ? group.t0 : this._t0;
    return ((Date.now() - base) / 1000).toFixed(1) + 's';
  };

  /** Build a level-1 <details> group element. */
  ActivityTree.prototype._mkGroup = function (label, kind) {
    var details = document.createElement('details');
    details.className = 'agent-step agent-step--' + (kind || 'misc');
    details.open = true; // open while active; collapse on completion
    var summary = document.createElement('summary');
    summary.className = 'agent-step__summary';
    summary.innerHTML =
      '<span class="step-label">' + esc(label) + '</span>' +
      '<span class="step-time"></span>';
    var body = document.createElement('div');
    body.className = 'agent-step__body';
    details.appendChild(summary);
    details.appendChild(body);
    var rec = {
      el: details, body: body,
      timeEl: summary.querySelector('.step-time'),
      labelEl: summary.querySelector('.step-label'),
      kind: kind, t0: Date.now(), done: false
    };
    if (this.el) this.el.appendChild(details);
    this._steps.push(rec);
    return rec;
  };

  /** Append a level-2 detail + level-3 raw JSON under a group. */
  ActivityTree.prototype._addDetail = function (group, label, content, raw) {
    if (!group) return;
    var d2 = document.createElement('details');
    d2.className = 'agent-step__detail';
    var s2 = document.createElement('summary');
    s2.className = 'agent-step__detail-summary';
    s2.textContent = label;
    d2.appendChild(s2);

    if (content != null && content !== '') {
      var c = document.createElement('div');
      c.className = 'agent-step__detail-body';
      c.textContent = String(content);
      d2.appendChild(c);
    }
    if (raw !== undefined) {
      var d3 = document.createElement('details');
      d3.className = 'agent-step__raw';
      var s3 = document.createElement('summary');
      s3.className = 'agent-step__raw-summary';
      s3.textContent = 'raw event';
      var pre = document.createElement('pre');
      pre.className = 'agent-step__raw-pre';
      try { pre.textContent = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2); }
      catch (_e) { pre.textContent = String(raw); }
      d3.appendChild(s3);
      d3.appendChild(pre);
      d2.appendChild(d3);
    }
    group.body.appendChild(d2);
  };

  /** Collapse + stamp a finished group. */
  ActivityTree.prototype._finishGroup = function (group) {
    if (!group || group.done) return;
    group.done = true;
    group.el.open = false;
    group.el.classList.add('agent-step--done');
    if (group.timeEl) group.timeEl.textContent = this._elapsed(group);
    if (this._active === group) this._active = null;
  };

  /** Collapse the currently-open streaming/thinking group (step boundary). */
  ActivityTree.prototype._closeActive = function () {
    if (this._active) this._finishGroup(this._active);
  };

  /**
   * Parse one SSE `data:` payload and render it. `rawData` is the content after
   * "data: " — either "[DONE]", a JSON object string, or a plain text chunk.
   * Mirrors chat.js's parse approach (try JSON, fall back to text).
   */
  ActivityTree.prototype.handleEvent = function (rawData) {
    if (!enabled() || !this.el || rawData == null) return;
    var data = String(rawData);

    if (data === '[DONE]') {
      this._finalize();
      return;
    }

    var json = null;
    if (data.charAt(0) === '{') {
      try { json = JSON.parse(data); } catch (_e) { json = null; }
    }

    // Plain text chunk (no JSON wrapper) — treat as streamed answer.
    if (json === null) {
      this._appendStream(data, false, data);
      return;
    }

    var type = json.type;

    // Streamed text / reasoning deltas.
    if (typeof json.delta === 'string') {
      this._appendStream(json.delta, !!json.thinking, json);
      return;
    }

    if (json.image_url) {
      this._closeActive();
      var g = this._mkGroup('Image', 'media');
      this._addDetail(g, json.image_prompt || 'generated image', json.image_url, json);
      this._finishGroup(g);
      return;
    }

    switch (type) {
      case 'tool_start':
        this._toolStart(json);
        return;
      case 'tool_output':
        this._toolOutput(json);
        return;
      case 'agent_step':
        // Step boundary — collapse the open streaming group; next delta opens fresh.
        this._closeActive();
        return;
      case 'stall_retry':
        this._statusStep('Retrying (stalled)', 'warn', json);
        return;
      case 'stall':
        this._statusStep('Waiting (' + (json.silent_for || 0) + 's silent)', 'wait', json);
        return;
      case 'run_alive':
        this._statusStep('Model working', 'info', json);
        return;
      case 'req':
        // Internal request bookkeeping — record quietly as a status step.
        this._statusStep('Request', 'info', json);
        return;
      default:
        // Unknown shape — show it so nothing is silently dropped.
        this._closeActive();
        var u = this._mkGroup(type ? ('Event: ' + type) : 'Event', 'misc');
        this._addDetail(u, type || 'event', null, json);
        this._finishGroup(u);
        return;
    }
  };

  /** Group consecutive token/text chunks into one streaming group. */
  ActivityTree.prototype._appendStream = function (text, thinking, raw) {
    var wantKind = thinking ? 'thinking' : 'stream';
    if (!this._active || this._active.kind !== wantKind || this._active.done) {
      this._closeActive();
      this._active = this._mkGroup(
        thinking ? 'Thinking' : 'Streaming answer', wantKind);
      // Level-2 detail holds the accumulating text.
      var d2 = document.createElement('details');
      d2.className = 'agent-step__detail';
      d2.open = true;
      var s2 = document.createElement('summary');
      s2.className = 'agent-step__detail-summary';
      s2.textContent = thinking ? 'reasoning' : 'answer text';
      var body = document.createElement('div');
      body.className = 'agent-step__detail-body agent-step__stream-text';
      d2.appendChild(s2);
      d2.appendChild(body);
      this._active.body.appendChild(d2);
      this._active._streamBody = body;
      this._active._rawCount = 0;
    }
    this._active._streamBody.textContent += text;
    this._active._rawCount++;
    // Keep a single most-recent raw sample (avoid unbounded raw nodes).
    if (this._active._rawCount <= 1) {
      this._addDetail(this._active, 'first chunk (raw)', null, raw);
    }
    if (this._active.timeEl) this._active.timeEl.textContent = this._elapsed(this._active);
  };

  ActivityTree.prototype._toolStart = function (json) {
    this._closeActive();
    var name = json.tool || 'tool';
    var g = this._mkGroup('Calling tool: ' + name, 'tool');
    g.toolId = json.tool_id;
    if (json.command) this._addDetail(g, 'input', json.command, json);
    else this._addDetail(g, 'started', null, json);
    if (json.tool_id != null) this._toolGroups[json.tool_id] = g;
    // Tools may interleave; keep the tool group open until its end frame.
    // It is NOT the streaming "_active" group (those are text deltas).
    this._active = null;
  };

  ActivityTree.prototype._toolOutput = function (json) {
    var g = (json.tool_id != null) ? this._toolGroups[json.tool_id] : null;
    if (!g) {
      // No matching start (or a bare tool_output like bridge errors) — make one.
      this._closeActive();
      g = this._mkGroup('Tool: ' + (json.tool || 'tool'), 'tool');
    }
    var ok = (json.exit_code === 0 || json.exit_code === undefined);
    g.el.classList.add(ok ? 'agent-step--ok' : 'agent-step--err');
    this._addDetail(g, ok ? 'output' : 'output (error)', json.output, json);
    this._finishGroup(g);
    if (json.tool_id != null) delete this._toolGroups[json.tool_id];
  };

  ActivityTree.prototype._statusStep = function (label, kind, json) {
    // Status steps are momentary — render as a self-contained collapsed group.
    var g = this._mkGroup(label, 'status status--' + kind);
    this._addDetail(g, label, null, json);
    this._finishGroup(g);
  };

  /** Stream end — collapse any still-open groups. */
  ActivityTree.prototype._finalize = function () {
    this._closeActive();
    for (var i = 0; i < this._steps.length; i++) {
      if (!this._steps[i].done) this._finishGroup(this._steps[i]);
    }
    this._toolGroups = {};
  };

  window.ActivityTree = window.ActivityTree || ActivityTree;
})();
