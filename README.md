# pi-media-models

[![npm version](https://img.shields.io/npm/v/pi-media-models.svg)](https://www.npmjs.com/package/pi-media-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Provider-neutral multimodal generation extension for Pi Coding Agent.**

This extension seamlessly bridges Pi's reasoning capabilities with top-tier AI media generation platforms. It abstracts away complex multi-part uploads, background task polling, CDN hosting, and API differences, exposing exactly **6 unified tools** for the agent.

## ✨ Features

- **Live Model Discovery**: Queries configured provider catalogs, performs lightweight access probes where supported, and marks the newest usable model as the default.
- **Unified Interface**: One request format (`provider`, optional `model`, `prompt`, `referenceImages`, etc.) maps automatically to the correct capability across providers. Omit `model` to use the newest discovered usable model.
- **Config-First Authentication**: Manage all API keys and credentials directly in a single `media-models.json` configuration file — no cluttered environment variables needed.
- **Auto-Download**: Output media (images, videos, audio) is automatically downloaded and saved to a local directory (`~/.pi/agent/media/outputs/`) using atomic `.part` renames. LLM context remains pristine and only receives local file paths.
- **Smart Input Resolution**: Pass local paths (`C:/...` or `/path/...`), file URIs (`file://`), standard URLs (`http(s)://`), or base64 (`data:...`). The router transparently handles multipart uploads, base64 encoding, or CDN pre-uploading (e.g., for `fal.ai`).
- **Resilient Polling**: Advanced `MediaJob` processing handles asynchronous Long-Running Operations (LROs), 429 rate limits (respecting `Retry-After`), and timeouts. Supports remote job cancellation where supported by the provider.

## 📦 Installation

This extension is built for the **Pi Coding Agent**. It bundles both the executable extension logic and the LLM `SKILL.md` prompt context.

Install natively inside your Pi environment:

```bash
# Install via NPM (Recommended)
pi install npm:pi-media-models

# Or install directly from GitHub
pi install git:github.com/luffysolution-svg/pi-media-models
```

Once installed, restart Pi or type `/reload` in your active session.

## 🚀 Quick Usage

After installation, the extension and its companion skill are active immediately. You can talk to Pi naturally — Pi knows how to query available models and route tasks to the appropriate tool.

**Example Prompts:**

```
帮我用 fal.ai 画一张赛博朋克风格的雨夜街景，比例 16:9
```

```
Use xAI to generate a 5-second video of ocean waves with audio
```

```
使用 Atlas 编辑这张图片，把背景换成雪山：C:/assets/photo.jpg
```

```
帮我查一下当前已配置好可用的多模态模型有哪些？
```

Pi 会自动调取对应工具、完成排队轮询与文件下载，并直接返回本地媒体文件的保存路径。

## ⚙️ Configuration

All API keys, custom endpoints, and output paths are configured directly in a single JSON file.

**Configuration File Location:**
- **Global (Recommended):** `~/.pi/agent/media-models.json`
- **Project-Specific:** `<project_root>/.pi/media-models.json`

### Example `media-models.json`

Create or edit `~/.pi/agent/media-models.json`:

```json
{
  "outputDir": "~/.pi/agent/media/outputs",
  "providerOptions": {
    "fal": {
      "apiKey": "fal-xxxxxxxxxxxxxxxxxxxx"
    },
    "xai": {
      "apiKey": "xai-xxxxxxxxxxxxxxxxxxxx"
    },
    "atlas": {
      "apiKey": "sk-xxxxxxxxxxxxxxxxxxxx"
    },
    "dashscope": {
      "apiKey": "sk-xxxxxxxxxxxxxxxxxxxx"
    },
    "openai": {
      "apiKey": "sk-xxxxxxxxxxxxxxxxxxxx"
    },
    "gemini": {
      "apiKey": "AIzaxxxxxxxxxxxxxxxxxxxx"
    },
    "openrouter": {
      "apiKey": "sk-or-xxxxxxxxxxxxxxxxxxxx"
    },
    "vertex": {
      "credentialsFile": "/path/to/vertex-service-account.json",
      "location": "us-central1"
    }
  }
}
```

> **Note**: You only need to fill in the providers you plan to use. Unused providers can simply be omitted. Vertex reads `project_id` from the service-account JSON when `project` is omitted or still set to a placeholder such as `my-gcp-project`; an explicit real project ID remains supported.

### Custom OpenAI-Compatible Providers

You can connect any third-party or internal OpenAI-compatible media gateway by declaring it in `customProviders`:

```json
{
  "customProviders": [
    {
      "id": "my-custom-ai",
      "name": "Internal AI Gateway",
      "baseUrl": "https://api.internal.com/v1",
      "auth": "bearer",
      "models": [
        {
          "id": "internal-video-pro",
          "vendor": "internal",
          "capabilities": ["video.text_to_video"],
          "endpoints": {
            "video.text_to_video": "/videos/generations"
          }
        }
      ]
    }
  ]
}
```

## 🔌 Supported Providers

| Provider | Provider ID | Supported Capabilities | Config Option |
|---|---|---|---|
| **fal.ai** | `fal` | Images, Video, Audio, TTS, STT (Queue/CDN integration) | `providerOptions.fal.apiKey` |
| **xAI (Grok Imagine)** | `xai` | Image Gen/Edit, T2V/I2V, Reference-to-Video, Video Extend | `providerOptions.xai.apiKey` |
| **Atlas API** | `atlas` | Sync/Async Image Gen & Edit, Video LROs | `providerOptions.atlas.apiKey` |
| **DashScope / 百炼** | `dashscope` | Qwen/Wan Images, Wan Video, Fun-Music, TTS/STT | `providerOptions.dashscope.apiKey` |
| **QwenCloud** | `qwencloud` | Same as DashScope (International endpoints) | `providerOptions.qwencloud.apiKey` |
| **OpenAI API** | `openai` | Image Gen/Edit (DALL-E), TTS, STT (Whisper) | `providerOptions.openai.apiKey` |
| **Google Gemini API** | `gemini` | Gemini/Imagen, Veo, Lyria, TTS, STT | `providerOptions.gemini.apiKey` |
| **Google Vertex AI** | `vertex` | ADC, Imagen/Gemini, Veo, Lyria, TTS, STT | `providerOptions.vertex.credentialsFile` |
| **OpenRouter** | `openrouter` | Image Generation, Async Video, TTS | `providerOptions.openrouter.apiKey` |

## 🛠️ Exposed Tools

The extension registers exactly 6 unified tools for the reasoning agent:

1. `media_models`: Discovers credential-visible models, probes access where supported, reports availability, and marks the newest usable model as the default.
2. `image_generate`: Generate images from text, image, or multiple reference inputs. `model` is optional; omission selects the newest usable discovered model.
3. `image_edit`: Edit existing images (supports masks and multiple references).
4. `video_generate`: Generates, edits, or extends videos. Automatically maps inputs (`referenceImages`, `inputVideo`, `duration`, `generateAudio`, etc.) to the provider's exact capability.
5. `audio_generate`: Generate music or raw audio (separate from TTS).
6. `speech_generate`: Handle TTS (Text-to-Speech) and STT (Speech-to-Text).

Live catalog discovery is implemented for Google Gemini, Vertex AI Model Garden, OpenAI, xAI, Atlas, and OpenRouter. Providers without a reliable catalog API use their declared fallback candidates; those entries are labeled `source=built-in` and `availability=unknown` rather than being presented as verified.

## 🔒 Security & Privacy

- **No Key Logging**: API keys and Bearer tokens are redacted (`[REDACTED]`) from all error logs and HTTP outputs before being returned to the LLM.
- **Local Downloads**: Media assets are fetched directly by your local client into your configured `outputDir` without third-party proxies.
- **Git Ignored**: `media-models.json` is automatically ignored from git repositories to prevent accidental credential commits.

---

## 🔄 Updating

```bash
pi update npm:pi-media-models
```

## 📄 License

MIT
