/** Authoring problems on the canvas: the Flow map chip and the band for those no step can show. */

import { AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'
import { localizeAuthoringProblem, type AuthoringProblem } from './authoring-problems'
import { openAuthoringProblem, openAuthoringProblemsList } from './open-authoring-problem'
import { Button } from './ui/Button'

const BAND_LIMIT = 2

export function CanvasProblemsChip({ problems }: { problems: AuthoringProblem[] }) {
  const { t } = useT()
  if (problems.length === 0) return null
  return (
    <Button
      size="sm"
      className="canvas-problems-chip"
      data-severity={problems[0].severity}
      data-testid="canvas-problems-chip"
      onClick={openAuthoringProblemsList}
    >
      {t('problems.title')} <b>{problems.length}</b>
    </Button>
  )
}

export function CanvasProblemsBand({ problems }: { problems: AuthoringProblem[] }) {
  const { t } = useT()
  const unplaced = problems.filter((problem) => !problem.nodeId)
  if (unplaced.length === 0) return null
  const overflow = unplaced.length - BAND_LIMIT
  return (
    <div
      className="canvas-problems-band"
      role="group"
      aria-label={t('problems.title')}
      data-severity={unplaced[0].severity}
      data-testid="canvas-problems-band"
    >
      <AlertTriangle size={13} aria-hidden="true" />
      {unplaced.slice(0, BAND_LIMIT).map((problem) => {
        const message = localizeAuthoringProblem(problem)
        return (
          <Button
            key={problem.id}
            variant="ghost"
            size="sm"
            title={message}
            data-testid={`canvas-problem-${problem.code}`}
            onClick={() => openAuthoringProblem(problem)}
          >
            {message}
          </Button>
        )
      })}
      {overflow > 0 && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('problems.title')}
          data-testid="canvas-problems-more"
          onClick={openAuthoringProblemsList}
        >
          +{overflow}
        </Button>
      )}
    </div>
  )
}
