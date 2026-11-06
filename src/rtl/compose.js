/*
 * Compose editor: right-to-left text gets dir="rtl" as it is written.
 *
 * Like Thunderbird's own text-direction button, but automatic and per paragraph, so a
 * Persian paragraph is right-aligned and ordered correctly while writing AND in the sent
 * message (the dir attribute is part of the HTML that is sent; CSS from an extension is not).
 *
 * Rules:
 *  - a block takes the direction of its first strong character (like dir="auto");
 *  - a direction chosen by the user (Thunderbird's direction buttons), or present in a
 *    reply/forward/draft, is never overridden: we only manage dir attributes that we set
 *    ourselves, or ones sitting on a still-empty block (a copy made by pressing Enter);
 *  - plain-text compose has nowhere to store a direction, so it only gets compose.css.
 */
(function () {
  const body = document.body;
  if (!body || /pre/.test(body.style.whiteSpace)) {
    return; // plain-text editor
  }

  const { ALL } = MahoorBidi;
  // element -> the dir value we wrote. If the attribute no longer matches, someone else
  // (the user's direction button) changed it and from then on it is theirs.
  const owned = new WeakMap();
  const win = document.defaultView;

  const isEmpty = el => !el.textContent.trim();

  /** Direction someone else decided for this element or one of its ancestors? */
  const isOurs = n => owned.has(n) && owned.get(n) === n.getAttribute("dir");
  const decidedElsewhere = el => {
    for (let n = el; n && n !== body.parentElement; n = n.parentElement) {
      if (owned.has(n) && !isOurs(n)) {
        owned.delete(n); // changed by someone else: no longer ours
      }
      if (n.hasAttribute("dir") && !isOurs(n) && !isEmpty(n)) {
        return true;
      }
      if (n.style && n.style.direction) {
        return true;
      }
    }
    return false;
  };

  const hooks = {
    manages: el => el !== body && !decidedElsewhere(el),
    claimed: el => owned.set(el, el.getAttribute("dir")),
    released: el => owned.delete(el),
  };
  const update = el => {
    // Pressing Enter copies the paragraph's dir onto the new, still empty one. Treat such a
    // copy as ours, so it can follow the first thing typed into it.
    if (el.hasAttribute("dir") && !owned.has(el) && isEmpty(el)) {
      owned.set(el, el.getAttribute("dir"));
    }
    MahoorBidi.settle(el, win, hooks);
  };

  const blockOf = node => {
    let n = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (n && n !== body && !n.matches(ALL)) {
      n = n.parentElement;
    }
    return n && n !== body ? n : null;
  };

  const pending = new Set();
  let timer = null;
  const schedule = () => {
    if (timer === null) {
      timer = win.setTimeout(flush, 30);
    }
  };

  function flush() {
    timer = null;
    const todo = new Set();
    for (const node of pending) {
      if (!node.isConnected) {
        continue;
      }
      // The block itself, blocks inside what was inserted, and the enclosing blocks
      // (typing into a list item can change the direction of its list or quote).
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches(ALL)) {
          todo.add(node);
        }
        node.querySelectorAll(ALL).forEach(e => todo.add(e));
      }
      for (let b = blockOf(node); b; b = blockOf(b.parentElement || body)) {
        todo.add(b);
        if (!b.parentElement) {
          break;
        }
      }
    }
    pending.clear();
    // Document order, so a container is settled before the blocks inside it.
    [...todo]
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .forEach(update);
  }

  new win.MutationObserver(records => {
    for (const r of records) {
      pending.add(r.type === "characterData" ? r.target : r.target);
      r.addedNodes.forEach(n => pending.add(n));
    }
    schedule();
  }).observe(body, { childList: true, subtree: true, characterData: true });

  // Content that is already there (drafts, and anything inserted before we started).
  pending.add(body);
  body.querySelectorAll(ALL).forEach(e => pending.add(e));
  schedule();
})();
