# pi-media-models

[![npm version](https://img.shields.io/npm/v/pi-media-models.svg)](https://www.npmjs.com/package/pi-media-models)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Provider-neutral multimodal generation extension for [Pi Coding Agent](https://pi.dev). Generate images, video, audio, and speech across 9 providers with a single unified interface.

---

## Installation

Run this once in any terminal:

```bash
pi install npm:pi-media-models
```

That's it. Pi downloads the package, registers the extension, and loads the skill guide automatically. No manual configuration needed to get started.

If Pi is already running, type `/reload` in the chat to activate it in the current session.

> **Alternative:** Install directly from source
> ```bash
> pi install git:github.com/luffysolution-svg/pi-media-models
> ```

---

## Quick Start

After installation, open Pi and start chatting. No extra steps required if you have environment variables set for your chosen provider.

**Example prompts:**

```
Generate an image of a misty mountain at sunrise using fal.ai
```

```
Use xAI to create a 5-second video of ocean waves with audio
```

```
Convert this text to speech using OpenAI: "Hello, world"
```

```
What image/video providers do I have configured?
```

Pi will automatically call the right tool, handle uploads and polling, and save the result to your local disk. It reports the saved file path when done.

---

## API Key Setup

The extension reads keys from environment variables. Set whichever providers you want to use:

| Provider | Environment Variable |
|---|---|
| fal.ai | `FAL_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| xAI (Grok) | `XAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| DashScope / QwenCloud | `DASHSCOPE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Atlas | `ATLAS_API_KEY` |
| Vertex AI | `GOOGLE_APPLICATION_CREDENTIALS` (ADC) |

**macOS / Linux** — add to `~/.zshrc` or `~/.bashrc`:

```bash
export FAL_KEY="your-key"
export XAI_API_KEY="your-key"
```

**Windows** — run in PowerShell (persists across reboots):

```powershell
[System.Environment]::SetEnvironmentVariable("FAL_KEY", "your-key", "User")
[System.Environment]::SetEnvironmentVariable("XAI_API_KEY", "your-key", "User")
```

Then restart Pi (or your terminal) for the variables to take effect.

### Alternative: Config File

If you prefer not to use environment variables, create the file `~/.pi/agent/media-models.json`:

```json
{
  "providerOptions": {
    "fal": { "apiKey": "your-fal-key" },
    "xai": { "apiKey": "xai-your-key" },
    "openai": { "apiKey": "sk-your-key" }
  }
}
```

Keys in the config file take precedence over environment variables for that provider.

**Vertex AI** requires a service account JSON file path instead of an API key:

```json
{
  "providerOptions": {
    "vertex": {
      "credentialsFile": "/path/to/service-account.json",
      "project": "my-gcp-project",
      "location": "us-central1"
    }
  }
}
```

---

## Output Files

All generated media is automatically downloaded and saved to:

```
~/.pi/agent/media/outputs/
```

To use a different directory, add `outputDir` to the config file:

```json
{
  "outputDir": "/Users/alice/Pictures/ai-output"
}
```

---

## Supported Providers

| Provider | Capabilities | Env Var |
|---|---|---|
| **fal.ai** | Images, Video, Audio, TTS, STT | `FAL_KEY` |
| **xAI (Grok Imagine)** | Image gen/edit, T2V, I2V, video extend | `XAI_API_KEY` |
| **OpenAI** | Image gen/edit (DALL-E), TTS, STT (Whisper) | `OPENAI_API_KEY` |
| **Google Gemini** | Imagen, Gemini image, Veo video, Lyria audio, TTS | `GEMINI_API_KEY` |
| **Google Vertex AI** | Same as Gemini, enterprise ADC auth | ADC JSON |
| **DashScope / 百炼** | Qwen image, Wan video, music, TTS/STT | `DASHSCOPE_API_KEY` |
| **QwenCloud** | Same as DashScope (international endpoints) | `DASHSCOPE_API_KEY` |
| **OpenRouter** | Image gen, async video, TTS | `OPENROUTER_API_KEY` |
| **Atlas** | Image gen/edit, video (sync + async) | `ATLAS_API_KEY` |

To see which providers are active in your current setup, ask Pi:

```
What media providers do I have configured?
```

---

## Available Tools

The extension registers exactly 6 tools. Pi selects the correct one automatically based on your request.

| Tool | Purpose |
|---|---|
| `media_models` | List providers, models, and capabilities |
| `image_generate` | Generate images from text or reference images |
| `image_edit` | Edit an existing image (inpainting, style, background) |
| `video_generate` | Text-to-video, image-to-video, video extend/edit |
| `audio_generate` | Generate music or raw audio |
| `speech_generate` | TTS (text → audio file) or STT (audio → transcript) |

---

## Advanced: Custom OpenAI-Compatible Providers

You can add any OpenAI-compatible API as a custom provider in the config file. Capabilities and endpoints must be declared explicitly — the extension does not probe `/models` to infer them.

```json
{
  "customProviders": [
    {
      "id": "my-gateway",
      "name": "Internal AI Gateway",
      "baseUrl": "https://api.internal.example.com/v1",
      "apiKeyEnv": "MY_INTERNAL_KEY",
      "auth": "bearer",
      "models": [
        {
          "id": "internal-image-v2",
          "vendor": "internal",
          "capabilities": ["image.text_to_image"],
          "endpoints": {
            "image.text_to_image": "/images/generations"
          }
        }
      ]
    }
  ]
}
```

---

## Security

- API keys and Bearer tokens are automatically redacted (`[REDACTED]`) from all error messages and logs before being returned to the LLM context.
- The config file (`media-models.json`) is listed in `.gitignore` and is never included in the npm package.
- No telemetry. All requests go directly from your machine to the provider API.

---

## Updating

```bash
pi update npm:pi-media-models
```

---

## License

MIT
