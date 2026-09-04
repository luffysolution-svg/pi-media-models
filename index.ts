import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerMediaTools } from './src/tools.js'

export { CapabilityRouter } from './src/router.js'
export { MediaJob } from './src/media-job.js'
export { MediaError, redactSecrets } from './src/errors.js'
export * from './src/types.js'

export default function piMediaExtension(pi: ExtensionAPI): void {
  registerMediaTools(pi)
}
