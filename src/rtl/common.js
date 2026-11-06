/*
 * Shared helpers for the RTL content scripts (message display and compose editor).
 * Loaded before display.js / compose.js, in the same script scope.
 */
var MahoorBidi = (() => {
  // Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Arabic extended,
  // and the Arabic/Hebrew presentation forms (covers Persian).
  const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  const LETTER = /\p{L}/u;

  const LEAVES = "p, li, div, h1, h2, h3, h4, h5, h6, pre, dd, dt, td, th, summary, figcaption, caption";
  const CONTAINERS = "ul, ol, dl, blockquote";
  const ALL = `${LEAVES}, ${CONTAINERS}`;

  return {
    LEAVES,
    CONTAINERS,
    ALL,

    /**
     * The text that decides a block's direction: for lists and quotes everything inside;
     * for other blocks their own text and inline children, not nested blocks'.
     */
    ownText(el) {
      if (el.matches(CONTAINERS)) {
        return el.textContent;
      }
      let text = "";
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.data;
        } else if (child.nodeType === Node.ELEMENT_NODE && !child.matches(ALL)) {
          text += child.textContent;
        }
      }
      return text;
    },

    /**
     * Make `el` read the way its own text reads. Only writes a dir attribute when the
     * direction it would inherit is not already the right one (so English mail is never
     * touched). `manages(el)` says whether we may touch the element's dir attribute;
     * `claimed(el)` is told about every attribute we set, `released(el)` about every one
     * we remove again.
     *
     * (Explicit rtl/ltr instead of dir="auto": auto ignores descendants that carry a dir
     * attribute, so a list whose items have one would see no text and stay ltr.)
     */
    settle(el, win, { manages, claimed, released }) {
      if (!manages(el)) {
        return;
      }
      const want = this.firstStrong(this.ownText(el));
      if (!want) {
        return; // empty or neutral so far: keep whatever it has
      }
      const inherited = el.parentElement ? win.getComputedStyle(el.parentElement).direction : "ltr";
      const has = el.getAttribute("dir");
      if (want !== inherited) {
        if (has !== want) {
          el.setAttribute("dir", want);
          claimed(el);
        }
      } else if (has) {
        el.removeAttribute("dir"); // not needed any more (only ever reached for our own)
        released(el);
      }
    },

    /** Does the text contain any right-to-left letter? */
    hasRtl(text) {
      return RTL_CHAR.test(text);
    },

    /**
     * The direction of the first strong character ("rtl" or "ltr"), like the
     * Unicode bidi algorithm / HTML dir=auto do, or null for neutral-only text.
     */
    firstStrong(text) {
      for (const ch of text) {
        if (RTL_CHAR.test(ch)) {
          return "rtl";
        }
        if (LETTER.test(ch)) {
          return "ltr";
        }
      }
      return null;
    },
  };
})();
