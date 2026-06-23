# LLM Assistant for Zotero

![Version](https://img.shields.io/badge/version-1.1.0-blue)
![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-orange)
![License](https://img.shields.io/badge/license-MIT-green)

将大语言模型接入 Zotero PDF 阅读器，提供上下文消歧翻译、术语标注、论文摘要与问答功能。双引擎架构让 LLM 与传统机器翻译并行工作，用户即时获得两层参考。

![LLM Assistant icon](docs/images/icon.png)

---

## 核心功能

**上下文翻译** — 选中文本后，插件自动提取所在句子与周边段落作为 prompt 上下文，LLM 据此判断词义并给出精准翻译，而非脱离语境的字典释义。

**双引擎并行** — LLM 翻译与百度/有道/Azure/Google 传统翻译同时发起，传统翻译先到先显示，LLM 随后补充语境分析。任一引擎失败不影响另一个。

**PDF 标注** — 翻译结果以可点击词块呈现，双击任一词即可将其作为高亮标注固定到 PDF 上方，支持随时移除。

**流式输出** — LLM 响应通过 SSE 流式传输，生成过程中即可看到部分结果，无需等待完整响应。

**论文工具** — 右键菜单提供整篇摘要、全文总结、关键词提取、标签生成与自由提问，结果可一键保存为 Zotero 笔记。

---

## 安装

### 下载预编译包

1. 前往 [Releases](https://github.com/Funvvell/zotero-llm-assistant/releases) 下载 `zotero-llm-assistant-1.1.0.xpi`
2. 打开 Zotero → `Tools` → `Plugins` → 齿轮按钮 → `Install Plugin From File`
3. 选择下载的 .xpi 文件，重启 Zotero

### 从源码构建

```bash
git clone https://github.com/Funvvell/zotero-llm-assistant.git
cd zotero-llm-assistant
node scripts/build.js
cd build && zip -r ../dist/zotero-llm-assistant-1.1.0.xpi .
```

生成的 .xpi 可直接拖入 Zotero 安装。

---

## 配置

打开 `Edit` → `Settings` → `LLM Assistant`。

### LLM 引擎

兼容所有 OpenAI 协议端点：OpenAI、DeepSeek、通义千问、智谱 GLM、月之暗面、Ollama、vLLM 等。

| 字段 | 说明 | 示例 |
|---|---|---|
| API Endpoint | OpenAI 兼容端点 | `https://api.openai.com/v1` |
| API Key | 密钥 | `sk-...` |
| Model | 模型名 | `gpt-4o-mini`, `deepseek-chat`, `qwen-plus` |
| Max Tokens | 单次回复上限 | `2048` |
| Temperature | 采样温度 | `0.3`（翻译推荐低值） |
| Output Language | 目标语言 | `Chinese` / `English` / `Japanese` / `Korean` |

### 传统翻译引擎

选择一个与传统引擎与 LLM 并行调用。未配置密钥的引擎会被自动跳过。

| 引擎 | 申请地址 | 需要的凭据 |
|---|---|---|
| 百度翻译 | https://api.fanyi.baidu.com | APP ID + 密钥 |
| 有道翻译 | https://ai.youdao.com | AppKey + AppSecret |
| 微软 Azure | https://portal.azure.com | Subscription Key + Region |
| Google Translate | https://cloud.google.com/translate | API Key |
| MyMemory | 无需申请 | 无（免费，默认引擎） |

---

## 使用方式

### PDF 阅读器内

打开任意 PDF，选中文本后右键：

| 菜单项 | 功能 |
|---|---|
| 翻译并标注 | LLM 上下文翻译 + 传统翻译并行，弹出气泡可双击词标注到 PDF |
| 解释选中文本 | LLM 对选中文本进行详细解释 |
| 翻译选中文本 | 仅翻译，不标注 |

### 翻译气泡交互

气泡出现在选中词上方（空间不足时自动切换到下方）：

- 上方橙色区域为 LLM 翻译，下方绿色区域为传统翻译
- 双击任一翻译词块，该词作为持久标注固定到 PDF 上方
- 点击"添加到笔记"可将翻译、语境分析、例句保存为条目笔记
- 气泡 30 秒后自动关闭

### 文献库右键菜单

在文献列表中右键条目：

| 菜单项 | 功能 |
|---|---|
| 总结条目 | 基于摘要 + 全文生成论文总结 |
| 翻译选中文本 | 翻译当前选中的文本 |
| 翻译并标注 | 翻译并支持标注到 PDF |
| 解释选中文本 | 解释当前选中的文本 |

---

## 架构

### 双引擎并行流程

```
选中文本
    │
    ├── 传统翻译 (TraditionalClient)     ← 先到先显示
    │
    ├── 上下文提取 (PDFViewerApplication)  ← 500ms 超时
    │       │
    │       └── LLM 翻译 (chatStream)     ← SSE 流式输出
    │
    └── 词典 API (dictionaryapi.dev)       ← 单词音标/词性
              │
              ↓
        合并渲染 → 气泡展示
```

上下文提取采用三级策略，按可靠性依次尝试：

1. `PDFViewerApplication.pdfPage.getTextContent()` — 直接读取 PDF 数据，最可靠
2. DOM `.textLayer` span 元素 — 同步回退
3. `Zotero.PDFWorker.getFullText()` — 索引全文兜底

页面文本提取结果缓存 60 秒，同一页连续选词不会重复调用 `getTextContent()`。

### 降级策略

| LLM | 传统翻译 | 显示结果 |
|---|---|---|
| 成功 | 成功 | LLM 行 + 传统行 |
| 成功 | 失败 | 仅 LLM 行 |
| 失败 | 成功 | 仅传统行（合成最小 LLM 数据） |
| 失败 | 失败 | 错误提示 |

### 文件结构

```
addon/
├── manifest.json              # 插件清单 (v1.1.0, Zotero 7-9)
├── bootstrap.js               # 生命周期管理，加载 6 个模块
├── llmClient.js               # OpenAI 兼容 chat() + chatStream()
├── promptBuilder.js           # 上下文感知 prompt 构建
├── traditionalClient.js       # 5 个传统翻译引擎
├── uiManager.js               # 面板、浮窗、标注 UI
├── overlay.js                 # 主逻辑：双引擎并行、上下文提取、标注
├── preferences.js             # 设置面板逻辑
└── preferences.xhtml          # 设置面板布局

scripts/
├── build.js                   # 构建 .xpi
├── test-bootstrap.js          # 启动/关闭冒烟测试
├── test-traditional-client.js # 41 个引擎单元测试
├── test-merge-logic.js        # 17 个并行合并集成测试
├── test-ui-helpers.js         # UI 工具测试
├── test-ui-source-name.js     # 引擎名称映射测试
└── validate.js                # manifest 验证
```

### 关键设计

**HTTP 连接池** — LLM 与传统翻译统一使用 `Zotero.HTTP.request`，复用 Mozilla 原生连接池，减少 TCP 握手开销。

**竞态防护** — 每次选词递增 `requestID`，异步回调比对 ID 后才写入上下文，防止快速连续选词时旧数据覆盖新数据。

**MutationObserver 精确监听** — 菜单注入观察器仅监听 `mainPopupSet` 而非整个文档子树，避免无关 DOM 变化触发回调。

**缓存 LRU 淘汰** — 页面文本缓存上限 50 条，超出时淘汰最旧条目，防止长时间使用后内存无限增长。

---

## 测试

```bash
node scripts/test-bootstrap.js           # 启动/关闭冒烟
node scripts/test-traditional-client.js  # 41 个引擎测试
node scripts/test-merge-logic.js         # 17 个并行合并测试
node scripts/test-ui-helpers.js          # UI 工具测试
node scripts/test-ui-source-name.js      # 引擎名称映射测试
node scripts/validate.js                 # manifest 验证
```

合计 66+ 自动化断言，覆盖引擎签名、网络错误处理、JSON 解析降级、并行合并逻辑。

---

## 已知限制

- 选中文本跨行时浮窗定位可能偏移
- 传统翻译返回多个分号分隔的释义，不进行语境消歧
- 百度/有道对长文本有限制，本插件按单词/短语粒度调用
- Ollama 等本地 LLM 需暴露 OpenAI 兼容的 `/v1/chat/completions` 端点
- 持久标注不会同步到 Zotero annotation 数据库，刷新页面后消失

---

## 贡献

欢迎提交 PR。添加新翻译引擎的步骤：

1. 在 `traditionalClient.js` 中实现 `_xxx(text, options)` 方法，返回 `{source, text, error}`
2. 在 `translate()` 的 switch 中添加 case
3. 在 `prefs.js` 和 `preferences.xhtml` 中添加偏好字段
4. 在 `uiManager.js` 的 `sourceDisplayName` 中添加名称映射
5. 在 `test-traditional-client.js` 中添加单元测试

---

## License

MIT
