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
      const truncatedText = this._truncateAtSentence(itemData.fullText, 8000);
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
      const truncatedText = this._truncateAtSentence(itemData.fullText, 8000);
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

    // Keep full text very short to minimize latency
    const MAX_FULL = 1500;
    const truncatedFull = fullText
      ? this._truncateAtSentence(fullText, MAX_FULL)
      : "";

    return (
      `Expert bilingual translator for academic papers. ` +
      `Based on the surrounding context, determine the most accurate meaning of the selected text and translate to ${lang}. ` +
      `The translation MUST reflect how the term is used in this specific sentence and paper context. ` +
      `Return ONLY JSON (no markdown):\n` +
      `{"type":"word|phrase","original":"${this._escapeQuotes(selected)}",` +
      `"phonetic":"IPA phonetic transcription, REQUIRED for English words, e.g. /ɪɡˈzæmpəl/",` +
      `"partOfSpeech":"词性 REQUIRED, e.g. n./v./adj./adv./prep./phr.",` +
      `"translation":"concise context-appropriate translation","reasoning":"1 sentence explaining the contextual meaning"}\n\n` +
      `Selected: ${selected}\n` +
      `Sentence: ${sentence}\n` +
      (surrounding ? `Context: ${surrounding}\n` : "") +
      (truncatedFull ? `Paper excerpt: ${truncatedFull}\n` : "")
    );
  },

  /**
   * Escape a string for embedding in a JSON prompt template.
   * Handles quotes, backslashes, newlines, tabs, and other control characters.
   */
  _escapeQuotes(s) {
    return (s || "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/[\x00-\x1f]/g, ""); // strip remaining control chars
  },

  /**
   * Truncate text at a sentence boundary near the target length.
   * Avoids cutting mid-word or mid-sentence.
   */
  _truncateAtSentence(text, maxLen) {
    if (!text || text.length <= maxLen) return text || "";
    // Try to find the last sentence boundary before maxLen
    const truncated = text.substring(0, maxLen);
    const lastBreak = truncated.search(/[^.!?。！？\n][.!?。！？\n][^.!?。！？\n]*$/);
    if (lastBreak > maxLen * 0.5) {
      return truncated.substring(0, lastBreak + 2);
    }
    // Fall back to last space
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.5) {
      return truncated.substring(0, lastSpace) + "...";
    }
    return truncated + "...";
  },
};
