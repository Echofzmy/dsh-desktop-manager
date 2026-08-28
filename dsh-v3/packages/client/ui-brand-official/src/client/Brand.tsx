import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return <FishLogo size={size} className={className} />
}

function instanceName(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const value = new URLSearchParams(window.location.search).get('dsh-instance')?.trim()
  return value || undefined
}

/**
 * Render the fixed dsh label and the manager-provided instance name.
 * @returns the instance-aware brand label.
 */
export function OfficialBrandName() {
  const name = instanceName()
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><span>dsh</span>{name && <span style={{ padding: '2px 7px', borderRadius: 4, background: '#111', color: '#fff', fontSize: '0.78em', fontWeight: 600, lineHeight: 1.4 }}>{name}</span>}</span>
}
