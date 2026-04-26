// ── Constants ──────────────────────────────────────────────
const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

const LANG_NAMES = {
  en:  "English",
  ne:  "Nepali",
  tmg: "Tamang"
};

// ── DOM References ──────────────────────────────────────────
const apiKeyInput      = document.getElementById("apiKey");
const saveKeyBtn       = document.getElementById("saveKey");
const keyStatus        = document.getElementById("keyStatus");
const srcLangSel       = document.getElementById("srcLang");
const tgtLangSel       = document.getElementById("tgtLang");
const swapLangBtn      = document.getElementById("swapLang");
const inputText        = document.getElementById("inputText");
const translateBtn     = document.getElementById("translateBtn");
const clearBtn         = document.getElementById("clearBtn");
const outputBox        = document.getElementById("outputBox");
const outputMeta       = document.getElementById("outputMeta");
const copyBtn          = document.getElementById("copyBtn");
const translatePageBtn = document.getElementById("translatePageBtn");
const pageStatus       = document.getElementById("pageStatus");

// ── On Load: restore saved settings ────────────────────────
chrome.storage.local.get(["apiKey", "srcLang", "tgtLang"], (data) => {
  if (data.apiKey) {
    apiKeyInput.value = data.apiKey;
    keyStatus.textContent = "✓ API key loaded";
    keyStatus.className = "key-status ok";
  }
  if (data.srcLang) srcLangSel.value = data.srcLang;
  if (data.tgtLang) tgtLangSel.value = data.tgtLang;
});

// ── Save API Key ────────────────────────────────────────────
saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key.startsWith("team_")) {
    keyStatus.textContent = "✗ Key should start with 'team_'";
    keyStatus.className = "key-status err";
    return;
  }
  chrome.storage.local.set({ apiKey: key }, () => {
    keyStatus.textContent = "✓ API key saved securely";
    keyStatus.className = "key-status ok";
  });
});

// ── Swap Languages ──────────────────────────────────────────
swapLangBtn.addEventListener("click", () => {
  const tmp = srcLangSel.value;
  srcLangSel.value = tgtLangSel.value;
  tgtLangSel.value = tmp;
  saveLanguages();
});

// ── Save language preference on change ─────────────────────
srcLangSel.addEventListener("change", saveLanguages);
tgtLangSel.addEventListener("change", saveLanguages);

function saveLanguages() {
  chrome.storage.local.set({
    srcLang: srcLangSel.value,
    tgtLang: tgtLangSel.value
  });
}

// ── Core translate function ─────────────────────────────────
async function translateText(text, srcLang, tgtLang, apiKey) {
  if (srcLang === tgtLang) {
    throw new Error("Source and target languages must be different.");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      text: text,
      src_lang: srcLang,
      tgt_lang: tgtLang
    })
  });

  const data = await response.json();

  // API always returns HTTP 200 — check message_type
  if (data.message_type === "SUCCESS") {
    return data;
  } else {
    throw new Error(data.message || "Translation failed.");
  }
}

// ── Translate Button ────────────────────────────────────────
translateBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();
  if (!text) return;

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    outputBox.textContent = "Please enter and save your API key first.";
    outputBox.className = "output-box error";
    return;
  }

  const src = srcLangSel.value;
  const tgt = tgtLangSel.value;

  if (src === tgt) {
    outputBox.textContent = "Source and target languages cannot be the same.";
    outputBox.className = "output-box error";
    return;
  }

  // Loading state
  outputBox.textContent = "Translating…";
  outputBox.className = "output-box loading";
  outputMeta.textContent = "";
  copyBtn.style.display = "none";
  translateBtn.disabled = true;
  translateBtn.textContent = "Translating…";

  try {
    const result = await translateText(text, src, tgt, apiKey);
    outputBox.textContent = result.output;
    outputBox.className = "output-box";
    outputMeta.innerHTML = `
      <span>${LANG_NAMES[src]} → ${LANG_NAMES[tgt]}</span>
      <span>${new Date(result.timestamp).toLocaleTimeString()}</span>
    `;
    copyBtn.style.display = "block";
  } catch (err) {
    outputBox.textContent = `Error: ${err.message}`;
    outputBox.className = "output-box error";
  } finally {
    translateBtn.disabled = false;
    translateBtn.textContent = "Translate";
  }
});

// ── Clear Button ────────────────────────────────────────────
clearBtn.addEventListener("click", () => {
  inputText.value = "";
  outputBox.textContent = "Translation will appear here.";
  outputBox.className = "output-box";
  outputMeta.textContent = "";
  copyBtn.style.display = "none";
});

// ── Copy Output ─────────────────────────────────────────────
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(outputBox.textContent).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy Translation"; }, 1500);
  });
});

// ── Translate Entire Page ───────────────────────────────────
translatePageBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    pageStatus.textContent = "Please save your API key first.";
    pageStatus.style.color = "var(--error)";
    return;
  }

  const src = srcLangSel.value;
  const tgt = tgtLangSel.value;

  if (src === tgt) {
    pageStatus.textContent = "Source and target languages cannot be the same.";
    pageStatus.style.color = "var(--error)";
    return;
  }

  translatePageBtn.disabled = true;
  translatePageBtn.textContent = "⏳ Translating page…";
  pageStatus.textContent = "Sending to content script…";
  pageStatus.style.color = "var(--muted)";

  // Send message to content.js
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {
      action: "translatePage",
      apiKey,
      srcLang: src,
      tgtLang: tgt
    }, (response) => {
      if (chrome.runtime.lastError) {
        pageStatus.textContent = "Could not reach page. Try refreshing.";
        pageStatus.style.color = "var(--error)";
      } else if (response && response.status === "started") {
        pageStatus.textContent = `Translating ${response.count} text nodes…`;
        pageStatus.style.color = "var(--muted)";
      }
      translatePageBtn.disabled = false;
      translatePageBtn.textContent = "🌐 Translate Page";
    });
  });
});
