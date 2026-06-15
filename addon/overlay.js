/* global Zotero, Services, Components */
/**
 * Main Overlay - Core plugin logic connecting UI, LLM client, and prompt builder.
 *
 * Architecture:
 *   - Traditional translation shows FIRST (faster), then LLM adds analysis
 *   - Each translated word is a clickable block — double-click pins annotation on PDF
 *   - Debounced auto-translation (prevents duplicate requests)
 *   - Non-greedy JSON extraction in _parseLlmResponse
 */

Zotero.LLMAssistant = Zotero.LLMAssistant || {};

(function () {
  const client  = () => Zotero.LLMAssistant.LLMClient;
  const prompts = () => Zotero.LLMAssistant.PromptBuilder;
  const ui      = () => Zotero.LLMAssistant.UIManager;

  const _autoSummarizedItems = new Set();

  let _translateRequestID = 0;
  let _translateDebounceTimer = null;

  // Popup context for progressive update
  let _popupIndicator = null;
  let _popupDoc = null;

  // Saved selection context for creating native Zotero annotations
  let _lastSelectionAnnotation = null;  // params.annotation from renderTextSelectionPopup
  let _lastReader = null;              // reader instance for getting attachment
  let _lastContext = { sentence: "", surrounding: "" };  // captured immediately on selection
  let _contextPromise = null;          // tracks async context fetch to avoid race condition

  // ── Helpers ──────────────────────────────────────────────────────────

  function getItemData(item) {
    return {
      title: item.getField("title") || "",
      abstractNote: item.getField("abstractNote") || "",
      date: item.getField("date") || "",
      publicationTitle: item.getField("publicationTitle") || "",
      creators: item.getCreators().map((c) =>
        [c.firstName, c.lastName].filter(Boolean).join(" ")
      ),
      tags: item.getTags().map((t) =>
        typeof t === "string" ? t : t.tag || t.name || ""
      ),
      fullText: "",
    };
  }

  async function getFullText(item) {
    const attachments = item.getAttachments();
    for (const attID of attachments) {
      const att = Zotero.Items.get(attID);
      if (!att || !att.isPDFAttachment()) continue;
      if (typeof att.getFullText === "function") {
        try {
          const text = await att.getFullText();
          if (text) return typeof text === "string" ? text : (text.content || "");
        } catch (e) { /* continue */ }
      }
      if (Zotero.Fulltext && typeof Zotero.Fulltext.getFulltextItem === "function") {
        try {
          await Zotero.Fulltext.getFulltextItem(att);
          const text = att.attachmentFullText || "";
          if (text) return text;
        } catch (e) { /* continue */ }
      }
      if (Zotero.PDFWorker && typeof Zotero.PDFWorker.getFullText === "function") {
        try {
          const text = await Zotero.PDFWorker.getFullText(attID, true);
          if (text) return text;
        } catch (e) { /* continue */ }
      }
    }
    return "";
  }

  function getSelectedItem() {
    const items = Zotero.getActiveZoteroPane().getSelectedItems();
    if (!items || items.length === 0) {
      ui().showError("未选择文献条目。请先在文献库中选择一篇论文。");
      return null;
    }
    return items[0];
  }

  async function runTask(taskName, promptFn) {
    const item = getSelectedItem();
    if (!item) return;
    ui().showLoading(`${taskName} - 处理中...`);
    try {
      if (!client()) throw new Error("LLMClient 未加载");
      if (!prompts()) throw new Error("PromptBuilder 未加载");
      const itemData = getItemData(item);
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

  // ── Public API ──────────────────────────────────────────────────────

  Zotero.LLMAssistant.summarizeSelected = async function () {
    await runTask("Summarize", (d) => prompts().buildSummarizePrompt(d));
  };

  Zotero.LLMAssistant.translateSelected = async function () {
    const item = getSelectedItem();
    if (!item) return;
    const abstract = item.getField("abstractNote");
    if (!abstract) { ui().showError("该条目没有摘要。"); return; }
    ui().showLoading("翻译摘要中...");
    try {
      const prompt = prompts().buildTranslatePrompt(abstract);
      const result = await client().chat([{ role: "user", content: prompt }]);
      ui().showResult(result);
    } catch (error) { ui().showError(error.message); }
  };

  Zotero.LLMAssistant.askAboutSelected = async function (question) {
    if (!question) {
      const input = { value: "" };
      const result = Services.prompt.prompt(null, "LLM Assistant - 提问", "请输入您的问题:", input, null, {});
      if (!result || !input.value.trim()) return;
      question = input.value.trim();
    }
    await runTask("Ask", (d) => prompts().buildAskPrompt(d, question));
  };

  Zotero.LLMAssistant.extractKeywords = async function () {
    await runTask("Extract Keywords", (d) => prompts().buildExtractKeywordsPrompt(d));
  };

  Zotero.LLMAssistant.generateTags = async function () {
    const item = getSelectedItem();
    if (!item) return;
    ui().showLoading("生成标签中...");
    try {
      const itemData = getItemData(item);
      const prompt = prompts().buildGenerateTagsPrompt(itemData);
      const result = await client().chat([{ role: "user", content: prompt }]);
      const tags = result.split(/[,\n]/).map((t) => t.trim().replace(/^[-*•\d.)\]]+\s*/, "")).filter((t) => t.length > 0 && t.length < 50);
      const apply = Services.prompt.confirm(null, "应用标签？", `生成的标签:\n${tags.join("\n")}\n\n是否应用到该条目？`);
      if (apply) { for (const tag of tags) item.addTag(tag); await item.saveTx(); ui().showResult(`标签已应用: ${tags.join(", ")}`); }
      else { ui().showResult(`生成的标签: ${tags.join(", ")}`); }
    } catch (error) { ui().showError(error.message); }
  };

  Zotero.LLMAssistant.explainSelection = async function () {
    const selectedText = _getReaderSelection();
    if (!selectedText) { ui().showError("未选中 PDF 中的文本。"); return; }
    ui().showLoading("解释选中内容...");
    try {
      const result = await client().chat([{ role: "user", content: prompts().buildExplainPrompt(selectedText) }]);
      ui().showResult(result);
    } catch (error) { ui().showError(error.message); }
  };

  Zotero.LLMAssistant.translateSelection = async function () {
    const selectedText = _getReaderSelection();
    if (!selectedText) { ui().showError("未在 PDF 阅读器中选中文本。"); return; }
    ui().showLoading("翻译中...");
    try {
      const result = await client().chat([{ role: "user", content: prompts().buildTranslateSelectionPrompt(selectedText) }]);
      ui().showResult(result);
    } catch (error) { ui().showError(error.message); }
  };

  // ── Core: translate + annotate (progressive: traditional first, LLM second) ──

  Zotero.LLMAssistant.translateAndAnnotate = async function () {
    try {
      const { text: selectedText, rect: selectionRect } = _getReaderSelectionWithRect();
      if (!selectedText) { ui().showError("未在 PDF 阅读器中选中文本。"); return; }
      const trimmed = selectedText.trim();
      if (!trimmed) { ui().showError("选中的内容为空。"); return; }

      const requestID = ++_translateRequestID;
      ui().showLoading("正在翻译...");

      // ── Traditional translation: show IMMEDIATELY when ready ──
      let tradData = null;
      const tradPromise = (async () => {
        if (typeof TraditionalClient === "undefined" || !TraditionalClient.translate) {
          return { source: "none", text: null, error: "TraditionalClient 未加载" };
        }
        return TraditionalClient.translate(trimmed);
      })();

      tradPromise.then((result) => {
        if (requestID !== _translateRequestID) return;
        tradData = result;
        Zotero.debug(`[LLM Assistant] Traditional ready: source=${result?.source}, text=${!!result?.text}`);
        // Show traditional translation immediately with clickable words
        _renderPopup(trimmed, null, tradData, selectionRect);
      }).catch((e) => {
        Zotero.debug(`[LLM Assistant] Traditional error: ${e.message}`);
      });

      // ── Dictionary API: fetch phonetic + POS for single English words (parallel) ──
      let dictData = { phonetic: "", partOfSpeech: "", definitions: "" };
      const isSingleWord = !trimmed.includes(" ") && /^[a-zA-Z'-]+$/.test(trimmed);
      const dictPromise = isSingleWord ? _fetchDictData(trimmed) : Promise.resolve(dictData);

      // ── LLM translation: adds analysis on top ──
      let llmData = null;
      try {
        // Wait for async context (getFullText) to complete before building prompt
        if (_contextPromise) {
          Zotero.debug("[LLM Assistant] Waiting for async context...");
          try { await _contextPromise; } catch { /* already handled */ }
          Zotero.debug(`[LLM Assistant] Async context completed: sentence="${(_lastContext.sentence||'').substring(0,60)}"`);
        }
        // Use context captured at selection time (selection may be gone by now)
        const { sentence, surrounding } = _lastContext;
        Zotero.debug(`[LLM Assistant] LLM prompt context: sentence="${(sentence||'').substring(0,60)}", surrounding=${!!surrounding}, surroundingLen=${(surrounding||'').length}`);
        const prompt = prompts().buildContextAwareTranslatePrompt({
          selected: trimmed, sentence: sentence || trimmed, surrounding, fullText: "",
        });
        Zotero.debug(`[LLM Assistant] LLM prompt built: len=${prompt.length}, hasSentence=${!!sentence}, hasSurrounding=${!!surrounding}`);
        const messages = [{ role: "user", content: prompt }];

        llmData = await Promise.race([
          (async () => {
            if (requestID !== _translateRequestID) return null;
            const raw = await client().chat(messages);
            if (requestID !== _translateRequestID) return null;
            return _parseLlmResponse(raw, trimmed);
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("LLM 请求超时 (20s)")), 20000)
          ),
        ]);
      } catch (e) {
        Zotero.debug(`[LLM Assistant] LLM error: ${e.message}`);
      }

      // Wait for dictionary data (fast, ~1-2s)
      try {
        dictData = await Promise.race([
          dictPromise,
          new Promise((resolve) => setTimeout(() => resolve({ phonetic: "", partOfSpeech: "", definitions: "" }), 3000)),
        ]);
      } catch { /* ignore */ }

      if (requestID !== _translateRequestID) return;

      // ── Final merged display ──
      if (!llmData && !tradData) {
        _renderPopup(trimmed, null, null, selectionRect, "翻译失败: LLM 和传统翻译均无结果");
        ui().showError("翻译失败");
        return;
      }

      // If no LLM, synthesize from traditional
      if (!llmData && tradData && tradData.text) {
        llmData = {
          type: trimmed.includes(" ") ? "phrase" : "word",
          original: trimmed, phonetic: "", partOfSpeech: "",
          translation: tradData.text, reasoning: "", examples: [],
        };
      }
      if (tradData && llmData) llmData.traditional = tradData;

      // Supplement phonetic/POS from dictionary API (more reliable than LLM)
      if (llmData && dictData) {
        if (!llmData.phonetic && dictData.phonetic) llmData.phonetic = dictData.phonetic;
        if (!llmData.partOfSpeech && dictData.partOfSpeech) llmData.partOfSpeech = dictData.partOfSpeech;
      }

      // Final render: merged result with all data
      _renderPopup(trimmed, llmData, tradData, selectionRect);
      ui().hideLoading();

    } catch (error) {
      Zotero.debug(`[LLM Assistant] translateAndAnnotate failed: ${error.message}`);
      _renderPopup("", null, null, null, error.message || "未知错误");
      ui().showError(`翻译失败: ${error.message || "未知错误"}`);
    }
  };

  /**
   * Auto-read and summarize a newly opened PDF.
   */
  Zotero.LLMAssistant.autoReadPDF = async function (reader) {
    if (!reader || !reader.itemID) return;
    const itemID = reader.itemID;
    if (_autoSummarizedItems.has(itemID)) return;
    _autoSummarizedItems.add(itemID);
    let apiKey;
    try { apiKey = Zotero.Prefs.get("extensions.zotero-llm-assistant.api-key", true); } catch { return; }
    if (!apiKey) return;
    Zotero.debug(`[LLM Assistant] Auto-reading PDF: itemID=${itemID}`);
    ui().showLoading("AI 正在阅读文献...");
    try {
      let item;
      try {
        const attItem = Zotero.Items.get(itemID);
        item = (attItem && attItem.parentItemID) ? Zotero.Items.get(attItem.parentItemID) : attItem;
      } catch { item = Zotero.Items.get(itemID); }
      if (!item) return;
      const itemData = getItemData(item);
      if (!itemData.abstractNote) return;
      const prompt = prompts().buildSummarizePrompt(itemData);
      const result = await client().chat([{ role: "user", content: prompt }]);
      ui().showResult(`AI 阅读摘要\n\n${result}`);
    } catch (error) {
      Zotero.debug(`[LLM Assistant] autoReadPDF failed: ${error.message}`);
      ui().showError(`自动阅读失败: ${error.message}`);
    }
  };

  /**
   * Called when text is selected in the PDF reader.
   */
  Zotero.LLMAssistant.onTextSelected = function (event) {
    const { doc, params, append, reader } = event;
    if (!doc) return;
    const selectedText = (params?.annotation?.text) || "";

    try {
      Zotero.LLMAssistant._lastSelection = { text: selectedText, ts: Date.now() };
    } catch (e) { /* ignore */ }

    // Save selection annotation data for creating native Zotero annotations
    _lastSelectionAnnotation = params?.annotation || null;
    _lastReader = reader || null;

    // Capture context: try PDFViewerApplication first (async), then DOM (sync)
    const ctxResult = _getSelectionContext(doc, selectedText, reader);
    _lastContext = { sentence: ctxResult.sentence, surrounding: ctxResult.surrounding };
    Zotero.debug(`[LLM Assistant] sync context: sentence="${_lastContext.sentence.substring(0, 80)}", surrounding=${!!_lastContext.surrounding}`);

    // Handle async context (PDFViewerApplication or getFullText)
    // Use requestID to prevent stale callbacks from overwriting newer context
    const contextRequestID = ++_translateRequestID;
    if (ctxResult.asyncPromise) {
      _contextPromise = ctxResult.asyncPromise.then(ctx => {
        if (contextRequestID !== _translateRequestID) return; // stale, discard
        if (ctx.sentence) {
          _lastContext = ctx;
          Zotero.debug(`[LLM Assistant] async context resolved: sentence="${ctx.sentence.substring(0, 80)}"`);
        }
      }).catch(e => {
        Zotero.debug(`[LLM Assistant] async context failed: ${e.message}`);
      });
    } else if (!_lastContext.sentence && reader && reader.itemID) {
      // Fallback: use Zotero's indexed full text
      _contextPromise = _fetchFullTextContext(reader.itemID, selectedText).then(ctx => {
        if (contextRequestID !== _translateRequestID) return; // stale, discard
        if (ctx.sentence) {
          _lastContext = ctx;
          Zotero.debug(`[LLM Assistant] FullText context: sentence="${ctx.sentence.substring(0, 80)}"`);
        }
      }).catch(e => {
        Zotero.debug(`[LLM Assistant] FullText context failed: ${e.message}`);
      });
    } else {
      _contextPromise = null;
    }

    if (!selectedText.trim()) return;

    _popupIndicator = null;
    _popupDoc = null;

    if (append) {
      try {
        const indicator = doc.createElement("div");
        indicator.className = "llm-assistant-loading";
        indicator.textContent = "正在翻译...";
        indicator.style.cssText = "padding: 6px 8px; font-size: 12px; color: #888; max-height: 260px; overflow-y: auto; word-wrap: break-word; overflow-wrap: break-word; max-width: 360px;";
        append(indicator);
        _popupIndicator = indicator;
        _popupDoc = doc;
      } catch (e) {
        Zotero.debug(`[LLM Assistant] append indicator failed: ${e.message}`);
      }
    }

    if (_translateDebounceTimer) clearTimeout(_translateDebounceTimer);
    _translateDebounceTimer = setTimeout(async () => {
      _translateDebounceTimer = null;
      try {
        if (Zotero.LLMAssistant?.translateAndAnnotate) {
          await Zotero.LLMAssistant.translateAndAnnotate();
        }
      } catch (e) {
        Zotero.logError(`[LLM Assistant] auto-translate failed: ${e.message}`);
      }
    }, 300);
  };

  // ── Private helpers ──────────────────────────────────────────────────

  function _parseLlmResponse(result, fallbackOriginal) {
    let data;
    try {
      data = JSON.parse(String(result).trim());
    } catch {
      try {
        const m = String(result).match(/\{[^]*?\}(?=\s*$|\s*[,;\n])/);
        if (m) data = JSON.parse(m[0]);
        else {
          const g = String(result).match(/\{[^]*\}/);
          if (g) data = JSON.parse(g[0]);
          else throw new Error("no JSON");
        }
      } catch {
        data = {
          type: fallbackOriginal.includes(" ") ? "phrase" : "word",
          original: fallbackOriginal, phonetic: "", partOfSpeech: "",
          translation: String(result).trim(), reasoning: "", examples: [],
        };
      }
    }
    data.type = data.type || (fallbackOriginal.includes(" ") ? "phrase" : "word");
    data.original = data.original || fallbackOriginal;
    data.phonetic = data.phonetic || "";
    data.partOfSpeech = data.partOfSpeech || "";
    data.translation = data.translation || "";
    data.reasoning = data.reasoning || "";
    data.examples = data.examples || [];
    return data;
  }

  // ── Popup renderer: merged display with clickable word blocks ────────

  /**
   * Render the translation result into the reader popup.
   * Called progressively:
   *   1st call: traditional only (llmData=null)
   *   2nd call: merged (both available)
   *
   * Each translated word is a clickable block. Double-click pins annotation.
   */
  function _renderPopup(original, llmData, tradData, selectionRect, errorMsg) {
    let indicator = _popupIndicator;
    const doc = _popupDoc;

    if (!indicator || !indicator.parentNode) {
      if (doc) {
        try { indicator = doc.querySelector(".llm-assistant-loading"); } catch { /* */ }
      }
    }
    if (!indicator || !indicator.parentNode) return;

    const ownerDoc = indicator.ownerDocument;

    // ── Error ──
    if (errorMsg) {
      indicator.innerHTML = "";
      indicator.style.cssText = "padding: 6px 8px; font-size: 12px; color: #c44;";
      indicator.textContent = errorMsg;
      return;
    }

    // ── No data at all ──
    if (!llmData && !tradData) {
      indicator.textContent = "无翻译结果";
      indicator.style.color = "#c44";
      return;
    }

    // ── Build merged content ──
    indicator.innerHTML = "";
    indicator.style.cssText = "padding: 4px 0; font-size: 12px; line-height: 1.6; max-height: 260px; overflow-y: auto; word-wrap: break-word; overflow-wrap: break-word; max-width: 360px;";

    const type = (llmData && llmData.type) || (original.includes(" ") ? "phrase" : "word");
    const tagColor = type === "phrase" ? "#7c3aed" : "#2563eb";
    const tagLabel = type === "phrase" ? "短语" : "单词";
    const phonetic = (llmData && llmData.phonetic) || "";
    const pos = (llmData && llmData.partOfSpeech) || "";

    // 1) Header: tag + original + phonetic + POS
    const header = ownerDoc.createElement("div");
    header.style.cssText = "margin-bottom: 4px; font-weight: bold; font-size: 14px; word-wrap: break-word; overflow-wrap: break-word;";
    header.innerHTML =
      `<span style="display:inline-block;background:${tagColor};color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;margin-right:5px;vertical-align:middle;">${tagLabel}</span>` +
      _escHtml(original) +
      (phonetic ? ` <span style="color:#666;font-weight:normal;font-size:12px;">[${_escHtml(phonetic)}]</span>` : "") +
      (pos ? ` <span style="color:${tagColor};font-size:11px;font-weight:normal;">${_escHtml(pos)}</span>` : "");
    indicator.appendChild(header);

    // 1b) Audio pronunciation buttons — only for single English words
    if (/^[a-zA-Z\s'-]+$/.test(original) && !original.includes(" ")) {
      const audioBox = ownerDoc.createElement("div");
      audioBox.style.cssText = "display:flex;gap:6px;margin-bottom:6px;";

      const safeWord = encodeURIComponent(original);
      const audioEntries = [
        { label: "英", url: `https://dict.youdao.com/dictvoice?audio=${safeWord}&type=1` },
        { label: "美", url: `https://dict.youdao.com/dictvoice?audio=${safeWord}&type=2` },
      ];

      for (const entry of audioEntries) {
        const btn = ownerDoc.createElement("button");
        btn.textContent = `🔊 ${entry.label}`;
        btn.style.cssText = "cursor:pointer;border:1px solid #d1d5db;border-radius:4px;padding:2px 8px;font-size:11px;background:#f9fafb;color:#374151;flex:1;";
        btn.title = `${entry.label}式发音`;
        const audioUrl = entry.url;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          try {
            const win = Zotero.getMainWindow();
            const audio = new (win.Audio || win.HTMLAudioElement)(audioUrl);
            audio.play().catch(() => {});
          } catch {
            // Fallback: use XMLHttpRequest to play
            try {
              const audio = new Audio(audioUrl);
              audio.play().catch(() => {});
            } catch { /* audio not available */ }
          }
        });
        // Stop propagation to prevent popup dismissal
        btn.addEventListener("pointerup", (e) => e.stopPropagation());
        btn.addEventListener("mousedown", (e) => e.stopPropagation());
        audioBox.appendChild(btn);
      }
      indicator.appendChild(audioBox);
    }

    // 2) Traditional translation — shown FIRST (arrives faster), with word blocks split by semicolons
    if (tradData && tradData.text) {
      const srcLabel = _sourceLabel(tradData.source);
      const tradLabel = ownerDoc.createElement("div");
      tradLabel.style.cssText = "font-size:10px;color:#047857;margin-bottom:2px;";
      tradLabel.textContent = `传统翻译（${srcLabel}）— 双击词块可标注：`;
      indicator.appendChild(tradLabel);

      const tradWords = ownerDoc.createElement("div");
      tradWords.style.cssText = "margin-bottom: 6px; line-height: 2.0;";
      tradWords.innerHTML = _wrapAsSemicolonBlocks(tradData.text);
      indicator.appendChild(tradWords);
    } else if (tradData && tradData.error) {
      const errDiv = ownerDoc.createElement("div");
      errDiv.style.cssText = "color:#999;font-size:10px;margin-bottom:4px;";
      errDiv.textContent = `传统翻译: ${tradData.error}`;
      indicator.appendChild(errDiv);
    }

    // 3) LLM translation — shown SECOND, also split by semicolons like traditional
    if (llmData && llmData.translation) {
      const llmLabel = ownerDoc.createElement("div");
      llmLabel.style.cssText = "font-size:10px;color:#92400e;margin-bottom:2px;border-top:1px solid #fde68a;padding-top:4px;";
      llmLabel.textContent = "AI 翻译（双击词块可标注到 PDF）：";
      indicator.appendChild(llmLabel);

      const wordsDiv = ownerDoc.createElement("div");
      wordsDiv.style.cssText = "margin-bottom: 6px; line-height: 2.0;";
      wordsDiv.innerHTML = _wrapAsSemicolonBlocks(llmData.translation);
      indicator.appendChild(wordsDiv);
    }

    // 4) LLM reasoning
    if (llmData && llmData.reasoning) {
      const rDiv = ownerDoc.createElement("div");
      rDiv.style.cssText = "color:#1e40af;font-size:11px;margin-bottom:4px;padding:3px 6px;border-left:2px solid #3b82f6;background:#f0f7ff;border-radius:2px;";
      rDiv.innerHTML = `<strong>语境分析：</strong>${_escHtml(llmData.reasoning)}`;
      indicator.appendChild(rDiv);
    }

    // 5) LLM still loading hint
    if (!llmData && tradData) {
      const hint = ownerDoc.createElement("div");
      hint.style.cssText = "color:#999;font-size:10px;margin-top:3px;font-style:italic;";
      hint.textContent = "AI 分析加载中...";
      indicator.appendChild(hint);
    }

    // 7) Event delegation for word block clicks — bind ONCE on indicator
    //    CRITICAL: The popup lives inside the PDF reader iframe.
    //    Zotero's selection popup dismisses on pointerup/mousedown, so we
    //    must stopPropagation on those events to keep the popup alive when
    //    clicking/double-clicking word blocks. (Same technique as zotero-pdf-translate.)
    if (!indicator._llmWordClickBound) {
      indicator._llmWordClickBound = true;

      // Prevent Zotero popup from dismissing when interacting with word blocks
      indicator.addEventListener("pointerup", (e) => {
        if (e.target.closest(".llm-word-block")) e.stopPropagation();
      });
      indicator.addEventListener("mousedown", (e) => {
        if (e.target.closest(".llm-word-block")) e.stopPropagation();
      });
      indicator.addEventListener("dragstart", (e) => {
        if (e.target.closest(".llm-word-block")) e.stopPropagation();
      });

      // dblclick → pin annotation on PDF
      indicator.addEventListener("dblclick", (e) => {
        const block = e.target.closest(".llm-word-block");
        if (!block) return;
        e.stopPropagation();
        e.preventDefault();
        const word = block.getAttribute("data-word") || block.textContent.trim();
        Zotero.debug(`[LLM Assistant] Word block dblclick: "${word}"`);
        _pinAnnotationOnPDF(word);
      });

      // Single click → visual highlight feedback
      indicator.addEventListener("click", (e) => {
        const block = e.target.closest(".llm-word-block");
        if (!block) return;
        e.stopPropagation();
        block.style.background = "#fde68a";
        block.style.borderColor = "#f59e0b";
        setTimeout(() => {
          block.style.background = "#fef3c7";
          block.style.borderColor = "#fde68a";
        }, 800);
      });
    }

    const wordCount = indicator.querySelectorAll(".llm-word-block").length;
    Zotero.debug(`[LLM Assistant] Popup rendered: type=${type}, words=${wordCount}, hasLLM=${!!llmData}, hasTrad=${!!tradData}`);
  }

  /**
   * Wrap translation text as clickable word/character blocks.
   * Chinese: each character is a block. English: each whitespace-delimited word.
   * Used for LLM translation.
   */
  function _wrapAsClickableBlocks(text) {
    if (!text) return "";
    const hasCJK = /[\u4e00-\u9fff]/.test(text);
    if (hasCJK) {
      return text
        .split(/([\u4e00-\u9fff]+)/)
        .map((seg) => {
          if (/^[\u4e00-\u9fff]+$/.test(seg)) {
            return seg.split("").map(ch => _wordBlock(ch)).join("");
          }
          return _wrapEnglishSegment(seg);
        })
        .join("");
    }
    return _wrapEnglishSegment(text);
  }

  /**
   * Wrap traditional translation as clickable blocks split by semicolons.
   * Each segment between ; or ； is ONE block. This matches how traditional
   * translation APIs (Baidu, Youdao, etc.) return multiple meanings separated
   * by semicolons.
   * Example: "名词；动词；形容词" → three clickable blocks
   */
  function _wrapAsSemicolonBlocks(text) {
    if (!text) return "";
    // Split by semicolons (both ; and ；) but keep the delimiter as trailing text
    const parts = text.split(/\s*[;；]\s*/);
    return parts
      .filter(s => s.trim())
      .map(part => _wordBlock(part.trim()))
      .join("");
  }

  function _wrapEnglishSegment(text) {
    return text
      .split(/(\s+|[,.;:!?，。；：！？、])/)
      .filter(s => s && !/^\s+$/.test(s))
      .map(tok => {
        if (/^[,.;:!?，。；：！？、]$/.test(tok)) return _escHtml(tok);
        return _wordBlock(tok);
      })
      .join("");
  }

  function _wordBlock(token) {
    const safe = _escHtml(token);
    return `<span class="llm-word-block" data-word="${safe}" ` +
      `style="display:inline-block;cursor:pointer;padding:1px 4px;margin:1px;border-radius:3px;` +
      `background:#fef3c7;border:1px solid #fde68a;font-size:13px;color:#92400e;` +
      `transition:background 0.12s;" ` +
      `title="双击标注到 PDF">${safe}</span>`;
  }

  /**
   * Create a native Zotero "text" annotation (sticky note) on the PDF.
   * Uses Zotero.Annotations.saveFromJSON() with position data from the
   * original text selection captured in renderTextSelectionPopup.
   */
  async function _pinAnnotationOnPDF(word) {
    Zotero.debug(`[LLM Assistant] _pinAnnotationOnPDF called: word="${word}"`);

    try {
      // ── Get the attachment item from the reader ──
      let attachment = null;

      // Method 1: From saved reader instance
      if (_lastReader) {
        try {
          if (_lastReader._item) {
            attachment = _lastReader._item;
          } else if (_lastReader.itemID) {
            attachment = Zotero.Items.get(_lastReader.itemID);
          }
        } catch (e) {
          Zotero.debug(`[LLM Assistant] pin: reader._item failed: ${e.message}`);
        }
      }

      // Method 2: From active reader tab
      if (!attachment) {
        try {
          const win = Zotero.getMainWindow();
          const tabsAPI = win.Zotero_Tabs;
          const reader = tabsAPI && Zotero.Reader?.getByTabID
            ? Zotero.Reader.getByTabID(tabsAPI.selectedID) : null;
          if (reader) {
            attachment = reader._item || (reader.itemID ? Zotero.Items.get(reader.itemID) : null);
          }
        } catch (e) {
          Zotero.debug(`[LLM Assistant] pin: active reader failed: ${e.message}`);
        }
      }

      if (!attachment) {
        Zotero.debug("[LLM Assistant] pin: no attachment item found!");
        _showToast("无法获取 PDF 附件，标注失败");
        return;
      }

      Zotero.debug(`[LLM Assistant] pin: attachment key=${attachment.key}, id=${attachment.id}`);

      // ── Build position from saved selection annotation ──
      // Use "highlight" type: highlights the selected text on the PDF,
      // with the translation word in the annotation comment.
      // This is visible directly on the PDF (highlighted text) and in
      // the sidebar / on hover (comment with translation).
      let position = null;
      let selectedText = "";

      if (_lastSelectionAnnotation && _lastSelectionAnnotation.position) {
        // Use the original selection position directly (same rects as the text)
        position = Object.assign({}, _lastSelectionAnnotation.position);
        selectedText = _lastSelectionAnnotation.text || "";
        Zotero.debug(`[LLM Assistant] pin: using selection position, pageIndex=${position.pageIndex}, rects=${(position.rects||[]).length}`);
      }

      if (!position) {
        // Fallback: try to get position from iframe selection
        try {
          const win = Zotero.getMainWindow();
          const iframe = win.document.querySelector("#reader-ui iframe");
          if (iframe && iframe.contentDocument) {
            const sel = iframe.contentDocument.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              const pageDiv = range.startContainer?.parentNode?.closest?.(".page");
              const pageIndex = pageDiv ? parseInt(pageDiv.getAttribute("data-page-number") || "0") : 0;
              const rect = range.getBoundingClientRect();
              position = {
                pageIndex: pageIndex,
                rects: [[rect.left, rect.bottom, rect.right, rect.top]],
              };
              selectedText = sel.toString().trim();
            }
          }
        } catch (e) {
          Zotero.debug(`[LLM Assistant] pin: fallback position failed: ${e.message}`);
        }
      }

      if (!position) {
        Zotero.debug("[LLM Assistant] pin: no position available!");
        _showToast("无法获取选区位置，标注失败");
        return;
      }

      // ── Generate sort index (Zotero PDF format: DDDDD|DDDDDD|DDDDD) ──
      const pi = position.pageIndex || 0;
      const sortIndex = String(pi).padStart(5, "0").slice(0, 5)
        + "|" + String(Math.floor(Math.random() * 999999)).padStart(6, "0").slice(0, 6)
        + "|" + String(Math.floor(Math.random() * 99999)).padStart(5, "0").slice(0, 5);

      // ── Create native Zotero text annotation ──
      // Generate a unique key (Zotero uses 8-char alphanumeric keys)
      let annotationKey;
      try {
        annotationKey = Zotero.DataObjectUtilities.generateKey();
      } catch {
        // Fallback: generate random 8-char key
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        annotationKey = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      }

      const json = {
        key: annotationKey,
        type: "highlight",
        color: "#ffd400",
        sortIndex: sortIndex,
        position: position,
        text: selectedText,
        comment: word,
        pageLabel: _lastSelectionAnnotation?.pageLabel || "",
        tags: [],
      };

      Zotero.debug(`[LLM Assistant] pin: creating annotation: ${JSON.stringify({type:json.type,comment:json.comment,page:position.pageIndex})}`);

      const annotationItem = await Zotero.Annotations.saveFromJSON(attachment, json);
      Zotero.debug(`[LLM Assistant] pin: annotation created! itemID=${annotationItem?.id}, key=${annotationItem?.key}`);

      _showToast(`已标注: "${word}"`);

    } catch (e) {
      Zotero.logError(`[LLM Assistant] pinAnnotation failed: ${e.message}\n${e.stack}`);
      _showToast(`标注失败: ${e.message}`);
    }
  }

  /**
   * Fetch phonetic and part-of-speech from Free Dictionary API.
   * Like zotero-pdf-translate, uses api.dictionaryapi.dev for reliable
   * structured dictionary data (phonetic, POS, definitions).
   * @param {string} word - A single English word
   * @returns {Promise<{phonetic:string, partOfSpeech:string, definitions:string}>}
   */
  async function _fetchDictData(word) {
    const result = { phonetic: "", partOfSpeech: "", definitions: "" };
    if (!word || !/^[a-zA-Z'-]+$/.test(word) || word.includes(" ")) return result;
    try {
      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
      const raw = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.timeout = 6000;
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
          else reject(new Error(`HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error("network error"));
        xhr.ontimeout = () => reject(new Error("timeout"));
        xhr.send();
      });
      const data = JSON.parse(raw);
      if (!Array.isArray(data) || !data.length) return result;
      const entry = data[0];
      // Phonetic: prefer the entry-level phonetic, then look in phonetics array
      result.phonetic = entry.phonetic || "";
      if (!result.phonetic && entry.phonetics) {
        const withText = entry.phonetics.find(p => p && p.text);
        if (withText) result.phonetic = withText.text;
      }
      // Part of speech and definitions from meanings
      if (entry.meanings && entry.meanings.length) {
        const parts = [];
        const defs = [];
        for (const m of entry.meanings) {
          if (m.partOfSpeech) parts.push(m.partOfSpeech);
          if (m.definitions && m.definitions.length) {
            defs.push(m.definitions[0].definition || "");
          }
        }
        result.partOfSpeech = parts.join("/");
        result.definitions = defs.join("; ");
      }
      Zotero.debug(`[LLM Assistant] Dict: phonetic="${result.phonetic}", pos="${result.partOfSpeech}"`);
    } catch (e) {
      Zotero.debug(`[LLM Assistant] Dict fetch failed: ${e.message}`);
    }
    return result;
  }

  function _showToast(message) {
    try {
      const win = Zotero.getMainWindow();
      if (win && win.Zotero) {
        const pw = new win.Zotero.ProgressWindow();
        pw.changeHeadline("LLM Assistant");
        pw.addDescription(message);
        pw.show();
        pw.startCloseTimer(3000);
      }
    } catch { /* toast is optional */ }
  }

  function _sourceLabel(source) {
    const map = { baidu:"百度翻译", youdao:"有道翻译", azure:"微软翻译", google:"Google 翻译", mymemory:"MyMemory" };
    return map[source] || (source || "传统翻译");
  }

  function _escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function _getReaderSelectionWithRect() {
    try {
      const cached = Zotero.LLMAssistant?._lastSelection;
      if (cached?.text && Date.now() - cached.ts < 60000) {
        return { text: cached.text, rect: null, source: "cached" };
      }
    } catch { /* */ }
    try {
      const win = Zotero.getMainWindow();
      if (!win) return { text: "", rect: null };
      const tabsAPI = win.Zotero_Tabs;
      const reader = tabsAPI && Zotero.Reader?.getByTabID ? Zotero.Reader.getByTabID(tabsAPI.selectedID) : null;
      if (!reader || typeof reader.getSelectedText !== "function") return { text: "", rect: null };
      const text = reader.getSelectedText() || "";
      if (!text) return { text: "", rect: null };
      let rect = null;
      try {
        const iframe = win.document.querySelector("#reader-ui iframe");
        if (iframe?.contentDocument) {
          const sel = iframe.contentDocument.getSelection();
          if (sel?.rangeCount > 0) {
            const rr = sel.getRangeAt(0).getBoundingClientRect();
            const ir = iframe.getBoundingClientRect();
            rect = { left: ir.left+rr.left, top: ir.top+rr.top, right: ir.left+rr.right, bottom: ir.top+rr.bottom, width: rr.width, height: rr.height };
          }
        }
      } catch { /* */ }
      return { text, rect, source: "legacy" };
    } catch { /* */ }
    return { text: "", rect: null };
  }

  /**
   * Extract the sentence and surrounding context from the PDF text layer.
   * Tries multiple strategies in order of reliability:
   *   1. PDFViewerApplication.getTextContent() (most reliable, async)
   *   2. DOM .textLayer span elements (sync fallback)
   *   3. DOM innerText/textContent (last resort sync fallback)
   *
   * @param {Document} doc - The iframe contentDocument from the event.
   * @param {string} selectedText - The selected text from params.annotation.text.
   * @param {Object} [reader] - The ReaderInstance from the event (for PDFViewerApplication access).
   * @returns {{ sentence: string, surrounding: string, asyncPromise: Promise|null }}
   *          asyncPromise is set when PDFViewerApplication approach is attempted;
   *          the caller should await it before using sentence/surrounding.
   */
  function _getSelectionContext(doc, selectedText, reader) {
    let sentence = "", surrounding = "";
    let asyncPromise = null;

    try {
      if (!doc) {
        Zotero.debug("[LLM Assistant] context: no doc provided");
        return { sentence, surrounding, asyncPromise };
      }
      Zotero.debug(`[LLM Assistant] context: selectedText="${(selectedText||'').substring(0,60)}"`);

      const normalizedSelected = (selectedText || "").replace(/\s+/g, " ").trim();
      if (!normalizedSelected) {
        return { sentence, surrounding, asyncPromise };
      }

      // ── Strategy 1 (BEST): Use PDFViewerApplication.getTextContent() ──
      // This is the official PDF.js API, accessed via reader._iframeWindow
      // as documented in https://zotero-chinese.com/plugin-dev-guide/reference/more
      if (reader && reader._iframeWindow) {
        asyncPromise = _getContextViaPDFViewer(reader._iframeWindow, normalizedSelected);
        return { sentence, surrounding, asyncPromise };
      }

      // ── Strategy 2: DOM .textLayer span elements (sync) ──
      const domResult = _getContextViaDOM(doc, normalizedSelected);
      if (domResult.sentence) {
        return { sentence: domResult.sentence, surrounding: domResult.surrounding, asyncPromise: null };
      }

      // ── Strategy 3: Fallback to body text ──
      if (doc.body) {
        const bodyText = (doc.body.innerText || doc.body.textContent || "").replace(/\s+/g, " ").trim();
        if (bodyText.length > 10) {
          const ctx = _extractContextFromText(bodyText, normalizedSelected);
          if (ctx.sentence) {
            return { sentence: ctx.sentence, surrounding: ctx.surrounding, asyncPromise: null };
          }
        }
      }

      Zotero.debug("[LLM Assistant] context: all strategies failed");
    } catch (e) {
      Zotero.debug(`[LLM Assistant] context error: ${e.message}`);
    }
    return { sentence, surrounding, asyncPromise };
  }

  /**
   * Strategy 1: Extract context using PDFViewerApplication.getTextContent().
   * This is the most reliable method because it reads text directly from the PDF
   * data, bypassing DOM rendering issues (absolute-positioned spans, lazy loading, etc.)
   *
   * Reference: https://zotero-chinese.com/plugin-dev-guide/reference/more
   *   const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
   *   const PDFViewerApplication = reader._iframeWindow.wrappedJSObject.PDFViewerApplication;
   *   const pages = PDFViewerApplication.pdfViewer._pages;
   *   const items = (await pages[0].pdfPage.getTextContent()).items;
   *
   * @param {Window} iframeWindow - The reader's _iframeWindow
   * @param {string} normalizedSelected - The normalized selected text
   * @returns {Promise<{sentence:string, surrounding:string}>}
   */
  async function _getContextViaPDFViewer(iframeWindow, normalizedSelected) {
    const result = { sentence: "", surrounding: "" };
    try {
      // Access PDFViewerApplication via wrappedJSObject (Zotero convention)
      let PDFViewerApplication;
      try {
        PDFViewerApplication = iframeWindow.wrappedJSObject?.PDFViewerApplication
          || iframeWindow.PDFViewerApplication;
      } catch (e) {
        Zotero.debug(`[LLM Assistant] PDFViewer: access failed: ${e.message}`);
      }
      if (!PDFViewerApplication) {
        Zotero.debug("[LLM Assistant] PDFViewer: PDFViewerApplication not found");
        return result;
      }

      // Wait for PDF to finish loading (with timeout to prevent hanging)
      try {
        const loadPromises = [];
        if (PDFViewerApplication.pdfLoadingTask) {
          loadPromises.push(PDFViewerApplication.pdfLoadingTask.promise);
        }
        if (PDFViewerApplication.pdfViewer && PDFViewerApplication.pdfViewer.pagesPromise) {
          loadPromises.push(PDFViewerApplication.pdfViewer.pagesPromise);
        }
        if (loadPromises.length > 0) {
          await Promise.race([
            Promise.all(loadPromises),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
        }
      } catch (e) {
        Zotero.debug(`[LLM Assistant] PDFViewer: wait failed: ${e.message}`);
      }

      const pages = PDFViewerApplication.pdfViewer?._pages;
      if (!pages || !pages.length) {
        Zotero.debug("[LLM Assistant] PDFViewer: no pages available");
        return result;
      }

      // Get current page number (1-based in PDFViewer, 0-based in _pages)
      const currentPage = PDFViewerApplication.pdfViewer.currentPageNumber || 1;

      // Try current page first, then adjacent pages
      const pageIndices = [currentPage - 1]; // current page (0-based)
      if (currentPage > 1) pageIndices.push(currentPage - 2); // previous page
      if (currentPage < pages.length) pageIndices.push(currentPage); // next page

      for (const pi of pageIndices) {
        if (pi < 0 || pi >= pages.length) continue;
        const page = pages[pi];
        if (!page || !page.pdfPage) continue;

        try {
          const textContent = await page.pdfPage.getTextContent();
          if (!textContent || !textContent.items || !textContent.items.length) continue;

          // Merge text items into a continuous string, using transform coordinates
          // to detect line breaks (significant y-coordinate change = new line)
          const pageText = _mergeTextItems(textContent.items);
          Zotero.debug(`[LLM Assistant] PDFViewer: page ${pi + 1} text len=${pageText.length}`);

          const ctx = _extractContextFromText(pageText, normalizedSelected);
          if (ctx.sentence) {
            result.sentence = ctx.sentence;
            result.surrounding = ctx.surrounding;
            Zotero.debug(`[LLM Assistant] PDFViewer: found on page ${pi + 1}, sentence="${ctx.sentence.substring(0, 80)}"`);
            return result;
          }
        } catch (e) {
          Zotero.debug(`[LLM Assistant] PDFViewer: page ${pi + 1} getTextContent failed: ${e.message}`);
        }
      }

      Zotero.debug("[LLM Assistant] PDFViewer: selected text not found on any nearby page");
    } catch (e) {
      Zotero.debug(`[LLM Assistant] PDFViewer error: ${e.message}`);
    }
    return result;
  }

  /**
   * Merge PDF text items into a continuous string.
   * Uses transform coordinates to detect line breaks:
   *   - If y-coordinate changes significantly → insert newline
   *   - If x-coordinate jumps backward → insert newline
   *   - Otherwise → space between items
   *
   * This handles the common case where PDF.js splits a line into multiple
   * items with absolute positioning.
   *
   * @param {Array} items - Text items from getTextContent()
   * @returns {string} Merged text
   */
  function _mergeTextItems(items) {
    if (!items || !items.length) return "";
    const lines = [];
    let currentLine = "";
    let lastY = null;
    let lastXEnd = null;
    const LINE_HEIGHT_THRESHOLD = 3; // PDF points tolerance for same-line detection

    for (const item of items) {
      if (!item.str) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const width = item.width || 0;

      if (lastY !== null) {
        const yDiff = Math.abs(y - lastY);
        // Significant Y change = new line
        if (yDiff > LINE_HEIGHT_THRESHOLD) {
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentLine = "";
          lastXEnd = null;
        } else if (lastXEnd !== null && x < lastXEnd - 2) {
          // X went backward on same line = new column/paragraph
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentLine = "";
        } else {
          // Same line, add space
          currentLine += " ";
        }
      }

      currentLine += item.str;
      lastY = y;
      lastXEnd = x + width;
    }

    if (currentLine.trim()) lines.push(currentLine.trim());
    return lines.join("\n").replace(/\s+/g, " ").trim();
  }

  /**
   * Strategy 2: Extract context from DOM .textLayer span elements (sync).
   * This works when the textLayer has been rendered but PDFViewerApplication
   * is not accessible.
   */
  function _getContextViaDOM(doc, normalizedSelected) {
    const result = { sentence: "", surrounding: "" };
    try {
      const pages = doc.querySelectorAll(".page");
      if (!pages.length) return result;

      const lowerSelected = normalizedSelected.toLowerCase();
      for (const page of pages) {
        const layer = page.querySelector(".textLayer");
        if (!layer) continue;

        // Extract text from span elements (PDF.js uses absolute-positioned spans)
        const spans = layer.querySelectorAll("span");
        let pageText = "";
        if (spans.length > 0) {
          pageText = Array.from(spans).map(s => s.textContent).join(" ").replace(/\s+/g, " ").trim();
          Zotero.debug(`[LLM Assistant] DOM context: extracted from ${spans.length} spans (len=${pageText.length})`);
        }

        // Fallback to innerText/textContent
        if (!pageText) {
          pageText = (layer.innerText || layer.textContent || "").replace(/\s+/g, " ").trim();
        }

        if (pageText.toLowerCase().includes(lowerSelected)) {
          Zotero.debug(`[LLM Assistant] DOM context: found in page (len=${pageText.length})`);
          const ctx = _extractContextFromText(pageText, normalizedSelected);
          if (ctx.sentence) return ctx;
        }
      }
    } catch (e) {
      Zotero.debug(`[LLM Assistant] DOM context error: ${e.message}`);
    }
    return result;
  }

  /**
   * Extract sentence and surrounding context from a full text string.
   * Shared by all extraction strategies.
   *
   * @param {string} fullText - The full text to search in
   * @param {string} normalizedSelected - The normalized selected text to find
   * @returns {{sentence:string, surrounding:string}}
   */
  function _extractContextFromText(fullText, normalizedSelected) {
    const result = { sentence: "", surrounding: "" };
    if (!fullText || !normalizedSelected) return result;

    const normalizedFull = fullText.replace(/\s+/g, " ").trim();
    const lowerFull = normalizedFull.toLowerCase();
    const lowerSelected = normalizedSelected.toLowerCase();

    // Try exact match first
    let idx = lowerFull.indexOf(lowerSelected);

    if (idx < 0) {
      // Try first few words (handles whitespace mismatches)
      const words = normalizedSelected.split(/\s+/);
      const shortSearch = words.slice(0, Math.min(3, words.length)).join(" ");
      idx = lowerFull.indexOf(shortSearch.toLowerCase());
      Zotero.debug(`[LLM Assistant] extractContext: partial search "${shortSearch}" idx=${idx}`);

      if (idx >= 0) {
        const cs = Math.max(0, idx - 300);
        const ce = Math.min(normalizedFull.length, idx + 500);
        result.sentence = normalizedFull.substring(cs, ce);
        result.surrounding = result.sentence;
        return result;
      }

      // Last fallback: use beginning of text as context
      result.sentence = normalizedFull.substring(0, 1500);
      result.surrounding = result.sentence;
      return result;
    }

    // Extract the sentence containing the selection
    const SENTENCE_END = /[.!?。！？]\s/g;
    const before = normalizedFull.substring(0, idx);
    const after = normalizedFull.substring(idx + normalizedSelected.length);
    let sentenceStart = 0, m;
    const bRe = new RegExp(SENTENCE_END, "g");
    while ((m = bRe.exec(before)) !== null) sentenceStart = m.index + m[0].length;
    const aRe = new RegExp(SENTENCE_END, "g");
    const firstAfter = aRe.exec(after);
    let sentenceEnd = after.length;
    if (firstAfter) sentenceEnd = firstAfter.index + firstAfter[0].length;
    result.sentence = (before.substring(sentenceStart) + normalizedSelected + after.substring(0, sentenceEnd)).replace(/\s+/g, " ").trim();

    // Extract surrounding context (±300 chars around the selection)
    const cs = Math.max(0, idx - 300), ce = Math.min(normalizedFull.length, idx + normalizedSelected.length + 300);
    result.surrounding = normalizedFull.substring(cs, ce).replace(/\s+/g, " ").trim();

    Zotero.debug(`[LLM Assistant] extractContext: sentence="${result.sentence.substring(0, 120)}"`);
    return result;
  }

  /**
   * Async fallback: use Zotero's indexed full text (getFullText) to extract context.
   * This bypasses the DOM entirely and works even when .textLayer queries fail.
   * @param {number} itemID - The PDF attachment item ID
   * @param {string} selectedText - The selected text
   * @returns {Promise<{sentence:string, surrounding:string}>}
   */
  async function _fetchFullTextContext(itemID, selectedText) {
    const result = { sentence: "", surrounding: "" };
    if (!selectedText || !itemID) return result;
    try {
      const attItem = Zotero.Items.get(itemID);
      if (!attItem) return result;
      let fullText = "";
      if (typeof attItem.getFullText === "function") {
        const ft = await attItem.getFullText();
        fullText = typeof ft === "string" ? ft : (ft?.content || "");
      }
      if (!fullText && Zotero.PDFWorker && typeof Zotero.PDFWorker.getFullText === "function") {
        fullText = await Zotero.PDFWorker.getFullText(itemID, true) || "";
      }
      if (!fullText) {
        Zotero.debug("[LLM Assistant] FullText: no full text available");
        return result;
      }
      Zotero.debug(`[LLM Assistant] FullText: length=${fullText.length}`);
      const normalizedSelected = selectedText.replace(/\s+/g, " ").trim();
      const ctx = _extractContextFromText(fullText, normalizedSelected);
      if (ctx.sentence) {
        result.sentence = ctx.sentence;
        result.surrounding = ctx.surrounding;
      }
      Zotero.debug(`[LLM Assistant] FullText: sentence="${result.sentence.substring(0, 100)}"`);
    } catch (e) {
      Zotero.debug(`[LLM Assistant] FullText error: ${e.message}`);
    }
    return result;
  }

  function _getReaderSelection() { return _getReaderSelectionWithRect().text; }

  // ── Init / Destroy ──────────────────────────────────────────────────

  Zotero.LLMAssistant.init = function () {
    Zotero.debug("[LLM Assistant] Initializing...");
    try { ui().init(); Zotero.debug("[LLM Assistant] Initialized."); }
    catch (e) { Zotero.logError(`[LLM Assistant] Init failed: ${e.message}\n${e.stack}`); }
  };

  Zotero.LLMAssistant.destroy = function () {
    Zotero.debug("[LLM Assistant] Destroying...");
    _autoSummarizedItems.clear();
    _translateRequestID++;
    if (_translateDebounceTimer) { clearTimeout(_translateDebounceTimer); _translateDebounceTimer = null; }
    try { ui().destroy(); } catch (e) { /* */ }
    Zotero.debug("[LLM Assistant] Destroyed.");
  };
})();
