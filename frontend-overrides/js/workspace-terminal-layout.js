// HERMES: pure stack-layout math for the terminal manager. No DOM.
// Loaded in the browser as a classic <script> (sets window.WTLayout) and served
// as application/javascript (a .cjs would not get a JS MIME type and the browser
// would refuse it). The node test loads THIS file via `vm` with a fake `window`
// (see __tests__/workspace-terminal-layout.test.js), so no module.exports needed.
(function () {
  // orderedRightToLeft: [{id, width}] with index 0 = rightmost. baseOffset px
  // reserves space on the right (e.g. an open Files explorer). Returns each id's
  // CSS `right` px and the total terminal width (for the chat margin; excludes base).
  function computeStack(orderedRightToLeft, baseOffset) {
    const positions = {};
    let cum = baseOffset || 0;
    for (const p of orderedRightToLeft) {
      positions[p.id] = cum;
      cum += p.width;
    }
    return { positions, totalWidth: cum - (baseOffset || 0) };
  }

  // pinnedRightToLeft: id[] with index 0 = rightmost (oldest pin), end = leftmost
  // (newest pin). activeUnpinnedId (or null) sits leftmost of everything. Returns
  // the visible ids ordered right -> left.
  function orderVisible(pinnedRightToLeft, activeUnpinnedId) {
    const order = (pinnedRightToLeft || []).slice();
    if (activeUnpinnedId) order.push(activeUnpinnedId);
    return order;
  }

  if (typeof window !== 'undefined') window.WTLayout = { computeStack, orderVisible };
})();
