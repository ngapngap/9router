<div align="center">

  <img src="./images/9router.png" alt="9Router Dashboard" width="220"/>

  # 9Router

  ### Một endpoint cho mọi AI provider — không bao giờ ngừng code.

  <p>
    <strong>40+ providers · 100+ models · RTK tiết kiệm 20–40% tokens</strong><br/>
    <sub>Subscription → Cheap → Free · Tự động fallback · Một endpoint OpenAI-compatible cho mọi CLI tool</sub>
  </p>

  <p>
    <a href="https://github.com/ngapngap/9router/releases"><img src="https://img.shields.io/badge/Release-latest-blue" alt="Release"/></a>
    <a href="https://github.com/ngapngap/9router/actions/workflows/docker-master.yml"><img src="https://img.shields.io/badge/CI-passing-green" alt="CI"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License MIT"/></a>
  </p>

  <p>
    <a href="#quick-start">⚡ Quick Start</a> ·
    <a href="#providers">🌐 Providers</a> ·
    <a href="#features">💡 Tính năng</a> ·
    <a href="#docs">📖 Tài liệu</a>
  </p>

</div>

---

> [!NOTE]
> Đây là **fork ngapngap/9router** của [decolua/9router](https://github.com/decolua/9router). Ngoài các provider của upstream, fork này bổ sung thêm:
> - `autoclaw` — **AutoClaw** (OAuth)
> - `workbuddy` · `workbuddy-ai` — **WorkBuddy & WorkBuddy AI** (OAuth)

---

## 🤔 Vì sao cần 9Router?

| ❌ Vấn đề | ✅ Giải pháp |
|---|---|
| Subscription hết hạn không dùng hết quota | Theo dõi quota realtime, dùng hết trước khi reset |
| Rate limit dừng bạn giữa chừng | Fallback 3 tầng: Subscription → Cheap → Free |
| Tool outputs đốt token (git diff, grep, ls…) | **RTK Token Saver** nén trước khi gửi LLM — tiết kiệm 20–40% input tokens |
| API đắt, chuyển provider thủ công | **Combos** — một tên gọi nhiều model, tự chuyển khi lỗi/hết quota |
| Mỗi CLI tool một format | **Format translation** — một endpoint `/v1` cho mọi tool |

---

## ⚡ Quick Start

### 1. Chạy

**Docker (khuyên dùng):**

```bash
docker pull ghcr.io/ngapngap/9router:latest
docker run -d --name 9router -p 20128:20128 -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data ghcr.io/ngapngap/9router:latest
```

**Từ source:**

```bash
cp .env.example .env   # sửa JWT_SECRET + INITIAL_PASSWORD
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

> Dashboard: `http://localhost:20128/dashboard` · API: `http://localhost:20128/v1`

### 2. Kết nối provider

Dashboard → **Providers** → chọn provider → login / dán API key. Xong.

### 3. Trỏ CLI tool về 9Router

```
Endpoint : http://localhost:20128/v1
API Key  : [copy từ dashboard]
Model    : kr/claude-sonnet-4.5   (hoặc tên combo của bạn)
```

Ví dụ combo free:

```
free-forever
  1. kr/claude-sonnet-4.5   # Kiro free
  2. kr/glm-5
  3. oc/<auto>              # OpenCode Free, không cần auth
```
→ **$0/tháng + RTK tiết kiệm 20–40% tokens.**

---

## 🌐 Providers

### 🔐 OAuth (subscription)

Claude Code · Codex · GitHub Copilot · Cursor · Antigravity · Kimchi · **AutoClaw** · **WorkBuddy / WorkBuddy AI**

### 🆓 Free

| Provider | Ghi chú |
|---|---|
| **Kiro AI** | Claude 4.5 + GLM-5 + MiniMax · ~50 credits/tháng free |
| **OpenCode Free** | Không cần auth, model tự fetch |
| **Vertex AI** | $300 credits cho GCP account mới |

### 🔑 API key (40+)

OpenRouter · GLM · Kimi · MiniMax · OpenAI · Anthropic · Gemini · DeepSeek · Groq · xAI · Mistral · Together · Fireworks · Cerebras · Cohere · NVIDIA · SiliconFlow · … + mọi endpoint OpenAI/Anthropic-compatible tự host.

### 🛠️ CLI tools hỗ trợ

Claude Code · Codex · Cursor · OpenClaw · Cline · Continue · Roo · Kilo Code · OpenCode · Antigravity · Continue · Copilot · Qwen Code · DeepSeek TUI · Droid · jcode · …

> Xem danh sách + nút Apply 1-click trong dashboard → **CLI Tools**.

---

## 💡 Tính năng

| Tính năng | Gì vậy? |
|---|---|
| 🚀 **RTK Token Saver** | Nén `tool_result` trước khi gửi LLM — **−20–40% input tokens**. Bỏ qua 1 request: header `X-9Router-Token-Saver: off` |
| 🧠 **Headroom** | Proxy `/v1/compress` ngoài để nén thêm context |
| 🪨 **Caveman / Ponytail** | Prompt khiến LLM trả lời ngắn gọn / code tối thiểu — **−65% output tokens** |
| 🎯 **Combos + 3-Tier Fallback** | Subscription → Cheap → Free, tự chuyển khi hết quota hoặc lỗi |
| 📊 **Quota Tracking realtime** | Token count + đếm ngược reset (5h / daily / weekly) |
| 🔄 **Format Translation** | OpenAI ↔ Claude ↔ Gemini ↔ Cursor ↔ Kiro ↔ Vertex… |
| 👥 **Multi-Account** | Nhiều account/provider, tự round-robin / fallback |
| 🔄 **Auto Token Refresh** | OAuth token tự refresh, không cần login lại |
| 💾 **Cloud Sync** | Đồng bộ config nhiều thiết bị |
| 🏠 **Self-hosted STT/TTS/Embedding** | whisper.cpp, llama.cpp, vLLM… qua `/v1/audio/*` & `/v1/embeddings` |

---

## 🚀 Deploy

| Cách | Lệnh |
|---|---|
| Docker | `docker run -d -p 20128:20128 -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data ghcr.io/ngapngap/9router:latest` |
| Source (production) | `npm run build` rồi `PORT=20128 HOSTNAME=0.0.0.0 npm run start` |
| VPS + PM2 | `pm2 start npm --name 9router -- start` |

Biến môi trường quan trọng (xem [`.env.example`](.env.example)):

| Biến | Ghi chú |
|---|---|
| `JWT_SECRET` | **Bắt buộc đổi** — secret ký session cookie |
| `INITIAL_PASSWORD` | **Bắt buộc đổi** — password login đầu tiên (mặc định `123456`) |
| `DATA_DIR` | Nơi lưu SQLite (mặc định `~/.9router`) |
| `PORT` | Cổng service (mặc định `20128` trong ví dụ) |
| `BASE_URL` / `CLOUD_URL` | Cho cloud sync scheduler |

---

## 📖 Tài liệu

| File | Nội dung |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Kiến trúc: vòng đời request, combo/account fallback, OAuth+refresh, cloud sync, data model |
| [`open-sse/AGENTS.md`](open-sse/AGENTS.md) | Engine routing/translation — cách thêm provider/executor/translator |
| [`CHANGELOG.md`](CHANGELOG.md) | Lịch sử release |
| [`.env.example`](.env.example) | Contract biến môi trường |

---

## 🙏 Acknowledgments

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — bản Go gốc truyền cảm hứng cho port JS này.
- **[RTK](https://github.com/rtk-ai/rtk)** — Rust token-saver, 9Router port sang JS → **−20–40% input tokens**.
- **[Caveman](https://github.com/JuliusBrussee/caveman)** by [@JuliusBrussee](https://github.com/JuliusBrussee) — prompt "few token do trick" → **−65% output tokens**.
- **[Ponytail](https://github.com/DietrichGebert/ponytail)** by [@DietrichGebert](https://github.com/DietrichGebert) — "lazy senior dev" → ít token, ít code hơn.

---

## 📄 License

MIT License — xem [LICENSE](LICENSE).

---

<div align="center">
  <sub>Fork ngapngap/9router · Dựa trên <a href="https://github.com/decolua/9router">decolua/9router</a> · Phần mềm free, không thu phí — bạn chỉ trả cho provider bạn dùng trực tiếp</sub>
</div>
