// Gary launcher widget for Scriptable. Paste into a new Scriptable script named
// "Gary", then add a Scriptable Home/Lock-screen widget pointing at it.
// Per-element tap URLs (medium/large) deep-link into the PWA's ?action= modes.
// Requires Tailscale connected on the device.

const BASE = "https://bespin.bicolor-triceratops.ts.net:8443";
const url = (a) => `${BASE}/?action=${a}`;

const BG = new Color("#1e1f22");
const FG = new Color("#ffffff");
const MUTED = new Color("#9aa0a6");

function button(row, glyph, label, action) {
  const cell = row.addStack();
  cell.layoutVertically();
  cell.centerAlignContent();
  cell.url = url(action);               // per-element tap target (medium/large)
  const g = cell.addText(glyph);
  g.font = Font.systemFont(22);
  g.centerAlignText();
  cell.addSpacer(2);
  const t = cell.addText(label);
  t.font = Font.mediumSystemFont(11);
  t.textColor = MUTED;
  t.centerAlignText();
}

function buildMedium() {
  const w = new ListWidget();
  w.backgroundColor = BG;
  const header = w.addText("Gary");
  header.font = Font.boldSystemFont(15);
  header.textColor = FG;
  w.addSpacer(8);
  const row = w.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  button(row, "\u{1F4AC}", "Ask", "new");      // speech balloon
  row.addSpacer();
  button(row, "\u{1F4F7}", "Photo", "photo");  // camera
  row.addSpacer();
  button(row, "\u{1F4E5}", "Inbox", "inbox");  // inbox tray
  row.addSpacer();
  return w;
}

function buildSmall() {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.url = url("new");                   // whole-widget tap
  w.addSpacer();
  const g = w.addText("\u{1F4AC}");
  g.font = Font.systemFont(26);
  g.centerAlignText();
  w.addSpacer(4);
  const t = w.addText("Ask Gary");
  t.font = Font.mediumSystemFont(12);
  t.textColor = FG;
  t.centerAlignText();
  w.addSpacer();
  return w;
}

function buildAccessory() {           // Lock Screen circular/inline: one tap target
  const w = new ListWidget();
  w.url = url("new");
  const g = w.addText("\u{1F4AC}");
  g.font = Font.systemFont(20);
  g.centerAlignText();
  return w;
}

let widget;
const fam = config.widgetFamily;      // small|medium|large|accessoryCircular|...
if (fam === "medium" || fam === "large") widget = buildMedium();
else if (fam && fam.startsWith("accessory")) widget = buildAccessory();
else widget = buildSmall();

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  widget.presentMedium();             // preview when run inside Scriptable
}
Script.complete();
