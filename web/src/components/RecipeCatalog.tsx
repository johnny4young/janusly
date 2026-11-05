import { ArrowRight } from 'lucide-react'
import { Fragment } from 'react'
import { getNodeLabel } from '../constants'
import { useT } from '../i18n'
import { tTemplateCategory, tTemplateDescription, tTemplateName } from '../i18n/server-events'
import type { Template, WorkflowDefinition } from '../types'
import { Button } from './ui/Button'
import { workflowNodeIcon } from './workflow-node-icons'

const ALL_CATEGORIES = 'all'

function categoryKey(template: Template): string {
  return template.categoryCode ?? template.category
}

/** Category chips over the recipe grid. Chips come from `templates` so a search
 * never removes one; their counts come from `matches`, the search result. */
export function RecipeCatalog({
  templates,
  matches,
  category,
  onCategoryChange,
  canUse,
  onUseTemplate,
}: {
  templates: Template[]
  matches: Template[]
  category: string
  onCategoryChange: (category: string) => void
  canUse: boolean
  onUseTemplate: (workflow: WorkflowDefinition) => void
}) {
  const { t } = useT()
  const labels = new Map<string, string>()
  for (const template of templates) {
    if (!labels.has(categoryKey(template))) labels.set(categoryKey(template), tTemplateCategory(template))
  }
  const counts = new Map<string, number>()
  for (const template of matches) {
    counts.set(categoryKey(template), (counts.get(categoryKey(template)) ?? 0) + 1)
  }
  const active = labels.has(category) ? category : ALL_CATEGORIES
  const visible = active === ALL_CATEGORIES ? matches : matches.filter(template => categoryKey(template) === active)
  const chips: Array<[string, string, number]> = [
    [ALL_CATEGORIES, t('rightPanel.templates.allCategories'), matches.length],
    ...[...labels].map(([key, label]): [string, string, number] => [key, label, counts.get(key) ?? 0]),
  ]

  return (
    <section className="we-recipe-catalog">
      <div className="we-recipe-catalog__chips" role="group" aria-label={t('rightPanel.templates.categoryAria')}>
        {chips.map(([key, label, count]) => (
          <Button
            key={key}
            size="sm"
            aria-pressed={active === key}
            onClick={() => onCategoryChange(key)}
            data-testid={`template-category-${key}`}
          >
            {label} <strong>{count}</strong>
          </Button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="helper-text">{t('rightPanel.templates.noRecipeMatches')}</p>
      ) : (
        <div className="we-recipe-catalog__grid">
          {visible.map(template => (
            <button
              key={template.id}
              type="button"
              className="list-card list-card-button we-recipe-card"
              disabled={!canUse}
              onClick={() => onUseTemplate(template.workflow)}
              data-testid={`template-recipe-${template.id}`}
            >
              <div className="split-row" style={{ width: '100%' }}>
                <span className="mode-pill mode-pill-neutral">{tTemplateCategory(template)}</span>
                <span className="mode-pill mode-pill-neutral">{t('rightPanel.templates.stepCount', { count: template.workflow.nodes.length })}</span>
              </div>
              <strong>{tTemplateName(template)}</strong>
              <span className="we-recipe-card__description" title={tTemplateDescription(template)}>{tTemplateDescription(template)}</span>
              <div className="we-recipe-card__footer">
                <div className="we-recipe-card__chain" aria-hidden="true">
                  {template.workflow.nodes.map((node, index) => (
                    <Fragment key={node.id}>
                      {index > 0 && <ArrowRight size={10} />}
                      <span className="we-recipe-card__step" title={getNodeLabel(node.type)}>{workflowNodeIcon(node.type)}</span>
                    </Fragment>
                  ))}
                </div>
                <span className="list-card-action">{t('rightPanel.templates.useRecipe')}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
