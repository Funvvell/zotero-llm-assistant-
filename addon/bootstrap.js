/* global Zotero, Services */
/**
 * Bootstrap file for LLM Assistant plugin
 * Zotero 7/8/9 format: uses { rootURI, id, version } object as first argument.
 *
 * Reader-internal UI (the right-click popup that appears when you select
 * text in a PDF) is injected via the official Zotero.Reader API
 * (registerEventListener), not by manually creating XUL <menuitem>s.
 * Manual XUL injection stopped working when Zotero moved to the
 * Firefox 140 platform baseline (Zotero 8 / 9). See:
 *   https://windingwind.github.io/doc-for-zotero-plugin-dev/main/reader-ui-injection
 */

let rootURI;
let windowObserver;

// Reader popup listeners are auto-removed on plugin unload, so we only
// need to track them for diagnostics.
const _readerListenerPluginID = "llm-assistant@zotero.org";

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI: rURI }, reason) {
  rootURI = rURI;
  Zotero.debug(`[LLM Assistant] Starting up (id=${id}, version=${version})`);

  // Load modules (rootURI ends with /content/)
  const baseURL = rootURI.endsWith("/") ? rootURI : rootURI + "/";
  const scriptURL = (file) => baseURL + file;
  try {
    Services.scriptloader.loadSubScript(scriptURL("llmClient.js"));
    Services.scriptloader.loadSubScript(scriptURL("promptBuilder.js"));
    Services.scriptloader.loadSubScript(scriptURL("uiManager.js"));
    Services.scriptloader.loadSubScript(scriptURL("traditionalClient.js"));
    Services.scriptloader.loadSubScript(scriptURL("overlay.js"));
  } catch (e) {
    Zotero.logError(`[LLM Assistant] Failed to load scripts: ${e.message}\n${e.stack}`);
  }

  // Wait for the main window to be ready
  if (typeof Zotero.uiReadyPromise !== "undefined") {
    try {
      await Zotero.uiReadyPromise;
    } catch (e) {
      Zotero.logError(`[LLM Assistant] uiReadyPromise failed: ${e.message}`);
    }
  }

  // Register reader-internal popup (PDF text selection) items.
  // This is the Zotero 7+ official API and works on 8/9.
  if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
    try {
      Zotero.Reader.registerEventListener(
        "renderTextSelectionPopup",
        onRenderTextSelectionPopup,
        _readerListenerPluginID
      );
      Zotero.debug("[LLM Assistant] Registered renderTextSelectionPopup listener");
    } catch (e) {
      Zotero.logError(`[LLM Assistant] registerEventListener failed: ${e.message}`);
    }
  } else {
    Zotero.logError("[LLM Assistant] Zotero.Reader.registerEventListener not available; reader popup will not be added");
  }

  // Add menu items and UI to all existing main windows
  try {
    const mainWindows = Zotero.getMainWindows();
    for (const win of mainWindows) {
      await onMainWindowLoad(win);
    }
  } catch (e) {
    Zotero.logError(`[LLM Assistant] Initial main-window load failed: ${e.message}`);
  }

  // Observe new windows
  windowObserver = {
    observe: async function (subject, topic) {
      if (topic === "domwindowopened") {
        const win = subject;
        if (win.document && win.document.documentURI?.includes("chrome://zotero")) {
          try {
            await onMainWindowLoad(win);
          } catch (e) {
            Zotero.logError(`[LLM Assistant] Window load failed: ${e.message}`);
          }
        }
      }
    },
  };
  try {
    Services.ww.registerNotification(windowObserver);
  } catch (e) {
    Zotero.logError(`[LLM Assistant] registerNotification failed: ${e.message}`);
  }
}

function shutdown({ id, version, resourceURI, rootURI: rURI }, reason) {
  Zotero.debug(`[LLM Assistant] Shutting down (reason=${reason})`);

  if (reason === APP_SHUTDOWN) return;

  // Unregister window observer
  if (windowObserver) {
    try {
      Services.ww.unregisterNotification(windowObserver);
    } catch (e) {
      Zotero.logError(`[LLM Assistant] unregisterNotification failed: ${e.message}`);
    }
    windowObserver = null;
  }

  // Note: reader popup listeners registered via Zotero.Reader.registerEventListener
  // are removed automatically when the plugin is unloaded.

  // Remove menu items from all windows
  try {
    const mainWindows = Zotero.getMainWindows();
    for (const win of mainWindows) {
      onMainWindowUnload(win);
    }
  } catch (e) {
    Zotero.logError(`[LLM Assistant] Window unload failed: ${e.message}`);
  }

  // Clean up plugin state
  if (typeof Zotero.LLMAssistant !== "undefined") {
    try {
      Zotero.LLMAssistant.destroy();
    } catch (e) {
      Zotero.logError(`[LLM Assistant] Destroy failed: ${e.message}`);
    }
    delete Zotero.LLMAssistant;
  }
}

function uninstall(data, reason) {}

/**
 * Called when the main Zotero window is loaded.
 * The main-window item context menu (#zotero-itemmenu) is a stable,
 * non-XUL-injected popup and still works in 8/9, so we keep the old
 * MutationObserver-based approach for it.
 */
async function onMainWindowLoad(win) {
  if (!win || !win.document) return;

  // Wait for document to be ready
  if (win.document.readyState !== "complete") {
    await new Promise((resolve) => {
      win.addEventListener("load", resolve, { once: true });
    });
  }

  await addMainWindowMenuItems(win);

  if (typeof Zotero.LLMAssistant !== "undefined" && Zotero.LLMAssistant.init) {
    if (!Zotero.LLMAssistant._initialized) {
      Zotero.LLMAssistant._initialized = true;
      try {
        Zotero.LLMAssistant.init();
      } catch (e) {
        Zotero.logError(`[LLM Assistant] init failed: ${e.message}`);
      }
    }
  }
}

function onMainWindowUnload(win) {
  if (!win || !win.document) return;
  removeMainWindowMenuItems(win);
}

/**
 * Add library-item right-click menu items to the main Zotero window.
 * Targets the stable #zotero-itemmenu popup, which is part of the
 * main window's XHTML and still injected the same way in 7/8/9.
 */
async function addMainWindowMenuItems(win) {
  if (win._llmAssistantMenuObserver) return;

  const inject = () => {
    const popup = win.document.getElementById("zotero-itemmenu");
    if (popup && !popup._llmAssistantInjected) {
      injectItemMenuItems(popup, win);
    }
  };

  inject();

  const observer = new win.MutationObserver(() => inject());
  observer.observe(win.document.documentElement, { childList: true, subtree: true });
  win._llmAssistantMenuObserver = observer;
}

function removeMainWindowMenuItems(win) {
  if (win._llmAssistantMenuObserver) {
    try { win._llmAssistantMenuObserver.disconnect(); } catch (e) { /* ignore */ }
    delete win._llmAssistantMenuObserver;
  }
}

function injectItemMenuItems(popup, win) {
  popup._llmAssistantInjected = true;
  const doc = win.document;

  const sep = doc.createXULElement("menuseparator");
  popup.appendChild(sep);

  const items = [
    { id: "zotero-llm-summarize",        label: "总结条目",      cmd: "Zotero.LLMAssistant.summarizeSelected()" },
    { id: "zotero-llm-translate",         label: "翻译选中文本",  cmd: "Zotero.LLMAssistant.translateSelection()" },
    { id: "zotero-llm-translate-annotate",label: "翻译并标注",    cmd: "Zotero.LLMAssistant.translateAndAnnotate()" },
    { id: "zotero-llm-explain",          label: "解释选中文本",  cmd: "Zotero.LLMAssistant.explainSelection()" },
  ];

  for (const def of items) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("id", def.id);
    item.setAttribute("label", def.label);
    item.setAttribute("oncommand", def.cmd);
    popup.appendChild(item);
  }
}

/**
 * Reader-internal popup: invoked by Zotero.Reader whenever a text
 * selection popup is about to be rendered inside a PDF/EPUB reader.
 * We append a "翻译并标注" button to that popup.
 *
 * The event payload (Zotero 7+):
 *   {
 *     reader,                       // Zotero.Reader instance
 *     doc,                          // document inside the reader iframe
 *     params: { annotation: { text, ... } },
 *     append,                       // (htmlElement) => void  — adds the element to the popup
 *   }
 */
function onRenderTextSelectionPopup(event) {
  const { doc, params, append } = event;
  if (!doc || !append) return;

  const selectedText = (params && params.annotation && params.annotation.text) || "";
  // Stash the current selection so translateAndAnnotate can read it
  // even if the old "find selection from main window" path no longer
  // works on Zotero 9's reader.
  try {
    if (Zotero.LLMAssistant) {
      Zotero.LLMAssistant._lastSelection = {
        text: selectedText,
        ts: Date.now(),
      };
    }
  } catch (e) {
    Zotero.logError(`[LLM Assistant] stash selection failed: ${e.message}`);
  }

  // Build a button
  let btn;
  try {
    btn = doc.createElement("button");
  } catch (e) {
    Zotero.logError(`[LLM Assistant] createElement(button) failed: ${e.message}`);
    return;
  }
  btn.className = "zotero-llm-assistant-selection-btn";
  btn.textContent = "🌐 翻译并标注";
  btn.setAttribute("data-llm-action", "translateAndAnnotate");
  btn.style.cssText = "margin: 0 4px; padding: 2px 8px; cursor: pointer;";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      if (Zotero.LLMAssistant && Zotero.LLMAssistant.translateAndAnnotate) {
        Zotero.LLMAssistant.translateAndAnnotate();
      }
    } catch (e) {
      Zotero.logError(`[LLM Assistant] translateAndAnnotate click failed: ${e.message}`);
    }
  });

  try {
    append(btn);
  } catch (e) {
    Zotero.logError(`[LLM Assistant] append(reader btn) failed: ${e.message}`);
  }
}
