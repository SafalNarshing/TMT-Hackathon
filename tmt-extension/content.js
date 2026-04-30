// content.js — Injected into every page
// Handles: page translation, text selection translation

const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";
const translationCache = new Map();

// ── Utility: split text into sentences ─────────────────────
// The TMT API works sentence-by-sentence
function splitSentences(text) {
  // Improved sentence splitter for Nepali + Latin:
  // - Split on danda (।) and on .!? when followed by whitespace and
  //   the next non-space char is uppercase Latin or Devanagari.
  // - Avoid splitting on dots inside numbers (e.g., २९,६८६) or URLs.
  const res = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;

    const isSentenceEnd = (ch === '।') || ch === '?' || ch === '!' || ch === '.';
    if (!isSentenceEnd) continue;

    // Look ahead for whitespace and then a candidate start
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const nextChar = text[j] || '';

    // Prevent splits inside numbers: if dot and adjacent digits, skip
    const prevChar = text[i - 1] || '';
    const prevIsDigit = /[0-9\u0966-\u096F]/.test(prevChar);
    const nextIsDigit = /[0-9\u0966-\u096F]/.test(nextChar);
    const nearby = text.slice(Math.max(0, i - 8), Math.min(text.length, j + 8));
    const looksLikeURL = /https?:\/\/|www\.|\/.+\./i.test(nearby);

    if (ch === '.' && (prevIsDigit && nextIsDigit)) {
      // dot between digits -> probably number, don't split
      continue;
    }
    if (looksLikeURL) continue;

    // Accept split if next non-space char is uppercase Latin or Devanagari letter
    const isNextLatinUpper = /[A-Z]/.test(nextChar);
    const isNextDevanagari = /[\u0900-\u097F]/.test(nextChar);
    if (nextChar === '' || isNextLatinUpper || isNextDevanagari) {
      res.push(buf.trim());
      buf = "";
      i = j - 1; // jump forward
    }
  }

  if (buf.trim().length > 0) res.push(buf.trim());
  return res.filter(s => s.length > 0);
}

// ── Check if element is visible ───────────────────────────
function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && 
         style.visibility !== "hidden" && 
         style.opacity !== "0";
}

// ── Utility: delay (rate limiting) ─────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple stable hash for short strings (djb2)
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return (h >>> 0).toString(16);
}

// Checks whether the string contains any letter (Latin or Devanagari)
function containsLetter(s) {
  return /[A-Za-z\u0900-\u097F]/.test(s);
}

// Heuristic: skip strings that are pure punctuation/numbers/short or look like dates/URLs
function shouldTranslate(s) {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length < 3) return false; // too short

  // Pure punctuation / numbers (including Devanagari digits)
  if (/^[\d\s\.,\u0966-\u096F।!?:;"'()\[\]{}\-–—\/\\,+%‰°]+$/.test(trimmed)) return false;

  // URLs, emails
  if (/https?:\/\/|www\.|@/.test(trimmed)) return false;

  // Dates like २०८३ वैशाख १५ or 2021-04-01 (quick catch)
  if (/\d{1,4}[\-\.\/]\d{1,2}[\-\.\/]?\d{0,4}/.test(trimmed)) return false;

  // If there are no letters (only symbols) skip
  if (!containsLetter(trimmed)) return false;

  return true;
}

// Detect mixed-language tokens: both ASCII letters and Devanagari present
function isLikelyMixedLanguage(s) {
  const letters = s.replace(/[^A-Za-z\u0900-\u097F]/g, '');
  if (letters.length < 4) return false; // too short to judge
  const latin = (letters.match(/[A-Za-z]/g) || []).length;
  const dev = (letters.match(/[\u0900-\u097F]/g) || []).length;
  if (latin > 0 && dev > 0) {
    // require both to be a meaningful proportion
    const total = latin + dev;
    if (latin / total > 0.15 && dev / total > 0.15) return true;
  }
  return false;
}

function getCharClass(ch) {
  if (/\s/.test(ch)) return "space";
  if (/[A-Za-z]/.test(ch)) return "latin";
  if (/[\u0900-\u097F]/.test(ch)) return "devanagari";
  if (/[0-9\u0966-\u096F]/.test(ch)) return "digit";
  if (/[\.,!?:;"'()\[\]{}\-–—\/\\|…।]/.test(ch)) return "punct";
  return "other";
}

function splitByScriptRuns(text) {
  const runs = [];
  let current = "";
  let currentClass = null;

  for (const ch of text) {
    const charClass = getCharClass(ch);

    if (!current) {
      current = ch;
      currentClass = charClass;
      continue;
    }

    if (charClass === "space" || charClass === "punct") {
      current += ch;
      continue;
    }

    if (currentClass === "space") {
      current += ch;
      currentClass = charClass;
      continue;
    }

    if (currentClass === charClass || currentClass === "digit" || charClass === "digit" || currentClass === "other" || charClass === "other") {
      current += ch;
      if (currentClass === "other" && charClass !== "other") currentClass = charClass;
      continue;
    }

    runs.push(current);
    current = ch;
    currentClass = charClass;
  }

  if (current) runs.push(current);
  return runs;
}

async function translateMeaningfulText(text, srcLang, tgtLang, apiKey) {
  const trimmed = text.trim();
  if (!shouldTranslate(trimmed)) return text;

  if (!isLikelyMixedLanguage(trimmed)) {
    return translateBlock(text, srcLang, tgtLang, apiKey);
  }

  const runs = splitByScriptRuns(text);
  const translatedRuns = [];

  for (const run of runs) {
    if (!shouldTranslate(run)) {
      translatedRuns.push(run);
      continue;
    }

    try {
      translatedRuns.push(await translateBlock(run, srcLang, tgtLang, apiKey));
      await delay(40);
    } catch (e) {
      translatedRuns.push(run);
    }
  }

  return translatedRuns.join("");
}

// ── Single sentence translation call ───────────────────────
async function translateSentence(text, srcLang, tgtLang, apiKey) {
  const cacheKey = `${srcLang}→${tgtLang}:${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const requestPromise = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: "translateSentence",
      text,
      srcLang,
      tgtLang,
      apiKey
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve(response.output);
      } else {
        reject(new Error(response?.error || "Translation failed"));
      }
    });
  })
    .then((output) => {
      translationCache.set(cacheKey, Promise.resolve(output));
      return output;
    })
    .catch((error) => {
      translationCache.delete(cacheKey);
      throw error;
    });

  translationCache.set(cacheKey, requestPromise);
  return requestPromise;
}
    let mutationObserver = null;
    let mutationDebounceTimer = null;


// ── Translate a whole block of text (multi-sentence) ───────
async function translateBlock(text, srcLang, tgtLang, apiKey) {
  const sentences = splitSentences(text);
  const translated = [];

  for (const sentence of sentences) {
    try {
      const result = await translateSentence(sentence, srcLang, tgtLang, apiKey);
      translated.push(result);
      await delay(150); // rate limiting: small pause between requests
    } catch (e) {
      translated.push(sentence); // fallback: keep original on error
    }
  }

  return translated.join(" ");
}

// ── Get all meaningful text nodes in the page ───────────────
function getTextNodes(root) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        // Skip script/style/invisible elements
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip elements that are not visible
        if (!isElementVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = node.textContent.trim();
        if (text.length < 1) return NodeFilter.FILTER_REJECT;
        // Skip nodes we already translated (parent stores a hash)
        try {
          const parentEl = node.parentElement;
          if (parentEl && parentEl.hasAttribute('data-tmt-translated-hash')) {
            const curHash = hashString(text);
            if (parentEl.getAttribute('data-tmt-translated-hash') === curHash) {
              return NodeFilter.FILTER_REJECT;
            }
          }
        } catch (e) {
          // ignore hashing errors and accept node
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    nodes.push(node);
  }
  return nodes;
}

// ── Translate element attributes that display text ────────
async function translateElementAttributes(apiKey, srcLang, tgtLang) {
  const attrNames = ["placeholder", "title", "alt", "aria-label"];
  const elements = document.querySelectorAll("[placeholder], [title], [alt], [aria-label]");
  
  for (const el of elements) {
    for (const attr of attrNames) {
      const value = el.getAttribute(attr);
      if (value && value.trim().length > 0 && shouldTranslate(value)) {
        try {
          const translated = await translateMeaningfulText(value, srcLang, tgtLang, apiKey);
          el.setAttribute(attr, translated);
          // store hash so mutation observers can detect our change
          try { el.setAttribute('data-tmt-translated-hash', hashString(translated.trim())); } catch (e) {}
          await delay(50);
        } catch (e) {
          // Keep original on error
        }
      }
    }
  }
}

// ── Translate the full page ─────────────────────────────────
async function translatePage(apiKey, srcLang, tgtLang) {
  startMutationObserver(apiKey, srcLang, tgtLang);
  const nodes = getTextNodes(document.body);

  // Show overlay indicator
  showIndicator(`Translating page… 0/${nodes.length}`);

  let done = 0;
  for (const node of nodes) {
    const original = node.textContent.trim();
    if (!original) continue;

    // Guards: skip very short / non-translatable nodes only
    if (!shouldTranslate(original)) {
      done++;
      updateIndicator(`Skipping… ${done}/${nodes.length}`);
      continue;
    }

    try {
      const translated = await translateMeaningfulText(original, srcLang, tgtLang, apiKey);
      if (translated && translated.trim().length > 0) {
        node.textContent = translated;
        // Mark parent so MutationObserver or later passes can detect we changed it
        try {
          const parentEl = node.parentElement;
          if (parentEl) parentEl.setAttribute('data-tmt-translated-hash', hashString(translated.trim()));
        } catch (e) {}
      }
    } catch (e) {
      // Keep original text if translation fails
    }

    done++;
    updateIndicator(`Translating… ${done}/${nodes.length}`);
    await delay(50);
  }

  // Also translate visible element attributes
  updateIndicator(`Translating UI elements…`);
  try {
    await translateElementAttributes(apiKey, srcLang, tgtLang);
  } catch (e) {
    // Continue even if attribute translation fails
  }

  updateIndicator(`✓ Page translated (${nodes.length} nodes)`, true);
  setTimeout(removeIndicator, 3000);

  return nodes.length;
}

function isNodeAlreadyTranslated(node) {
  const parentEl = node?.parentElement;
  if (!parentEl || !parentEl.hasAttribute('data-tmt-translated-hash')) return false;
  const currentText = (node.textContent || '').trim();
  if (!currentText) return false;
  return parentEl.getAttribute('data-tmt-translated-hash') === hashString(currentText);
}

function collectTextNodesFromNode(rootNode) {
  if (!rootNode) return [];
  if (rootNode.nodeType === Node.TEXT_NODE) {
    return [rootNode];
  }
  if (rootNode.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }
  return getTextNodes(rootNode);
}

function startMutationObserver(apiKey, srcLang, tgtLang) {
  if (mutationObserver) return;

  mutationObserver = new MutationObserver((mutations) => {
    const candidates = new Set();

    for (const mutation of mutations) {
      if (mutation.type === 'characterData' && mutation.target) {
        candidates.add(mutation.target);
      }

      for (const addedNode of mutation.addedNodes || []) {
        for (const textNode of collectTextNodesFromNode(addedNode)) {
          candidates.add(textNode);
        }
      }
    }

    if (candidates.size === 0) return;

    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(async () => {
      const nodesToTranslate = [];
      for (const node of candidates) {
        const text = node.textContent?.trim() || '';
        if (!text || !shouldTranslate(text) || isNodeAlreadyTranslated(node)) continue;
        nodesToTranslate.push(node);
      }

      if (nodesToTranslate.length === 0) return;

      for (const node of nodesToTranslate) {
        try {
          const original = node.textContent.trim();
          const translated = await translateMeaningfulText(original, srcLang, tgtLang, apiKey);
          if (translated && translated.trim().length > 0) {
            node.textContent = translated;
            const parentEl = node.parentElement;
            if (parentEl) parentEl.setAttribute('data-tmt-translated-hash', hashString(translated.trim()));
          }
        } catch (e) {
          // Ignore mutation-time translation failures and keep page content intact.
        }
      }
    }, 600);
  });

  mutationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true
  });
}
// ── Floating indicator UI ───────────────────────────────────
let indicatorEl = null;

function showIndicator(text) {
  if (indicatorEl) return;
  indicatorEl = document.createElement("div");
  indicatorEl.id = "tmt-indicator";
  indicatorEl.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    background: #0d1117;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 10px 16px;
    font-family: 'Sora', sans-serif;
    font-size: 13px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 220px;
  `;

  const dot = document.createElement("span");
  dot.id = "tmt-dot";
  dot.style.cssText = `
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #00d4ff;
    animation: tmt-pulse 1s infinite;
    flex-shrink: 0;
  `;

  // Inject animation
  const style = document.createElement("style");
  style.textContent = `
    @keyframes tmt-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  `;
  document.head.appendChild(style);

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
  if (dot && done) {
    dot.style.background = "#3fb950";
    dot.style.animation = "none";
  }
}

function removeIndicator() {
  if (indicatorEl) {
    indicatorEl.remove();
    indicatorEl = null;
  }
}

// ── Listen for messages from popup.js ──────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "translatePage") {
    const nodes = getTextNodes(document.body);
    sendResponse({ status: "started", count: nodes.length });

    // Run translation asynchronously
    translatePage(message.apiKey, message.srcLang, message.tgtLang);
    return true; // Keep message channel open
  }
});

// ── Track right-click position for context menu panels ─────
document.addEventListener("contextmenu", (event) => {
  const selection = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : "";
  let selectionAnchor = null;

  if (selectedText && selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      selectionAnchor = {
        x: rect.left,
        y: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    }
  }

  chrome.runtime.sendMessage({
    action: "storeContextMenuPosition",
    x: event.clientX,
    y: event.clientY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    selectedText,
    selectionAnchor
  });
});
