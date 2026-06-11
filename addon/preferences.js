/* global Zotero */
/**
 * LLM Assistant — Preferences pane controller.
 *
 * Loaded as a module via Services.scriptloader.loadSubScript() in bootstrap.js
 * startup().  Defines Zotero.LLMAssistant.Prefs which is called from inline
 * onload handler on the preference pane's root <vbox>.
 *
 * KEY PATTERN (from zotero-pdf-translate reference project):
 *   <vbox onload="Zotero.LLMAssistant.Prefs.onPaneLoad(event)">
 *   → event.target.ownerGlobal  → pane's Window object
 *   → win.document.getElementById(...)  → correct element lookup
 */

// ── Namespace setup ────────────────────────────────────────────────────
if (!Zotero.LLMAssistant) Zotero.LLMAssistant = {};

Zotero.LLMAssistant.Prefs = {

  // ── Provider definitions ──────────────────────────────────────────────
  _providers: {
    openai:      { endpoint: "https://api.openai.com/v1" },
    deepseek:    { endpoint: "https://api.deepseek.com" },
    qwen:        { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    glm:         { endpoint: "https://open.bigmodel.cn/api/paas/v4" },
    moonshot:    { endpoint: "https://api.moonshot.cn/v1" },
    baichuan:    { endpoint: "https://api.baichuan-ai.com/v1" },
    yi:          { endpoint: "https://api.lingyiwanwu.com/v1" },
    siliconflow: { endpoint: "https://api.siliconflow.cn/v1" },
    claude:      { endpoint: "https://api.anthropic.com/v1" },
    gemini:      { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai" },
  },

  _PK: "extensions.zotero-llm-assistant.",
  _doc: null,
  _fetching: false,
  _testing: false,

  // ── Entry point: called from <vbox onload="..."> ─────────────────────
  onPaneLoad(event) {
    try {
      // event.target = the <vbox> root element of the preference pane
      // ownerGlobal = the Window that contains this element
      //   (could be iframe window or Settings window — either way works)
      const win = event.target.ownerGlobal
        || (event.target.ownerDocument && event.target.ownerDocument.defaultView)
        || window;
      const doc = win.document;

      Zotero.debug("[LLM Assistant Prefs] onPaneLoad fired");

      // Verify we can actually find our elements
      const testEl = doc.getElementById("pref-provider-preset");
      if (!testEl) {
        Zotero.logError("[LLM Assistant Prefs] onPaneLoad: pref-provider-preset not found in doc");
        // Retry once after a short delay in case bindings aren't ready
        setTimeout(() => {
          try {
            const retryEl = doc.getElementById("pref-provider-preset");
            Zotero.debug(`[LLM Assistant Prefs] Retry after delay: found=${!!retryEl}`);
            if (retryEl) {
              this._doc = doc;
              this._setupUI(doc);
            }
          } catch (e2) {
            Zotero.logError(`[LLM Assistant Prefs] Retry failed: ${e2.message}`);
          }
        }, 500);
        return;
      }

      this._doc = doc;
      this._setupUI(doc);
    } catch (e) {
      Zotero.logError(`[LLM Assistant Prefs] onPaneLoad error: ${e.message}\n${e.stack}`);
    }
  },

  // ── Set up all event listeners ───────────────────────────────────────
  _setupUI(doc) {
    const $provider   = doc.getElementById("pref-provider-preset");
    const $endpoint   = doc.getElementById("pref-llm-api-endpoint");
    const $apiKey     = doc.getElementById("pref-llm-api-key");
    const $modelPopup = doc.getElementById("pref-llm-model-popup");
    const $modelList  = doc.getElementById("pref-llm-model-list");
    const $modelInput = doc.getElementById("pref-llm-model");
    const $fetchBtn   = doc.getElementById("btn-fetch-models");
    const $testBtn    = doc.getElementById("btn-test-connection");
    const $testBox    = doc.getElementById("test-result-box");
    const $testResult = doc.getElementById("test-result");

    Zotero.debug(
      `[LLM Assistant Prefs] Elements: provider=${!!$provider} endpoint=${!!$endpoint} ` +
      `apiKey=${!!$apiKey} fetchBtn=${!!$fetchBtn} testBtn=${!!$testBtn}`
    );

    if (!$provider || !$endpoint) {
      Zotero.logError("[LLM Assistant Prefs] Critical elements missing, cannot init");
      return;
    }

    // ── Provider preset change (menulist fires "command") ──
    $provider.addEventListener("command", () => {
      const val = $provider.value;
      Zotero.debug(`[LLM Assistant Prefs] Provider → ${val}`);
      if (val !== "custom" && this._providers[val]) {
        $endpoint.value = this._providers[val].endpoint;
        $endpoint.readOnly = true;
        $endpoint.style.opacity = "0.7";
        this._clearDropdown($modelPopup, "(select provider, then click Fetch Models)");
      } else {
        $endpoint.readOnly = false;
        $endpoint.style.opacity = "1";
      }
    });

    // ── Endpoint manual edit → detect custom ──
    $endpoint.addEventListener("change", () => {
      const prov = $provider.value;
      if (prov !== "custom" && this._providers[prov]) {
        if ($endpoint.value !== this._providers[prov].endpoint) {
          $provider.value = "custom";
          $endpoint.readOnly = false;
          $endpoint.style.opacity = "1";
        }
      }
    });

    // ── Model dropdown selection → fill text input ──
    if ($modelList && $modelInput) {
      $modelList.addEventListener("command", () => {
        const val = $modelList.value;
        if (val) {
          $modelInput.value = val;
          $modelInput.dispatchEvent(new Event("input", { bubbles: true }));
          $modelInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    }

    // ── Fetch Models button ──
    if ($fetchBtn) {
      $fetchBtn.addEventListener("command", async () => {
        Zotero.debug("[LLM Assistant Prefs] Fetch Models clicked");
        if (this._fetching) return;

        const endpoint = ($endpoint.value || "").replace(/\/+$/, "");
        const apiKey   = $apiKey ? ($apiKey.value || "") : "";

        if (!endpoint) { this._showStatus(doc, "Please enter an API Endpoint first.", true); return; }
        if (!apiKey)   { this._showStatus(doc, "Please enter an API Key first.", true); return; }

        this._fetching = true;
        $fetchBtn.disabled = true;
        $fetchBtn.label = "Fetching...";

        try {
          const models = await this._fetchModels(endpoint, apiKey);
          Zotero.debug(`[LLM Assistant Prefs] Fetched ${models.length} models`);
          if (models.length === 0) {
            this._showStatus(doc, "No models returned.", true);
            this._clearDropdown($modelPopup, "(no models)");
          } else {
            this._fillDropdown(doc, $modelPopup, models);
            this._showStatus(doc, `Loaded ${models.length} models.`, false);
          }
        } catch (e) {
          Zotero.logError(`[LLM Assistant Prefs] Fetch error: ${e.message}`);
          this._showStatus(doc, `Fetch failed: ${e.message}`, true);
          this._clearDropdown($modelPopup, "(fetch failed)");
        } finally {
          this._fetching = false;
          $fetchBtn.disabled = false;
          $fetchBtn.label = "Fetch Models";
        }
      });
      Zotero.debug("[LLM Assistant Prefs] Fetch Models listener attached");
    }

    // ── Test Connection button ──
    if ($testBtn) {
      $testBtn.addEventListener("command", async () => {
        Zotero.debug("[LLM Assistant Prefs] Test Connection clicked");
        if (this._testing) return;

        const endpoint = ($endpoint.value || "").replace(/\/+$/, "");
        const apiKey   = $apiKey ? ($apiKey.value || "") : "";

        if (!endpoint) { this._showTestResult($testBox, $testResult, "Enter API Endpoint first.", false); return; }
        if (!apiKey)   { this._showTestResult($testBox, $testResult, "Enter API Key first.", false); return; }

        this._testing = true;
        $testBtn.disabled = true;
        $testBtn.label = "Testing...";

        try {
          const r = await this._testConn(endpoint, apiKey);
          this._showTestResult($testBox, $testResult, r.message, r.success);
        } catch (e) {
          this._showTestResult($testBox, $testResult, `Failed: ${e.message}`, false);
        } finally {
          this._testing = false;
          $testBtn.disabled = false;
          $testBtn.label = "Test Connection";
        }
      });
      Zotero.debug("[LLM Assistant Prefs] Test Connection listener attached");
    }

    // ── Test Traditional Engine button ──
    const $tradTestBtn = doc.getElementById("btn-test-traditional");
    const $tradTestBox = doc.getElementById("traditional-test-result-box");
    const $tradTestResult = doc.getElementById("traditional-test-result");

    if ($tradTestBtn) {
      $tradTestBtn.addEventListener("command", async () => {
        Zotero.debug("[LLM Assistant Prefs] Test Traditional Engine clicked");
        if (this._testing) return;

        if (typeof TraditionalClient === "undefined" || !TraditionalClient.testConnection) {
          this._showTestResult($tradTestBox, $tradTestResult, "TraditionalClient 未加载", false);
          return;
        }

        this._testing = true;
        $tradTestBtn.disabled = true;
        $tradTestBtn.label = "Testing...";

        try {
          const r = await TraditionalClient.testConnection();
          Zotero.debug(`[LLM Assistant Prefs] Traditional test: ${JSON.stringify(r)}`);
          this._showTestResult($tradTestBox, $tradTestResult, r.message, r.success);
        } catch (e) {
          this._showTestResult($tradTestBox, $tradTestResult, `测试失败: ${e.message}`, false);
        } finally {
          this._testing = false;
          $tradTestBtn.disabled = false;
          $tradTestBtn.label = "Test Engine";
        }
      });
      Zotero.debug("[LLM Assistant Prefs] Test Traditional Engine listener attached");
    }

    // ── Initialize provider UI state ──
    try {
      const prov = Zotero.Prefs.get(this._PK + "provider-preset", true) || "custom";
      if (prov !== "custom" && this._providers[prov]) {
        $endpoint.readOnly = true;
        $endpoint.style.opacity = "0.7";
      }
    } catch (e) {
      Zotero.debug(`[LLM Assistant Prefs] Init state: ${e.message}`);
    }

    Zotero.debug("[LLM Assistant Prefs] All listeners attached successfully");
  },

  // ── Fetch models from API ────────────────────────────────────────────
  _fetchModels(endpoint, apiKey) {
    const url = `${endpoint}/models`;
    Zotero.debug(`[LLM Assistant Prefs] GET ${url}`);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Authorization", `Bearer ${apiKey}`);
      xhr.timeout = 15000;
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error?.message || msg; } catch {}
          reject(new Error(msg));
          return;
        }
        try {
          const json = JSON.parse(xhr.responseText);
          let models = [];
          if (Array.isArray(json.data)) {
            models = json.data.map(m => ({ id: m.id || m.name || "" })).filter(m => m.id);
          } else if (Array.isArray(json)) {
            models = json.map(m => ({ id: m.id || m.name || m.model || "" })).filter(m => m.id);
          }
          models.sort((a, b) => a.id.localeCompare(b.id));
          resolve(models);
        } catch (e) {
          reject(new Error("Invalid JSON"));
        }
      };
      xhr.onerror   = () => reject(new Error("Network error"));
      xhr.ontimeout = () => reject(new Error("Timeout (15s)"));
      xhr.send(null);
    });
  },

  // ── Test API connection ──────────────────────────────────────────────
  _testConn(endpoint, apiKey) {
    const url = `${endpoint}/models`;
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Authorization", `Bearer ${apiKey}`);
      xhr.timeout = 10000;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const d = JSON.parse(xhr.responseText);
            const n = Array.isArray(d.data) ? d.data.length : 0;
            resolve({ success: true, message: `Connected (${n} models available)` });
          } catch { resolve({ success: true, message: "Connected" }); }
        } else {
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error?.message || msg; } catch {}
          resolve({ success: false, message: msg });
        }
      };
      xhr.onerror   = () => resolve({ success: false, message: "Network error" });
      xhr.ontimeout = () => resolve({ success: false, message: "Timeout (10s)" });
      xhr.send(null);
    });
  },

  // ── Dropdown helpers ─────────────────────────────────────────────────
  _fillDropdown(doc, popup, models) {
    if (!popup) return;
    while (popup.firstChild) popup.removeChild(popup.firstChild);
    for (const m of models) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", m.id);
      item.setAttribute("value", m.id);
      popup.appendChild(item);
    }
  },

  _clearDropdown(popup, placeholder) {
    if (!popup) return;
    while (popup.firstChild) popup.removeChild(popup.firstChild);
    const doc = popup.ownerDocument;
    const item = doc.createXULElement("menuitem");
    item.setAttribute("label", placeholder);
    item.setAttribute("value", "");
    item.setAttribute("disabled", "true");
    popup.appendChild(item);
  },

  // ── Status display ───────────────────────────────────────────────────
  _showStatus(doc, text, isError) {
    let status = doc.getElementById("fetch-status");
    if (!status) {
      status = doc.createXULElement("description");
      status.id = "fetch-status";
      status.style.cssText = "font-size: 11px; margin-top: 2px; margin-bottom: 2px;";
      const btn = doc.getElementById("btn-fetch-models");
      const hbox = btn && btn.closest ? btn.closest("hbox") : (btn && btn.parentNode);
      if (hbox && hbox.parentNode) {
        hbox.parentNode.insertBefore(status, hbox.nextSibling);
      }
    }
    status.textContent = text;
    status.style.color = isError ? "#c44" : "#080";
    status.hidden = !text;
    if (!isError && text) {
      setTimeout(() => { status.hidden = true; }, 5000);
    }
  },

  _showTestResult(box, el, text, success) {
    if (!box || !el) return;
    box.hidden = false;
    el.textContent = text;
    el.style.color = success ? "#080" : "#c44";
    if (success && text) {
      setTimeout(() => { box.hidden = true; }, 8000);
    }
  },

}; // end Zotero.LLMAssistant.Prefs

Zotero.debug("[LLM Assistant Prefs] Module loaded — Prefs namespace defined");
