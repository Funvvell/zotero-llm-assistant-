/* global Zotero, Services, Components */
/**
 * UI Manager - Handles panel, notifications, and dialog interactions
 *
 * Improvements learned from zotero-pdf-translate:
 *   - CSS :hover instead of inline onmouseover/onmouseout handlers
 *   - Proper DOM element tracking for cleanup
 *   - Centralized style constants
 *   - Services.clipboard for modern clipboard access
 */

Zotero.LLMAssistant = Zotero.LLMAssistant || {};

Zotero.LLMAssistant.UIManager = {
  _panel: null,
  _panelContent: null,
  _progressBar: null,

  /**
   * Initialize the UI panel
   */
  init() {
    this._createPanel();
  },

  /**
   * Create the LLM Assistant panel in the right sidebar
   */
  _createPanel() {
    const doc = Zotero.getMainWindow().document;

    // Find the right-side panel container
    const rightPanel = doc.getElementById("zotero-items-splitter");
    if (!rightPanel) return;

    // Create panel — MUST use createXULElement for panel to have openPopup()
    this._panel = doc.createXULElement("panel");
    this._panel.id = "zotero-llm-assistant-panel";
    this._panel.setAttribute("noautohide", "true");
    this._panel.setAttribute("width", "480");
    this._panel.setAttribute("height", "600");

    this._panelContent = doc.createXULElement("vbox");
    this._panelContent.setAttribute("flex", "1");
    this._panelContent.setAttribute("style", "padding: 8px; font-size: 13px;");

    // Header
    const header = doc.createXULElement("hbox");
    header.setAttribute("align", "center");
    header.setAttribute("style", "margin-bottom: 8px;");

    const title = doc.createXULElement("label");
    title.setAttribute("value", "LLM Assistant");
    title.setAttribute("style", "font-weight: bold; font-size: 15px;");
    header.appendChild(title);

    const spacer = doc.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    header.appendChild(spacer);

    const closeBtn = doc.createXULElement("button");
    closeBtn.setAttribute("label", "Close");
    closeBtn.setAttribute("style", "min-width: 60px;");
    closeBtn.addEventListener("command", () => this.hidePanel());
    header.appendChild(closeBtn);

    this._panelContent.appendChild(header);

    // Progress bar
    this._progressBar = doc.createXULElement("progressmeter");
    this._progressBar.setAttribute("mode", "determined");
    this._progressBar.setAttribute("value", "0");
    this._progressBar.setAttribute("style", "display: none; margin-bottom: 8px;");
    this._panelContent.appendChild(this._progressBar);

    // Result area (scrollable)
    const resultScroll = doc.createXULElement("scrollbox");
    resultScroll.setAttribute("flex", "1");
    resultScroll.setAttribute("style", "border: 1px solid #ccc; border-radius: 4px; padding: 8px; overflow: auto; min-height: 300px; max-height: 400px;");

    this._resultLabel = doc.createXULElement("label");
    this._resultLabel.setAttribute("value", "Ready. Select a paper and choose an action from the context menu.");
    this._resultLabel.setAttribute("wrap", "true");
    this._resultLabel.setAttribute("style", "white-space: pre-wrap; line-height: 1.5;");
    resultScroll.appendChild(this._resultLabel);

    this._panelContent.appendChild(resultScroll);

    // Ask question input area
    const askBox = doc.createXULElement("vbox");
    askBox.setAttribute("style", "margin-top: 8px;");

    const askLabel = doc.createXULElement("label");
    askLabel.setAttribute("value", "Ask a question about the selected paper:");
    askBox.appendChild(askLabel);

    const inputHbox = doc.createXULElement("hbox");
    this._askInput = doc.createXULElement("textbox");
    this._askInput.setAttribute("flex", "1");
    this._askInput.setAttribute("placeholder", "Type your question...");
    inputHbox.appendChild(this._askInput);

    const askBtn = doc.createXULElement("button");
    askBtn.setAttribute("label", "Ask");
    askBtn.addEventListener("command", () => {
      const question = this._askInput.value.trim();
      if (question) {
        Zotero.LLMAssistant.askAboutSelected(question);
      }
    });
    inputHbox.appendChild(askBtn);

    askBox.appendChild(inputHbox);
    this._panelContent.appendChild(askBox);

    // Action buttons
    const actionBox = doc.createXULElement("hbox");
    actionBox.setAttribute("style", "margin-top: 8px;");

    const copyBtn = doc.createXULElement("button");
    copyBtn.setAttribute("label", "Copy Result");
    copyBtn.addEventListener("command", () => this._copyResult());
    actionBox.appendChild(copyBtn);

    const saveBtn = doc.createXULElement("button");
    saveBtn.setAttribute("label", "Save to Note");
    saveBtn.addEventListener("command", () => this._saveToNote());
    actionBox.appendChild(saveBtn);

    this._panelContent.appendChild(actionBox);

    this._panel.appendChild(this._panelContent);
    const popupSet = doc.getElementById("mainPopupSet");
    if (popupSet) {
      popupSet.appendChild(this._panel);
    } else {
      Zotero.logError("[LLM Assistant] mainPopupSet not found, panel may not display");
      doc.documentElement.appendChild(this._panel);
    }
  },

  /**
   * Show the panel near the item tree
   */
  showPanel() {
    if (!this._panel) this._createPanel();
    const doc = Zotero.getMainWindow().document;
    const itemTree = doc.getElementById("zotero-items-tree");
    if (itemTree) {
      const rect = itemTree.getBoundingClientRect();
      this._panel.openPopup(itemTree, "end_before", 0, 0);
    } else {
      this._panel.openPopupAtScreen(200, 200);
    }
  },

  /**
   * Hide the panel
   */
  hidePanel() {
    if (this._panel) {
      this._panel.hidePopup();
    }
  },

  /**
   * Show loading state
   */
  showLoading(message) {
    if (this._progressBar) {
      this._progressBar.setAttribute("mode", "undetermined");
      this._progressBar.setAttribute("style", "display: block; margin-bottom: 8px;");
    }
    this._updateResult(message || "Processing...");
  },

  /**
   * Hide loading state
   */
  hideLoading() {
    if (this._progressBar) {
      this._progressBar.setAttribute("style", "display: none; margin-bottom: 8px;");
    }
  },

  /**
   * Update the result display
   */
  _updateResult(text) {
    if (this._resultLabel) {
      this._resultLabel.setAttribute("value", text);
    }
    this._lastResult = text;
  },

  /**
   * Show a result in the panel
   */
  showResult(text) {
    this.hideLoading();
    this._updateResult(text);
    this.showPanel();
  },

  /**
   * Show an error message
   */
  showError(error) {
    this.hideLoading();
    this._updateResult(`Error: ${error}`);
    this.showPanel();
  },

  /**
   * Copy the current result to clipboard.
   * Uses navigator.clipboard (modern) with Components.classes fallback.
   */
  _copyResult() {
    if (!this._lastResult) return;
    const text = this._lastResult;

    // Modern path: navigator.clipboard
    const win = Zotero.getMainWindow();
    if (win && win.navigator && win.navigator.clipboard) {
      win.navigator.clipboard.writeText(text).then(
        () => this._showNotification("Result copied to clipboard!"),
        () => this._copyResultFallback(text)
      );
    } else {
      this._copyResultFallback(text);
    }
  },

  /** Fallback clipboard copy via XPCOM */
  _copyResultFallback(text) {
    try {
      const clipboard = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clipboard.copyString(text);
      this._showNotification("Result copied to clipboard!");
    } catch (e) {
      this._showNotification("Copy failed: " + e.message);
    }
  },

  /**
   * Save the current result as a note on the selected item
   */
  async _saveToNote() {
    if (!this._lastResult) return;

    const items = Zotero.getActiveZoteroPane().getSelectedItems();
    if (!items || items.length === 0) {
      this._showNotification("Please select an item first.");
      return;
    }

    const item = items[0];
    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    note.parentKey = item.key;
    note.setNote(`<h2>LLM Assistant Result</h2><p>${this._escapeHtml(this._lastResult).replace(/\n/g, "<br>")}</p>`);
    await note.saveTx();

    this._showNotification("Result saved as note!");
  },

  /**
   * Show a brief notification
   */
  _showNotification(message) {
    const doc = Zotero.getMainWindow().document;
    const notification = doc.createElement("notification");
    notification.setAttribute("label", message);
    notification.setAttribute("type", "info");

    const notifBox = doc.getElementById("zotero-notifications");
    if (notifBox) {
      notifBox.appendChild(notification);
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 3000);
    }
  },

  /**
   * Escape HTML special characters
   */
  _escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  /**
   * Show translation annotation as a floating tooltip over the PDF
   * @param {Object} data - Translation data {type, original, phonetic, partOfSpeech, translation, reasoning, examples}
   * @param {Object} selectionRect - Bounding rect of the selected text {left, top, right, bottom, width, height}
   */
  showAnnotationOnPDF(data, selectionRect) {
    this.hideLoading();

    const win = Zotero.getMainWindow();
    if (!win || !win.document) {
      Zotero.debug("[LLM Assistant] showAnnotationOnPDF: main window not available");
      return;
    }
    const doc = win.document;

    // Remove any existing annotation tooltip
    this._removeExistingAnnotation();

    // Create tooltip element with CSS class (styles injected via <style>)
    const tooltip = doc.createElement("div");
    tooltip.id = "zotero-llm-annotation-tooltip";
    tooltip.className = "zotero-llm-tooltip";

    // Inject shared stylesheet once
    if (!doc.getElementById("zotero-llm-tooltip-css")) {
      const styleEl = doc.createElement("style");
      styleEl.id = "zotero-llm-tooltip-css";
      styleEl.textContent = this._getTooltipCSS();
      (doc.head || doc.documentElement).appendChild(styleEl);
    }

    // Normalize data fields (support both old "word" and new "original")
    const type = data.type || (data.word ? "word" : (data.original || "").includes(" ") ? "phrase" : "word");
    const original = data.original || data.word || "";
    const phonetic = data.phonetic || "";
    const partOfSpeech = data.partOfSpeech || "";
    const translation = data.translation || "";
    const reasoning = data.reasoning || "";
    const examples = data.examples || [];

    // Tag color: blue for word, purple for phrase
    const tagColor = type === "phrase" ? "#7c3aed" : "#2563eb";
    const tagLabel = type === "phrase" ? "短语" : "单词";

    // Build tooltip content
    const headerHtml = `<div style="font-weight: bold; font-size: 15px; color: #1a1a1a; margin-bottom: 4px;">
      <span style="display: inline-block; background: ${tagColor}; color: #fff; font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 3px; margin-right: 6px; vertical-align: middle;">${tagLabel}</span>
      ${this._escapeHtml(original)}
      ${phonetic ? `<span style="font-weight: normal; color: #666; font-size: 13px;">[${this._escapeHtml(phonetic)}]</span>` : ""}
      ${partOfSpeech ? `<span style="color: ${tagColor}; font-size: 12px;"> ${this._escapeHtml(partOfSpeech)}</span>` : ""}
    </div>`;

    const translationHtml = `<div style="color: #d97706; font-size: 14px; margin-bottom: 6px; line-height: 1.8;">
      <div style="font-size: 10px; color: #b45309; margin-bottom: 2px;">译文（双击词可标注到 PDF 上）：</div>
      <span id="zotero-llm-translation-words">${this._wrapTranslationAsClickableWords(translation)}</span>
    </div>`;

    // Second row: traditional engine translation, when present.
    let traditionalHtml = "";
    if (data.traditional) {
      if (data.traditional.text) {
        const trad = data.traditional;
        const sourceLabel = this.sourceDisplayName(trad.source);
        traditionalHtml = `<div style="color: #059669; font-size: 13px; margin-bottom: 6px; line-height: 1.6; border-top: 1px dashed #d1fae5; padding-top: 4px;">
          <div style="font-size: 10px; color: #047857; margin-bottom: 2px;">传统翻译（${this._escapeHtml(sourceLabel)}）：</div>
          <span class="zotero-llm-traditional-translation">${this._escapeHtml(trad.text)}</span>
        </div>`;
      } else if (data.traditional.error) {
        const err = data.traditional.error;
        const source = data.traditional.source || "unknown";
        let hint = "";
        if (/not configured/.test(err)) {
          hint = `<div style="font-size: 10px; color: #92400e; margin-top: 2px;">请在 LLM Assistant 设置中配置翻译引擎 API 密钥，或选择免费的 MyMemory 引擎。</div>`;
        } else if (/network|timeout/.test(err)) {
          hint = `<div style="font-size: 10px; color: #92400e; margin-top: 2px;">请检查网络连接后重试。</div>`;
        }
        traditionalHtml = `<div style="color: #dc2626; font-size: 12px; margin-bottom: 6px; line-height: 1.5; border-top: 1px dashed #fecaca; padding-top: 4px;">
          <div style="font-size: 10px; color: #b91c1c; margin-bottom: 2px;">传统翻译（${this._escapeHtml(source)}）：</div>
          <span>${this._escapeHtml(err)}</span>
          ${hint}
        </div>`;
      }
    }

    let reasoningHtml = "";
    if (reasoning) {
      reasoningHtml = `<div style="background: #f0f7ff; border-left: 3px solid #3b82f6; padding: 6px 8px; margin: 6px 0; font-size: 12px; color: #1e40af; border-radius: 3px;">
        <strong>为什么是这意思：</strong>${this._escapeHtml(reasoning)}
      </div>`;
    }

    let examplesHtml = "";
    if (examples.length > 0) {
      examplesHtml = `<div style="border-top: 1px dashed #e5e7eb; padding-top: 6px; margin-top: 6px;">
        <div style="font-size: 11px; color: #888; margin-bottom: 3px;">例句：</div>
        ${examples.map((ex) => `<div style="font-size: 12px; color: #555; margin-bottom: 2px;">• ${this._escapeHtml(ex)}</div>`).join("")}
      </div>`;
    }

    const closeBtnHtml = `<div style="text-align: right; margin-top: 8px;">
      <button id="zotero-llm-annotation-close" class="close-btn">关闭</button>
      <button id="zotero-llm-annotation-add-note" class="note-btn">添加到笔记</button>
    </div>`;

    tooltip.innerHTML = headerHtml + translationHtml + traditionalHtml + reasoningHtml + examplesHtml + closeBtnHtml;

    // Find the PDF viewer container to position the tooltip
    let pdfContainer = doc.getElementById("reader-ui");
    if (!pdfContainer) {
      pdfContainer = doc.getElementById("zotero-pane");
    }
    if (!pdfContainer) {
      pdfContainer = doc.getElementById("mainPopupSet");
    }
    if (!pdfContainer) {
      pdfContainer = doc.body;
    }

    if (!pdfContainer) {
      Zotero.debug("[LLM Assistant] showAnnotationOnPDF: no container found");
      return;
    }

    pdfContainer.appendChild(tooltip);
    this._annotationTooltip = tooltip;

    // Calculate tooltip position: above the selected word, in the inter-line space
    let x, y;

    if (selectionRect && selectionRect.left !== undefined) {
      // We have the exact selection coordinates - position tooltip above the word
      const tooltipRect = tooltip.getBoundingClientRect();
      const tooltipHeight = tooltipRect.height || 140; // estimated if not rendered yet
      const tooltipWidth = tooltipRect.width || 280;

      // Center horizontally on the selected word
      x = selectionRect.left + selectionRect.width / 2 - tooltipWidth / 2;
      // Place above the selected text, in the inter-line space
      y = selectionRect.top - tooltipHeight - 6;

      Zotero.debug(`[LLM Assistant] Selection rect: left=${selectionRect.left}, top=${selectionRect.top}, width=${selectionRect.width}, height=${selectionRect.height}`);
      Zotero.debug(`[LLM Assistant] Initial tooltip pos: x=${x}, y=${y}`);
    } else {
      // Fallback: position near the center of the reader
      const reader = doc.querySelector("#reader-ui .reader");
      if (reader) {
        const rect = reader.getBoundingClientRect();
        x = rect.left + rect.width / 2 - 140;
        y = rect.top + 80;
      } else {
        x = 200;
        y = 150;
      }
    }

    // Ensure tooltip stays within viewport
    const viewportWidth = win.innerWidth;
    const viewportHeight = win.innerHeight;
    const tooltipRect = tooltip.getBoundingClientRect();
    const finalWidth = tooltipRect.width || 280;
    const finalHeight = tooltipRect.height || 140;

    // Horizontal bounds
    if (x + finalWidth > viewportWidth - 10) {
      x = viewportWidth - finalWidth - 10;
    }
    if (x < 10) x = 10;

    // Vertical bounds: if too close to top, show below the word instead
    if (y < 10) {
      // Not enough space above - show below the selected text
      if (selectionRect && selectionRect.bottom !== undefined) {
        y = selectionRect.bottom + 6;
      } else {
        y = 10;
      }
      // If also too close to bottom, just clamp
      if (y + finalHeight > viewportHeight - 10) {
        y = viewportHeight - finalHeight - 10;
      }
    }

    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";

    Zotero.debug(`[LLM Assistant] Final tooltip pos: x=${x}, y=${y}`);

    // Bind close button
    const closeBtn = doc.getElementById("zotero-llm-annotation-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this._removeExistingAnnotation());
    }

    // Bind add-to-note button
    const noteBtn = doc.getElementById("zotero-llm-annotation-add-note");
    if (noteBtn) {
      noteBtn.addEventListener("click", () => {
        this._saveAnnotationToNote(data);
        this._removeExistingAnnotation();
      });
    }

    // Bind double-click on individual translation words -> create a persistent
    // annotation label above the original selected word in the PDF
    const wordSpans = tooltip.querySelectorAll(".zotero-llm-translation-word");
    wordSpans.forEach((span) => {
      span.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const word = span.getAttribute("data-word") || span.textContent.trim();
        this._createPersistentAnnotation(word, selectionRect);
        this._removeExistingAnnotation();
      });
    });

    // Auto-remove after 30 seconds
    this._annotationTimeout = setTimeout(() => {
      this._removeExistingAnnotation();
    }, 30000);
  },

  /**
   * Map a traditional-engine source key to a human-readable label
   * shown in the UI (e.g. "baidu" → "百度翻译").
   */
  sourceDisplayName(source) {
    const map = {
      baidu:    "百度翻译",
      youdao:   "有道翻译",
      azure:    "微软翻译",
      google:   "Google 翻译",
      mymemory: "MyMemory 翻译",
      none:     "无"
    };
    return map[source] || (source || "未知");
  },

  /**
   * Wrap each meaningful word/character in the translation text with a clickable
   * span. For Chinese we split by character; for English by whitespace.
   * Punctuation is rendered as plain text. Mixed text is handled by
   * first splitting on CJK runs and then wrapping the non-CJK runs as English.
   */
  _wrapTranslationAsClickableWords(text) {
    if (!text) return "";
    const hasCJK = /[\u4e00-\u9fff]/.test(text);
    if (hasCJK) {
      // Split into runs of CJK characters vs non-CJK
      return text
        .split(/([\u4e00-\u9fff]+)/)
        .map((segment) => {
          if (/^[\u4e00-\u9fff]+$/.test(segment)) {
            return segment
              .split("")
              .map((ch) => this._wrapAsClickable(ch))
              .join("");
          }
          // Non-CJK segment inside CJK text: still wrap English tokens
          return this._wrapEnglishSegment(segment);
        })
        .join("");
    }
    return this._wrapEnglishSegment(text);
  },

  /**
   * Wrap an English/mixed segment: split on whitespace, keep punctuation.
   */
  _wrapEnglishSegment(text) {
    return text
      .split(/(\s+|[,.;:!?，。；：！？、])/)
      .filter((s) => s && !/^\s+$/.test(s))
      .map((tok) => {
        if (/^\s+$/.test(tok) || /^[,.;:!?，。；：！？、]$/.test(tok)) {
          return this._escapeHtml(tok);
        }
        return this._wrapAsClickable(tok);
      })
      .join("");
  },

  /**
   * Render a single word/char as a clickable span.
   * Uses CSS class for hover effect instead of inline onmouseover/onmouseout.
   */
  _wrapAsClickable(token) {
    const safe = this._escapeHtml(token);
    return `<span class="zotero-llm-translation-word" data-word="${safe}" title="双击标注到 PDF">${safe}</span>`;
  },

  /**
   * Get the shared CSS stylesheet for tooltip elements.
   * Centralizes styles to avoid inline duplication and enables :hover.
   */
  _getTooltipCSS() {
    return `
      .zotero-llm-translation-word {
        cursor: pointer; padding: 0 1px; border-radius: 2px;
        transition: background 0.15s;
      }
      .zotero-llm-translation-word:hover {
        background: #fef3c7;
      }
      .zotero-llm-tooltip {
        position: fixed; z-index: 999999;
        background: #fffbe6; border: 1px solid #ffd700;
        border-radius: 8px; padding: 10px 14px;
        max-width: 360px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
        font-size: 13px; line-height: 1.6; color: #333;
        pointer-events: auto; user-select: text;
      }
      .zotero-llm-tooltip .close-btn {
        background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px;
        padding: 2px 10px; font-size: 12px; cursor: pointer; color: #374151;
      }
      .zotero-llm-tooltip .note-btn {
        background: #2563eb; border: 1px solid #2563eb; border-radius: 4px;
        padding: 2px 10px; font-size: 12px; cursor: pointer; color: #fff; margin-left: 6px;
      }
      .zotero-llm-persistent-annotation {
        position: fixed; z-index: 999998;
        background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
        padding: 2px 8px; font-size: 12px; color: #92400e;
        box-shadow: 0 2px 6px rgba(0,0,0,0.12);
        pointer-events: auto; user-select: none;
        white-space: nowrap; max-width: 200px;
        overflow: hidden; text-overflow: ellipsis;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
      }
    `;
  },

  /**
   * Create a persistent annotation label on the PDF at the location of the
   * original selected text. The label shows the chosen translation word and
   * has a small × to remove it.
   */
  _createPersistentAnnotation(word, selectionRect) {
    const win = Zotero.getMainWindow();
    if (!win || !win.document) {
      Zotero.debug("[LLM Assistant] _createPersistentAnnotation: main window not available");
      return;
    }
    const doc = win.document;

    // Inject shared stylesheet once
    if (!doc.getElementById("zotero-llm-tooltip-css")) {
      const styleEl = doc.createElement("style");
      styleEl.id = "zotero-llm-tooltip-css";
      styleEl.textContent = this._getTooltipCSS();
      (doc.head || doc.documentElement).appendChild(styleEl);
    }

    // Find the PDF viewer container
    let pdfContainer = doc.getElementById("reader-ui");
    if (!pdfContainer) pdfContainer = doc.getElementById("zotero-pane");
    if (!pdfContainer) pdfContainer = doc.body;

    const label = doc.createElement("div");
    label.className = "zotero-llm-persistent-annotation";
    label.setAttribute("data-word", word);
    label.innerHTML = `<span style="margin-right: 6px;">${this._escapeHtml(word)}</span><span class="zotero-llm-annotation-close-x" style="cursor: pointer; color: #b45309; font-weight: bold;" title="移除标注">×</span>`;

    // Position the label above the original selected word
    if (selectionRect && selectionRect.left !== undefined) {
      const labelWidth = Math.min(200, (word.length || 2) * 14 + 30);
      let x = selectionRect.left + selectionRect.width / 2 - labelWidth / 2;
      let y = selectionRect.top - 28;
      if (y < 10) y = selectionRect.bottom + 4;
      if (x < 10) x = 10;
      if (x + labelWidth > doc.defaultView.innerWidth - 10) {
        x = doc.defaultView.innerWidth - labelWidth - 10;
      }
      label.style.left = x + "px";
      label.style.top = y + "px";
    } else {
      // Fallback: place near the center of the reader
      const reader = doc.querySelector("#reader-ui .reader");
      if (reader) {
        const rect = reader.getBoundingClientRect();
        label.style.left = rect.left + rect.width / 2 - 60 + "px";
        label.style.top = rect.top + 60 + "px";
      } else {
        label.style.left = "200px";
        label.style.top = "200px";
      }
    }

    // Bind close button
    const closeX = label.querySelector(".zotero-llm-annotation-close-x");
    if (closeX) {
      closeX.addEventListener("click", (e) => {
        e.stopPropagation();
        if (label.parentNode) label.parentNode.removeChild(label);
      });
    }

    pdfContainer.appendChild(label);
  },

  /**
   * Remove all persistent annotation labels currently displayed.
   */
  removeAllPersistentAnnotations() {
    try {
      const win = Zotero.getMainWindow();
      if (!win || !win.document) return;
      const doc = win.document;
      if (typeof doc.querySelectorAll !== "function") return;
      const labels = doc.querySelectorAll(".zotero-llm-persistent-annotation");
      labels.forEach((el) => {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
    } catch (e) {
      Zotero.debug(`[LLM Assistant] removeAllPersistentAnnotations failed: ${e.message}`);
    }
  },

  /**
   * Remove the existing annotation tooltip
   */
  _removeExistingAnnotation() {
    if (this._annotationTimeout) {
      clearTimeout(this._annotationTimeout);
      this._annotationTimeout = null;
    }
    if (this._annotationTooltip && this._annotationTooltip.parentNode) {
      this._annotationTooltip.parentNode.removeChild(this._annotationTooltip);
      this._annotationTooltip = null;
    }
  },

  /**
   * Save annotation data as a note on the selected item
   */
  async _saveAnnotationToNote(data) {
    try {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      if (!items || items.length === 0) {
        this._showNotification("请先选择一个文献条目。");
        return;
      }

      const item = items[0];
      const note = new Zotero.Item("note");
      note.libraryID = item.libraryID;
      note.parentKey = item.key;

      const type = data.type || (data.word ? "word" : "word");
      const typeLabel = type === "phrase" ? "短语标注" : "单词标注";
      const original = data.original || data.word || "";

      const examplesHtml = (data.examples || [])
        .map((ex) => `<li>${this._escapeHtml(ex)}</li>`)
        .join("");

      const reasoningHtml = data.reasoning
        ? `<p><strong>语境分析：</strong>${this._escapeHtml(data.reasoning)}</p>`
        : "";

      // Optional second engine: traditional translation
      const traditionalHtml = (data.traditional && data.traditional.text)
        ? `<p><strong>传统翻译（${this._escapeHtml(this.sourceDisplayName(data.traditional.source))}）：</strong>${this._escapeHtml(data.traditional.text)}</p>`
        : "";

      note.setNote(
        `<h3>${typeLabel}: ${this._escapeHtml(original)}</h3>` +
        `<p><strong>类型：</strong>${type === "phrase" ? "短语" : "单词"}</p>` +
        (data.phonetic
          ? `<p><strong>音标：</strong>${this._escapeHtml(data.phonetic)}</p>`
          : "") +
        (data.partOfSpeech
          ? `<p><strong>词性：</strong>${this._escapeHtml(data.partOfSpeech)}</p>`
          : "") +
        `<p><strong>释义：</strong>${this._escapeHtml(data.translation || "")}</p>` +
        traditionalHtml +
        reasoningHtml +
        (examplesHtml ? `<p><strong>例句：</strong></p><ul>${examplesHtml}</ul>` : "")
      );
      await note.saveTx();
      this._showNotification("已保存到笔记！");
    } catch (e) {
      Zotero.debug(`[LLM Assistant] Save annotation note failed: ${e.message}`);
      this._showNotification("保存笔记失败。");
    }
  },

  /**
   * Clean up UI elements
   */
  destroy() {
    this._removeExistingAnnotation();
    this.removeAllPersistentAnnotations();
    if (this._panel) {
      this._panel.hidePopup();
      if (this._panel.parentNode) {
        this._panel.parentNode.removeChild(this._panel);
      }
      this._panel = null;
    }
  },
};
