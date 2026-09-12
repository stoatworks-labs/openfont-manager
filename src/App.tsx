import { useCallback, useEffect, useState } from 'react'
import { CATALOGUE_DATES, COUNTS } from './core/catalogue'
import { normalizeKey } from './core/names'
import { formatBytes } from './core/plan'
import { isDesktop, native, onNativeEvent } from './platform/native'
import { CartPanel } from './ui/CartPanel'
import { Catalogue } from './ui/Catalogue'
import { ImportList } from './ui/ImportList'
import { Provision } from './ui/Provision'
import { useCart } from './ui/useCart'
import { useJobs } from './ui/useJobs'

type Tab = 'catalogue' | 'import' | 'provision'

export default function App() {
  const [tab, setTab] = useState<Tab>('catalogue')
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [external, setExternal] = useState<{ name: string; text: string } | null>(null)
  const cart = useCart()
  const desktop = isDesktop()

  const refreshInstalled = useCallback(async () => {
    if (!desktop) return
    try {
      const families = await native.installedFamilies()
      setInstalled(new Set(families.map(normalizeKey)))
    } catch {
      // The badge is a nicety; a failure here must not break the catalogue.
    }
  }, [desktop])

  const jobs = useJobs(refreshInstalled)

  useEffect(() => {
    void refreshInstalled()
  }, [refreshInstalled])

  // The desktop app hands over a list given on its command line or opened
  // with it; a sync pass finishing refreshes the installed badges.
  useEffect(() => {
    if (!desktop) return
    const offs: Array<() => void> = []
    void onNativeEvent<{ name: string; text: string }>('open-list', (payload) => {
      setExternal(payload)
      setTab('import')
    }).then((off) => offs.push(off))
    void onNativeEvent('sync-report', () => void refreshInstalled()).then((off) => offs.push(off))
    return () => offs.forEach((f) => f())
  }, [desktop, refreshInstalled])

  return (
    <div className="app">
      <header className="top">
        <div className="top__title">
          <h1>OpenFont Manager</h1>
          <p className="sub">
            {COUNTS.googleDownloadable.toLocaleString()} Google Fonts families and {COUNTS.fontsource} more from Fontsource —{' '}
            {COUNTS.files.toLocaleString()} original, installable font files, about {formatBytes(COUNTS.bytes)} in all. Every one
            under an open licence.
          </p>
        </div>
        <nav className="tabs" aria-label="Sections">
          <button type="button" className={tab === 'catalogue' ? 'on' : ''} onClick={() => setTab('catalogue')}>
            Catalogue
          </button>
          <button type="button" className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')}>
            Import a list
          </button>
          <button type="button" className={tab === 'provision' ? 'on' : ''} onClick={() => setTab('provision')}>
            Automatic provisioning{desktop ? '' : ' ↗'}
          </button>
        </nav>
      </header>

      <main className={`main${tab === 'provision' ? ' main--wide' : ''}`}>
        <div className="main__content">
          {tab === 'catalogue' && <Catalogue cart={cart} installed={installed} />}
          {tab === 'import' && <ImportList cart={cart} jobs={jobs} external={external} />}
          {tab === 'provision' && <Provision />}
        </div>
        {tab !== 'provision' && <CartPanel cart={cart} jobs={jobs} />}
      </main>

      <footer className="foot muted">
        Catalogues: Google Fonts {CATALOGUE_DATES.google}, Fontsource {CATALOGUE_DATES.fontsource}. Downloads come straight
        from the google/fonts repository and the Fontsource CDN — the complete original files, never the subsetted web
        versions. Nothing you do here is sent anywhere else. {__APP_VERSION__}
        {desktop ? ' · desktop' : ''}
      </footer>
    </div>
  )
}
