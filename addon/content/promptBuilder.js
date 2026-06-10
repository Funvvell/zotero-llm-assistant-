/* global Zotero */
/**
 * Prompt Builder - Constructs prompts for various LLM tasks
 */

Zotero.LLMAssistant = Zotero.LLMAssistant || {};

Zotero.LLMAssistant.PromptBuilder = {
  /**
   * Get the output language from preferences
   */
  _getLanguage() {
    return Zotero.LLMAssistant.LLMClient.getConfig().language || "Chinese";
  },

  /**
   * Build a prompt for summarizing a paper
   */
  buildSummarizePrompt(itemData) {
    const lang = this._getLanguage();
    const parts = [];

    parts.push(
      `You are a research assistant. Please provide a comprehensive summary of the following academic paper in ${lang}.`
    );
    parts.push(
      `The summary should include: 1) Main research question/objective, 2) Methodology, 3) Key findings, 4) Significance/contribution.`
    );
    parts.push(`\n--- Paper Information ---`);
    if (itemData.title) parts.push(`Title: ${itemData.title}`);
    if (itemData.abstractNote) parts.push(`Abstract: ${itemData.abstractNote}`);
    if (itemData.creators && itemData.creators.length > 0) {
      parts.push(`Authors: ${itemData.creators.join(", ")}`);
    }
    if (itemData.date) parts.push(`Date: ${itemData.date}`);
    if (itemData.publicationTitle) parts.push(`Journal: ${itemData.publicationTitle}`);
    if (itemData.tags && itemData.tags.length > 0) {
      parts.push(`Existing Tags: ${itemData.tags.join(", ")}`);
    }
    if (itemData.fullText) {
      const truncatedText = itemData.fullText.substring(0, 8000);
      parts.push(`\n--- Paper Content (truncated) ---\n${truncatedText}`);
    }

    return parts.join("\n");
  },

  /**
   * Build a prompt for translating an abstract
   */
  buildTranslatePrompt(abstract, targetLanguage) {
    const lang = targetLanguage || this._getLanguage();
    return (
      `Please translate the following academic abstract into ${lang}. ` +
      `Preserve the academic tone and technical terminology accurately.\n\n` +
      `--- Abstract ---\n${abstract}`
    );
  },

  /**
   * Build a prompt for answering questions about a paper
   */
  buildAskPrompt(itemData, question) {
    const lang = this._getLanguage();
    const parts = [];

    parts.push(
      `You are a research assistant. Please answer the following question about this paper in ${lang}.`
    );
    parts.push(`\n--- Paper Information ---`);
    if (itemData.title) parts.push(`Title: ${itemData.title}`);
    if (itemData.abstractNote) parts.push(`Abstract: ${itemData.abstractNote}`);
    if (itemData.fullText) {
      const truncatedText = itemData.fullText.substring(0, 8000);
      parts.push(`\n--- Paper Content (truncated) ---\n${truncatedText}`);
    }
    parts.push(`\n--- Question ---\n${question}`);

    return parts.join("\n");
  },

  /**
   * Build a prompt for extracting keywords
   */
  buildExtractKeywordsPrompt(itemData) {
    const lang = this._getLanguage();
    return (
      `You are a research assistant. Please extract 5-10 key academic keywords from the following paper. ` +
      `Return only the keywords separated by commas, in ${lang}.\n\n` +
      `--- Paper Information ---\n` +
      `Title: ${itemData.title || ""}\n` +
      `Abstract: ${itemData.abstractNote || ""}`
    );
  },

  /**
   * Build a prompt for generating tags
   */
  buildGenerateTagsPrompt(itemData) {
    const lang = this._getLanguage();
    return (
      `You are a research assistant. Please generate 5-8 appropriate Zotero tags for the following paper. ` +
      `Tags should be concise and useful for categorization. Return only the tags separated by commas, in ${lang}.\n\n` +
      `--- Paper Information ---\n` +
      `Title: ${itemData.title || ""}\n` +
      `Abstract: ${itemData.abstractNote || ""}\n` +
      `Authors: ${(itemData.creators || []).join(", ")}\n` +
      `Journal: ${itemData.publicationTitle || ""}`
    );
  },

  /**
   * Build a prompt for explaining selected text
   */
  buildExplainPrompt(selectedText) {
    const lang = this._getLanguage();
    return (
      `You are a research assistant. Please explain the following text from an academic paper in ${lang}. ` +
      `Clarify any technical terms and provide context.\n\n` +
      `--- Text ---\n${selectedText}`
    );
  },

  /**
   * Build a prompt for translating selected text
   */
  buildTranslateSelectionPrompt(selectedText, targetLanguage) {
    const lang = targetLanguage || this._getLanguage();
    return (
      `Please translate the following text from an academic paper into ${lang}. ` +
      `Preserve the academic tone and technical terminology accurately.\n\n` +
      `--- Text ---\n${selectedText}`
    );
  },

  /**
   * Build a prompt for translating a single word with annotation info
   * Returns structured data: word, phonetic, partOfSpeech, translation, examples
   */
  buildWordTranslatePrompt(word) {
    const lang = this._getLanguage();
    return (
      `You are a dictionary. For the word "${word}", provide a concise translation in ${lang}. ` +
      `Return ONLY a JSON object with this exact structure (no markdown, no extra text):\n` +
      `{\n  "word": "${word}",\n  "phonetic": "phonetic symbol",\n  "partOfSpeech": "词性缩写如 n./v./adj.",\n  "translation": "中文释义（简洁）",\n  "examples": ["例句1", "例句2（含中文翻译）"]\n}`
    );
  },

  /**
   * Build a context-aware translation prompt that disambiguates the meaning
   * of a word/phrase based on the surrounding sentence and the full paper.
   *
   * @param {Object} params
   * @param {string} params.selected - The word/phrase the user selected
   * @param {string} params.sentence - The full sentence containing the selection
   * @param {string} [params.surrounding] - Adjacent sentences for additional context
   * @param {string} [params.fullText] - The full paper text (truncated to fit context)
   * @returns {string} Prompt text
   */
  buildContextAwareTranslatePrompt({ selected, sentence, surrounding, fullText }) {
    const lang = this._getLanguage();

    // Truncate full text to keep within token budget
    const MAX_FULL = 6000;
    const truncatedFull = fullText
      ? fullText.length > MAX_FULL
        ? "..." + fullText.substring(fullText.length - MAX_FULL)
        : fullText
      : "";

    return (
      `You are an expert bilingual translator specialized in academic papers. ` +
      `Your task is to determine the most appropriate meaning of a selected term ` +
      `based on its context within the paper.\n\n` +
      `Steps:\n` +
      `1. Identify whether the selected text is a single word or a multi-word phrase.\n` +
      `2. Consider the sentence where it appears, the surrounding paragraphs, and ` +
      `the overall topic of the paper.\n` +
      `3. Choose the meaning that BEST fits THIS specific context (not a generic ` +
      `dictionary definition). If it is a phrase, translate it as a phrase.\n` +
      `4. Provide a concise Chinese translation.\n\n` +
      `Return ONLY a JSON object with this exact structure (no markdown fences, no extra text):\n` +
      `{\n` +
      `  "type": "word" or "phrase",\n` +
      `  "original": "${this._escapeQuotes(selected)}",\n` +
      `  "phonetic": "phonetic symbol (only for single words, empty if phrase or unknown)",\n` +
      `  "partOfSpeech": "词性缩写 n./v./adj./adv./phr. (use 'phr.' for phrases)",\n` +
      `  "translation": "the most context-appropriate Chinese meaning",\n` +
      `  "reasoning": "1 sentence explaining why this meaning fits the context",\n` +
      `  "examples": ["原文例句 + 中文翻译", "..."]\n` +
      `}\n\n` +
      `--- Selected Term ---\n${selected}\n\n` +
      `--- Sentence Containing Selection ---\n${sentence}\n\n` +
      (surrounding
        ? `--- Surrounding Context ---\n${surrounding}\n\n`
        : "") +
      (truncatedFull
        ? `--- Full Paper (most recent ${truncatedFull.length} chars) ---\n${truncatedFull}\n`
        : "")
    );
  },

  /**
   * Escape a string for embedding in a JSON prompt template
   */
  _escapeQuotes(s) {
    return (s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  },
};
