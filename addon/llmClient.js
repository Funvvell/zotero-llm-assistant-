/* global Zotero, Services */
/**
 * LLM API Client - Supports OpenAI-compatible Chat Completions API.
 * Compatible with: OpenAI, DeepSeek, Qwen, GLM, Moonshot, Claude (via proxy), etc.
 *
 * Patterns learned from zotero-pdf-translate's GPT service:
 *   - Proper type coercion for numeric preferences
 *   - No Content-Type header on GET requests
 *   - Rate-limit (429) awareness in error messages
 *   - Response status logging for debugging
 */

Zotero.LLMAssistant = Zotero.LLMAssistant || {};

Zotero.LLMAssistant.LLMClient = {

  PREF_PREFIX: "extensions.zotero-llm-assistant.",

  getPref(key) {
    try {
      return Zotero.Prefs.get(this.PREF_PREFIX + key, true);
    } catch (e) {
      return undefined;
    }
  },

  /**
   * Get API configuration from preferences.
   * Numeric prefs are coerced to their proper types here so that
   * downstream code never has to worry about string-vs-number.
   */
  getConfig() {
    const temp = this.getPref("temperature");
    const maxTok = this.getPref("max-tokens");
    return {
      endpoint:    this.getPref("api-endpoint") || "https://api.openai.com/v1",
      apiKey:      this.getPref("api-key") || "",
      model:       this.getPref("model") || "gpt-4o-mini",
      maxTokens:   (typeof maxTok === "number" ? maxTok : parseInt(maxTok, 10)) || 2048,
      temperature: (typeof temp === "number" ? temp : parseFloat(temp)) || 0.3,
      language:    this.getPref("language") || "Chinese",
    };
  },

  /**
   * Call the LLM API with the given messages.
   * @param {Array<{role:string, content:string}>} messages
   * @param {Object} [options] - Optional overrides for config values
   * @returns {Promise<string>} - The assistant's response text
   */
  async chat(messages, options = {}) {
    Zotero.debug("[LLM Assistant] chat() called");
    
    const config = this.getConfig();
    const endpoint    = options.endpoint    || config.endpoint;
    const apiKey      = options.apiKey      || config.apiKey;
    const model       = options.model       || config.model;
    const maxTokens   = options.maxTokens   || config.maxTokens;
    const temperature = options.temperature !== undefined ? options.temperature : config.temperature;
    const timeout     = options.timeout     || 30000;

    Zotero.debug(`[LLM Assistant] Config: endpoint=${endpoint}, hasKey=${!!apiKey}, model=${model}`);

    if (!apiKey) {
      throw new Error("API Key 未配置。请在 LLM Assistant 设置中填写 API Key。");
    }

    const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: Number(temperature), // ensure numeric in JSON output
    });

    Zotero.debug(`[LLM Assistant] API call: ${url}, model=${model}, temp=${temperature}`);

    try {
      const response = await this._fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body,
        timeout,
      });

    const status = response.status;
    Zotero.debug(`[LLM Assistant] API response: status=${status}`);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg;
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error?.message || errorJson.message || errorText;
      } catch {
        errorMsg = errorText;
      }

      if (status === 429) {
        throw new Error(`API 速率限制 (429): ${errorMsg || "请求过于频繁，请稍后重试"}`);
      }
      if (status === 401 || status === 403) {
        throw new Error(`API 认证失败 (${status}): ${errorMsg || "请检查 API Key 是否正确"}`);
      }
      throw new Error(`API 错误 (${status}): ${errorMsg}`);
    }

    const data = await response.json();
    Zotero.debug(`[LLM Assistant] API response data received`);

    if (!data.choices || data.choices.length === 0) {
      throw new Error("API 返回了空结果 (no choices)");
    }

    const content = data.choices[0].message?.content;
    if (typeof content !== "string") {
      throw new Error("API 返回格式异常: choices[0].message.content 不是字符串");
    }

    Zotero.debug(`[LLM Assistant] Translation complete, content length: ${content.length}`);
    return content.trim();
    
    } catch (fetchError) {
      Zotero.logError(`[LLM Assistant] chat() fetch error: ${fetchError.message}`);
      throw fetchError;
    }
  },

  /**
   * Call the LLM API with streaming (Server-Sent Events).
   * Calls onChunk(text) as tokens arrive, enabling progressive display.
   * Falls back to non-streaming if XHR streaming is unavailable.
   * @param {Array<{role:string, content:string}>} messages
   * @param {Object} [options] - Optional overrides + { onChunk: (text) => void }
   * @returns {Promise<string>} - The full assistant response text
   */
  async chatStream(messages, options = {}) {
    Zotero.debug("[LLM Assistant] chatStream() called");

    const config = this.getConfig();
    const endpoint    = options.endpoint    || config.endpoint;
    const apiKey      = options.apiKey      || config.apiKey;
    const model       = options.model       || config.model;
    const maxTokens   = options.maxTokens   || config.maxTokens;
    const temperature = options.temperature !== undefined ? options.temperature : config.temperature;
    const timeout     = options.timeout     || 30000;
    const onChunk     = options.onChunk     || (() => {});

    if (!apiKey) {
      throw new Error("API Key 未配置。请在 LLM Assistant 设置中填写 API Key。");
    }

    const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: Number(temperature),
      stream: true,
    });

    Zotero.debug(`[LLM Assistant] Stream API call: ${url}, model=${model}`);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Authorization", `Bearer ${apiKey}`);
      // Request SSE stream
      try { xhr.responseType = "moz-chunked-text"; } catch { /* not supported */ }

      let fullText = "";
      let buffer = "";
      let usedFallback = false;

      // If moz-chunked-text isn't supported, fall back to non-streaming
      xhr.onload = () => {
        if (usedFallback) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          // If we got here without streaming, parse the full response
          if (!fullText) {
            try {
              const data = JSON.parse(xhr.responseText);
              fullText = data.choices?.[0]?.message?.content || "";
            } catch (e) {
              reject(new Error(`解析响应失败: ${e.message}`));
              return;
            }
          }
          Zotero.debug(`[LLM Assistant] Stream complete, length: ${fullText.length}`);
          resolve(fullText.trim());
        } else {
          const errorText = xhr.responseText || "";
          let errorMsg;
          try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.error?.message || errorJson.message || errorText;
          } catch { errorMsg = errorText; }
          if (xhr.status === 429) {
            reject(new Error(`API 速率限制 (429): ${errorMsg}`));
          } else if (xhr.status === 401 || xhr.status === 403) {
            reject(new Error(`API 认证失败 (${xhr.status}): ${errorMsg}`));
          } else {
            reject(new Error(`API 错误 (${xhr.status}): ${errorMsg}`));
          }
        }
      };

      xhr.onerror = () => reject(new Error(`网络错误: 无法连接 ${url}`));
      xhr.ontimeout = () => reject(new Error(`请求超时 (${timeout}ms)`));
      xhr.timeout = timeout;

      // Progressive parsing for moz-chunked-text
      xhr.onprogress = () => {
        if (xhr.responseType === "moz-chunked-text" && xhr.responseText) {
          const chunk = xhr.responseText;
          buffer += chunk;
          // Parse SSE lines: "data: {...}\n\n"
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // keep incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content || "";
              if (delta) {
                fullText += delta;
                try { onChunk(delta); } catch { /* callback error */ }
              }
            } catch { /* incomplete JSON, skip */ }
          }
        }
      };

      // If responseType couldn't be set, mark for fallback
      if (xhr.responseType !== "moz-chunked-text") {
        usedFallback = false; // will use onload to parse full response
        Zotero.debug("[LLM Assistant] Stream: moz-chunked-text not supported, using fallback");
      }

      xhr.send(body);
    });
  },

  /**
   * Lightweight connection test — calls GET /models (zero tokens, fast).
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    const config = this.getConfig();
    const endpoint = config.endpoint.replace(/\/+$/, "");
    const apiKey = config.apiKey;

    if (!apiKey) {
      return { success: false, message: "API Key 未配置" };
    }

    try {
      const response = await this._fetch(`${endpoint}/models`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
        timeout: 10000,
      });

      if (response.ok) {
        try {
          const data = await response.json();
          const count = Array.isArray(data.data) ? data.data.length : 0;
          return { success: true, message: `已连接 (${count} 个模型可用)` };
        } catch {
          return { success: true, message: "已连接" };
        }
      } else {
        const text = await response.text();
        let msg = `HTTP ${response.status}`;
        try { msg = JSON.parse(text).error?.message || msg; } catch { /* ignore */ }
        return { success: false, message: msg };
      }
    } catch (error) {
      return { success: false, message: `连接失败: ${error.message}` };
    }
  },

  /**
   * Fetch wrapper using XMLHttpRequest.
   * Only sets Content-Type when the caller explicitly provides it in headers
   * (avoids sending it on GET requests where it's meaningless).
   */
  async _fetch(url, options) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(options.method || "GET", url, true);

      // Only set headers that the caller explicitly provides
      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          xhr.setRequestHeader(key, value);
        }
      }

      xhr.onload = () => {
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          text: async () => xhr.responseText,
          json: async () => JSON.parse(xhr.responseText),
        });
      };

      xhr.onerror = () => reject(new Error(`网络错误: 无法连接 ${url}`));
      xhr.ontimeout = () => reject(new Error(`请求超时 (${options.timeout || 30000}ms): ${url}`));

      xhr.timeout = options.timeout || 30000;
      xhr.send(options.body || null);
    });
  },
};
