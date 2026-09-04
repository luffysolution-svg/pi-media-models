# pi-media-models

[![npm version](https://img.shields.io/npm/v/pi-media-models.svg)](https://www.npmjs.com/package/pi-media-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Provider-neutral multimodal generation extension for Pi Coding Agent.**

This extension seamlessly bridges Pi's reasoning capabilities with top-tier AI media generation platforms. It abstracts away complex multi-part uploads, background task polling, CDN hosting, and API differences, exposing exactly **6 unified tools** for the agent.

## ✨ Features

- **Live Model Discovery**: Queries configured provider catalogs, performs lightweight access probes where supported, and marks the newest usable model as the default.
- **Unified Interface**: One request format (`provider`, optional `model`, `prompt`, `referenceImages`, etc.) maps automatically to the correct capability across providers. Omit `model` to use the newest discovered usable model.
- **Config-First Authentication**: Read credentials from a global `media-models.json` file or provider environment variables; tool-call `providerOptions` cannot override credentials or endpoints.
- **Streaming Auto-Download**: Output media is streamed to `~/.pi/agent/media/outputs/`, committed with atomic `.part` renames, and rolled back on failure. The LLM receives local paths rather than media bytes or raw provider payloads.
- **Smart Input Resolution**: Pass local paths, file URIs, HTTP(S) URLs, or data URIs when the selected provider accepts uploaded/inline media. The router handles multipart, inline encoding, or fal CDN upload; URL-only provider modes fail early with a clear error.
- **Resilient Polling**: Advanced `MediaJob` processing handles asynchronous Long-Running Operations (LROs), 429 rate limits (respecting `Retry-After`), and timeouts. Supports remote job cancellation where supported by the provider.
- **Native Qwen Audio TTS**: Uses Alibaba's duplex WebSocket protocol for `qwen-audio-3.0-tts-plus` and `qwen-audio-3.0-tts-flash`, including binary audio streaming and instruction/language controls.

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
  "maxArtifactBytes": 2147483648,
  "artifactTimeoutMs": 120000,
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
    "qwencloud": {
      "apiKey": "sk-ws-xxxxxxxxxxxxxxxxxxxx"
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

> **Note**: You only need to fill in the providers you plan to use. Unused providers can simply be omitted. `dashscope` uses the China endpoint, while `qwencloud` uses the international endpoint and requires its own QwenCloud API key. Do not paste API keys into prompts or `providerOptions`; credential and endpoint overrides are accepted only from `media-models.json`. Vertex reads `project_id` from the service-account JSON when `project` is omitted or still set to a placeholder such as `my-gcp-project`; an explicit real project ID remains supported. Set `location` to `global` to use Vertex's global endpoint for models that support it.

Environment-variable fallback is also supported: `FAL_KEY`, `XAI_API_KEY`, `ATLAS_API_KEY`, `DASHSCOPE_API_KEY`, `QWENCLOUD_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `OPENROUTER_API_KEY`. Vertex also reads standard ADC/Google Cloud environment settings. QwenCloud falls back to `DASHSCOPE_API_KEY` only for backward compatibility.

Keep secrets in the global file, which is outside normal project repositories, or use environment variables. The extension does **not** edit `.gitignore`; never place secrets in a project `.pi/media-models.json` unless that file is already excluded:

```gitignore
.pi/media-models.json
```

### Custom OpenAI-Compatible Providers

You can connect any third-party or internal OpenAI-compatible media gateway by declaring it in `customProviders`:

```json
{
  "customProviders": [
    {
      "id": "my-custom-ai",
      "name": "Internal AI Gateway",
      "baseUrl": "https://api.internal.com/v1",
      "apiKeyEnv": "MY_CUSTOM_AI_API_KEY",
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

For a trusted unauthenticated local service, set `"auth": "none"` and omit `apiKeyEnv`. Custom capabilities and endpoints must always be declared explicitly.

## 🔌 Supported Providers

| Provider | Provider ID | Supported Capabilities | Config Option |
|---|---|---|---|
| **fal.ai** | `fal` | Images, Video, Audio, TTS, STT (Queue/CDN integration) | `providerOptions.fal.apiKey` |
| **xAI (Grok Imagine)** | `xai` | Image Gen/Edit; T2V/I2V; image/voice-reference video; Video Edit/Extend | `providerOptions.xai.apiKey` |
| **Atlas API** | `atlas` | Aixoras sync/async Image Gen/Edit and Video LROs | `providerOptions.atlas.apiKey` |
| **DashScope / 百炼** | `dashscope` | Qwen Image 3, Wan 3 Video, Beijing-only Fun-Music, Qwen Audio TTS/STT | `providerOptions.dashscope.apiKey` |
| **QwenCloud** | `qwencloud` | Qwen Image/Wan Video and Qwen Audio TTS/STT on international endpoints | `providerOptions.qwencloud.apiKey` |
| **OpenAI API** | `openai` | GPT Image generation/edit, TTS, STT | `providerOptions.openai.apiKey` |
| **Google Gemini API** | `gemini` | Gemini native image, Imagen generation, Veo, Gemini TTS/STT | `providerOptions.gemini.apiKey` |
| **Google Vertex AI** | `vertex` | ADC; Gemini/Imagen; Veo; Lyria; Gemini TTS/STT | `providerOptions.vertex.credentialsFile` |
| **OpenRouter** | `openrouter` | Image Generation, Async Video, TTS | `providerOptions.openrouter.apiKey` |

## 🛠️ Exposed Tools

The extension registers exactly 6 unified tools for the reasoning agent:

1. `media_models`: Discovers credential-visible models, probes access where supported, reports availability, and marks the newest usable model as the default.
2. `image_generate`: Generate images from text, image, or multiple reference inputs. `model` is optional; omission selects the newest usable discovered model.
3. `image_edit`: Edit existing images with optional masks/references when the selected provider/model supports them.
4. `video_generate`: Generate, reference, edit, or extend videos. Automatic routing distinguishes first/last frames, references, and input video; contradictory explicit operations are rejected before submission.
5. `audio_generate`: Generate music or raw audio (separate from TTS).
6. `speech_generate`: Handle TTS (Text-to-Speech) and STT (Speech-to-Text).

Live catalog discovery is implemented for Google Gemini, Vertex AI Model Garden, OpenAI, xAI, Atlas, and OpenRouter. Providers without a reliable catalog API use their declared fallback candidates; those entries are labeled `source=built-in` and `availability=unknown` rather than being presented as verified.

Normalized image controls include `background`, `outputFormat`, `quality`, and `compression`; unsupported provider/model combinations fail instead of being silently ignored. `providerOptions` is for model-native fields only, and normalized tool fields take precedence. Do not place keys, endpoints, headers, or normalized aliases inside call-level `providerOptions`.

Provider constraints still differ. OpenAI uses `resolution` rather than `aspectRatio`; DashScope/QwenCloud file transcription and Wan video/audio references require public HTTP(S) URLs; Atlas video references are also URL-only; xAI voice-reference video uses `referenceAudioVoices` preset IDs rather than audio files; and fal schemas remain endpoint-specific. Avoid forcing `providerOptions.async: true` for Qwen Image unless the account supports it. Paid POST submissions are not retried after ambiguous failures.

## 🔒 Security & Privacy

- **No Key Logging**: API keys and bearer tokens are redacted (`[REDACTED]`) from surfaced HTTP errors.
- **Payload Boundary**: Credential/routing fields and common normalized aliases are removed or rejected before provider-native payload construction.
- **Origin-Bound Auth**: Authenticated polling/download headers are never forwarded to an untrusted response origin.
- **Outbound URL Guard**: Remote inputs, provider result URLs, redirects, and resolved addresses are checked to reject embedded credentials and private/reserved network targets.
- **Local Downloads**: Media is streamed directly into the configured `outputDir`; partial and earlier outputs from a failed batch are removed. `maxArtifactBytes` defaults to 2 GiB and `artifactTimeoutMs` to 120 seconds; both are configurable.
- **Repository Safety**: No automatic `.gitignore` changes are made. Keep credential-bearing configuration outside repositories or exclude it yourself.

---

## 🔄 Updating

```bash
pi update npm:pi-media-models
```

## 📄 License

MIT
