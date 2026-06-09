# Dual-Engine Translation Design

**Date:** 2026-06-09
**Status:** Approved (pending user review)
**Author:** LLM Assistant project

## Background

The LLM Assistant plugin currently only translates selected words/phrases
through a large language model (LLM) call. This produces high-quality,
context-aware translations, but introduces noticeable latency (typically
1-5 seconds per call) and depends entirely on the user having an LLM API
key configured.

The user reported that reading academic PDFs often involves many quick
word lookups, where waiting several seconds for each one is frustrating.
A traditional machine-translation API (Baidu, Youdao, Azure, Google) is
much faster (200-500ms) but lacks context awareness and may return an
inappropriate dictionary definition when a word has multiple senses.

The desired behavior is to show **both** results in parallel so the user
can use the fast one as a baseline and the slow but accurate one as the
final answer.

## Goals

1. Reduce perceived translation latency by surfacing a fast machine-
   translation result in parallel with the LLM result.
2. Give the user a side-by-side comparison so they can verify the LLM
   choice against the traditional API's literal translation.
3. Keep the existing LLM-only mode fully working when the user has not
   configured any traditional API.

## Non-Goals

- Auto-merge / "review" both results algorithmically. The user wants to
  see them side-by-side and judge for themselves.
- Running all 4 traditional APIs in parallel. The user picks ONE in
  preferences; we call that one.
- Caching results across selections. Out of scope for v1.
- Saving translation history beyond the existing note-saving flow.

## User-Visible Behavior

### Preferences

Add a new section "Traditional Translation API" to the LLM Assistant
preferences panel:

- **Engine dropdown:** `None (LLM only)` (default), `Baidu Translate`,
  `Youdao Translate`, `Microsoft Translator`, `Google Translate API`.
- **Baidu fields:** App ID, Secret Key (only shown when engine=baidu).
- **Youdao fields:** AppKey, AppSecret (only shown when engine=youdao).
- **Azure fields:** Subscription Key, Region (only shown when engine=azure).
- **Google field:** API Key (only shown when engine=google).

### Right-Click Menu

No change. `translateAndAnnotate` is the entry point.

### Annotation Card

The existing floating annotation card gains a second result row.

```
┌────────────────────────────────────────────┐
│ 单词 task  [tæsk]  n.              [蓝色]   │
│                                            │
│ 译文（双击词可标注到 PDF 上）：              │
│ ┌──────────────────────────────────────┐  │
│ │ 任务 作业（双击可标注）              │  │
│ └──────────────────────────────────────┘  │
│                                            │
│ ⚡ 百度翻译：任务；作业                     │  ← 新增行
│                                            │
│ 🤖 LLM 上下文消歧：                        │  ← 已有（重命名）
│ 学习任务                                  │
│ ┌──────────────────────────────────────┐  │
│ │ 为什么是这意思：本文讨论...           │  │
│ └──────────────────────────────────────┘  │
│                                            │
│              [关闭]  [添加到笔记]          │
└────────────────────────────────────────────┘
```

**Rendering rules:**

| Traditional result | LLM result | UI |
|---|---|---|
| Success | Success | Both rows shown. |
| Success | Failure/timeout | Traditional row + "LLM 调用失败/超时" notice. |
| Failure/timeout | Success | LLM row + "百度翻译失败：xxx" notice. |
| Unconfigured | Success | LLM row only + small "(传统翻译未配置)" hint. |
| Unconfigured | Failure | Single error message. |

### Double-Click to Annotate

Unchanged from the previous feature. The user can still double-click any
word in the **LLM** translation row to create a persistent annotation
on the PDF.

## Architecture

### Data Flow

```
translateAndAnnotate()
   │
   ├──► TraditionalClient.translate(text)  ──► Promise<{source, text, error}>
   │
   └──► LLMClient.chat(contextPrompt)      ──► Promise<{type, original,
            phonetic, partOfSpeech, translation, reasoning, examples}>
                                                  (may throw on failure)

   Promise.allSettled([traditional, llm])
      → { traditional: {source, text}|null, llm: {...}|null, errors: [...] }
      → showAnnotationOnPDF(merged, selectionRect)
```

We use `Promise.allSettled` rather than `Promise.all` so that a single
failure does not abort the other result.

### Module Layout

| File | Status | Responsibility |
|---|---|---|
| `content/traditionalClient.js` | **new** | Unified facade for 4 engines; `translate(text)` returns `{source, text, error}`. |
| `content/llmClient.js` | unchanged | Already exposes `chat(messages)`. |
| `content/promptBuilder.js` | unchanged | `buildContextAwareTranslatePrompt` already handles the LLM side. |
| `content/overlay.js` | modified | `translateAndAnnotate` now does parallel calls and merges. |
| `content/uiManager.js` | modified | `showAnnotationOnPDF` accepts the merged shape and renders the new row. |
| `content/preferences.xhtml` | modified | New engine dropdown + key fields. |
| `manifest.json` | modified | Declares new preferences. |

### TraditionalClient API

```js
Zotero.LLMAssistant.TraditionalClient = {
  // Returns { source: "baidu"|"youdao"|"azure"|"google"|null,
  //           text: string|null, error: string|null }
  async translate(text, options = {})
};
```

`source: null` means the user has not selected an engine or the chosen
engine is not configured; in that case `text` is null and `error` is a
human-readable explanation.

### TraditionalClient Internals

- A single `translate(text)` entrypoint dispatches to one of four
  private methods (`_baidu`, `_youdao`, `_azure`, `_google`) based on
  the preference `pref-traditional-engine`.
- Each private method:
  1. Reads its own credentials from preferences.
  2. Validates the credentials are present; otherwise returns
     `{source, text: null, error: "未配置 API key"}`.
  3. Builds the vendor-specific request (URL, params, headers, sign).
  4. Calls `_fetch` (the same XMLHttpRequest wrapper used by LLMClient).
  5. Parses the response into a single best-guess Chinese string.
  6. Returns `{source, text, error: null}` on success, or
     `{source, text: null, error: msg}` on any thrown exception.

### Vendor-Specific Notes

- **Baidu** uses MD5(appid+q+salt+key) signing; the request goes to
  `https://fanyi-api.baidu.com/api/trans/vip/translate`. We use
  `from=en&to=zh` and concatenate `trans_result` entries with `；`.
- **Youdao** uses SHA256 signing with `sign = sha256(appKey + input +
  salt + curtime + appSecret)`; the request goes to
  `https://openapi.youdao.com/api`. We use `from=en&to=zh-CHS` and
  parse `translation[0]`.
- **Azure** uses an Ocp-Apim-Subscription-Key header and a region
  header; the request goes to
  `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans`.
  We pick `translations[0].text`.
- **Google** v2 REST uses `?key=...&source=en&target=zh-CN&q=...`
  against `https://translation.googleapis.com/language/translate/v2`.
  We pick `data.translations[0].translatedText`.

All four use a 10-second timeout (lower than LLM's 60-second timeout
because traditional APIs are expected to be fast).

## Preferences

| Key | Type | Default | Description |
|---|---|---|---|
| `pref-traditional-engine` | string | `""` (none) | One of `baidu`, `youdao`, `azure`, `google`. Empty = disabled. |
| `pref-baidu-appid` | string | `""` | Baidu Translate APP ID. |
| `pref-baidu-key` | string | `""` | Baidu Translate secret key. |
| `pref-youdao-appkey` | string | `""` | Youdao AppKey. |
| `pref-youdao-appsecret` | string | `""` | Youdao AppSecret. |
| `pref-azure-key` | string | `""` | Azure Translator subscription key. |
| `pref-azure-region` | string | `""` | Azure resource region (e.g. `eastasia`). |
| `pref-google-key` | string | `""` | Google Cloud Translation API key. |

## Error Handling

| Scenario | Behavior |
|---|---|
| Engine unset | Traditional client returns `{source:null, text:null, error:"未选择翻译引擎"}`; UI shows only LLM row + small hint. |
| Engine set but key missing | Traditional client returns `{source, text:null, error:"未配置 API key"}`; UI shows the error under a disabled traditional row. |
| HTTP 401/403 | `error = "鉴权失败，请检查 API key"` |
| HTTP 429 | `error = "请求过于频繁或配额用尽"` |
| HTTP 5xx | `error = "服务暂时不可用 (HTTP {status})"` |
| Network/timeout | `error = "网络错误或超时"` |
| Parse error | `error = "响应解析失败"` |

The LLM-side errors are handled exactly as today. If both sides fail,
the card shows a single combined error message and the existing
"error toast" is also triggered.

## Testing

1. **Unit test for TraditionalClient** (`scripts/test-traditional-client.js`):
   - Mock `_fetch` to return canned responses from each vendor.
   - Verify request URL, params, headers, and signing match each
     vendor's documented format.
   - Verify response parsing extracts the correct field.
   - Verify missing credentials return a clean error.
2. **Unit test for the parallel merge logic** in `overlay.js`:
   - Simulate `TraditionalClient.translate` success + `LLMClient.chat`
     success → both rows rendered.
   - Simulate traditional failure + LLM success → only LLM row.
   - Simulate both failure → combined error.
3. **Regression test for the existing single-engine mode**:
   - Empty `pref-traditional-engine` → behavior identical to v1.0.0.
4. **Manual UI verification** in Zotero 7:
   - Configure each of the 4 engines in turn; confirm the right result
     appears.
   - Unset the engine; confirm the UI gracefully degrades.
   - Trigger a LLM timeout (point to a non-existent endpoint) and
     confirm the traditional result still displays.

## Open Questions

None at the time of writing. All clarifications were resolved during
brainstorming (4 vendors as alternatives, user picks one, two-row
layout, Baidu as default suggestion if the user does not pick).

## Implementation Phases

1. Add `TraditionalClient` with the 4 vendor methods and unit tests.
2. Extend preferences UI (XHTML) and `manifest.json`.
3. Wire `translateAndAnnotate` to call both engines in parallel and
   merge results.
4. Update `showAnnotationOnPDF` to render the new traditional row.
5. Rebuild, run all tests, and produce a new `.xpi`.
