/* global Zotero */
/**
 * Main Overlay - Core plugin logic connecting UI, LLM client, and prompt builder
 * This is the main entry point for plugin functionality
 */

Zotero.LLMAssistant = Zotero.LLMAssistant || {};

(function () {
  const client = () => Zotero.LLMAssistant.LLMClient;
  const prompts = () => Zotero.LLMAssistant.PromptBuilder;
  const ui = () => Zotero.LLMAssistant.UIManager;

  /**
   * Get data from a Zotero item for LLM processing
   */
  function getItemData(item) {
    return {
      title: item.getField("title") || "",
      abstractNote: item.getField("abstractNote") || "",
      date: item.getField("date") || "",
      publicationTitle: item.getField("publicationTitle") || "",
      creators: item.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")),
      tags: item.getTags().map((t) => (typeof t === "string" ? t : t.tag || t.name || "")),
      fullText: "",
    };
  }

  /**
   * Try to get full text from an item's attachments
   */
  async function getFullText(item) {
    const attachments = item.getAttachments();
    for (const attID of attachments) {
      const att = Zotero.Items.get(attID);
      if (att && att.isPDFAttachment()) {
        try {
          const path = await att.getFilePathAsync();
          if (path) {
            // Use Zotero's built-in PDF text extraction
            const text = await Zotero.PDFWorker.getFullText(attID, true);
            if (text) return text;
          }
        } catch (e) {
          Zotero.debug(`[LLM Assistant] Could not extract text from attachment: ${e.message}`);
        }
      }
    }
    return "";
  }

  /**
   * Get the first selected item
   */
  function getSelectedItem() {
    const items = Zotero.getActiveZoteroPane().getSelectedItems();
    if (!items || items.length === 0) {
      ui().showError("No item selected. Please select a paper in your library.");
      return null;
    }
    return items[0];
  }

  /**
   * Run an LLM task with loading state and error handling
   */
  async function runTask(taskName, promptFn) {
    const item = getSelectedItem();
    if (!item) return;

    ui().showLoading(`${taskName} - Processing...`);

    try {
      const itemData = getItemData(item);
      // Try to get full text for tasks that benefit from it
      if (["Summarize", "Ask"].includes(taskName)) {
        itemData.fullText = await getFullText(item);
      }

      const prompt = promptFn(itemData);
      const messages = [{ role: "user", content: prompt }];
      const result = await client().chat(messages);
      ui().showResult(result);
    } catch (error) {
      ui().showError(error.message);
    }
  }

  // ---- Public API ----

  /**
   * Summarize the selected paper
   */
  Zotero.LLMAssistant.summarizeSelected = async function () {
    await runTask("Summarize", (itemData) => prompts().buildSummarizePrompt(itemData));
  };

  /**
   * Translate the abstract of the selected paper
   */
  Zotero.LLMAssistant.translateSelected = async function () {
    const item = getSelectedItem();
    if (!item) return;

    const abstract = item.getField("abstractNote");
    if (!abstract) {
      ui().showError("This item has no abstract to translate.");
      return;
    }

    ui().showLoading("Translating abstract...");

    try {
      const prompt = prompts().buildTranslatePrompt(abstract);
      const messages = [{ role: "user", content: prompt }];
      const result = await client().chat(messages);
      ui().showResult(result);
    } catch (error) {
      ui().showError(error.message);
    }
  };

  /**
   * Ask a question about the selected paper
   */
  Zotero.LLMAssistant.askAboutSelected = async function (question) {
    if (!question) {
      // Prompt user for question
      const prompts2 = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
        .getService(Components.interfaces.nsIPromptService);
      const input = { value: "" };
      const result = prompts2.prompt(
        null,
        "LLM Assistant - Ask about Paper",
        "Enter your question:",
        input,
        null,
        {}
      );
      if (!result || !input.value.trim()) return;
      question = input.value.trim();
    }

    await runTask("Ask", (itemData) => prompts().buildAskPrompt(itemData, question));
  };

  /**
   * Extract keywords from the selected paper
   */
  Zotero.LLMAssistant.extractKeywords = async function () {
    await runTask("Extract Keywords", (itemData) => prompts().buildExtractKeywordsPrompt(itemData));
  };

  /**
   * Generate tags for the selected paper and optionally apply them
   */
  Zotero.LLMAssistant.generateTags = async function () {
    const item = getSelectedItem();
    if (!item) return;

    ui().showLoading("Generating tags...");

    try {
      const itemData = getItemData(item);
      const prompt = prompts().buildGenerateTagsPrompt(itemData);
      const messages = [{ role: "user", content: prompt }];
      const result = await client().chat(messages);

      // Parse tags from the response
      const tags = result
        .split(/[,\n]/)
        .map((t) => t.trim().replace(/^[-*•\d.]+\s*/, ""))
        .filter((t) => t.length > 0 && t.length < 50);

      // Ask user if they want to apply the tags
      const promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
        .getService(Components.interfaces.nsIPromptService);
      const apply = promptService.confirm(
        null,
        "Apply Tags?",
        `Generated tags:\n${tags.join("\n")}\n\nApply these tags to the item?`
      );

      if (apply) {
        for (const tag of tags) {
          item.addTag(tag);
        }
        await item.saveTx();
        ui().showResult(`Tags applied:\n${tags.join(", ")}`);
      } else {
        ui().showResult(`Generated tags:\n${tags.join(", ")}`);
      }
    } catch (error) {
      ui().showError(error.message);
    }
  };

  /**
   * Explain selected text in the reader
   */
  Zotero.LLMAssistant.explainSelection = async function () {
    const selectedText = _getReaderSelection();
    if (!selectedText) {
      ui().showError("No text selected in the reader.");
      return;
    }

    ui().showLoading("Explaining selection...");

    try {
      const prompt = prompts().buildExplainPrompt(selectedText);
      const messages = [{ role: "user", content: prompt }];
      const result = await client().chat(messages);
      ui().showResult(result);
    } catch (error) {
      ui().showError(error.message);
    }
  };

  /**
   * Translate selected text in the reader
   */
  Zotero.LLMAssistant.translateSelection = async function () {
    const selectedText = _getReaderSelection();
    if (!selectedText) {
      ui().showError("未在 PDF 阅读器中选中文本。");
      return;
    }

    ui().showLoading("翻译中...");

    try {
      const prompt = prompts().buildTranslateSelectionPrompt(selectedText);
      const messages = [{ role: "user", content: prompt }];
      const result = await client().chat(messages);
      ui().showResult(result);
    } catch (error) {
      ui().showError(error.message);
    }
  };

  /**
   * Translate selected word/phrase and annotate it on the PDF.
   * Uses the full paper text to disambiguate the most appropriate meaning.
   */
  Zotero.LLMAssistant.translateAndAnnotate = async function () {
    const { text: selectedText, rect: selectionRect } = _getReaderSelectionWithRect();
    if (!selectedText) {
      ui().showError("未在 PDF 阅读器中选中文本。请先选中单词或短语。");
      return;
    }

    const trimmed = selectedText.trim();
    if (!trimmed) {
      ui().showError("选中的内容为空。");
      return;
    }

    ui().showLoading("正在分析上下文并翻译...");

    // Kick off both engines in parallel; let them race. Whichever finishes
    // first can render; the other fills in when ready. We use
    // Promise.allSettled so a traditional-API failure does NOT block the LLM
    // result, and vice versa.
    let llmPromise;
    let traditionalPromise;
    try {
      // 1) Build LLM request (needs context, may require full-text fetch).
      const { sentence, surrounding } = _getSelectionContext();
      const fullTextPromise = _getReaderFullText();
      const prompt = prompts().buildContextAwareTranslatePrompt({
        selected: trimmed,
        sentence: sentence || trimmed,
        surrounding,
        fullText: "", // filled in below; LLM call doesn't need to block on full text
      });
      const messages = [{ role: "user", content: prompt }];

      llmPromise = (async () => {
        // Await full text only for the LLM branch; we don't want a slow
        // full-text extraction to delay the traditional call.
        const fullText = await fullTextPromise;
        // Rebuild the prompt with the full text now that we have it.
        const fullPrompt = prompts().buildContextAwareTranslatePrompt({
          selected: trimmed,
          sentence: sentence || trimmed,
          surrounding,
          fullText,
        });
        const fullMessages = [{ role: "user", content: fullPrompt }];
        Zotero.debug(
          `[LLM Assistant] Context lengths: sentence=${sentence.length}, surrounding=${surrounding.length}, fullText=${fullText.length}`
        );
        const result = await client().chat(fullMessages);
        return _parseLlmResponse(result, trimmed);
      })();

      // 2) Traditional engine in parallel — independent, no context needed.
      if (typeof TraditionalClient !== "undefined" && TraditionalClient.translate) {
        traditionalPromise = TraditionalClient.translate(trimmed);
      } else {
        traditionalPromise = Promise.resolve({ source: "none", text: null, error: "TraditionalClient not loaded" });
      }
    } catch (error) {
      ui().showError(error.message);
      return;
    }

    // Render whichever finishes first; then update with the other.
    let annotationData = null;
    let traditionalData = null;
    const settled = await Promise.allSettled([llmPromise, traditionalPromise]);
    const llmResult = settled[0];
    const tradResult = settled[1];

    if (llmResult.status === "fulfilled" && llmResult.value) {
      annotationData = llmResult.value;
    }
    if (tradResult.status === "fulfilled" && tradResult.value) {
      traditionalData = tradResult.value;
    }

    if (!annotationData && !traditionalData) {
      const err = (llmResult.status === "rejected" && llmResult.reason) || "translation failed";
      ui().showError(`翻译失败: ${err.message || err}`);
      return;
    }
    if (!annotationData) {
      // Traditional-only fallback: synthesize a minimal annotationData.
      annotationData = {
        type: trimmed.includes(" ") ? "phrase" : "word",
        original: trimmed,
        phonetic: "",
        partOfSpeech: "",
        translation: (traditionalData && traditionalData.text) || "",
        reasoning: "",
        examples: [],
      };
    }
    if (traditionalData) annotationData.traditional = traditionalData;

    // 3) Show on PDF
    ui().showAnnotationOnPDF(annotationData, selectionRect);
  };

  /**
   * Parse the LLM's free-form response into a normalized annotation object.
   * Tries JSON extraction first, then a plain-text fallback.
   */
  function _parseLlmResponse(result, fallbackOriginal) {
    let annotationData;
    try {
      const jsonMatch = String(result).match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        annotationData = JSON.parse(jsonMatch[0]);
      } else {
        annotationData = JSON.parse(result);
      }
    } catch {
      annotationData = {
        type: fallbackOriginal.includes(" ") ? "phrase" : "word",
        original: fallbackOriginal,
        phonetic: "",
        partOfSpeech: "",
        translation: String(result).trim(),
        reasoning: "",
        examples: [],
      };
    }
    annotationData.type        = annotationData.type        || (fallbackOriginal.includes(" ") ? "phrase" : "word");
    annotationData.original    = annotationData.original    || fallbackOriginal;
    annotationData.phonetic    = annotationData.phonetic    || "";
    annotationData.partOfSpeech = annotationData.partOfSpeech || "";
    annotationData.translation = annotationData.translation || "";
    annotationData.reasoning   = annotationData.reasoning   || "";
    annotationData.examples    = annotationData.examples    || [];
    return annotationData;
  }

  /**
   * Get selected text and its bounding rect from the PDF reader
   * Returns { text, rect } where rect has { left, top, right, bottom, width, height }
   */
  function _getReaderSelectionWithRect() {
    try {
      const win = Zotero.getMainWindow();
      const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      if (!reader) return { text: "", rect: null };

      const text = reader.getSelectedText() || "";
      if (!text) return { text: "", rect: null };

      // Try to get selection coordinates from the PDF viewer iframe
      let rect = null;
      try {
        const iframe = win.document.querySelector("#reader-ui iframe");
        if (iframe && iframe.contentDocument) {
          const selection = iframe.contentDocument.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const rangeRect = range.getBoundingClientRect();
            // Convert iframe-relative to window-relative
            const iframeRect = iframe.getBoundingClientRect();
            rect = {
              left: iframeRect.left + rangeRect.left,
              top: iframeRect.top + rangeRect.top,
              right: iframeRect.left + rangeRect.right,
              bottom: iframeRect.top + rangeRect.bottom,
              width: rangeRect.width,
              height: rangeRect.height,
            };
          }
        }
      } catch (e) {
        Zotero.debug(`[LLM Assistant] Could not get selection rect: ${e.message}`);
      }

      return { text, rect };
    } catch (e) {
      Zotero.debug(`[LLM Assistant] Could not get reader selection: ${e.message}`);
    }
    return { text: "", rect: null };
  }

  /**
   * Get the sentence containing the current PDF selection, plus surrounding
   * sentences as additional context. Uses the text layer of the PDF reader.
   *
   * @returns {{ sentence: string, surrounding: string }}
   */
  function _getSelectionContext() {
    let sentence = "";
    let surrounding = "";

    try {
      const win = Zotero.getMainWindow();
      const iframe = win.document.querySelector("#reader-ui iframe");
      if (!iframe || !iframe.contentDocument) {
        return { sentence: "", surrounding: "" };
      }

      const doc = iframe.contentDocument;
      const selection = doc.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return { sentence: "", surrounding: "" };
      }

      const range = selection.getRangeAt(0);

      // Get the full visible text of the current page(s)
      // Try the text layer first; fall back to the full document text
      const textLayer = doc.querySelector(".textLayer") || doc.body;
      if (!textLayer) return { sentence: "", surrounding: "" };

      // Build a flat text representation and find the selection's position
      // by walking text nodes
      const fullText = textLayer.innerText || textLayer.textContent || "";
      const selectedText = selection.toString().trim();

      if (!fullText || !selectedText) {
        return { sentence: "", surrounding: "" };
      }

      // Find the start index of the selected text in the page text
      const idx = fullText.indexOf(selectedText);
      if (idx < 0) {
        // Fallback: use the entire page text as the sentence
        return { sentence: fullText.substring(0, 1000), surrounding: "" };
      }

      // Extract the sentence: find the nearest sentence boundaries
      // (periods, question/exclamation marks followed by space or newline)
      const SENTENCE_END = /[.!?。！？]\s/g;
      const before = fullText.substring(0, idx);
      const after = fullText.substring(idx + selectedText.length);

      // Last sentence end before the selection
      let sentenceStart = 0;
      let m;
      const beforeRegex = new RegExp(SENTENCE_END, "g");
      while ((m = beforeRegex.exec(before)) !== null) {
        sentenceStart = m.index + m[0].length;
      }

      // First sentence end after the selection
      const afterRegex = new RegExp(SENTENCE_END, "g");
      const firstAfter = afterRegex.exec(after);
      let sentenceEnd = after.length;
      if (firstAfter) {
        sentenceEnd = firstAfter.index + firstAfter[0].length;
      }

      sentence = (before.substring(sentenceStart) + selectedText + after.substring(0, sentenceEnd))
        .replace(/\s+/g, " ")
        .trim();

      // Surrounding context: ±500 chars around the selection in the page text
      const ctxStart = Math.max(0, idx - 500);
      const ctxEnd = Math.min(fullText.length, idx + selectedText.length + 500);
      surrounding = fullText.substring(ctxStart, ctxEnd).replace(/\s+/g, " ").trim();
    } catch (e) {
      Zotero.debug(`[LLM Assistant] Could not get selection context: ${e.message}`);
    }

    return { sentence, surrounding };
  }

  /**
   * Get the full text of the currently opened PDF in the reader.
   * Tries Zotero's PDF text index first, then falls back to the visible text layer.
   *
   * @returns {Promise<string>}
   */
  async function _getReaderFullText() {
    try {
      const win = Zotero.getMainWindow();
      const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      if (!reader) return "";

      // Try Zotero's indexed full text (fast, includes OCR for some PDFs)
      try {
        const itemID = reader.itemID;
        if (itemID) {
          const item = Zotero.Items.get(itemID);
          if (item) {
            const fullText = await Zotero.PDFWorker.getFullText(itemID, true);
            if (fullText) {
              Zotero.debug(`[LLM Assistant] Got full text via PDFWorker (${fullText.length} chars)`);
              return fullText;
            }
          }
        }
      } catch (e) {
        Zotero.debug(`[LLM Assistant] PDFWorker failed: ${e.message}`);
      }

      // Fallback: read all visible text from the iframe
      try {
        const iframe = win.document.querySelector("#reader-ui iframe");
        if (iframe && iframe.contentDocument) {
          const body = iframe.contentDocument.body;
          if (body) {
            const text = body.innerText || body.textContent || "";
            Zotero.debug(`[LLM Assistant] Got full text via iframe (${text.length} chars)`);
            return text;
          }
        }
      } catch (e) {
        Zotero.debug(`[LLM Assistant] Iframe text extraction failed: ${e.message}`);
      }
    } catch (e) {
      Zotero.debug(`[LLM Assistant] Could not get full text: ${e.message}`);
    }
    return "";
  }

  /**
   * Get selected text from the PDF reader (backward compat)
   */
  function _getReaderSelection() {
    return _getReaderSelectionWithRect().text;
  }

  /**
   * Preferences panel helper
   */
  Zotero.LLMAssistant.Prefs = {
    init() {
      // Bind preferences to the XUL elements
    },

    async testConnection() {
      const result = await client().testConnection();
      const doc = Zotero.getMainWindow().document;
      const resultLabel = doc.getElementById("test-result-label");
      const resultBox = doc.getElementById("test-result");
      if (resultLabel && resultBox) {
        resultLabel.setAttribute("value", result.message);
        resultLabel.setAttribute(
          "style",
          `color: ${result.success ? "green" : "red"};`
        );
        resultBox.setAttribute("style", "margin-top: 5px;");
      }
    },
  };

  /**
   * Initialize the plugin
   */
  Zotero.LLMAssistant.init = function () {
    Zotero.debug("[LLM Assistant] Initializing...");
    try {
      ui().init();
      Zotero.debug("[LLM Assistant] Initialized successfully.");
    } catch (e) {
      Zotero.logError(`[LLM Assistant] Init failed: ${e.message}\n${e.stack}`);
    }
  };

  /**
   * Clean up
   */
  Zotero.LLMAssistant.destroy = function () {
    Zotero.debug("[LLM Assistant] Destroying...");
    try {
      ui().destroy();
    } catch (e) {
      Zotero.logError(`[LLM Assistant] Destroy failed: ${e.message}`);
    }
    Zotero.debug("[LLM Assistant] Destroyed.");
  };

  // Don't auto-initialize here - bootstrap.js will call init() after main window is ready
})();
