// Live-bubble doubling detector.
//
// Bug B (2026-09-11): Frank's reply rendered twice in the LIVE bubble while
// /api/history for the same thread was clean, and a reload cured it. The
// backend frame tracer ran for 29 minutes and caught nothing — every real chat
// frame was an ordinary startswith=true delta, and the relay's redelivery
// branch never fired — so the evidence we need is on the SPA side: the frames
// as the reducer saw them, plus the bubble text they produced.
//
// This module is the trigger. It is deliberately a pure function so it can be
// tested without a DOM: the `done` handler runs it over the finished bubble and
// only then ships the turn's frame log. Clean turns cost one substring scan.

// The shape a re-emitted turn always has: the text ENDS with content that
// already appeared earlier ("…answer" + "narration…answer"). So take the tail
// window and count it. Whitespace is normalized first because the snapshot
// joins blocks with "\n\n" while the stream delivers them as they came.
const DEFAULT_MIN_LEN = 80;

function normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length); // non-overlapping
  }
  return n;
}

/**
 * Detect a span repeated verbatim inside one assistant bubble.
 *
 * @param {string} text  the bubble's full text
 * @param {number} minLen  shortest span worth reporting; below this, repeats
 *   are ordinary prose (a repeated sentence fragment, a list label) rather
 *   than a re-emitted turn.
 * @returns {{span: string, count: number, length: number}|null}
 */
export function findDoubledSpan(text, minLen = DEFAULT_MIN_LEN) {
  const flat = normalize(text);
  if (flat.length < minLen * 2) return null; // can't hold two copies
  const span = flat.slice(-minLen);
  const count = countOccurrences(flat, span);
  if (count < 2) return null;
  return { span, count, length: span.length };
}
