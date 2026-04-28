// content.js — Injected into every page
// Handles: page translation, text selection translation

const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

// ── Utility: split text into sentences ─────────────────────
// The TMT API works sentence-by-sentence
function splitSentences(text) {
  // Split on sentence-ending punctuation, with fallback for older browsers
  let sentences = [];
  try {
    // Try lookbehind (modern browsers)
    sentences = text.split(/(?<=[।.!?])\s+/);
  } catch (e) {
    // Fallback for older browsers - split on ". " or "। "
    sentences = text.split(/[\.\!؟\?।]\s+/);
  }
  return sentences
    .map(s => s.trim())
    .filter(s => s.length > 0);
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

// ── Single sentence translation call ───────────────────────
async function translateSentence(text, srcLang, tgtLang, apiKey) {
  return new Promise((resolve, reject) => {
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
  });
}

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
      if (value && value.trim().length > 0) {
        try {
          const translated = await translateBlock(value, srcLang, tgtLang, apiKey);
          el.setAttribute(attr, translated);
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
  const nodes = getTextNodes(document.body);

  // Show overlay indicator
  showIndicator(`Translating page… 0/${nodes.length}`);

  let done = 0;
  for (const node of nodes) {
    const original = node.textContent.trim();
    if (!original) continue;

    try {
      const translated = await translateBlock(original, srcLang, tgtLang, apiKey);
      node.textContent = translated;
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
