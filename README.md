# pi-media-models

Pi Coding Agent 的 Provider-neutral 多模态生成 Extension。只注册 6 个稳定 Tool；模型和 Provider 的变化被隔离在 Capability Router 与 Adapter 内。

## 架构

```text
Pi Tool
  → Capability Router
    → Provider Adapter (Provider 与模型厂商分离)
      → MediaJob (poll/backoff/timeout/AbortSignal/cancel-if-supported)
        → Normalized Result
          → Download (~/.pi/agent/media/outputs, .part + atomic rename)
```

Provider 原始大 JSON 不进入 LLM 上下文。Tool 只返回 Provider/模型、capability、任务 ID（如有）、本地文件路径或 STT 文本。

## Tools

- `media_models`：列出 Provider、已知模型/厂商和显式 capability。
- `image_generate`：文生图、图生图、多参考图。
- `image_edit`：图片编辑、多图编辑、mask（按 Provider 支持情况）。
- `video_generate`：统一参数 `prompt`、`provider`、`model`、`inputImage`、`endImage`、`referenceImages`、`referenceVideos`、`referenceAudios`、`inputVideo`、`duration`、`resolution`、`aspectRatio`、`seed`、`generateAudio`、`operation`、`providerOptions`；自动映射 T2V/I2V/首尾帧/reference/edit/extend。
- `audio_generate`：音乐或模型原生音频生成（不是 TTS）。
- `speech_generate`：`operation=tts|stt`。

所有输入文件字段接受本地路径、`file://`、`http(s)://` 和 data URI。Adapter 会按接口转为 data URI、base64、multipart 或上传 URL。fal 本地输入先上传 fal CDN；需要公网 URL 且没有文档化上传接口的 Provider 会使用 data URI，最终是否接受仍取决于具体模型。

## Provider

| Provider | Adapter | 能力摘要 | Key |
|---|---|---|---|
| OpenRouter | `OpenRouterAdapter` | Images API、视频异步任务、TTS | `OPENROUTER_API_KEY` |
| fal.ai | `FalAdapter` | 任意 endpoint 的图片/视频/音频/TTS/STT；Queue + CDN upload | `FAL_KEY` |
| 百炼/DashScope | `DashScopeAdapter` | Qwen/Wan 图片、Wan 视频参考/编辑/延长/原生音频、Fun-Music、TTS/STT | `DASHSCOPE_API_KEY` |
| QwenCloud | `DashScopeAdapter`（国际 endpoint） | 同 DashScope 协议 | `DASHSCOPE_API_KEY` |
| OpenAI API | `OpenAIAdapter` | 图片生成/编辑、TTS/STT；**不实现 Sora/OpenAI Video** | `OPENAI_API_KEY` |
| Gemini API | `GoogleMediaAdapter` | Gemini/Imagen 图片、Veo、Lyria、TTS/STT | `GEMINI_API_KEY` |
| Vertex AI | `GoogleMediaAdapter` | ADC、Imagen/Gemini、Veo、Lyria、TTS/STT | ADC |
| xAI | 独立 `XAIAdapter` | Grok Imagine 图片生成/多图编辑、T2V/I2V/reference-to-video、video edit/extend | `XAI_API_KEY` |
| Atlas | 独立 `AtlasAdapter` | 文档化图片同步/异步/编辑、视频任务及 reference image/video/audio、原生音频 | `ATLAS_API_KEY` |
| 自定义 OpenAI-compatible | `CustomOpenAICompatibleAdapter` | 仅用户显式声明的 model/capability/endpoint | 用户声明的 env 名 |

## 安装

本目录已位于 Pi 全局自动发现位置：

```bash
cd ~/.pi/agent/extensions/pi-media
npm install
npm run check
```

在 Pi 中运行 `/reload`，或启动时显式加载：

```bash
pi -e ~/.pi/agent/extensions/pi-media/index.ts
```

生成结果默认立即下载到：

```text
~/.pi/agent/media/outputs/
```

## 配置

API Key 只从环境变量读取，不写 JSON。可选配置：

- 全局：`~/.pi/agent/media-models.json`
- 项目：`<repo>/.pi/media-models.json`（只有 Pi 信任项目后才读取）

```json
{
  "outputDir": "D:/media-output",
  "providerOptions": {
    "dashscope": {
      "baseUrl": "https://WORKSPACE_ID.cn-beijing.maas.aliyuncs.com"
    }
  },
  "customProviders": [
    {
      "id": "my-media",
      "name": "My explicit media gateway",
      "baseUrl": "https://media.example.com/v1",
      "apiKeyEnv": "MY_MEDIA_API_KEY",
      "auth": "bearer",
      "models": [
        {
          "id": "vendor/image-model",
          "vendor": "vendor",
          "capabilities": ["image.text_to_image"],
          "endpoints": {
            "image.text_to_image": "/images/generations"
          }
        },
        {
          "id": "vendor/video-model",
          "vendor": "vendor",
          "capabilities": ["video.text_to_video"],
          "endpoints": {
            "video.text_to_video": {
              "path": "/videos",
              "format": "json",
              "async": {
                "idPath": "id",
                "statusPath": "status",
                "pollEndpoint": "/videos/{id}",
                "resultPath": "result",
                "cancelEndpoint": "/videos/{id}/cancel",
                "successValues": ["completed"],
                "failureValues": ["failed", "cancelled"]
              }
            }
          }
        }
      ]
    }
  ]
}
```

自定义 Provider **不会**请求或信任 `GET /models` 来推断能力；每个模型必须同时声明 `capabilities` 与对应 `endpoints`。

## 使用示例

先调用 `media_models` 查看 capability，再调用统一 Tool。例如：

```json
{
  "provider": "xai",
  "model": "grok-imagine-video-1.5",
  "prompt": "A paper boat drifting down a rainy street",
  "inputImage": "C:/assets/boat.png",
  "duration": 8,
  "resolution": "720p",
  "aspectRatio": "16:9",
  "generateAudio": true
}
```

Atlas 多模态 reference-to-video：

```json
{
  "provider": "atlas",
  "model": "bytedance/seedance-2.0/text-to-video",
  "prompt": "Product launch film",
  "referenceImages": ["https://example.com/product.png"],
  "referenceVideos": ["https://example.com/motion.mp4"],
  "referenceAudios": ["https://example.com/voice.mp3"],
  "generateAudio": true
}
```

## 安全与可靠性

- Key 仅取环境变量；错误消息自动脱敏，不记录请求头或完整 Provider JSON。
- HTTP 请求有超时；幂等请求对 429/5xx 退避重试并尊重 `Retry-After`。为避免重复计费，非幂等生成 POST 默认不自动重试。
- 异步任务统一支持 polling、backoff、总超时和 `AbortSignal`；仅在 Provider 文档明确提供 cancel 时调用远端取消（fal、DashScope、自定义显式 cancel）。
- 测试进程设置 `PI_MEDIA_TEST_MODE=1`，未注入 mock fetch 时真实网络请求会直接失败，避免付费误调用。

## 已知限制

- 媒体模型与参数变化很快；`media_models` 中内置列表是已知入口，不是实时价格/可用性保证。具体模型、区域和账户权限仍由 Provider 校验。
- fal 的输入/输出 schema 按 endpoint 变化，通用字段可通过 `providerOptions` 覆盖；应按所选 endpoint 文档传原生字段。
- xAI 官方未公开视频任务 cancel；中止只停止本地 polling。自定义音频 reference 可能要求 trusted-partner 权限。
- Gemini/Veo 和 Atlas 未公开视频任务 cancel。Atlas 文档未声明独立 TTS/STT、视频 edit/extend，因此不虚构这些 capability。
- Vertex Veo REST 使用 `:fetchPredictOperation`；GCS 输出需要调用身份有对象读取权限。建议配置 Provider 原生输出到可读 GCS 或返回 base64。
- 本仓库测试不进行真实付费生成；真实 Key、配额、内容策略和临时 URL 生命周期需在用户明确授权后做 smoke test。

## 文档基线

Atlas 以用户指定的 <https://doc.aixoras.com/jieruwendang/1-jiekouwendang.html> 为准。其余实现基于 OpenAI、OpenRouter、fal.ai、Alibaba/QwenCloud、Google/Vertex 和 xAI 官方文档（检查日期：2026-08-31）。
