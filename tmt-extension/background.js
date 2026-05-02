// background.js — Service Worker
// Handles context menu (right-click) translation

const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

async function readApiResponse(response) {
  const rawBody = await response.text();

  try {
    return JSON.parse(rawBody);
  } catch {
    if (response.status === 429) {
      throw new Error("Too many requests. Please wait a moment and try again.");
    }

    if (response.status >= 500) {
      throw new Error("The translation service is temporarily unavailable. Try again later.");
    }

    throw new Error("The translation service returned an unexpected response. Please try again.");
  }
}

function getContextMenuStorageArea() {
  const storageAreaName = "session" in chrome.storage ? "session" : "local";
  return chrome.storage[storageAreaName];
}

// ── Create context menu on install ─────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {

    // Root
    chrome.contextMenus.create({
      id: "tmt-root",
      title: "TMT Translate",
      contexts: ["page", "selection"]
    });

    // Open popup — always visible
    chrome.contextMenus.create({
      id: "tmt-open",
      parentId: "tmt-root",
      title: "Open TMT Translator",
      contexts: ["page", "selection"]
    });

    // ── Translate Selected Text (only when text is selected) ──
    chrome.contextMenus.create({
      id: "tmt-translate-selection",
      parentId: "tmt-root",
      title: "Translate Selection",
      contexts: ["selection"]
    });

    const translationPairs = [
      { id: "en-ne", title: "English → Nepali" },
      { id: "en-tmg", title: "English → Tamang" },
      { id: "ne-en", title: "Nepali → English" },
      { id: "ne-tmg", title: "Nepali → Tamang" },
      { id: "tmg-en", title: "Tamang → English" },
      { id: "tmg-ne", title: "Tamang → Nepali" }
    ];

    // ── Translate Selected Text ───────────────────────────
    for (const pair of translationPairs) {
      chrome.contextMenus.create({
        id: `tmt-sel-${pair.id}`,
        parentId: "tmt-translate-selection",
        title: pair.title,
        contexts: ["selection"]
      });
    }

    // ── Translate Page (only on page context, not selection) ──
    chrome.contextMenus.create({
      id: "tmt-translate-page",
      parentId: "tmt-root",
      title: "Translate Page",
      contexts: ["page", "selection"]
    });

    for (const pair of translationPairs) {
      chrome.contextMenus.create({
        id: `tmt-page-${pair.id}`,
        parentId: "tmt-translate-page",
        title: pair.title,
        contexts: ["page", "selection"]
      });
    }

  });
});

// ── Message listener ────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const contextMenuStorage = getContextMenuStorageArea();

  if (request.action === "getApiKey") {
    chrome.storage.local.get("apiKey", (data) => {
      sendResponse({ apiKey: data.apiKey || null });
    });
    return true;
  }

  if (request.action === "storeContextMenuPosition" && sender.tab?.id != null) {
    contextMenuStorage.set({
      [`tmt-context-pos-${sender.tab.id}`]: {
        x: request.x,
        y: request.y,
        viewportWidth: request.viewportWidth,
        viewportHeight: request.viewportHeight,
        selectedText: request.selectedText || "",
        selectionAnchor: request.selectionAnchor || null,
        timestamp: Date.now()
      }
    });
    return false;
  }

  if (request.action === "translateSentence") {
    (async () => {
      try {
        const { text, srcLang, tgtLang } = request;
        // Read API key from extension storage (do not accept from page)
        chrome.storage.local.get("apiKey", async (data) => {
          const apiKey = data.apiKey;
          if (!apiKey) {
            sendResponse({ success: false, error: "No API key set" });
            return;
          }

          try {
            const response = await fetch(API_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
              },
              body: JSON.stringify({ text, src_lang: srcLang, tgt_lang: tgtLang })
            });
            const data = await readApiResponse(response);
            if (data.message_type === "SUCCESS") {
              sendResponse({ success: true, output: data.output });
            } else {
              sendResponse({ success: false, error: data.message || "Translation failed" });
            }
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

});

// ── Context menu click handler ──────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {

  // ── Open popup ────────────────────────────────────────
  if (info.menuItemId === "tmt-open") {
    try {
      await chrome.action.openPopup();
    } catch {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    }
    return;
  }

  // ── Shared: get stored settings ───────────────────────
  const _storage = await new Promise((resolve) => chrome.storage.local.get(["apiKey", "theme", "srcLang"], resolve));
  const { apiKey, theme, srcLang } = _storage;

  if (!apiKey) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (msg) => alert(msg),
      args: ["TMT Translator: Please set your API key in the extension popup first."]
    });
    return;
  }

  // ── Page translation ───────────────────────────────────
  const pageTargets = {
    "tmt-page-en-ne": { src: "en", tgt: "ne" },
    "tmt-page-en-tmg": { src: "en", tgt: "tmg" },
    "tmt-page-ne-en": { src: "ne", tgt: "en" },
    "tmt-page-ne-tmg": { src: "ne", tgt: "tmg" },
    "tmt-page-tmg-en": { src: "tmg", tgt: "en" },
    "tmt-page-tmg-ne": { src: "tmg", tgt: "ne" }
  };
  if (pageTargets[info.menuItemId]) {
    const { src, tgt } = pageTargets[info.menuItemId];

    if (src === tgt) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msg) => alert(msg),
        args: ["TMT Translator: Source and target language are the same. Change the source language in the popup first."]
      });
      return;
    }

    // Re-inject content script in case it isn't active on this page
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
    } catch {
      // Already injected — ignore
    }

    chrome.tabs.sendMessage(tab.id, {
      action: "translatePage",
      srcLang: src,
      tgtLang: tgt
    }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (msg) => alert(msg),
          args: ["TMT Translator: Could not reach the page. Try refreshing and trying again."]
        });
      }
    });
    return;
  }

  // ── Selected text translation ──────────────────────────
  const selTargets = {
    "tmt-sel-en-ne": "ne",
    "tmt-sel-en-tmg": "tmg",
    "tmt-sel-ne-en": "en",
    "tmt-sel-ne-tmg": "tmg",
    "tmt-sel-tmg-en": "en",
    "tmt-sel-tmg-ne": "ne"
  };
  if (!selTargets[info.menuItemId]) return;

  const tgt          = selTargets[info.menuItemId];
  const selectedText = info.selectionText?.trim() || "";
  if (!selectedText) return;

  // Pick a sensible source that isn't the target
  let src = srcLang || "en";
  if (src === tgt) {
    src = tgt === "en" ? "ne" : "en";
  }

  const panelTheme = theme === "light"
    ? { bg: "#f9f6f1", surface: "#ffffff", border: "#e5e5e5", accent: "#d97757", text: "#1d1d1d", muted: "#676767", pin: "#1a7f37" }
    : { bg: "#171717", surface: "#212121", border: "#333333", accent: "#d97757", text: "#ececec", muted: "#a0a0a0", pin: "#3fb950" };

  let storedPos = null;
  if (tab?.id != null) {
    const key = `tmt-context-pos-${tab.id}`;
    const store = getContextMenuStorageArea();
    const data = await new Promise((resolve) => store.get(key, resolve));
    storedPos = data && data[key];
  }
  const clickPosition = storedPos?.selectionAnchor || storedPos || null;

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Background performs authenticated requests using stored key
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ text: selectedText, src_lang: src, tgt_lang: tgt })
      });

      const data = await readApiResponse(response);
      const translated = data.message_type === "SUCCESS" ? data.output : `Error: ${data.message}`;

      // Inject tooltip into page — do NOT pass the API key into page args
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showTranslationTooltip,
        args: [selectedText, translated, src, tgt, clickPosition, panelTheme]
      });

    } catch (err) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msg) => alert(msg),
        args: [`TMT Translation error: ${err.message}`]
      });
    }

});

// ── Tooltip injected into the page ──────────────────────────
function showTranslationTooltip(original, translated, srcLang, tgtLang, clickPosition, theme) {
  const existing = document.getElementById("tmt-tooltip");
  if (existing) existing.remove();

  const langNames = { en: "English", ne: "Nepali", tmg: "Tamang" };

  const palette = theme || {
    bg: "#171717", surface: "#212121", border: "#333333",
    accent: "#d97757", text: "#ececec", muted: "#a0a0a0", pin: "#3fb950"
  };

  const shellBg    = palette.bg === "#f9f6f1"
    ? "linear-gradient(180deg,rgba(255,255,255,0.98),rgba(249,246,241,0.98))"
    : "linear-gradient(180deg,rgba(33,33,33,0.98),rgba(23,23,23,0.98))";
  const bodySurface = palette.bg === "#f9f6f1" ? "#fffdfa" : "rgba(255,255,255,0.02)";

  // Position
  const vw = window.innerWidth, vh = window.innerHeight;
  const contentLen   = typeof translated === "string" ? translated.length : 0;
  const tooltipWidth = Math.min(Math.max(contentLen > 160 ? 460 : 340, 300), vw - 32);
  const estimatedH   = contentLen > 320 ? 340 : 230;
  const anchorX = clickPosition?.x ?? vw - tooltipWidth - 24;
  const anchorY = clickPosition?.y ?? 24;
  const anchorH = clickPosition?.height ?? 0;
  const left = Math.max(16, Math.min(anchorX, vw - tooltipWidth - 16));
  const top  = Math.max(16, Math.min(anchorY + anchorH + 10, vh - estimatedH - 16));

  const targetOptions = ["en", "ne", "tmg"]
    .map(c => `<option value="${c}"${c === tgtLang ? " selected" : ""}>${langNames[c]}</option>`)
    .join("");

  const tooltip = document.createElement("div");
  tooltip.id = "tmt-tooltip";
  tooltip.style.cssText = `
    position:fixed; top:${top}px; left:${left}px;
    z-index:2147483647; width:${tooltipWidth}px;
    max-height:min(72vh,calc(100vh - 32px));
    color:${palette.text};
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:13px; line-height:1.55;
    border:1px solid ${palette.border}; border-radius:14px;
    overflow:hidden; box-shadow:0 18px 60px rgba(0,0,0,0.45);
    background:${shellBg};
  `;

  tooltip.innerHTML = `
    <div id="tmt-drag-handle" style="
      display:flex; align-items:center; justify-content:space-between;
      gap:10px; padding:10px 12px;
      background:${palette.surface};
      border-bottom:1px solid ${palette.border};
      cursor:grab; user-select:none;
    ">
      <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
        <span style="font-size:14px; font-weight:700; color:${palette.text}; white-space:nowrap;">
          Translate
        </span>
        <select id="tmt-target-select" style="
          appearance:none; border:1px solid ${palette.border}; border-radius:999px;
          background:${palette.bg}; color:${palette.text};
          padding:5px 26px 5px 10px; font-size:12px; font-weight:600;
          cursor:pointer; outline:none;
          background-image:linear-gradient(45deg,transparent 50%,${palette.muted} 50%),
                           linear-gradient(135deg,${palette.muted} 50%,transparent 50%);
          background-position:calc(100% - 13px) 50%,calc(100% - 8px) 50%;
          background-size:5px 5px,5px 5px; background-repeat:no-repeat;
        ">${targetOptions}</select>
      </div>
      <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
        <button id="tmt-pin" title="Pin" style="
          width:28px; height:28px; border-radius:7px;
          border:1px solid ${palette.border}; background:transparent;
          color:${palette.accent}; cursor:pointer;
          display:flex; align-items:center; justify-content:center;
        ">📌</button>
        <button id="tmt-close" title="Close" style="
          width:28px; height:28px; border-radius:7px;
          border:1px solid ${palette.border}; background:transparent;
          color:${palette.muted}; cursor:pointer; font-size:16px;
          display:flex; align-items:center; justify-content:center;
        ">×</button>
      </div>
    </div>

    <div style="
      padding:12px 13px 13px; background:${palette.bg};
      overflow-y:auto; max-height:calc(min(72vh,100vh - 32px) - 54px);
    ">
      <div style="
        margin-bottom:9px; padding:8px 10px;
        border:1px solid ${palette.border}; border-radius:9px;
        background:${palette.surface}; color:${palette.muted};
        font-size:12px; font-style:italic;
        white-space:pre-wrap; word-break:break-word;
      ">${original.slice(0, 140)}${original.length > 140 ? "…" : ""}</div>

      <div id="tmt-translated-text" style="
        position:relative; padding:11px 12px 13px;
        border:1px solid ${palette.border}; border-radius:9px;
        background:${bodySurface}; color:${palette.text}; font-size:15px;
        white-space:pre-wrap; word-break:break-word;
        transition:opacity 0.15s;
      ">
        <button id="tmt-copy-btn" title="Copy translation" style="
          position:absolute; top:8px; right:8px; z-index:2;
          width:45px; height:40px; border-radius:7px; border:1px solid ${palette.border};
          background:transparent; color:${palette.muted}; cursor:pointer; display:flex;
          align-items:center; justify-content:center; font-size:14px;
        ">Copy</button>
        ${translated}
      </div>

      <div style="
        margin-top:9px; display:flex;
        justify-content:space-between; align-items:center;
        color:${palette.muted}; font-size:11px;
      ">
        <span id="tmt-lang-label">${langNames[srcLang]} → ${langNames[tgtLang]}</span>
        <span id="tmt-status" style="color:${palette.accent}; font-weight:600;">Unpinned</span>
      </div>
    </div>
  `;

  document.body.appendChild(tooltip);

  const closeBtn     = document.getElementById("tmt-close");
  const pinBtn       = document.getElementById("tmt-pin");
  const statusEl     = document.getElementById("tmt-status");
  const langLabel    = document.getElementById("tmt-lang-label");
  const dragHandle   = document.getElementById("tmt-drag-handle");
  const targetSelect = document.getElementById("tmt-target-select");
  const translatedEl = document.getElementById("tmt-translated-text");

  const copyBtn = document.getElementById("tmt-copy-btn");

  let pinned = false;
  let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

  const pinIcon = (filled) => filled
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="#d97757" stroke = "#d97757" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.0004 15L12.0004 22M8.00043 7.30813V9.43875C8.00043 9.64677 8.00043 9.75078 7.98001 9.85026C7.9619 9.93852 7.93194 10.0239 7.89095 10.1042C7.84474 10.1946 7.77977 10.2758 7.64982 10.4383L6.08004 12.4005C5.4143 13.2327 5.08143 13.6487 5.08106 13.9989C5.08073 14.3035 5.21919 14.5916 5.4572 14.7815C5.73088 15 6.26373 15 7.32943 15H16.6714C17.7371 15 18.27 15 18.5437 14.7815C18.7817 14.5916 18.9201 14.3035 18.9198 13.9989C18.9194 13.6487 18.5866 13.2327 17.9208 12.4005L16.351 10.4383C16.2211 10.2758 16.1561 10.1946 16.1099 10.1042C16.0689 10.0239 16.039 9.93852 16.0208 9.85026C16.0004 9.75078 16.0004 9.64677 16.0004 9.43875V7.30813C16.0004 7.19301 16.0004 7.13544 16.0069 7.07868C16.0127 7.02825 16.0223 6.97833 16.0357 6.92937C16.0507 6.87424 16.0721 6.8208 16.1149 6.71391L17.1227 4.19423C17.4168 3.45914 17.5638 3.09159 17.5025 2.79655C17.4489 2.53853 17.2956 2.31211 17.0759 2.1665C16.8247 2 16.4289 2 15.6372 2H8.36368C7.57197 2 7.17611 2 6.92494 2.1665C6.70529 2.31211 6.55199 2.53853 6.49838 2.79655C6.43707 3.09159 6.58408 3.45914 6.87812 4.19423L7.88599 6.71391C7.92875 6.8208 7.95013 6.87424 7.96517 6.92937C7.97853 6.97833 7.98814 7.02825 7.99392 7.07868C8.00043 7.13544 8.00043 7.19301 8.00043 7.30813Z"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97757" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.0004 15L12.0004 22M8.00043 7.30813V9.43875C8.00043 9.64677 8.00043 9.75078 7.98001 9.85026C7.9619 9.93852 7.93194 10.0239 7.89095 10.1042C7.84474 10.1946 7.77977 10.2758 7.64982 10.4383L6.08004 12.4005C5.4143 13.2327 5.08143 13.6487 5.08106 13.9989C5.08073 14.3035 5.21919 14.5916 5.4572 14.7815C5.73088 15 6.26373 15 7.32943 15H16.6714C17.7371 15 18.27 15 18.5437 14.7815C18.7817 14.5916 18.9201 14.3035 18.9198 13.9989C18.9194 13.6487 18.5866 13.2327 17.9208 12.4005L16.351 10.4383C16.2211 10.2758 16.1561 10.1946 16.1099 10.1042C16.0689 10.0239 16.039 9.93852 16.0208 9.85026C16.0004 9.75078 16.0004 9.64677 16.0004 9.43875V7.30813C16.0004 7.19301 16.0004 7.13544 16.0069 7.07868C16.0127 7.02825 16.0223 6.97833 16.0357 6.92937C16.0507 6.87424 16.0721 6.8208 16.1149 6.71391L17.1227 4.19423C17.4168 3.45914 17.5638 3.09159 17.5025 2.79655C17.4489 2.53853 17.2956 2.31211 17.0759 2.1665C16.8247 2 16.4289 2 15.6372 2H8.36368C7.57197 2 7.17611 2 6.92494 2.1665C6.70529 2.31211 6.55199 2.53853 6.49838 2.79655C6.43707 3.09159 6.58408 3.45914 6.87812 4.19423L7.88599 6.71391C7.92875 6.8208 7.95013 6.87424 7.96517 6.92937C7.97853 6.97833 7.98814 7.02825 7.99392 7.07868C8.00043 7.13544 8.00043 7.19301 8.00043 7.30813Z"/></svg>`;

  // Close
  closeBtn.addEventListener("click", () => tooltip.remove());

  // Pin toggle
  pinBtn.addEventListener("click", () => {
    pinned = !pinned;
    statusEl.textContent = pinned ? "Pinned" : "Unpinned";
    statusEl.style.color = pinned ? palette.pin : palette.accent;
    pinBtn.style.opacity = pinned ? "1" : "0.6";
    pinBtn.style.color = pinned ? palette.pin : palette.accent;
    pinBtn.innerHTML = pinIcon(pinned);
  });

  pinBtn.style.color = palette.accent;
  pinBtn.innerHTML = pinIcon(false);

  // Dismiss on outside click (unless pinned)
  const outsideClick = (e) => {
    if (pinned || tooltip.contains(e.target)) return;
    tooltip.remove();
    document.removeEventListener("pointerdown", outsideClick, true);
  };
  document.addEventListener("pointerdown", outsideClick, true);

  // Copy button handler (top-right of translated box)
  if (copyBtn) {
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(translatedEl.textContent || "");
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "📋"; }, 1500);
      } catch (err) {
        copyBtn.textContent = "✗";
        setTimeout(() => { copyBtn.textContent = "📋"; }, 1500);
      }
    });
  }

  // Retranslate when dropdown changes
  targetSelect.addEventListener("change", async () => {
    const nextTgt = targetSelect.value;
    if (nextTgt === srcLang) {
      statusEl.textContent = "Same as source";
      statusEl.style.color = "#ff8b8b";
      return;
    }
    statusEl.textContent = `Translating to ${langNames[nextTgt]}…`;
    statusEl.style.color = palette.accent;
    translatedEl.style.opacity = "0.4";

    try {
      const result = await new Promise((resolve, reject) => {
        // Request translation from the background; do NOT include the API key here
        chrome.runtime.sendMessage({
          action: "translateSentence",
          text: original, srcLang, tgtLang: nextTgt
        }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (res?.success) resolve(res.output);
          else reject(new Error(res?.error || "Failed"));
        });
      });
      translatedEl.textContent  = result;
      translatedEl.style.opacity = "1";
      langLabel.textContent     = `${langNames[srcLang]} → ${langNames[nextTgt]}`;
      statusEl.textContent      = "Updated";
      statusEl.style.color      = palette.accent;
    } catch (err) {
      translatedEl.style.opacity = "1";
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = "#ff8b8b";
    }
  });

  // Drag
  const clamp = (x, y) => {
    const r = tooltip.getBoundingClientRect();
    return {
      left: Math.max(16, Math.min(x, window.innerWidth  - r.width  - 16)),
      top:  Math.max(16, Math.min(y, window.innerHeight - r.height - 16))
    };
  };

  dragHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || pinned) return;
    if (e.target.closest("button,select,input")) return;
    e.preventDefault();
    isDragging = true;
    const r = tooltip.getBoundingClientRect();
    dragOffsetX = e.clientX - r.left;
    dragOffsetY = e.clientY - r.top;
    dragHandle.style.cursor = "grabbing";
  });

  document.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const { left, top } = clamp(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
  });

  document.addEventListener("pointerup", () => {
    if (!isDragging) return;
    isDragging = false;
    dragHandle.style.cursor = "grab";
  });
}