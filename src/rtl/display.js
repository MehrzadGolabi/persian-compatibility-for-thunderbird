/*
 * Message display: give right-to-left text the direction it needs.
 *
 * Messages that don't say which way they read (no dir attribute) are shown left-to-right
 * by Thunderbird, so Persian paragraphs are left-aligned, bullets and quote bars are on
 * the wrong side and mixed Persian/English lines scramble their word order. Giving blocks
 * a dir attribute fixes all of that natively, since Thunderbird's quote/list styles use
 * logical properties.
 *
 * Rules: only messages that contain RTL text are touched; anything the author gave a
 * direction (a dir attribute or an inline direction style, on the element or an ancestor)
 * is left exactly as written. Plain-text bodies are handled per line by display.css.
 */
(function () {
  const body = document.body;
  if (!body || !MahoorBidi.hasRtl(body.textContent)) {
    return;
  }

  // Plain-text bodies are handled per line by display.css.
  const PLAIN_TEXT = "pre.moz-quote-pre, pre.moz-signature, .moz-text-plain pre, .moz-text-flowed";
  const ours = new WeakSet();

  const authorControlled = el => {
    for (let n = el; n; n = n.parentElement) {
      if (n.hasAttribute("dir") && !ours.has(n)) {
        return true;
      }
      if (n.style && n.style.direction) {
        return true;
      }
    }
    return false;
  };

  const candidates = [...body.querySelectorAll(MahoorBidi.ALL)];
  if (candidates.length > 5000) {
    return; // huge generated mail: not worth the layout cost or the risk
  }

  const win = document.defaultView;
  const hooks = {
    manages: el =>
      !el.matches(PLAIN_TEXT) &&
      !el.closest(PLAIN_TEXT) &&
      !authorControlled(el) &&
      // wrappers just inherit; blocks that hold text (and lists/quotes) decide for themselves
      (el.matches(MahoorBidi.CONTAINERS) || !el.querySelector(MahoorBidi.LEAVES)),
    claimed: el => ours.add(el),
    released: el => ours.delete(el),
  };
  // Document order: a list or quote is settled before the items inside it.
  for (const el of candidates) {
    MahoorBidi.settle(el, win, hooks);
  }
})();
