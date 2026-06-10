# LLM Assistant v1.1.0 — Smoke Checklist

Manual verification steps for a fresh install. Run in order and tick each
box. Any failure: capture the browser error console output and file an
issue.

## 0. Install

- [ ] `dist/zotero-llm-assistant-1.1.0.xpi` exists
- [ ] In Zotero 7: Tools → Plugins → gear icon → Install Plugin From File
- [ ] Plugin appears in the list, no "incompatible" warning
- [ ] Plugin version reads "1.1.0" (Tools → Plugins → LLM Assistant)

## 1. Bootstrap

- [ ] Browser console (Help → Debug Output Logging) shows
      `[LLM Assistant] Starting up (id=llm-assistant@zotero.org, version=1.1.0)`
- [ ] Right-click on the PDF reader shows three new items in the context menu:
  "翻译并标注" / "解释选中文本" / "翻译选中文本"
- [ ] Preferences → LLM Assistant opens without error

## 2. Preferences UI

- [ ] Groupbox "Traditional Translation API (parallel to LLM)" is visible
- [ ] "Active Engine" dropdown has 4 options: Baidu / Youdao / Azure / Google
- [ ] Each vendor has the expected fields and `preference=` bindings
      (typing in a field does not throw)
- [ ] Saving and re-opening the prefs panel shows the saved values

## 3. LLM-only path (no traditional engine configured)

- [ ] Select a word in any PDF reader
- [ ] Right-click → "翻译并标注"
- [ ] Tooltip appears above the selected word with the LLM translation
- [ ] Tooltip does NOT show a "传统翻译" row
- [ ] Double-click a translated word in the tooltip → a small yellow label
      persists above the original word with a × to dismiss
- [ ] "添加到笔记" button creates a note with the structured LLM output

## 4. Traditional-engine path (Baidu)

- [ ] In Preferences, choose "Baidu Translate" as the active engine
- [ ] Enter Baidu appid + secret (real credentials)
- [ ] Select a word, right-click → "翻译并标注"
- [ ] Tooltip shows TWO rows:
      - Row 1 (LLM, 译文 / orange)
      - Row 2 (传统翻译（百度翻译） / green)
- [ ] Both translations are non-empty

## 5. Traditional-engine path (Youdao / Azure / Google)

- [ ] Repeat step 4 with each of the other 3 vendors
- [ ] Source label in tooltip matches the chosen vendor
      (百度翻译 / 有道翻译 / 微软翻译 / Google 翻译)
- [ ] Invalid credentials produce a single-row tooltip (LLM only) and a
      `baidu 401` (or similar) error in the console; the plugin does not
      throw or crash

## 6. Parallel-rendering race

- [ ] On a slow LLM endpoint and a fast traditional engine, the LLM
      row may appear slightly after the traditional row; both end up
      visible in the same tooltip (no flicker / no duplicate tooltip)
- [ ] On a slow traditional engine and a fast LLM, the LLM row appears
      first; the traditional row fills in when ready

## 7. Failure modes

- [ ] LLM API key not set → right-clicking shows an error tooltip with
      "API Key is not configured…"
- [ ] LLM rejects mid-call, traditional succeeds → tooltip shows the
      traditional translation in row 1 (no LLM row)
- [ ] Both engines fail → tooltip shows an error, nothing is annotated
- [ ] No selection → right-clicking shows "未在 PDF 阅读器中选中文本"

## 8. Regression check (v1.0 features)

- [ ] "解释选中文本" still works
- [ ] "翻译选中文本" still works
- [ ] Test Connection button in preferences still works
- [ ] Saving an annotation to a note includes the new "传统翻译" line
      when present (only when data.traditional.text is non-null)

## 9. Cleanup

- [ ] Disable the plugin via Tools → Plugins
- [ ] No errors in the console
- [ ] Re-enable → all 9 items above still pass

---

## Test matrix (automated)

| Script                         | Tests | Status |
|--------------------------------|-------|--------|
| test-bootstrap.js              |  smoke |  ✓    |
| test-ui-helpers.js             |   6   |  ✓    |
| test-ui-source-name.js         |   8   |  ✓    |
| test-traditional-client.js     |  41   |  ✓    |
| test-merge-logic.js            |  17   |  ✓    |
| **Total assertions**           | **72+** | **✓** |

## Manifest

```
name:        LLM Assistant
version:     1.1.0
id:          llm-assistant@zotero.org
min:         6.999
max:         7.0.*
preferences: 8 (1 engine selector + 7 vendor credentials)
```

## Build artifact

```
dist/zotero-llm-assistant-1.1.0.xpi   (~28 KB)
└── manifest.json
└── bootstrap.js
└── content/
    ├── icons/icon@48.png
    ├── icons/icon@96.png
    ├── llmClient.js
    ├── overlay.css
    ├── overlay.js
    ├── preferences.xhtml
    ├── promptBuilder.js
    ├── traditionalClient.js
    └── uiManager.js
```
