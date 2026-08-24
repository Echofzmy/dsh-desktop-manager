import type { ManagerApi } from '../../shared/types'

declare global {
  interface Window {
    manager: ManagerApi
  }
}

export {}
