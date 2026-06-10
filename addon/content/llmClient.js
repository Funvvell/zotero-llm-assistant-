/* global Zotero, Services */
/**
 * LLM API Client - Supports OpenAI-compatible API endpoints
 * Compatible with: OpenAI, DeepSeek, Qwen, GLM, Claude (via compatible endpoint), etc.
 */

Zotero.LLMAssistant = Zotero.LLMAssistant || {};

Zotero.LLMAssistant.LLMClient = {
  /**
   * Get preference value
   */
  getPref(key) {
    return Zotero.Prefs.get(`extensions.zotero-llm-assistant.${key}`, true);
  },

  /**
   * Get API configuration from preferences
   */
  getConfig() {
    return {
      endpoint: this.getPref("api-endpoint") || "https://api.openai.com/v1",
      apiKey: this.getPref("api-key") || "",
      model: this.getPref("model") || "gpt-4o",
      maxTokens: this.getPref("max-tokens") || 2048,
      temperature: this.getPref("temperature") || 0.7,
      language: this.getPref("language") || "Chinese",
    };
  },

  /**
   * Call the LLM API with the given messages
   * @param {Array} messages - Array of message objects [{role, content}]
   * @param {Object} options - Optional overrides for config
   * @returns {Promise<string>} - The assistant's response text
   */
  async chat(messages, options = {}) {
    const config = this.getConfig();
    const endpoint = options.endpoint || config.endpoint;
    const apiKey = options.apiKey || config.apiKey;
    const model = options.model || config.model;
    const maxTokens = options.maxTokens || config.maxTokens;
    const temperature =
      options.temperature !== undefined ? options.temperature : config.temperature;

    if (!apiKey) {
      throw new Error("API Key is not configured. Please set it in LLM Assistant preferences.");
    }

    const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    });

    Zotero.debug(`[LLM Assistant] Calling API: ${url}, model: ${model}`);

    try {
      const response = await this._fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson.error?.message || errorJson.message || errorText;
        } catch {
          errorMsg = errorText;
        }
        throw new Error(`API Error (${response.status}): ${errorMsg}`);
      }

      const data = await response.json();

      if (!data.choices || data.choices.length === 0) {
        throw new Error("API returned no choices");
      }

      return data.choices[0].message.content.trim();
    } catch (error) {
      Zotero.debug(`[LLM Assistant] API call failed: ${error.message}`);
      throw error;
    }
  },

  /**
   * Test the API connection
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    try {
      const result = await this.chat(
        [
          {
            role: "user",
            content: "Hello, please respond with 'OK' to confirm the connection.",
          },
        ],
        { maxTokens: 10 }
      );
      return { success: true, message: `Connection successful: ${result}` };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error.message}` };
    }
  },

  /**
   * Fetch wrapper - uses Zotero's HTTP request or XMLHttpRequest
   */
  async _fetch(url, options) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(options.method || "GET", url, true);

      xhr.setRequestHeader("Content-Type", "application/json");

      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          if (key !== "Content-Type") {
            xhr.setRequestHeader(key, value);
          }
        }
      }

      xhr.onload = () => {
        // Create a minimal Response-like object
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          text: async () => xhr.responseText,
          json: async () => JSON.parse(xhr.responseText),
        });
      };

      xhr.onerror = () => {
        reject(new Error(`Network error: Failed to connect to ${url}`));
      };

      xhr.ontimeout = () => {
        reject(new Error(`Request timeout: ${url}`));
      };

      xhr.timeout = 60000; // 60 seconds timeout
      xhr.send(options.body || null);
    });
  },
};
