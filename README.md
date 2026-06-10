# LLM Assistant for Zotero

一个 Zotero 7/8/9 插件（manifest 范围 7.0.0 – 9.*.*），把大语言模型 (LLM) 接入 PDF 阅读器，支持：
- 上下文消歧的单词/短语翻译（基于全文 prompt）
- 选中文本一键标注到 PDF 上方
- 双引擎：LLM 主翻译 + 传统机器翻译（百度/有道/Azure/Google）并行
- 解释选中文本、提问、笔记保存

最新版本：**v1.1.0**（双引擎翻译）

---

## 安装

### 方式 A：下载预编译 .xpi（推荐）

1. 从 [Releases](https://github.com/你的用户名/zotero-llm-assistant/releases) 下载 `zotero-llm-assistant-1.1.0.xpi`
2. Zotero（7.0+）→ `Tools` → `Plugins` → 齿轮按钮 → `Install Plugin From File`
3. 选下载的 .xpi，安装完成
4. 重启 Zotero

### 方式 B：从源码构建

```bash
git clone <repo-url>
cd zotero-llm-assistant
node scripts/build.js          # 输出到 build/
cd build && zip -r ../dist/zotero-llm-assistant-1.1.0.xpi .
```

`dist/` 下的 .xpi 直接拖给 Zotero 安装。

---

## 配置

打开 `Edit` → `Settings` → `LLM Assistant` 标签页。

### LLM 主引擎（OpenAI 兼容 API）

| 字段 | 说明 | 示例 |
|---|---|---|
| API Endpoint | OpenAI 兼容端点 | `https://api.openai.com/v1` / `https://api.deepseek.com/v1` |
| API Key | 你的 key | `sk-...` |
| Model | 模型名 | `gpt-4o-mini`, `deepseek-chat`, `qwen-plus` |
| Max Tokens | 单次回复上限 | `2048` |
| Temperature | 创造性 0-2 | `0.3`（翻译推荐低） |
| Output Language | 目标语言 | `Chinese` / `English` / `Japanese` / `Korean` |

兼容 OpenAI 协议的端点都行：OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 月之暗面 / Ollama / vLLM 等。

### 传统翻译引擎（v1.1 新增）

选择一个 vendor 与 LLM **并行**调用。LLM 是首选，传统翻译作为快速参考，UI 上两行展示。

#### 1. 百度翻译（默认）

- 申请：https://api.fanyi.baidu.com/api/trans/product/desktop
- 需要：APP ID + 密钥
- 协议：GET，`sign = md5(appid + q + salt + key)`

#### 2. 有道翻译

- 申请：https://ai.youdao.com/
- 需要：AppKey + AppSecret
- 协议：POST，`sign = sha256(appKey + input + salt + curtime + appSecret)`

#### 3. 微软 Azure Translator

- 申请：https://portal.azure.com → 创建 Translator 资源
- 需要：Subscription Key + Region（区域，如 `eastasia`，全局资源可空）
- 协议：POST，header `Ocp-Apim-Subscription-Key: <key>`

#### 4. Google Translate v2

- 申请：https://cloud.google.com/translate → API key
- 需要：API Key
- 协议：GET，`?key=<key>&q=...&target=...`

留空字段的 vendor 会被自动跳过。

---

## 使用

### 右键菜单（PDF 阅读器内）

1. 打开任意 PDF item
2. 选中一个单词或短语
3. 右键 → 选一项：

| 菜单 | 作用 |
|---|---|
| **翻译并标注** | LLM 上下文翻译 + 传统翻译，弹出气泡可双击词标注到 PDF |
| **解释选中文本** | 让 LLM 详细解释 |
| **翻译选中文本** | 只翻译、不标注 |

### 翻译气泡的交互

- 浮窗出现在选中词**上方一行**（不够空间则下方）
- 第一行橙色：LLM 翻译
- 第二行绿色：传统翻译（如有）
- **双击任一词** → 该词持久标注在 PDF 上，带 × 可删
- "添加到笔记" → 把翻译 + 语境分析 + 例句 + 传统翻译都存到条目笔记
- 30 秒自动关闭

### 持久标注

双击翻译词后，会在原词上方留一个小标签：

```
   河岸
   ←原文 "bank"→  🏞️河岸 ×
```

× 关闭单个标注；选择其他工具/刷新页面会保留。

---

## v1.1.0 架构

### 双引擎并行

`overlay.js#translateAndAnnotate`：

```
        ┌─ LLM.chat() (慢, 上下文)
        │       ↓
        │   _parseLlmResponse()  → annotationData
        │
Promise.allSettled ─┤
        │
        │   TraditionalClient.translate()  → annotationData.traditional
        │
        ↓
   showAnnotationOnPDF(annotationData, rect)
        ↓
   两行布局 + 双击交互 + 笔记
```

`Promise.allSettled` 保证任一失败都不影响另一个：

| LLM | Traditional | 结果 |
|---|---|---|
| ✓ | ✓ | LLM 行 + 传统行 |
| ✓ | ✗ | 只有 LLM 行 |
| ✗ | ✓ | 只有传统行（synthesized minimal annotationData） |
| ✗ | ✗ | 弹错误 |

### 文件结构

```
addon/
├── manifest.json              # 1.1.0, 8 个偏好 metadata
├── bootstrap.js               # 加载 5 个 content 脚本
└── content/
    ├── llmClient.js           # OpenAI 兼容 chat()
    ├── promptBuilder.js       # 上下文 prompt
    ├── uiManager.js           # 面板 + 浮窗 + 持久标注
    ├── traditionalClient.js   # ★ 4 vendor 并行调用
    ├── overlay.js             # ★ 改写为 Promise.allSettled
    └── preferences.xhtml      # ★ 新增 Traditional Translation API groupbox

scripts/
├── build.js                   # 构建 .xpi
├── test-bootstrap.js          # 模拟 Zotero 环境冒烟
├── test-ui-helpers.js         # 6 个 UI 工具测试
├── test-ui-source-name.js     # 8 个 sourceDisplayName 测试
├── test-traditional-client.js # 41 个 vendor 单元测试
├── test-merge-logic.js        # 17 个并行合并集成测试
└── validate.js                # manifest 验证
```

### 关键设计决策

1. **并行而非顺序**：避免 LLM 慢时传统翻译空等
2. **降级而非 fail**：传统翻译失败不影响 LLM 结果，反之亦然
3. **UI 两行而非替换**：用户自己判断哪个对，LLM 仍是首选（基于全文）
4. **签名前置**：`_md5` / `_sha256` 在 Zotero 走 `Zotero.Utilities.Internal.*`，测试环境走 Node `crypto`
5. **HTML 实体解码**：Google 返回 `&quot;` 等，强制反转义
6. **超时硬限**：所有 vendor 10s timeout，失败走降级

### Vendor 签名实现

| Vendor | 算法 | 关键参数 |
|---|---|---|
| Baidu | `md5(appid + q + salt + key)` | salt = random int32 |
| Youdao | `sha256(appKey + input + salt + curtime + appSecret)` | `input` = q (≤20) 或 q[:10]+len+q[-10:] (>20) |
| Azure | header `Ocp-Apim-Subscription-Key` | body JSON `[{Text: q}]` |
| Google | `?key=...&q=...&target=...` | GET, 解码 HTML 实体 |

---

## 测试

```bash
node scripts/test-bootstrap.js           # 启动/关闭冒烟
node scripts/test-ui-helpers.js          # 6 个 UI 工具
node scripts/test-ui-source-name.js      # 8 个 sourceDisplayName
node scripts/test-traditional-client.js  # 41 个 vendor
node scripts/test-merge-logic.js         # 17 个并行合并
node scripts/validate.js                 # manifest
```

合计 **72+ 自动化断言** + 9 项手动 smoke checklist
（见 `docs/superpowers/plans/2026-06-09-smoke-checklist-v1.1.0.md`）。

---

## 已知限制

- 选中文本超过一行时浮窗定位可能偏移
- 传统翻译只取第一个意思（不消歧），仍需 LLM 提供语境
- 百度/有道对长文/多行有限制，本插件按单词/短语调用
- Ollama 等本地 LLM 必须暴露 OpenAI 兼容 `/v1/chat/completions`
- 持久标注不会同步到 Zotero annotation 数据库，刷新页面会消失

---

## 路线图

- v1.2：传统翻译引擎支持多选 + 用户自选引擎
- v1.3：标注持久化到 Zotero annotation
- v1.4：多语言 PDF（中日韩）支持

---

## 贡献

PR 欢迎。所有 vendor 在 `traditionalClient.js` 是隔离的，加一个新翻译引擎：

1. `_xxx(text, options)` 实现 + 返回 `{source, text, error}`
2. `translate()` switch 加一个 case
3. `manifest.json` preferences 加字段
4. `preferences.xhtml` 加 input
5. `uiManager.sourceDisplayName` map 加映射
6. 单元测试加一组

---

## License

MIT
