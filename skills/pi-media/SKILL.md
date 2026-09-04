---
name: pi-media
description: Multimodal media generation for Pi — images, video, audio, and speech across OpenAI, Gemini, Vertex AI, xAI, Atlas, DashScope, QwenCloud, fal.ai, and OpenRouter. Use whenever the user asks to generate, edit, or transform media content of any kind.
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

When the user has not specified a provider, call `media_models` first to see which providers have `configured: true` and which capabilities they support. Never invent model names. If the provider is known but the model is not, omit `model`; the media tool discovers models, probes access where supported, and selects the newest usable model.

```
media_models({ capability: "image.text_to_image" })
```

### 2. Call the right tool

Pick the tool that matches the request. Image/video/audio generation needs `provider` and a non-empty `prompt`; TTS needs `provider`, `operation: "tts"`, and `text`; STT needs `provider`, `operation: "stt"`, and `inputAudio`. Pass `model` only when a specific model is required; otherwise omit it for automatic discovery.

```
image_generate({
  provider: "fal",
  model: "fal-ai/flux/schnell",
  prompt: "a sunset over misty mountains",
  aspectRatio: "16:9"
})
```

### 3. Pass input files as-is

Do **not** read files yourself or convert them to base64. Pass the original source. Local paths are supported when the selected provider accepts uploaded/inline data; URL-only exceptions are listed below. Accepted source syntax:

- Absolute local path: `/Users/alice/photo.jpg` or `C:\Users\alice\photo.jpg`
- File URI: `file:///Users/alice/photo.jpg`
- Remote URL: `https://example.com/image.png`
- Data URI: `data:image/png;base64,...`

```
image_edit({
  provider: "openai",
  model: "gpt-image-2",
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
| `model` | Optional exact model id as returned by `media_models`; omit to select the newest discovered usable model |
| `prompt` | Required for image/video/audio generation; not required for STT |
| `aspectRatio` | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, etc. |
| `resolution` | `"1024x1024"`, `"720p"`, `"1080p"` (DashScope/QwenCloud Wan values are normalized to documented uppercase automatically) |
| `duration` | Seconds (number). For video and audio |
| `generateAudio` | `true` to include an audio track with video (Wan, xAI, Veo, Atlas) |
| `referenceImages` | Image inputs for style or subject reference |
| `inputImage` / `endImage` | Input image or explicit first/last video frames |
| `inputVideo` | Input video for extend or edit tasks |
| `referenceAudioVoices` | Provider preset voice IDs for xAI reference-to-video; not audio paths |
| `background` | `auto`, `opaque`, or `transparent` when the model supports it |
| `outputFormat` / `quality` / `compression` | Normalized image output controls; unsupported combinations fail |
| `seed` | Integer seed for reproducibility |
| `providerOptions` | Model-native fields only; typed normalized fields take precedence |

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
    "qwencloud": { "apiKey": "sk-ws-..." },
    "openai": { "apiKey": "sk-..." },
    "gemini": { "apiKey": "AIza..." },
    "openrouter": { "apiKey": "sk-or-..." },
    "vertex": {
      "credentialsFile": "/path/to/service-account.json",
      "location": "us-central1"
    }
  }
}
```

Tell the user to edit the global `~/.pi/agent/media-models.json` or set the documented environment variable. Never ask them to paste secrets into chat or pass API keys, endpoints, headers, or normalized aliases through a tool call's `providerOptions`. The extension does not modify `.gitignore`; project-local configuration containing secrets must already be excluded. `dashscope` and `qwencloud` require separate China and international keys. Vertex reads `project_id` from ADC/service-account configuration when no real project is configured.

For Qwen Audio 3 TTS, use `qwen-audio-3.0-tts-plus` for quality or `qwen-audio-3.0-tts-flash` for latency. Plus defaults to `longanlingxin`; Flash defaults to `longanhuan_v3.6`. Voices are model-bound, so preserve an explicit user choice and let the provider reject unavailable custom voices.

## Provider Rules That Matter

- OpenAI GPT Image uses `resolution`, not `aspectRatio`; transparent output requires PNG or WebP.
- Gemini native image models return one image per request. Imagen generation supports up to four. Mask editing requires an Imagen capability/customization model.
- OpenRouter first/last frames and reference images are different modes and cannot be mixed.
- xAI accepts up to five image-edit inputs, up to seven video reference images, and up to three `referenceAudioVoices`; raw reference audio is not supported by its public reference API.
- DashScope/QwenCloud file transcription accepts a public HTTP(S) URL, not a local file or data URI. Wan 3 video/audio references are likewise URL-only.
- Atlas/Aixoras video reference media must use public HTTP(S) URLs; its documented video API has no local upload step.
- fal model schemas vary by endpoint. Put endpoint-native fields in `providerOptions`; do not guess that one fal endpoint's fields work for another.
- Explicit `video_generate.operation` must match its inputs: edit/extend require `inputVideo`, reference requires references, and `endImage` requires `inputImage`.

*(Environment variables such as `FAL_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `DASHSCOPE_API_KEY`, and `QWENCLOUD_API_KEY` are also checked as a fallback).*
