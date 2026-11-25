# google-agent-kit

[English README](README.md)

一套通用、与特定 Agent 解耦的 **Google AI 全家桶（非 Antigravity 宿主插件）命令行工具集与跨 Agent 技能包**，适用于终端脚本及 Claude Code、Codex、OpenCode、Pi、Cursor、Antigravity 等任意支持 `SKILL.md` 的代理：

1. **`gemini-web`** — 通过 `ego-browser` 驱动 **Gemini Web**（`gemini.google.com/app`）：支持常规对话（`chat`）与异步 **Deep Research** 报告收割（`deep-research start/check`），自动锁定模型与思考档位并校验状态。
2. **`aistudio`** — 通过 `ego-browser` 驱动 **Google AI Studio**（`aistudio.google.com`），直接使用已登录的 Google 订阅额度（无需 API Key）：支持 1M 上下文对话（`run`/`send`/`get`）、文件与 YouTube 附件、JSON Schema 结构化输出、图片生成/编辑（`image`）、TTS 语音合成（`speech`）、Build 应用 `.zip` 导出（`build-export`）、多空间并发锁与本地用量账本（`usage`）。
3. **`gemini-api`** — 零第三方依赖的纯 Python 标准库 CLI，直接调用官方 **Gemini REST API** 与 **Gemini Decisions API**（`gemini-decision-1` 校准是非/多选/打分），支持多模态上下文、Google 搜索联网与并发 JSON 批处理。
4. **`colab-kit`** — 面向 `google-colab-cli` 的轻量封装，自动将 `--auth=adc` 放在子命令之前解决非交互授权坑，附带环境体检（`doctor`）与可选本地目录上传拦截。

> [!NOTE]
> **仓库内的两层边界说明：**
> - **官方 API / 云端 CLI 层（`gemini-api`、`colab-kit`）**：走标准 `GEMINI_API_KEY` 或 `gcloud` ADC，稳定、合规、适合无头自动化与 CI。
> - **浏览器网页驱动层（`gemini-web`、`aistudio`）**：实验性工具，复用你自己在 `ego-browser` 中的登录态。驱动绝不读取或输入密码，遇登录/人机验证会以退出码 `7` 停下交还人工处理。Google 上游网页改版可能导致 DOM 选择器失效，批量跑之前请先执行 `check`，并遵守 Google 服务条款与频率限制。

---

## 模块选型速查

| 场景 | 工具 | 依赖与鉴权 | 输出形式 |
| --- | --- | --- | --- |
| Gemini Web 对话、4–10 分钟深度调研报告 | `gemini-web` | `bun` + 已登录的 `ego-browser` | stdout 单行 JSON + `.md` 报告 |
| AI Studio Playground（长上下文、附件/YouTube、Schema、生图、TTS、Build 导出） | `aistudio` | `bun` + 已登录的 `ego-browser` | stdout 单行 JSON + 产物文件 + 本地用量账本 |
| 无头 API 推理、Google Search 联网、校准决策、批量并发 | `gemini-api` | `python3` + `GEMINI_API_KEY` | stdout 正文/JSON + stderr 元数据 JSON |
| Google Colab 云端 GPU/TPU（`A100` / `L4` / `T4` / `H100`） | `colab-kit` | `python3` + `google-colab-cli` + `gcloud` ADC | 透传 `colab` 输出 + `doctor` JSON |

---

## 快速上手

### 1. 克隆并加入 `PATH`

```bash
git clone https://github.com/lepetitprince716-prog/google-agent-kit.git
cd google-agent-kit
export PATH="$PWD/bin:$PATH"
```

或者软链到 `~/.local/bin/`：

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/"{google-agent-kit,gemini-web,aistudio,gemini-api,colab-kit} ~/.local/bin/
```

### 2. 环境自检

```bash
google-agent-kit doctor
```

按需准备对应环境即可（互不强制依赖）：
- **`gemini-web` / `aistudio`**：安装 [Bun](https://bun.sh)（`>= 1.1`）和 `ego-browser`，并在浏览器内登录 Google 账号（使用 `aistudio build-export` 时另需系统 `unzip`）。
- **`gemini-api`**：Python `>= 3.10`，设置 `GEMINI_API_KEY`（或写入 `~/.config/gemini-api/api_key`），零 pip 依赖。
- **`colab-kit`**：Python `>= 3.10`，安装 `google-colab-cli`（`uv tool install google-colab-cli`），执行一次 `gcloud auth application-default login`。

### 3. 一键安装跨 Agent 技能（可选）

```bash
# 默认安装到 ~/.agents/skills
google-agent-kit install-skills

# 或指定 Claude Code / Codex / Antigravity / OpenCode / 自定义目录
google-agent-kit install-skills --claude --codex
google-agent-kit install-skills --target /path/to/your/skills --copy
```

---

## 常用命令示例

### `gemini-web`（`gemini.google.com/app`）

```bash
# 无配额消耗自检 & 验证模型/思考档位锁定
gemini-web check
gemini-web verify-lock --model neon --thinking high --deep-research

# 常规对话（--model 支持简称，也可直接传网页下拉菜单里的精确文字如 "2.5 Pro"）
gemini-web chat --model neon --thinking high --prompt-file prompt.md --out reply.md

# 异步 Deep Research（通常耗时 4–10 分钟，发起后异步等待再收割）
gemini-web deep-research start --model neon --thinking high --prompt-file topic.md
gemini-web deep-research check --space-id 42 --out report.md

# 释放空闲浏览器空间
gemini-web close
```

### `aistudio`（`aistudio.google.com`）

```bash
# 页面金丝雀自检 & 刷新模型目录缓存
aistudio check
aistudio models --refresh

# 文本推理（支持附件、YouTube、搜索/代码工具、JSON Schema）
aistudio run --model gemini-4-neon --thinking high --prompt-file prompt.md \
  --attach repo.zip spec.pdf --youtube https://youtu.be/dQw4w9WgXcQ \
  --tools search,code --schema schema.json --out answer.md

# 续聊与回读历史轮次
aistudio send --chat https://aistudio.google.com/prompts/<id> --prompt "精简第二节" --out answer2.md
aistudio get --chat <id> --turn last --out answer.md

# 生图/改图、TTS 语音、Build 项目导出
aistudio image --model gemini-nano-banana-2.1 --prompt "等轴测技术架构图" --size 2K --aspect 16:9 --out-dir imgs/
aistudio speech --text "测试语音合成。" --voice Kira --out voice.wav
aistudio build-export --app https://aistudio.google.com/apps/<id> --out-dir exported-app/

# 查看本地用量统计 & 关闭空闲空间
aistudio usage --days 7
aistudio close
```

需要并行多开时传不同的 `--space <name>`；每个空间自动加锁，跨空间下载自动串行化。

### `gemini-api`（REST & Decisions API）

```bash
# 带上下文、图片与搜索联网的推理
gemini-api -m neon --thinking high --search --context notes.md --image chart.png -p "核查这些数据" -o review.md

# gemini-decision-1 校准决策（是非 / 多选 / 评分）
gemini-api --decision-noul "这个改动是否破坏现有 CLI 参数？" --context patch.diff
gemini-api --decision "bug=逻辑缺陷" "feat=新能力" "chore=维护" -p "修复并发锁竞态"
gemini-api --decision-score "差" "中" "优" -p "评估文档清晰度" --decision-cache cache.jsonl

# 并发批处理
gemini-api --batch jobs.json --workers 4
```

### `colab-kit`（Google Colab GPU/TPU）

```bash
colab-kit doctor
colab-kit usage
colab-kit sessions

# 推荐：一次性执行（跑完或报错自动销毁实例）
colab-kit run --gpu A100 --high-mem train.py

# 持久会话（收尾务必 stop 并核对 sessions 为 0）
colab-kit new -s eval1 --gpu L4
colab-kit upload -s eval1 ./dataset.tar /content/dataset.tar
colab-kit exec -s eval1 -f eval.py
colab-kit download -s eval1 /content/metrics.json ./metrics.json
colab-kit stop -s eval1
```

---

## 工程设计约定

- **稳定结构化协议**：`aistudio` 与 `gemini-web` 严格在 `stdout` 输出单行 JSON，日志走 `stderr`；退出码语义统一（`0` 成功、`1` 运行错误/忙碌、`2` 参数错误、`3` 页面 DOM 变动、`4` 限流/配额、`5` 安全拦截、`6` 输出截断、`7` 需人工登录或介入）。
- **状态完全外置**：锁文件、空间登记表、用量账本和模型缓存统一存放在 XDG 标准目录（`~/.local/state/google-agent-kit/` 与 `~/.cache/google-agent-kit/`），不会弄脏代码仓库。
- **跨平台锁机制**：macOS 使用内核 `O_EXLOCK`，Linux 使用带 PID 存活检测的原子 `O_CREAT|O_EXCL` 锁文件，两侧行为与单测完全一致。
- **可选目录防误传红线**：配置环境变量 `GEMINI_API_DENY_DIRS` 或 `COLAB_KIT_DENY_DIRS`（逗号分隔目录名，如 `private,secrets`）即可在读取/上传前 fail-closed 拦截。
- **隐私与密钥守门**：克隆后运行 `git config core.hooksPath .githooks` 开启本地隐私扫描与 Betterleaks 密钥门禁，详见 [PRIVACY.md](PRIVACY.md)。

---

## 本地测试

```bash
bun test packages/aistudio/tests packages/gemini-web/tests
python3 -m unittest discover -s packages/gemini-api/tests -v
python3 -m unittest discover -s packages/colab/tests -v
python3 -m unittest discover -s tests -v
```

## 协议

[Apache-2.0](LICENSE)
