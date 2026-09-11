/** The composer's Tower-mode status chip: a display-only business-accent pill
 * beside the Access trigger, derived entirely from the host-folded `tower`
 * projection (undefined never reaches here — the bar renders the seat empty
 * while the tower capability is absent). Like the plan chip, the chip follows
 * the projection's effective target so an in-flight `/tower on` already reads
 * as the mode it selected.
 */

import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TowerProjection } from '@deepseek-ai/dsh-tower/client'
import type { ComposerBarProps } from '../contract/slots.ts'
import css from './TowerChip.module.css'

export interface TowerChipProps {
  /** The host-computed `tower` projection value. */
  tower: TowerProjection
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
}

/** The modes row's Tower status chip. */
export function TowerChip({ tower, t }: TowerChipProps) {
  if (!(tower.pending ? !tower.active : tower.active)) return null
  const titled = tower.base !== undefined
    ? t('mode.tower.title', { base: tower.base })
    : t('mode.tower.titlePlain')
  return (
    <span className={css.chip} data-composer-tower title={titled}>
      <span className={css.icon} aria-hidden>
        <IconBranchOutline16 size={14} />
      </span>
      {t('mode.tower')}
      {tower.base !== undefined && (
        <>
          <span aria-hidden className={css.dot}>·</span>
          <span className={css.base}>{tower.base}</span>
        </>
      )}
    </span>
  )
}
