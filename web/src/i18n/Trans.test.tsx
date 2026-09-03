import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { changeAppLanguage, Trans } from './index'
import { registerRuntimeCatalog } from './runtime'

describe('Trans', () => {
  it('maps numbered catalog placeholders to safe React elements', () => {
    render(
      <p>
        <Trans
          i18nKey="budgetBanner.detail"
          values={{ spent: '7.50', limit: '20.00' }}
          components={[<strong key="spent" />, <strong key="limit" />]}
        />
      </p>,
    )

    expect(screen.getByText('$7.50', { selector: 'strong' })).toBeVisible()
    expect(screen.getByText('$20.00', { selector: 'strong' })).toBeVisible()
    expect(screen.getByText(/raise the Workspace budget or switch the policy to warn-only/)).toBeVisible()
  })

  it('maps named placeholders and re-renders after a locale change', async () => {
    render(
      <p>
        <Trans
          i18nKey="recoveryDialog.idle.clickGenerate"
          components={{ strong: <strong /> }}
        />
      </p>,
    )
    expect(screen.getByText('Generate suggestion', { selector: 'strong' })).toBeVisible()

    await changeAppLanguage('es')
    expect(screen.getByText('Generar sugerencia', { selector: 'strong' })).toBeVisible()
  })

  it('preserves malformed rich text as inert text without dropping content', async () => {
    await changeAppLanguage('en')
    registerRuntimeCatalog('en', {
      'test.malformed': '<strong>Keep me</em>',
      'test.unknown': '<script>Still safe</script>',
    })

    const { rerender } = render(<Trans i18nKey="test.malformed" />)
    expect(screen.getByText('<strong>Keep me</em>')).toBeVisible()

    rerender(<Trans i18nKey="test.unknown" />)
    expect(screen.getByText('Still safe')).toBeVisible()
    expect(document.querySelector('script')).toBeNull()
  })
})
