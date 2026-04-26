// background.js — Service Worker
// Handles context menu (right-click) translation

const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

// ── Create context menu on install ─────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // Parent menu
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
  // Language combination map: menuId -> { src, tgt }
  const langMap = {
    "tmt-en-ne": { src: "en", tgt: "ne" },
    "tmt-en-tmg": { src: "en", tgt: "tmg" },
    "tmt-ne-en": { src: "ne", tgt: "en" },
    "tmt-ne-tmg": { src: "ne", tgt: "tmg" },
    "tmt-tmg-en": { src: "tmg", tgt: "en" },
    "tmt-tmg-ne": { src: "tmg", tgt: "ne" }
  };

  if (!langMap[info.menuItemId]) return;

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
