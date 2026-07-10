// The live turn's identity, shared between live/chat.js (writer) and
// task-rows.js (reader) without an import cycle. Phase-1 turn_start frames
// carry the durable ledger turn_id; registry records that know their
// originating turn can anchor to the exact bubble instead of the
// newest-assistant heuristic.
let _ref = null;
export function setLiveTurn(ref) { _ref = ref || null; }
export function liveTurn() { return _ref; }
