---
name: pi-media
description: Multimodal media generation for Pi — images, video, audio, and speech across OpenAI, Gemini, Vertex AI, xAI, Atlas, DashScope, fal.ai, and OpenRouter. Use whenever the user asks to generate, edit, or transform media content of any kind.
---

# Pi Media Models

This skill activates the `pi-media-models` extension, which exposes six unified tools for multimodal generation across all configured providers. Read this skill before making any media tool call.

## Available Tools

| Tool | When to use |
|---|---|
| `media_models` | List available providers, models, and capabilities |
| `image_generate` | Generate images from text or reference images |
| `image_edit` | Edit an existing image (inpainting, style, background) |
| `video_generate` | Text-to-video, image-to-video, extend, or edit video |
| `audio_generate` | Generate music or raw audio (not TTS) |
| `speech_generate` | TTS (text → speech) or STT (audio → transcript) |

## Workflow

### 1. Discover what is configured

When the user has not specified a provider and model, call `media_models` first to see which providers have `configured: true` and which capabilities they support. Never invent model names.

```
media_models({ capability: "image.text_to_image" })
```

### 2. Call the right tool

Pick the tool that matches the request, then pass `provider`, `model`, and `prompt` at minimum. Add optional parameters as needed.

```
image_generate({
  provider: "fal",
  model: "fal-ai/flux/schnell",
  prompt: "a sunset over misty mountains",
  aspectRatio: "16:9"
})
```

### 3. Pass input files as-is

Do **not** read files yourself or convert them to base64. The extension handles all file resolution internally. Pass:

- Absolute local path: `/Users/alice/photo.jpg` or `C:\Users\alice\photo.jpg`
- File URI: `file:///Users/alice/photo.jpg`
- Remote URL: `https://example.com/image.png`
- Data URI: `data:image/png;base64,...`

```
image_edit({
  provider: "openai",
  model: "gpt-image-1",
  prompt: "remove the background",
  inputImage: "/Users/alice/photo.jpg"
})
```

### 4. Report the output path

All generated media is automatically downloaded to `~/.pi/agent/media/outputs/`. The tool returns local `path` values — show these to the user directly.

## Common Parameters

| Parameter | Description |
|---|---|
| `provider` | Provider id: `openai`, `gemini`, `vertex`, `xai`, `atlas`, `dashscope`, `qwencloud`, `fal`, `openrouter` |
| `model` | Exact model id as returned by `media_models` |
| `prompt` | Required. Describe the desired output |
| `aspectRatio` | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, etc. |
| `resolution` | `"1024x1024"`, `"720p"`, `"1080p"` |
| `duration` | Seconds (number). For video and audio |
| `generateAudio` | `true` to include audio track with video (xAI, Veo, Atlas) |
| `referenceImages` | Array of image inputs for style or subject reference |
| `inputImage` | Single input image for edit tasks |
| `inputVideo` | Input video for extend or edit tasks |
| `seed` | Integer seed for reproducibility |
| `providerOptions` | Provider-specific overrides (e.g. `{ "async": false }`) |

## Key Configuration

All API keys and provider options are configured in `~/.pi/agent/media-models.json` (or `.pi/media-models.json` in the workspace root):

```json
{
  "outputDir": "~/.pi/agent/media/outputs",
  "providerOptions": {
    "fal": { "apiKey": "fal-..." },
    "xai": { "apiKey": "xai-..." },
    "atlas": { "apiKey": "sk-..." },
    "dashscope": { "apiKey": "sk-..." },
    "openai": { "apiKey": "sk-..." },
    "gemini": { "apiKey": "AIza..." },
    "openrouter": { "apiKey": "sk-or-..." },
    "vertex": {
      "credentialsFile": "/path/to/service-account.json",
      "project": "my-gcp-project",
      "location": "us-central1"
    }
  }
}
```

Tell the user to edit `~/.pi/agent/media-models.json` directly to add or update API keys.

*(Environment variables such as `FAL_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` are also checked as a fallback).*
