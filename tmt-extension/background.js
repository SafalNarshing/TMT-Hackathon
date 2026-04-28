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

// ── Create context menu on install ─────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // Root menu item (no text selection required)
  chrome.contextMenus.create({
    id: "tmt-translate-root",
    title: "Translate with TMT",
    contexts: ["page", "selection", "link", "image"]
  });

  // Parent menu for text selection
  chrome.contextMenus.create({
    id: "tmt-translate-selection",
    title: "Translate with TMT →",
    contexts: ["selection"]
  });

  // English → Other languages
  chrome.contextMenus.create({
    id: "tmt-en-ne",
    parentId: "tmt-translate-selection",
    title: "English → Nepali (नेपाली)",
    contexts: ["selection"]
  });

  chrome.contextMenus.create({
    id: "tmt-en-tmg",
    parentId: "tmt-translate-selection",
    title: "English → Tamang (तामाङ)",
    contexts: ["selection"]
  });

  // Nepali → Other languages
  chrome.contextMenus.create({
    id: "tmt-ne-en",
    parentId: "tmt-translate-selection",
    title: "Nepali (नेपाली) → English",
    contexts: ["selection"]
  });

  chrome.contextMenus.create({
    id: "tmt-ne-tmg",
    parentId: "tmt-translate-selection",
    title: "Nepali (नेपाली) → Tamang (तामाङ)",
    contexts: ["selection"]
  });

  // Tamang → Other languages
  chrome.contextMenus.create({
    id: "tmt-tmg-en",
    parentId: "tmt-translate-selection",
    title: "Tamang (तामाङ) → English",
    contexts: ["selection"]
  });

  chrome.contextMenus.create({
    id: "tmt-tmg-ne",
    parentId: "tmt-translate-selection",
    title: "Tamang (तामाङ) → Nepali (नेपाली)",
    contexts: ["selection"]
  });
});

// ── Handle API key request from popup ──────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getApiKey") {
    chrome.storage.local.get("apiKey", (data) => {
      sendResponse({ apiKey: data.apiKey || null });
    });
    return true; // Keep channel open for async response
  }

  if (request.action === "storeContextMenuPosition" && sender.tab?.id != null) {
    chrome.storage.session.set({
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
  }

  if (request.action === "translateSentence") {
    // Handle translation request from content.js (bypasses CORS)
    (async () => {
      try {
        const { text, srcLang, tgtLang, apiKey } = request;
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
    })();
    return true;
  }
});

// ── Handle context menu click ───────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Handle root "Translate with TMT" menu item
  if (info.menuItemId === "tmt-translate-root") {
    // Try to open the popup, or fall back to opening in a new tab
    try {
      await chrome.action.openPopup();
    } catch (err) {
      // Fallback: open in new tab
      chrome.tabs.create({
        url: chrome.runtime.getURL("popup.html")
      });
    }
    return;
  }

  // Language combination map: menuId -> { src, tgt }
  const langMap = {
    "tmt-en-ne": { src: "en", tgt: "ne" },
    "tmt-en-tmg": { src: "en", tgt: "tmg" },
    "tmt-ne-en": { src: "ne", tgt: "en" },
    "tmt-ne-tmg": { src: "ne", tgt: "tmg" },
    "tmt-tmg-en": { src: "tmg", tgt: "en" },
    "tmt-tmg-ne": { src: "tmg", tgt: "ne" }
  };

  const selectedText = info.selectionText?.trim();
  if (!selectedText) return;

  // Get saved API key and theme once for the selected-translation panel
  const { apiKey, theme } = await chrome.storage.local.get(["apiKey", "theme"]);

  if (!apiKey) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (msg) => alert(msg),
      args: ["TMT Translator: Please set your API key in the extension popup first."]
    });
    return;
  }

  if (!langMap[info.menuItemId]) return;

  const { src, tgt } = langMap[info.menuItemId];
  const storedPosition = tab?.id != null
    ? (await chrome.storage.session.get(`tmt-context-pos-${tab.id}`))[`tmt-context-pos-${tab.id}`]
    : null;
  const clickPosition = storedPosition?.selectionAnchor || storedPosition || null;

  const panelTheme = theme === "light"
    ? {
        bg: "#f9f6f1",
        surface: "#ffffff",
        border: "#e5e5e5",
        accent: "#d97757",
        text: "#1d1d1d",
        muted: "#676767",
        pin: "#1a7f37"
      }
    : {
        bg: "#171717",
        surface: "#212121",
        border: "#333333",
        accent: "#d97757",
        text: "#ececec",
        muted: "#a0a0a0",
        pin: "#3fb950"
      };

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ text: selectedText, src_lang: src, tgt_lang: tgt })
    });

    const data = await response.json();
    const translated = data.message_type === "SUCCESS"
      ? data.output
      : `Error: ${data.message}`;

    // Show result as a tooltip in the page
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showTranslationTooltip,
      args: [selectedText, translated, src, tgt, clickPosition, panelTheme, apiKey]
    });

  } catch (err) {
    console.error("TMT background translation error:", err);
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (msg) => alert(msg),
      args: [`Translation error: ${err.message}`]
    });
  }
});

// ── Tooltip injected into the page ─────────────────────────
// (This function is serialized and injected via scripting API)
function showTranslationTooltip(original, translated, srcLang, tgtLang, clickPosition, theme, apiKey) {
  // Remove any existing tooltip
  const existing = document.getElementById("tmt-tooltip");
  if (existing) existing.remove();

  const langNames = { en: "English", ne: "Nepali", tmg: "Tamang" };
  const palette = theme || {
    bg: "#171717",
    surface: "#212121",
    border: "#333333",
    accent: "#d97757",
    text: "#ececec",
    muted: "#a0a0a0",
    pin: "#3fb950"
  };
  const shellBackground = palette.bg === "#f9f6f1"
    ? "linear-gradient(180deg, rgba(255,255,255,0.98), rgba(249,246,241,0.98))"
    : "linear-gradient(180deg, rgba(33,33,33,0.98), rgba(23,23,23,0.98))";
  const bodySurface = palette.bg === "#f9f6f1"
    ? "#fffdfa"
    : "rgba(255,255,255,0.02)";

  const targetOptions = ["en", "ne", "tmg"]
    .map((code) => `<option value="${code}">${langNames[code] || code}</option>`)
    .join("");

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const contentLength = typeof translated === "string" ? translated.length : 0;
  const maxWidth = contentLength > 320 ? 600 : contentLength > 160 ? 480 : 380;
  const minWidth = contentLength > 220 ? 340 : 300;
  const estimatedHeight = contentLength > 320 ? 360 : contentLength > 160 ? 280 : 220;
  const anchorX = clickPosition && Number.isFinite(clickPosition.x) ? clickPosition.x : viewportWidth - 24;
  const anchorY = clickPosition && Number.isFinite(clickPosition.y) ? clickPosition.y : 24;
  const left = Math.max(16, Math.min(anchorX, viewportWidth - maxWidth - 16));
  const top = Math.max(16, Math.min(anchorY + 10, viewportHeight - estimatedHeight - 16));

  const tooltip = document.createElement("div");
  tooltip.id = "tmt-tooltip";
  tooltip.style.cssText = `
    position: fixed;
    top: ${top}px;
    left: ${left}px;
    z-index: 2147483647;
    width: fit-content;
    min-width: ${minWidth}px;
    max-width: min(${maxWidth}px, calc(100vw - 32px));
    max-height: min(72vh, calc(100vh - 32px));
    color: ${palette.text};
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    line-height: 1.55;
    border: 1px solid ${palette.border};
    border-radius: 22px;
    overflow: visible;
    box-shadow: 0 28px 80px rgba(0,0,0,0.42), 0 8px 20px rgba(0,0,0,0.18);
    background: ${shellBackground};
  `;

  tooltip.innerHTML = `
    <div id="tmt-drag-handle" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; background:${palette.surface}; border-bottom:1px solid ${palette.border}; cursor:grab; user-select:none; border-top-left-radius:22px; border-top-right-radius:22px;">
      <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1 1 auto;">
        <div style="font-size:14px; font-weight:800; color:${palette.text}; letter-spacing:0.2px;">
          Translate
        </div>
      </div>
      <select id="tmt-target-language" aria-label="Translate to language" style="appearance:none; border:1px solid ${palette.border}; border-radius:999px; background:${palette.bg}; color:${palette.text}; padding:7px 32px 7px 12px; font-size:12px; font-weight:700; cursor:pointer; outline:none; background-image:linear-gradient(45deg, transparent 50%, ${palette.muted} 50%), linear-gradient(135deg, ${palette.muted} 50%, transparent 50%); background-position:calc(100% - 17px) 50%, calc(100% - 11px) 50%; background-size:6px 6px, 6px 6px; background-repeat:no-repeat; position:relative; z-index:2;">
        ${targetOptions}
      </select>
      <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
        <button id="tmt-pin" aria-label="Pin translation window" title="Pin window" style="
          width:32px; height:32px; border-radius:10px; border:1px solid ${palette.border};
          background:${palette.bg}; color:${palette.muted}; cursor:pointer; display:flex; align-items:center; justify-content:center;
        ">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M12.0004 15L12.0004 22M8.00043 7.30813V9.43875C8.00043 9.64677 8.00043 9.75078 7.98001 9.85026C7.9619 9.93852 7.93194 10.0239 7.89095 10.1042C7.84474 10.1946 7.77977 10.2758 7.64982 10.4383L6.08004 12.4005C5.4143 13.2327 5.08143 13.6487 5.08106 13.9989C5.08073 14.3035 5.21919 14.5916 5.4572 14.7815C5.73088 15 6.26373 15 7.32943 15H16.6714C17.7371 15 18.27 15 18.5437 14.7815C18.7817 14.5916 18.9201 14.3035 18.9198 13.9989C18.9194 13.6487 18.5866 13.2327 17.9208 12.4005L16.351 10.4383C16.2211 10.2758 16.1561 10.1946 16.1099 10.1042C16.0689 10.0239 16.039 9.93852 16.0208 9.85026C16.0004 9.75078 16.0004 9.64677 16.0004 9.43875V7.30813C16.0004 7.19301 16.0004 7.13544 16.0069 7.07868C16.0127 7.02825 16.0223 6.97833 16.0357 6.92937C16.0507 6.87424 16.0721 6.8208 16.1149 6.71391L17.1227 4.19423C17.4168 3.45914 17.5638 3.09159 17.5025 2.79655C17.4489 2.53853 17.2956 2.31211 17.0759 2.1665C16.8247 2 16.4289 2 15.6372 2H8.36368C7.57197 2 7.17611 2 6.92494 2.1665C6.70529 2.31211 6.55199 2.53853 6.49838 2.79655C6.43707 3.09159 6.58408 3.45914 6.87812 4.19423L7.88599 6.71391C7.92875 6.8208 7.95013 6.87424 7.96517 6.92937C7.97853 6.97833 7.98814 7.02825 7.99392 7.07868C8.00043 7.13544 8.00043 7.19301 8.00043 7.30813Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button id="tmt-close" aria-label="Close translation window (Esc)" title="Close (Esc)" style="
          width:32px; height:32px; border-radius:10px; border:1px solid ${palette.border};
          background:${palette.bg}; color:${palette.muted}; cursor:pointer; display:flex; align-items:center; justify-content:center;
        ">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6L6 18"></path>
            <path d="M6 6l12 12"></path>
          </svg>
        </button>
      </div>
    </div>
    <div style="padding:14px; background:${palette.bg}; overflow:visible; max-height: calc(min(72vh, 100vh - 32px) - 58px); border-bottom-left-radius:22px; border-bottom-right-radius:22px;">
      <div style="margin-bottom:10px; padding:10px 12px; border:1px solid ${palette.border}; border-radius:14px; background:${palette.surface}; color:${palette.muted}; font-size:12px; font-style:italic; white-space:pre-wrap; word-break:break-word;">
        ${original.slice(0, 140)}${original.length > 140 ? '…' : ''}
      </div>
      <div id="tmt-translated-text" style="padding:14px 14px 16px; border:1px solid ${palette.border}; border-radius:14px; background:${bodySurface}; color:${palette.text}; font-size:15px; white-space:pre-wrap; word-break:break-word;">
        ${translated}
      </div>
      <div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center; gap:12px; color:${palette.muted}; font-size:11px; flex-wrap:wrap;">
        <span>Click pin to keep the panel locked in place.</span>
        <span id="tmt-status" style="color:${palette.accent}; font-weight:600;">Unpinned</span>
      </div>
    </div>
  `;

  document.body.appendChild(tooltip);

  const closeBtn = document.getElementById("tmt-close");
  const pinBtn = document.getElementById("tmt-pin");
  const statusEl = document.getElementById("tmt-status");
  const dragHandle = document.getElementById("tmt-drag-handle");
  const targetLanguageSelect = document.getElementById("tmt-target-language");
  let pinned = false;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let currentTargetLang = tgtLang;

  const removeTooltip = () => {
    tooltip.remove();
    document.removeEventListener("pointerdown", handleOutsideClick, true);
    document.removeEventListener("pointermove", moveDrag);
    document.removeEventListener("pointerup", endDrag);
    document.removeEventListener("keydown", handleEscapeKey, true);
  };

  if (targetLanguageSelect) {
    targetLanguageSelect.value = tgtLang;
  }

  const updateTranslationLanguage = async (nextTargetLang) => {
    const targetLang = nextTargetLang || currentTargetLang;
    if (!targetLang) return;

    if (targetLang === srcLang) {
      if (statusEl) {
        statusEl.textContent = "Source and target languages cannot be the same.";
        statusEl.style.color = "#ff8b8b";
      }
      return;
    }

    if (statusEl) {
      statusEl.textContent = `Translating to ${langNames[targetLang] || targetLang}…`;
      statusEl.style.color = palette.accent;
    }

    try {
      const translatedResult = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: "translateSentence",
          text: original,
          srcLang,
          tgtLang: targetLang,
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

      currentTargetLang = targetLang;
      const translatedEl = document.getElementById("tmt-translated-text");
      if (translatedEl) translatedEl.textContent = translatedResult;
      if (targetLanguageSelect) {
        targetLanguageSelect.value = targetLang;
      }
      if (statusEl) {
        statusEl.textContent = "Updated";
        statusEl.style.color = palette.accent;
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `Translation error: ${error.message}`;
        statusEl.style.color = "#ff8b8b";
      }
    }
  };

  const setPinnedState = () => {
    tooltip.dataset.pinned = pinned ? "true" : "false";
    tooltip.style.boxShadow = "0 18px 60px rgba(0,0,0,0.45)";
    pinBtn.innerHTML = pinned
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="#d97757" stroke="#d97757" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.0004 15L12.0004 22M8.00043 7.30813V9.43875C8.00043 9.64677 8.00043 9.75078 7.98001 9.85026C7.9619 9.93852 7.93194 10.0239 7.89095 10.1042C7.84474 10.1946 7.77977 10.2758 7.64982 10.4383L6.08004 12.4005C5.4143 13.2327 5.08143 13.6487 5.08106 13.9989C5.08073 14.3035 5.21919 14.5916 5.4572 14.7815C5.73088 15 6.26373 15 7.32943 15H16.6714C17.7371 15 18.27 15 18.5437 14.7815C18.7817 14.5916 18.9201 14.3035 18.9198 13.9989C18.9194 13.6487 18.5866 13.2327 17.9208 12.4005L16.351 10.4383C16.2211 10.2758 16.1561 10.1946 16.1099 10.1042C16.0689 10.0239 16.039 9.93852 16.0208 9.85026C16.0004 9.75078 16.0004 9.64677 16.0004 9.43875V7.30813C16.0004 7.19301 16.0004 7.13544 16.0069 7.07868C16.0127 7.02825 16.0223 6.97833 16.0357 6.92937C16.0507 6.87424 16.0721 6.8208 16.1149 6.71391L17.1227 4.19423C17.4168 3.45914 17.5638 3.09159 17.5025 2.79655C17.4489 2.53853 17.2956 2.31211 17.0759 2.1665C16.8247 2 16.4289 2 15.6372 2H8.36368C7.57197 2 7.17611 2 6.92494 2.1665C6.70529 2.31211 6.55199 2.53853 6.49838 2.79655C6.43707 3.09159 6.58408 3.45914 6.87812 4.19423L7.88599 6.71391C7.92875 6.8208 7.95013 6.87424 7.96517 6.92937C7.97853 6.97833 7.98814 7.02825 7.99392 7.07868C8.00043 7.13544 8.00043 7.19301 8.00043 7.30813Z"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97757" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.0004 15L12.0004 22M8.00043 7.30813V9.43875C8.00043 9.64677 8.00043 9.75078 7.98001 9.85026C7.9619 9.93852 7.93194 10.0239 7.89095 10.1042C7.84474 10.1946 7.77977 10.2758 7.64982 10.4383L6.08004 12.4005C5.4143 13.2327 5.08143 13.6487 5.08106 13.9989C5.08073 14.3035 5.21919 14.5916 5.4572 14.7815C5.73088 15 6.26373 15 7.32943 15H16.6714C17.7371 15 18.27 15 18.5437 14.7815C18.7817 14.5916 18.9201 14.3035 18.9198 13.9989C18.9194 13.6487 18.5866 13.2327 17.9208 12.4005L16.351 10.4383C16.2211 10.2758 16.1561 10.1946 16.1099 10.1042C16.0689 10.0239 16.039 9.93852 16.0208 9.85026C16.0004 9.75078 16.0004 9.64677 16.0004 9.43875V7.30813C16.0004 7.19301 16.0004 7.13544 16.0069 7.07868C16.0127 7.02825 16.0223 6.97833 16.0357 6.92937C16.0507 6.87424 16.0721 6.8208 16.1149 6.71391L17.1227 4.19423C17.4168 3.45914 17.5638 3.09159 17.5025 2.79655C17.4489 2.53853 17.2956 2.31211 17.0759 2.1665C16.8247 2 16.4289 2 15.6372 2H8.36368C7.57197 2 7.17611 2 6.92494 2.1665C6.70529 2.31211 6.55199 2.53853 6.49838 2.79655C6.43707 3.09159 6.58408 3.45914 6.87812 4.19423L7.88599 6.71391C7.92875 6.8208 7.95013 6.87424 7.96517 6.92937C7.97853 6.97833 7.98814 7.02825 7.99392 7.07868C8.00043 7.13544 8.00043 7.19301 8.00043 7.30813Z"/></svg>';
    statusEl.textContent = pinned ? "Pinned" : "Unpinned";
    statusEl.style.color = pinned ? palette.pin : palette.accent;
  };

  const handleOutsideClick = (event) => {
    if (pinned) return;
    if (!tooltip.contains(event.target)) {
      removeTooltip();
    }
  };

  const handleEscapeKey = (event) => {
    if (event.key === "Escape") {
      removeTooltip();
    }
  };

  const startDrag = (event) => {
    if (event.button !== 0 || pinned) return;
    if (event.target.closest("button, select, option, input, textarea, a, [contenteditable='true']")) return;
    event.preventDefault();
    isDragging = true;
    const rect = tooltip.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    tooltip.style.transition = "none";
    dragHandle.style.cursor = "grabbing";
  };

  const moveDrag = (event) => {
    if (!isDragging) return;
    tooltip.style.left = `${event.clientX - dragOffsetX}px`;
    tooltip.style.top = `${event.clientY - dragOffsetY}px`;
  };

  const endDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    tooltip.style.transition = "";
    dragHandle.style.cursor = "grab";
  };

  closeBtn.addEventListener("click", () => {
    removeTooltip();
  });

  pinBtn.addEventListener("click", () => {
    pinned = !pinned;
    setPinnedState();
  });

  if (targetLanguageSelect) {
    targetLanguageSelect.addEventListener("change", () => {
      updateTranslationLanguage(targetLanguageSelect.value);
    });
  }

  dragHandle.addEventListener("pointerdown", startDrag);
  document.addEventListener("pointermove", moveDrag);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointerdown", handleOutsideClick, true);
  document.addEventListener("keydown", handleEscapeKey, true);

  // Keep the panel open until the user closes it explicitly.
  setPinnedState();
}
