// HERMES: pure stack-layout math for the terminal manager. No DOM. Dual-export:
// window.WTLayout (browser <script>) + module.exports (node --test).
// .cjs so it stays CommonJS even though frontend-overrides/js/package.json
// declares "type": "module".
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WTLayout = api;
})(function () {
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

  return { computeStack, orderVisible };
});
