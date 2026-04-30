// content.js — Injected into every page
// Handles: page translation, text selection translation
//
// ── Strategy: NON-DESTRUCTIVE span-wrapping ───────────────────────────────────
//   Each text node is replaced with:
//     <span class="tmt-wrap">
//       <span class="tmt-original" data-original="…">original</span>
//       <span class="tmt-translated">translated</span>
//     </span>
//   • display:contents on .tmt-wrap  → layout invisible to browser
//   • .tmt-original stays in DOM (CSS-hidden) so React/Vue can reconcile
//   • restorePage() replaces all wrappers back with plain text nodes
//   • Bilingual toggle shows both side-by-side via CSS; zero re-translation
//
// ── Revision history ──────────────────────────────────────────────────────────
//   v1  Non-destructive wrapping, viewport-first, restore button
//   v2  Shadow DOM, concurrency semaphore, double-scan, bilingual toggle,
//       style deduplication, closest() guard, translate="no" / contenteditable,
//       zero-rect guard
//   v3  (this file)
//       ✓ Deep shadow DOM  — walkRoot called immediately on each discovered
//                            shadowRoot so nested/dynamic roots are captured
//       ✓ Triple re-scan   — passes at 800 ms + 1 800 ms + requestIdleCallback
//       ✓ Debug diagnostics — debugTranslationStats() + console.debug skips
//       ✓ Stop button       — user can abort mid-translation
//       ✓ Error summary     — indicator shows failure count when non-zero
//       ✓ Bilingual inline  — side-by-side layout instead of superscript
//       ✓ translateBlock concurrency — sentences in a block run concurrently
//         (guarded by their own inner semaphore, SENTENCE_CONCURRENCY = 3)
//       ✓ MutationObserver debounce lowered to 400 ms
//       ✓ Relaxed acceptNode visibility check on re-scan passes
//   v4  shouldTranslate threshold lowered, translateTables(), relaxed visibility
//   v5  (this file)
//       ✓ isSPASite() — detects React/Vue/Vite/Angular/Next/Nuxt at runtime
//       ✓ Adaptive getAllTextNodes() — two strategies chosen per-pass:
//           SPA  pass-1 : isElementVisible (strict) + shouldTranslate in walker
//                         → avoids grabbing unmounted fiber/route nodes, prevents
//                            React reconciliation errors on DOM mutation
//           SPA  re-scan: isElementVisibleRelaxed, shouldTranslate deferred
//           Traditional  : isElementVisibleRelaxed on ALL passes, shouldTranslate
//                          deferred to translateNodes() on all passes
//                         → catches opacity-hidden elements in news/wiki layouts
//         This replaces the v4 "always relaxed" approach which broke SPAs, and
//         the original "always strict" approach which broke traditional sites.
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";
const translationCache = new Map();

// Max simultaneous node-level translation jobs (outer concurrency)
const CONCURRENCY_LIMIT = 5;
// Max simultaneous sentence calls inside a single block (inner concurrency)
const SENTENCE_CONCURRENCY = 3;

// ─────────────────────────────────────────────────────────────
// Global mutable state
// ─────────────────────────────────────────────────────────────

let mutationObserver     = null;
let mutationDebounceTimer = null;
let tmtStylesInjected    = false;
let bilingualMode        = false;
let indicatorEl          = null;
let restoreButtonEl      = null;
let bilingualButtonEl    = null;
let stopButtonEl         = null;

// Abort signal — set to true when user clicks Stop
let translationAborted   = false;

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wrap requestIdleCallback with a Promise (falls back to setTimeout). */
function idleDelay(timeout = 2000) {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(resolve, { timeout });
    } else {
      setTimeout(resolve, timeout);
    }
  });
}

function containsLetter(s) {
  return /[A-Za-z\u0900-\u097F]/.test(s);
}

function shouldTranslate(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 2) return false;                    // lowered threshold (was 3)
  // Pure punctuation / numbers / Devanagari digits
  if (/^[\d\s\.,\u0966-\u096F\u0964!?:;"'()\[\]{}\-\u2013\u2014\/\\,+%\u2030°]+$/.test(t))
    return false;
  if (/https?:\/\/|www\.|@/.test(t)) return false;
  if (/\d{1,4}[\-./]\d{1,2}[\-./]?\d{0,4}/.test(t)) return false;
  // Require at least one Devanagari or Latin letter — lenient for short Nepali text
  return containsLetter(t) || /[\u0900-\u097F]/.test(t);
}

/**
 * Relaxed visibility check: only rejects elements with display:none or
 * visibility:hidden. Skips opacity check so recently-inserted nodes
 * (opacity still animating in) are not excluded.
 */
function isElementVisibleRelaxed(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden";
}

/** Strict visibility — used for initial pass only. */
function isElementVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

/**
 * Detect whether this page is a modern JS-framework SPA (React, Vue, Vite, Angular, etc.)
 * vs a traditional server-rendered site.
 *
 * SPAs need strict visibility on pass 1 (avoid grabbing unmounted fiber nodes)
 * and benefit from shouldTranslate inside the walker (reduces noise that can
 * trigger React reconciliation when we later mutate the DOM).
 *
 * Traditional sites need relaxed visibility even on pass 1 because their CSS
 * frequently hides elements via opacity transitions or position tricks, not
 * display:none, and the extra noise from a wider net is harmless.
 */
function isSPASite() {
  // React: __reactFiber / __reactContainer on any element, or React DevTools hook
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return true;
  const bodyKeys = Object.keys(document.body).join(",");
  if (/__reactFiber|__reactContainer|__vue|ng-version/.test(bodyKeys)) return true;

  // Vite / bundler fingerprints in <script> src attributes
  const scripts = Array.from(document.querySelectorAll("script[src]"));
  if (scripts.some(s => /\/@vite\/|\/assets\/.+\.[a-f0-9]{8}\.js|chunk-/.test(s.src))) return true;

  // Vue: __vue_app__ on #app or root element
  const appEl = document.getElementById("app") || document.getElementById("root");
  if (appEl && (appEl.__vue_app__ || Object.keys(appEl).some(k => k.startsWith("__vue")))) return true;

  // Angular
  if (document.querySelector("[ng-version]") || document.querySelector("app-root")) return true;

  // Next.js / Nuxt data islands
  if (document.getElementById("__NEXT_DATA__") || document.getElementById("__NUXT__")) return true;

  return false;
}

// ── Concurrency semaphore ──────────────────────────────────
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return function acquire() {
    return new Promise((resolve) => {
      const tryRun = () => {
        if (active < limit) {
          active++;
          resolve(() => {
            active--;
            if (queue.length) queue.shift()();
          });
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });
  };
}

// ─────────────────────────────────────────────────────────────
// Sentence / script splitting
// ─────────────────────────────────────────────────────────────

function splitSentences(text) {
  const res = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    const isEnd = ch === "\u0964" || ch === "?" || ch === "!" || ch === ".";
    if (!isEnd) continue;

    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const nextChar = text[j] || "";
    const prevChar = text[i - 1] || "";

    const prevIsDigit = /[0-9\u0966-\u096F]/.test(prevChar);
    const nextIsDigit = /[0-9\u0966-\u096F]/.test(nextChar);
    const nearby      = text.slice(Math.max(0, i - 8), Math.min(text.length, j + 8));
    const looksLikeURL = /https?:\/\/|www\.|\/.+\./i.test(nearby);

    if (ch === "." && prevIsDigit && nextIsDigit) continue;
    if (looksLikeURL) continue;

    if (nextChar === "" || /[A-Z]/.test(nextChar) || /[\u0900-\u097F]/.test(nextChar)) {
      res.push(buf.trim());
      buf = "";
      i = j - 1;
    }
  }
  if (buf.trim()) res.push(buf.trim());
  return res.filter(Boolean);
}

function isLikelyMixedLanguage(s) {
  const letters = s.replace(/[^A-Za-z\u0900-\u097F]/g, "");
  if (letters.length < 4) return false;
  const latin = (letters.match(/[A-Za-z]/g) || []).length;
  const dev   = (letters.match(/[\u0900-\u097F]/g) || []).length;
  const total = latin + dev;
  return latin > 0 && dev > 0 && latin / total > 0.15 && dev / total > 0.15;
}

function getCharClass(ch) {
  if (/\s/.test(ch)) return "space";
  if (/[A-Za-z]/.test(ch)) return "latin";
  if (/[\u0900-\u097F]/.test(ch)) return "devanagari";
  if (/[0-9\u0966-\u096F]/.test(ch)) return "digit";
  if (/[\.,!?:;"'()\[\]{}\-\u2013\u2014\/\\|…\u0964]/.test(ch)) return "punct";
  return "other";
}

function splitByScriptRuns(text) {
  const runs = [];
  let current = "", currentClass = null;
  for (const ch of text) {
    const cc = getCharClass(ch);
    if (!current) { current = ch; currentClass = cc; continue; }
    if (cc === "space" || cc === "punct") { current += ch; continue; }
    if (currentClass === "space") { current += ch; currentClass = cc; continue; }
    if (currentClass === cc || currentClass === "digit" || cc === "digit"
        || currentClass === "other" || cc === "other") {
      current += ch;
      if (currentClass === "other" && cc !== "other") currentClass = cc;
      continue;
    }
    runs.push(current);
    current = ch; currentClass = cc;
  }
  if (current) runs.push(current);
  return runs;
}

// ─────────────────────────────────────────────────────────────
// Translation API
// ─────────────────────────────────────────────────────────────

async function translateSentence(text, srcLang, tgtLang, apiKey) {
  const cacheKey = `${srcLang}\u2192${tgtLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const promise = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: "translateSentence", text, srcLang, tgtLang, apiKey },
      (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (response?.success) resolve(response.output);
        else reject(new Error(response?.error || "Translation failed"));
      }
    );
  })
    .then((out) => { translationCache.set(cacheKey, Promise.resolve(out)); return out; })
    .catch((err) => { translationCache.delete(cacheKey); throw err; });

  translationCache.set(cacheKey, promise);
  return promise;
}

/**
 * Translate a multi-sentence block.
 * Sentences run concurrently (SENTENCE_CONCURRENCY) so a paragraph with
 * 5 sentences doesn't take 5× as long as a single sentence.
 */
async function translateBlock(text, srcLang, tgtLang, apiKey) {
  const sentences = splitSentences(text);
  if (!sentences.length) return text;

  const sentAcquire = makeSemaphore(SENTENCE_CONCURRENCY);
  const results = new Array(sentences.length);

  await Promise.allSettled(
    sentences.map((s, i) => async () => {
      const release = await sentAcquire();
      try {
        results[i] = await translateSentence(s, srcLang, tgtLang, apiKey);
      } catch (e) {
        results[i] = s; // fallback to original
      } finally {
        release();
      }
    }).map((fn) => fn())
  );

  return results.join(" ");
}

async function translateMeaningfulText(text, srcLang, tgtLang, apiKey) {
  const trimmed = text.trim();
  if (!shouldTranslate(trimmed)) return text;
  if (!isLikelyMixedLanguage(trimmed)) return translateBlock(text, srcLang, tgtLang, apiKey);

  const runs = splitByScriptRuns(text);
  const out = [];
  for (const run of runs) {
    if (!shouldTranslate(run)) { out.push(run); continue; }
    try { out.push(await translateBlock(run, srcLang, tgtLang, apiKey)); }
    catch (e) { out.push(run); }
  }
  return out.join("");
}

// ─────────────────────────────────────────────────────────────
// DOM traversal — deep Shadow DOM support
// ─────────────────────────────────────────────────────────────

/**
 * Collect all translatable text nodes, recursing immediately into every
 * discovered shadow root (open ones).
 *
 * Strategy adapts to site type:
 *  • SPA (React/Vue/Vite/Angular): strict visibility + shouldTranslate inside
 *    the walker on pass 1. This avoids collecting unmounted fiber nodes or
 *    hidden route containers that haven't rendered yet, which can trigger React
 *    reconciliation errors when we later mutate the DOM.
 *  • Traditional (server-rendered): relaxed visibility on all passes, and
 *    shouldTranslate deferred to translateNodes(). Traditional sites hide
 *    content via opacity/position rather than display:none, and the wider
 *    node collection is harmless since there's no framework reconciling.
 *
 * Re-scan passes always use relaxed visibility regardless of site type,
 * because by then the initial render is complete.
 */
function getAllTextNodes(root = document.body, relaxedVisibility = false) {
  const nodes = [];
  const spa = isSPASite();

  // Pass-1 on an SPA: use strict visibility to avoid grabbing unmounted nodes.
  // Pass-1 on traditional, or any re-scan: use relaxed.
  const visibilityCheck = (!relaxedVisibility && spa) ? isElementVisible : isElementVisibleRelaxed;

  // On SPA pass-1: filter inside the walker to reduce noise & reconciliation risk.
  // On traditional or re-scans: defer to translateNodes() so short Nepali text isn't killed early.
  const filterInWalker = (!relaxedVisibility && spa);

  function walkRoot(r) {
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const tag = parent.tagName.toLowerCase();
        if (["script", "style", "noscript", "iframe", "canvas"].includes(tag))
          return NodeFilter.FILTER_REJECT;

        // Honour translate="no" standard attribute
        if (parent.closest("[translate='no']"))
          return NodeFilter.FILTER_REJECT;

        // Don't mangle editable content
        if (parent.closest("[contenteditable]"))
          return NodeFilter.FILTER_REJECT;

        // Skip anything already wrapped by us
        if (parent.closest(".tmt-wrap"))
          return NodeFilter.FILTER_REJECT;

        if (!visibilityCheck(parent)) return NodeFilter.FILTER_REJECT;

        const text = node.textContent.trim();
        if (text.length < 2) return NodeFilter.FILTER_REJECT;

        // On SPA pass 1: apply shouldTranslate here to reduce noise.
        // On traditional sites / re-scans: skip — translateNodes() decides.
        if (filterInWalker && !shouldTranslate(text))
          return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Walk this root's text nodes
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    // Immediately recurse into every open shadow root discovered in this root.
    // querySelectorAll("*") on a ShadowRoot searches only within it, so this
    // correctly handles arbitrarily deep nesting.
    try {
      const allEls = r.querySelectorAll ? r.querySelectorAll("*") : [];
      for (const el of allEls) {
        if (el.shadowRoot) walkRoot(el.shadowRoot);
      }
    } catch (e) {
      // Closed shadow root or cross-origin — skip silently
    }
  }

  walkRoot(root);
  return nodes;
}

// ─────────────────────────────────────────────────────────────
// Debug diagnostics
// ─────────────────────────────────────────────────────────────

/**
 * Call this after a translation pass to surface potential misses.
 * Exposed globally so it can be called from DevTools console.
 */
function debugTranslationStats() {
  const totalTextLength = document.body.innerText.length;
  const wrappedNodes    = document.querySelectorAll(".tmt-wrap").length;
  const failedNodes     = document.querySelectorAll(".tmt-wrap[data-tmt-failed]").length;

  console.group("[TMT] Translation Stats");
  console.log(`Total text length  : ${totalTextLength} chars`);
  console.log(`Wrapped (translated): ${wrappedNodes} nodes`);
  console.log(`Failed nodes       : ${failedNodes}`);

  // Detect potentially missed large blocks
  let missedCount = 0;
  document.querySelectorAll("p, h1, h2, h3, h4, li, td, div[role='article'], div[role='main']")
    .forEach((el) => {
      if (el.closest(".tmt-wrap")) return;
      const text = el.innerText?.trim() || "";
      if (text.length > 50 && shouldTranslate(text)) {
        console.debug("[TMT] Potentially missed block:", text.substring(0, 120) + "…");
        missedCount++;
      }
    });

  console.log(`Potentially missed blocks: ${missedCount}`);
  console.groupEnd();

  return { totalTextLength, wrappedNodes, failedNodes, missedCount };
}

// Make it callable from DevTools
window.__tmtDebug = debugTranslationStats;

// ─────────────────────────────────────────────────────────────
// Non-destructive wrapping
// ─────────────────────────────────────────────────────────────

function wrapTextNodeWithTranslation(textNode, translatedText, failed = false) {
  if (!textNode.parentNode) return null;
  if (textNode.parentElement?.closest(".tmt-wrap")) return null;

  const originalText = textNode.textContent;

  const wrap  = document.createElement("span");
  wrap.className = "tmt-wrap";
  if (failed) wrap.setAttribute("data-tmt-failed", "1");

  const orig  = document.createElement("span");
  orig.className = "tmt-original";
  orig.setAttribute("data-original", originalText);
  orig.textContent = originalText;

  const trans = document.createElement("span");
  trans.className = "tmt-translated";
  trans.textContent = translatedText;

  wrap.appendChild(orig);
  wrap.appendChild(trans);

  try {
    const range = document.createRange();
    range.selectNode(textNode);
    range.deleteContents();
    range.insertNode(wrap);
  } catch (e) {
    if (textNode.parentNode) textNode.parentNode.replaceChild(wrap, textNode);
    else return null;
  }

  return wrap;
}

// ─────────────────────────────────────────────────────────────
// Restore original text
// ─────────────────────────────────────────────────────────────

function restorePage() {
  stopMutationObserver();
  translationAborted = true; // stop any in-progress pass

  document.querySelectorAll(".tmt-wrap").forEach((wrap) => {
    const origSpan = wrap.querySelector(".tmt-original");
    const text = origSpan ? origSpan.getAttribute("data-original") : wrap.textContent;
    if (wrap.parentNode) wrap.parentNode.replaceChild(document.createTextNode(text), wrap);
  });

  const attrRestoreMap = {
    "data-tmt-orig-placeholder": "placeholder",
    "data-tmt-orig-title":       "title",
    "data-tmt-orig-alt":         "alt",
    "data-tmt-orig-aria-label":  "aria-label",
  };
  for (const [dataAttr, origAttr] of Object.entries(attrRestoreMap)) {
    document.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
      el.setAttribute(origAttr, el.getAttribute(dataAttr));
      el.removeAttribute(dataAttr);
    });
  }

  document.getElementById("tmt-styles")?.remove();
  tmtStylesInjected = false;
  bilingualMode = false;
  document.body.classList.remove("tmt-bilingual");

  removeRestoreButton();
  removeBilingualButton();
  removeStopButton();
  updateIndicator("\u2713 Original restored", true);
  setTimeout(removeIndicator, 2500);
}

// ─────────────────────────────────────────────────────────────
// Bilingual toggle
// ─────────────────────────────────────────────────────────────

function setBilingualMode(on) {
  bilingualMode = on;
  document.body.classList.toggle("tmt-bilingual", on);
  updateBilingualButton();
}

function toggleBilingual() { setBilingualMode(!bilingualMode); }

// ─────────────────────────────────────────────────────────────
// Viewport partitioning
// ─────────────────────────────────────────────────────────────

function partitionByViewport(nodes) {
  const vw = window.innerWidth  || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const visible = [], offscreen = [];

  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent) { offscreen.push(node); continue; }
    const rect = parent.getBoundingClientRect();
    const hasLayout = rect.width > 0 || rect.height > 0;
    if (hasLayout && rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw) {
      visible.push(node);
    } else {
      offscreen.push(node);
    }
  }
  return { visible, offscreen };
}

// ─────────────────────────────────────────────────────────────
// Translate a list of nodes (concurrently, with semaphore)
// ─────────────────────────────────────────────────────────────

async function translateNodes(nodes, apiKey, srcLang, tgtLang, acquire, opts = {}) {
  const { progressCallback, relaxed = false } = opts;
  let done = 0, failed = 0;

  const tasks = nodes.map((node) => async () => {
    if (translationAborted) return;
    const release = await acquire();
    try {
      if (!node.isConnected) return;
      if (node.parentElement?.closest(".tmt-wrap")) return;

      const original = node.textContent.trim();
      if (!original || !shouldTranslate(original)) return;

      const translated = await translateMeaningfulText(original, srcLang, tgtLang, apiKey);
      if (translated && translated !== original) {
        wrapTextNodeWithTranslation(node, translated);
      }
    } catch (e) {
      failed++;
      // Mark the node's parent for debug diagnostics — don't mangle content
      try { node.parentElement?.setAttribute("data-tmt-failed", "1"); } catch (_) {}
    } finally {
      release();
      done++;
      progressCallback && progressCallback(done, failed);
    }
  });

  await Promise.allSettled(tasks.map((t) => t()));
  return { done, failed };
}

// ─────────────────────────────────────────────────────────────
// Translate element attributes
// ─────────────────────────────────────────────────────────────

async function translateElementAttributes(apiKey, srcLang, tgtLang) {
  const attrMap = {
    placeholder:  "data-tmt-orig-placeholder",
    title:        "data-tmt-orig-title",
    alt:          "data-tmt-orig-alt",
    "aria-label": "data-tmt-orig-aria-label",
  };
  const selector = Object.keys(attrMap).map((a) => `[${a}]`).join(", ");
  for (const el of document.querySelectorAll(selector)) {
    if (translationAborted) break;
    for (const [attr, origAttr] of Object.entries(attrMap)) {
      const value = el.getAttribute(attr);
      if (!value || !shouldTranslate(value) || el.hasAttribute(origAttr)) continue;
      try {
        const translated = await translateMeaningfulText(value, srcLang, tgtLang, apiKey);
        if (translated && translated !== value) {
          el.setAttribute(origAttr, value);
          el.setAttribute(attr, translated);
        }
        await delay(50);
      } catch (e) { /* keep original */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Table translation — dedicated pass for Wikipedia/news tables
// ─────────────────────────────────────────────────────────────

/**
 * Translate text nodes directly inside table cells and captions.
 * MediaWiki and traditional news sites use tables heavily; the main
 * TreeWalker pass can miss fragmented text nodes inside <td>/<th>.
 * This runs after the main passes as a targeted cleanup.
 */
async function translateTables(apiKey, srcLang, tgtLang, acquire) {
  const tables = document.querySelectorAll("table");
  if (!tables.length) return;

  const cellNodes = [];
  for (const table of tables) {
    if (translationAborted) break;
    // Skip tables that are already fully wrapped (e.g. re-scan hit them)
    if (table.closest(".tmt-wrap")) continue;

    const cells = table.querySelectorAll("td, th, caption");
    for (const cell of cells) {
      // Collect direct text-node children only — preserves table structure
      for (const child of cell.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE) continue;
        if (child.parentElement?.closest(".tmt-wrap")) continue;
        const text = child.textContent.trim();
        if (!text || !shouldTranslate(text)) continue;
        cellNodes.push(child);
      }
    }
  }

  if (cellNodes.length) {
    await translateNodes(cellNodes, apiKey, srcLang, tgtLang, acquire, { relaxed: true });
  }
}

// ─────────────────────────────────────────────────────────────
// Main translatePage  —  3-pass with idle scheduling
// ─────────────────────────────────────────────────────────────

async function translatePage(apiKey, srcLang, tgtLang) {
  stopMutationObserver();
  translationAborted = false;
  injectStyles();
  bilingualMode = false;
  document.body.classList.remove("tmt-bilingual");

  const acquire = makeSemaphore(CONCURRENCY_LIMIT);
  let totalFailed = 0;

  /**
   * One translation pass over the current DOM state.
   * @param {string} label         — indicator prefix
   * @param {boolean} relaxed      — use relaxed visibility check
   */
  async function runPass(label, relaxed = false) {
    if (translationAborted) return 0;

    const allNodes = getAllTextNodes(document.body, relaxed);
    const { visible, offscreen } = partitionByViewport(allNodes);
    const total = allNodes.length;
    let done = 0;

    const onProgress = (n, f) => {
      done = n; totalFailed += f;
      const failStr = totalFailed > 0 ? ` · ${totalFailed} failed` : "";
      updateIndicator(`${label} ${done}/${total}${failStr}`);
    };

    await translateNodes(visible,   apiKey, srcLang, tgtLang, acquire, { progressCallback: onProgress, relaxed });
    await translateNodes(offscreen, apiKey, srcLang, tgtLang, acquire, {
      progressCallback: (n, f) => {
        done = visible.length + n; totalFailed += f;
        const failStr = totalFailed > 0 ? ` · ${totalFailed} failed` : "";
        updateIndicator(`${label} ${done}/${total}${failStr}`);
      },
      relaxed,
    });

    return total;
  }

  showIndicator("Translating\u2026 0/?");
  showStopButton();

  // ── Pass 1: initial DOM ────────────────────────────────────
  const count = await runPass("Translating\u2026");

  // Attributes
  if (!translationAborted) {
    updateIndicator("Translating UI elements\u2026");
    try { await translateElementAttributes(apiKey, srcLang, tgtLang); } catch (e) {}
  }

  // ── Table pass: dedicated cleanup for Wikipedia/news tables ──
  if (!translationAborted) {
    updateIndicator("Translating tables\u2026");
    try { await translateTables(apiKey, srcLang, tgtLang, acquire); } catch (e) {}
  }

  // ── Pass 2: 800 ms later — catch first hydration wave ─────
  if (!translationAborted) {
    updateIndicator("Re-scanning\u2026 (pass 2)");
    await delay(800);
    await runPass("Re-scan 2\u2026", /* relaxed */ true);
  }

  // ── Pass 3: 1 800 ms after start — idle time, catch AJAX/lazy ─
  if (!translationAborted) {
    updateIndicator("Re-scanning\u2026 (pass 3)");
    await delay(1000); // total ~1 800 ms from end of pass 2
    await idleDelay(3000);
    await runPass("Re-scan 3\u2026", /* relaxed */ true);
  }

  removeStopButton();

  if (translationAborted) {
    updateIndicator("\u26A0 Translation stopped", true);
    setTimeout(removeIndicator, 3000);
    return count;
  }

  const failStr = totalFailed > 0 ? ` · ${totalFailed} errors` : "";
  updateIndicator(`\u2713 Done (${count} nodes${failStr})`, true);
  showRestoreButton();
  showBilingualButton();

  // Run diagnostics in the background
  setTimeout(() => debugTranslationStats(), 500);

  startMutationObserver(apiKey, srcLang, tgtLang);

  return count;
}

// ─────────────────────────────────────────────────────────────
// MutationObserver for dynamic / infinite-scroll content
// ─────────────────────────────────────────────────────────────

function collectTextNodesFromNode(rootNode) {
  if (!rootNode) return [];
  if (rootNode.nodeType === Node.TEXT_NODE) return [rootNode];
  if (rootNode.nodeType !== Node.ELEMENT_NODE) return [];
  return getAllTextNodes(rootNode, /* relaxed */ true);
}

function startMutationObserver(apiKey, srcLang, tgtLang) {
  if (mutationObserver) return;
  const acquire = makeSemaphore(CONCURRENCY_LIMIT);

  mutationObserver = new MutationObserver((mutations) => {
    const candidates = new Set();

    for (const mutation of mutations) {
      const tgt = mutation.target;
      if (tgt?.nodeType === Node.ELEMENT_NODE && tgt.closest?.(".tmt-wrap")) continue;
      if (tgt?.nodeType === Node.TEXT_NODE   && tgt.parentElement?.closest(".tmt-wrap")) continue;

      if (mutation.type === "characterData" && tgt) {
        if (!tgt.parentElement?.closest(".tmt-wrap")) candidates.add(tgt);
      }

      for (const added of mutation.addedNodes || []) {
        if (added.nodeType === Node.ELEMENT_NODE && added.closest?.(".tmt-wrap")) continue;
        for (const tn of collectTextNodesFromNode(added)) candidates.add(tn);
      }
    }

    if (!candidates.size) return;

    clearTimeout(mutationDebounceTimer);
    // 400 ms debounce — faster reaction than v2's 600 ms
    mutationDebounceTimer = setTimeout(async () => {
      const toTranslate = [];
      for (const node of candidates) {
        if (!node.isConnected) continue;
        const text = node.textContent?.trim() || "";
        if (!text || !shouldTranslate(text)) continue;
        if (node.parentElement?.closest(".tmt-wrap")) continue;
        toTranslate.push(node);
      }
      if (!toTranslate.length) return;
      await translateNodes(toTranslate, apiKey, srcLang, tgtLang, acquire, { relaxed: true });
    }, 400);
  });

  mutationObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
}

function stopMutationObserver() {
  mutationObserver?.disconnect();
  mutationObserver = null;
  clearTimeout(mutationDebounceTimer);
}

// ─────────────────────────────────────────────────────────────
// Styles — single <style id="tmt-styles">, removed on restore
// ─────────────────────────────────────────────────────────────

function injectStyles() {
  if (tmtStylesInjected || document.getElementById("tmt-styles")) {
    tmtStylesInjected = true;
    return;
  }
  tmtStylesInjected = true;

  const style = document.createElement("style");
  style.id = "tmt-styles";
  style.textContent = `
    /* Wrapper is layout-invisible */
    .tmt-wrap       { display: contents; }

    /* Default: hide original, show translation */
    .tmt-original   { display: none !important; }
    .tmt-translated { display: inline; }

    /* Bilingual mode: side-by-side inline block */
    body.tmt-bilingual .tmt-wrap {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      vertical-align: top;
    }
    body.tmt-bilingual .tmt-original {
      display: inline !important;
      color: inherit;
      opacity: 0.42;
      font-size: 0.78em;
      line-height: 1.2;
    }
    body.tmt-bilingual .tmt-translated {
      display: inline;
      font-size: 1em;
      line-height: 1.4;
    }

    @keyframes tmt-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────
// Floating indicator
// ─────────────────────────────────────────────────────────────

function showIndicator(text) {
  if (indicatorEl) { updateIndicator(text); return; }
  injectStyles();

  indicatorEl = document.createElement("div");
  indicatorEl.id = "tmt-indicator";
  Object.assign(indicatorEl.style, {
    position: "fixed", bottom: "20px", right: "20px", zIndex: "2147483647",
    background: "#0d1117", color: "#e6edf3", border: "1px solid #30363d",
    borderRadius: "8px", padding: "10px 16px", fontFamily: "'Sora', sans-serif",
    fontSize: "13px", boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    display: "flex", alignItems: "center", gap: "8px", minWidth: "240px",
  });

  const dot = document.createElement("span");
  dot.id = "tmt-dot";
  Object.assign(dot.style, {
    width: "8px", height: "8px", borderRadius: "50%",
    background: "#00d4ff", animation: "tmt-pulse 1s infinite", flexShrink: "0",
  });

  const label = document.createElement("span");
  label.id = "tmt-label";
  label.textContent = text;

  indicatorEl.appendChild(dot);
  indicatorEl.appendChild(label);
  document.body.appendChild(indicatorEl);
}

function updateIndicator(text, done = false) {
  const label = document.getElementById("tmt-label");
  const dot   = document.getElementById("tmt-dot");
  if (label) label.textContent = text;
  if (dot && done) { dot.style.background = "#3fb950"; dot.style.animation = "none"; }
}

function removeIndicator() {
  indicatorEl?.remove();
  indicatorEl = null;
}

// ─────────────────────────────────────────────────────────────
// Shared button factory
// ─────────────────────────────────────────────────────────────

function makeButton(id, label, bottomPx, onClick) {
  const btn = document.createElement("button");
  btn.id = id;
  btn.textContent = label;
  Object.assign(btn.style, {
    position: "fixed", bottom: `${bottomPx}px`, left: "20px", zIndex: "2147483647",
    background: "#21262d", color: "#e6edf3", border: "1px solid #30363d",
    borderRadius: "8px", padding: "8px 14px", fontFamily: "'Sora', sans-serif",
    fontSize: "12px", cursor: "pointer", boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    transition: "background 0.15s",
  });
  btn.addEventListener("mouseenter", () => { btn.style.background = "#30363d"; });
  btn.addEventListener("mouseleave", () => { btn.style.background = "#21262d"; });
  btn.addEventListener("click", onClick);
  document.body.appendChild(btn);
  return btn;
}

// ─────────────────────────────────────────────────────────────
// Restore button  (bottom-left, row 1)
// ─────────────────────────────────────────────────────────────

function showRestoreButton() {
  if (restoreButtonEl) return;
  restoreButtonEl = makeButton("tmt-restore-btn", "\u21A9 Restore Original", 20, restorePage);
}
function removeRestoreButton() { restoreButtonEl?.remove(); restoreButtonEl = null; }

// ─────────────────────────────────────────────────────────────
// Bilingual toggle button  (bottom-left, row 2)
// ─────────────────────────────────────────────────────────────

function showBilingualButton() {
  if (bilingualButtonEl) return;
  bilingualButtonEl = makeButton("tmt-bilingual-btn", "\u2295 Show Original", 60, toggleBilingual);
}
function updateBilingualButton() {
  if (!bilingualButtonEl) return;
  bilingualButtonEl.textContent = bilingualMode ? "\u2297 Hide Original" : "\u2295 Show Original";
}
function removeBilingualButton() { bilingualButtonEl?.remove(); bilingualButtonEl = null; }

// ─────────────────────────────────────────────────────────────
// Stop button  (bottom-left, row 3 — visible only while translating)
// ─────────────────────────────────────────────────────────────

function showStopButton() {
  if (stopButtonEl) return;
  stopButtonEl = makeButton("tmt-stop-btn", "\u25A0 Stop", 100, () => {
    translationAborted = true;
    removeStopButton();
    updateIndicator("\u26A0 Stopping\u2026");
  });
  stopButtonEl.style.background = "#3d1515";
  stopButtonEl.style.borderColor = "#6e2020";
  stopButtonEl.addEventListener("mouseenter", () => { stopButtonEl.style.background = "#5a1f1f"; });
  stopButtonEl.addEventListener("mouseleave", () => { stopButtonEl.style.background = "#3d1515"; });
}
function removeStopButton() { stopButtonEl?.remove(); stopButtonEl = null; }

// ─────────────────────────────────────────────────────────────
// Message listener (popup.js)
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "translatePage") {
    const estimate = getAllTextNodes(document.body).length;
    sendResponse({ status: "started", count: estimate });
    translatePage(message.apiKey, message.srcLang, message.tgtLang);
    return true;
  }

  if (message.action === "restorePage") {
    restorePage();
    sendResponse({ status: "restored" });
    return true;
  }

  if (message.action === "toggleBilingual") {
    toggleBilingual();
    sendResponse({ status: "ok", bilingual: bilingualMode });
    return true;
  }

  if (message.action === "debugStats") {
    sendResponse({ status: "ok", stats: debugTranslationStats() });
    return true;
  }
});

// ─────────────────────────────────────────────────────────────
// Context menu position tracking
// ─────────────────────────────────────────────────────────────

document.addEventListener("contextmenu", (event) => {
  const selection   = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : "";
  let selectionAnchor = null;

  if (selectedText && selection?.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      selectionAnchor = { x: rect.left, y: rect.bottom, width: rect.width, height: rect.height };
    }
  }

  chrome.runtime.sendMessage({
    action: "storeContextMenuPosition",
    x: event.clientX, y: event.clientY,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    selectedText, selectionAnchor,
  });
});