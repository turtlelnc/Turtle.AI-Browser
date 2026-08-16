import type { TibrowserApi } from '../shared/api'

declare global {
  interface Window {
    tibrowser: TibrowserApi
  }
}

export {}
