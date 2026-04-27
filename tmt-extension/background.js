// background.js — Service Worker
// Handles context menu (right-click) translation

const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

// ── Create context menu on install ─────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // Root menu item (no text selection required)
  chrome.contextMenus.create({
    id: "tmt-translate-root",
    title: "Translate with TMT",
    contexts: ["page", "selection", "link", "image"]
  });

  chrome.contextMenus.create({
    id: "tmt-detect-language",
    title: "Detect Language with TMT",
    contexts: ["selection"]
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

  // Get saved API key
  const { apiKey } = await chrome.storage.local.get("apiKey");

  if (!apiKey) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (msg) => alert(msg),
      args: ["TMT Translator: Please set your API key in the extension popup first."]
    });
    return;
  }

  if (info.menuItemId === "tmt-detect-language") {
    try {
      const detected = await detectLanguageViaAPI(selectedText, apiKey);

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showDetectionTooltip,
        args: [detected]
      });
    } catch (err) {
      console.error("TMT language detection error:", err);
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msg) => alert(msg),
        args: [`Language detection error: ${err.message}`]
      });
    }
    return;
  }

  if (!langMap[info.menuItemId]) return;

  const { src, tgt } = langMap[info.menuItemId];

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
      args: [selectedText, translated, src, tgt]
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
function showTranslationTooltip(original, translated, srcLang, tgtLang) {
  // Remove any existing tooltip
  const existing = document.getElementById("tmt-tooltip");
  if (existing) existing.remove();

  const langNames = { en: "English", ne: "Nepali", tmg: "Tamang" };

  const tooltip = document.createElement("div");
  tooltip.id = "tmt-tooltip";
  tooltip.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    background: #0d1117;
    color: #e6edf3;
    border: 1px solid #00d4ff;
    border-radius: 10px;
    padding: 14px 16px;
    max-width: 320px;
    font-family: sans-serif;
    font-size: 13px;
    box-shadow: 0 8px 32px rgba(0,212,255,0.15);
    line-height: 1.5;
  `;

  tooltip.innerHTML = `
    <div style="font-size:10px; color:#00d4ff; letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">
      ${langNames[srcLang] || srcLang} → ${langNames[tgtLang] || tgtLang}
    </div>
    <div style="color:#7d8590; margin-bottom:6px; font-style:italic; font-size:12px;">"${original.slice(0, 80)}${original.length > 80 ? '…' : ''}"</div>
    <div style="color:#e6edf3; font-size:14px;">${translated}</div>
    <div style="margin-top:10px; display:flex; justify-content:flex-end;">
      <button id="tmt-close" style="
        background:transparent; border:1px solid #30363d;
        color:#7d8590; border-radius:6px; padding:4px 10px;
        cursor:pointer; font-size:11px;
      ">Close</button>
    </div>
  `;

  document.body.appendChild(tooltip);

  document.getElementById("tmt-close").addEventListener("click", () => {
    tooltip.remove();
  });

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    if (document.getElementById("tmt-tooltip")) tooltip.remove();
  }, 8000);
}

function showDetectionTooltip(detectedLanguage) {
  const existing = document.getElementById("tmt-tooltip");
  if (existing) existing.remove();

  const tooltip = document.createElement("div");
  tooltip.id = "tmt-tooltip";
  tooltip.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    background: #0d1117;
    color: #e6edf3;
    border: 1px solid #00d4ff;
    border-radius: 10px;
    padding: 14px 16px;
    max-width: 320px;
    font-family: sans-serif;
    font-size: 13px;
    box-shadow: 0 8px 32px rgba(0,212,255,0.15);
    line-height: 1.5;
  `;

  tooltip.innerHTML = `
    <div style="font-size:10px; color:#00d4ff; letter-spacing:1px; text-transform:uppercase; margin-bottom:8px;">
      TMT Language Detection
    </div>
    <div style="color:#e6edf3; font-size:14px;">${detectedLanguage}</div>
    <div style="margin-top:10px; display:flex; justify-content:flex-end;">
      <button id="tmt-close" style="
        background:transparent; border:1px solid #30363d;
        color:#7d8590; border-radius:6px; padding:4px 10px;
        cursor:pointer; font-size:11px;
      ">Close</button>
    </div>
  `;

  document.body.appendChild(tooltip);

  document.getElementById("tmt-close").addEventListener("click", () => {
    tooltip.remove();
  });

  setTimeout(() => {
    if (document.getElementById("tmt-tooltip")) tooltip.remove();
  }, 8000);
}

async function safeTranslate(text, srcLang, tgtLang, apiKey) {
  // API rejects same-language pairs, guard explicitly.
  if (srcLang === tgtLang) return null;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({ text, src_lang: srcLang, tgt_lang: tgtLang })
  });

  const data = await response.json();

  return data.message_type === "SUCCESS" && typeof data.output === "string"
    ? data.output
    : null;
}

function scriptRatios(text) {
  const safeLength = Math.max(text.length, 1);
  const devanagariCount = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  return {
    devanagariRatio: devanagariCount / safeLength,
    latinRatio: latinCount / safeLength
  };
}

function englishScore(text) {
  if (!text || typeof text !== "string") return 0;

  const COMMON_EN = ["the", "is", "are", "was", "you", "have", "this", "that", "with", "and"];
  const safeLength = Math.max(text.length, 1);
  const latinRatio = (text.match(/[a-zA-Z]/g) || []).length / safeLength;
  const lower = text.toLowerCase();
  const wordBonus = COMMON_EN.filter(word => lower.includes(word)).length;

  return latinRatio + wordBonus * 0.1;
}

async function detectLanguageViaAPI(inputText, apiKey) {
  const langNames = {
    en: "English",
    ne: "Nepali",
    tmg: "Tamang"
  };

  const cleanInput = inputText.trim();
  if (!cleanInput) return "Unknown (empty selection)";

  // 2-call warm-up in parallel, as requested.
  const [toEnFromNe, toNeFromEn] = await Promise.all([
    safeTranslate(cleanInput, "ne", "en", apiKey),
    safeTranslate(cleanInput, "en", "ne", apiKey)
  ]);

  const { latinRatio, devanagariRatio } = scriptRatios(cleanInput);

  // Latin-heavy text is most likely English among supported languages.
  if (latinRatio > 0.4) {
    return langNames.en;
  }

  // If there is little to no Devanagari and not Latin-heavy, confidence is low.
  if (devanagariRatio < 0.2) {
    if (toEnFromNe && englishScore(toEnFromNe) > 0.45) {
      return langNames.ne;
    }
    return "Ambiguous";
  }

  // Devanagari branch: disambiguate Nepali vs Tamang using English-likeness.
  const [fromNe, fromTmg] = await Promise.all([
    safeTranslate(cleanInput, "ne", "en", apiKey),
    safeTranslate(cleanInput, "tmg", "en", apiKey)
  ]);

  const neScore = englishScore(fromNe);
  const tmgScore = englishScore(fromTmg);

  if (!fromNe && !fromTmg) {
    return "Ambiguous";
  }

  if (Math.abs(neScore - tmgScore) < 0.08) {
    return "Ambiguous";
  }

  return neScore >= tmgScore ? langNames.ne : langNames.tmg;
}
