# pi-media-models

[![npm version](https://img.shields.io/npm/v/pi-media-models.svg)](https://www.npmjs.com/package/pi-media-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Provider-neutral multimodal generation extension for Pi Coding Agent.**

This extension seamlessly bridges Pi's reasoning capabilities with top-tier AI media generation platforms. It abstracts away complex multi-part uploads, background task polling, CDN hosting, and API differences, exposing exactly **6 unified tools** for the agent.

## ✨ Features

- **Unified Interface**: One request format (`provider`, `model`, `prompt`, `referenceImages`, etc.) maps automatically to the correct capability across providers.
- **Auto-Download**: Output media (images, videos, audio) is automatically downloaded and saved to a local directory (`~/.pi/agent/media/outputs/`) using atomic `.part` renames. LLM context remains pristine and only receives local file paths.
- **Smart Input Resolution**: Pass local paths (`C:/...`), file URIs (`file://`), standard URLs (`http(s)://`), or base64 (`data:...`). The router transparently handles multipart uploads, base64 encoding, or CDN pre-uploading (e.g., for `fal.ai`).
- **Resilient Polling**: Advanced `MediaJob` processing handles asynchronous Long-Running Operations (LROs), 429 rate limits (respecting `Retry-After`), and timeouts. Supports remote job cancellation where supported by the provider.

## 📦 Installation

This extension is built for the **Pi Coding Agent**. It includes both the executable extension logic and the LLM `SKILL.md` prompt context.

Install natively inside your Pi environment:

```bash
# Install via NPM (Recommended)
pi install npm:pi-media-models

# Or install directly from GitHub
pi install git:github.com/luffysolution-svg/pi-media-models
```

Once installed, simply type `/reload` in your active Pi session to apply the extension.

## 🔌 Supported Providers

| Provider | Adapter | Supported Capabilities | Required Env Var |
|---|---|---|---|
| **OpenRouter** | `OpenRouterAdapter` | Image Generation, Async Video, TTS | `OPENROUTER_API_KEY` |
| **fal.ai** | `FalAdapter` | Images, Video, Audio, TTS, STT (Queue/CDN integration) | `FAL_KEY` |
| **Google Gemini API** | `GoogleMediaAdapter` | Gemini/Imagen, Veo, Lyria, TTS, STT | `GEMINI_API_KEY` |
| **Google Vertex AI** | `GoogleMediaAdapter` | ADC, Imagen/Gemini, Veo, Lyria, TTS, STT | ADC credentials |
| **DashScope / 百炼** | `DashScopeAdapter` | Qwen/Wan Images, Wan Video, Fun-Music, TTS/STT | `DASHSCOPE_API_KEY` |
| **QwenCloud** | `DashScopeAdapter` | Same as DashScope (International endpoints) | `DASHSCOPE_API_KEY` |
| **OpenAI API** | `OpenAIAdapter` | Image Gen/Edit (DALL-E), TTS, STT (Whisper) | `OPENAI_API_KEY` |
| **xAI (Grok Imagine)** | `XAIAdapter` | Image Gen/Edit, T2V/I2V, Reference-to-Video, Edit, Extend | `XAI_API_KEY` |
| **Atlas API** | `AtlasAdapter` | Sync/Async Image Gen & Edit, Video LROs | `ATLAS_API_KEY` |

## ⚙️ Configuration

API Keys can be provided as standard environment variables. Alternatively, you can configure them (along with advanced options) via JSON configuration.

**Configuration Path**: 
`~/.pi/agent/media-models.json` (Global) or `<project_root>/.pi/media-models.json` (Project-specific).

```json
{
  "outputDir": "/path/to/custom/output/directory",
  "providerOptions": {
    "vertex": {
      "credentialsFile": "/path/to/vertex-service-account.json",
      "project": "my-gcp-project",
      "location": "us-central1"
    },
    "dashscope": {
      "baseUrl": "https://<workspace_id>.cn-beijing.maas.aliyuncs.com"
    }
  },
  "customProviders": [
    {
      "id": "my-custom-ai",
      "name": "Internal AI Gateway",
      "baseUrl": "https://api.internal.com/v1",
      "apiKeyEnv": "MY_INTERNAL_KEY",
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

*Note: Custom OpenAI-compatible endpoints require explicit capability mapping in the configuration, avoiding hallucinated unsupported paths from standard `/models` probing.*

## 🛠️ Exposed Tools

The extension registers the following unified tools for the reasoning agent:

1. `media_models`: Lists providers, configured models, and capabilities.
2. `image_generate`: Generate images from text, image, or multiple reference inputs.
3. `image_edit`: Edit existing images (supports masks and multiple references).
4. `video_generate`: Generates, edits, or extends videos. Automatically maps inputs (`referenceImages`, `inputVideo`, `duration`, `generateAudio`, etc.) to the provider's exact capability.
5. `audio_generate`: Generate music or raw audio (separate from TTS).
6. `speech_generate`: Handle TTS (Text-to-Speech) and STT (Speech-to-Text).

## 🔒 Security & Privacy

- **No Key Logging**: API keys and Bearer tokens are redacted (`[REDACTED]`) from all error logs and HTTP outputs before being returned to the LLM.
- **Stateless Configuration**: Configuration does not hardcode user secrets if initialized via environment variables.

---
*Built for production multimodal orchestration inside Pi.*
