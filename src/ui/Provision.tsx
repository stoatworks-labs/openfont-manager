import { useCallback, useEffect, useState } from 'react'
import {
  isDesktop,
  native,
  onNativeEvent,
  type Settings,
  type SourceConfig,
  type SourceProbe,
  type Status,
  type SyncReport,
} from '../platform/native'

/**
 * Automatic provisioning — desktop only.
 *
 * The app watches a folder for font lists, optionally one or more network
 * shares for lists *and* font files, and installs whatever it finds: at
 * login, on a timer, and on demand. This panel is the settings for that plus
 * the last run's report. In the browser it explains what the desktop app adds.
 */

const INTERVALS = [
  [0, 'Only at startup and on demand'],
  [15, 'Every 15 minutes'],
  [30, 'Every 30 minutes'],
  [60, 'Every hour'],
  [240, 'Every 4 hours'],
  [1440, 'Once a day'],
] as const

function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function Provision() {
  if (!isDesktop()) return <BrowserNote />
  return <DesktopProvision />
}

function BrowserNote() {
  return (
    <section className="provision">
      <div className="panel">
        <h2>Automatic provisioning needs the desktop app</h2>
        <p>
          A web page cannot write into your font folder, run at login or read a network share. The OpenFont Manager
          desktop app (macOS, Windows, Linux) can, and it is this same interface with four more things:
        </p>
        <ul className="bullets">
          <li>
            <strong>Install</strong> straight from the checkout into your user font folder — no zip, no scripts, no
            administrator password.
          </li>
          <li>
            <strong>A watched folder.</strong> Drop a CSV, XML or TXT list in it and the fonts it names are fetched
            and installed. Each list is remembered by content, so it is only processed once until it changes.
          </li>
          <li>
            <strong>Start at login</strong>, hidden in the tray, running a sync pass on startup and on a timer.
          </li>
          <li>
            <strong>Network shares as sources.</strong> Point it at an SMB, NFS or WebDAV share the OS has mounted —
            or a WebDAV URL directly — and it installs the font files and lists found there, so one folder on a NAS
            provisions every machine that runs the app.
          </li>
        </ul>
        <p className="muted">
          Until then: build your checkout here, export it as a CSV or XML list, and hand that to the desktop app or
          drop it in its watched folder.
        </p>
      </div>
    </section>
  )
}

function DesktopProvision() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [log, setLog] = useState<string>('')
  const [probes, setProbes] = useState<Record<string, SourceProbe | 'probing'>>({})
  const [adding, setAdding] = useState<null | 'webdav'>(null)

  const refresh = useCallback(async () => {
    const [s, st] = await Promise.all([native.getSettings(), native.getStatus()])
    setSettings(s)
    setStatus(st)
  }, [])

  useEffect(() => {
    void refresh()
    let off: (() => void) | undefined
    void onNativeEvent<SyncReport>('sync-report', () => void refresh()).then((f) => (off = f))
    return () => off?.()
  }, [refresh])

  const save = async (next: Settings) => {
    setSaving(true)
    setMessage(null)
    try {
      const saved = await native.saveSettings(next)
      setSettings(saved)
      setStatus(await native.getStatus())
    } catch (e) {
      setMessage(String(e))
    } finally {
      setSaving(false)
    }
  }

  const patch = (p: Partial<Settings>) => settings && void save({ ...settings, ...p })

  const syncNow = async () => {
    setMessage(null)
    try {
      setStatus((s) => (s ? { ...s, syncing: true } : s))
      const report = await native.syncNow()
      setMessage(`Sync finished: ${report.installed} installed, ${report.skipped} already present, ${report.failed} failed.`)
    } catch (e) {
      setMessage(String(e))
    } finally {
      await refresh()
    }
  }

  const chooseListsDir = async () => {
    const dir = await native.pickDirectory('Choose the folder to watch for font lists')
    if (dir) patch({ listsDir: dir })
  }

  const addDirSource = async () => {
    const dir = await native.pickDirectory('Choose a folder or mounted share to use as a font source')
    if (!dir || !settings) return
    const src: SourceConfig = {
      id: newId(),
      label: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
      kind: 'dir',
      path: dir,
      username: '',
      enabled: true,
      installFonts: true,
      readLists: true,
    }
    void save({ ...settings, sources: [...settings.sources, src] })
  }

  const updateSource = (id: string, p: Partial<SourceConfig>) =>
    settings && void save({ ...settings, sources: settings.sources.map((s) => (s.id === id ? { ...s, ...p } : s)) })

  const removeSource = (id: string) =>
    settings && void save({ ...settings, sources: settings.sources.filter((s) => s.id !== id) })

  const probe = async (s: SourceConfig) => {
    setProbes((p) => ({ ...p, [s.id]: 'probing' }))
    try {
      const r = await native.probeSource(s)
      setProbes((p) => ({ ...p, [s.id]: r }))
    } catch (e) {
      setProbes((p) => ({ ...p, [s.id]: { ok: false, message: String(e), fonts: 0, lists: 0 } }))
    }
  }

  const loadLog = async () => setLog(await native.readLog(200))

  if (!settings || !status) return <section className="provision muted">Loading…</section>

  const last = status.lastSync

  return (
    <section className="provision">
      <div className="panel">
        <div className="panel__head">
          <h2>Automatic provisioning</h2>
          <button type="button" className="btn btn--primary" disabled={status.syncing} onClick={syncNow}>
            {status.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        <p className="muted">
          Fonts install into <code>{status.installDir}</code> for this user account — no administrator password. Files
          already there are never overwritten.
        </p>
        {message && <p className="note">{message}</p>}

        <div className="settings">
          <label className="setting">
            <input type="checkbox" checked={settings.autostart} onChange={(e) => patch({ autostart: e.target.checked })} disabled={saving} />
            <span>
              <strong>Start at login</strong>
              <small>Launches hidden in the tray. {status.autostartEnabled ? 'Currently registered.' : 'Not registered.'}</small>
            </span>
          </label>
          <label className="setting">
            <input type="checkbox" checked={settings.syncOnStartup} onChange={(e) => patch({ syncOnStartup: e.target.checked })} disabled={saving} />
            <span>
              <strong>Sync when the app starts</strong>
              <small>Read every list and source, install what is new.</small>
            </span>
          </label>
          <label className="setting setting--select">
            <span>
              <strong>Then repeat</strong>
            </span>
            <select value={settings.syncIntervalMinutes} onChange={(e) => patch({ syncIntervalMinutes: Number(e.target.value) })} disabled={saving}>
              {INTERVALS.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="panel">
        <h2>Watched folder for lists</h2>
        <p className="muted">
          Any <code>.csv</code>, <code>.xml</code> or <code>.txt</code> font list placed here is fetched and installed on
          the next pass. A list is remembered by its content, so it is processed once and again only if it changes.
        </p>
        <div className="pathrow">
          <code className="path">{settings.listsDir ?? 'No folder chosen'}</code>
          <button type="button" className="btn btn--sm" onClick={chooseListsDir} disabled={saving}>
            Choose…
          </button>
          {settings.listsDir && (
            <>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => native.openPath(settings.listsDir!)}>
                Open
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => patch({ listsDir: null })} disabled={saving}>
                Stop watching
              </button>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h2>Network sources</h2>
          <div className="cart__row">
            <button type="button" className="btn btn--sm" onClick={addDirSource} disabled={saving}>
              Add folder or mounted share…
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setAdding('webdav')} disabled={saving}>
              Add WebDAV URL…
            </button>
          </div>
        </div>
        <p className="muted">
          A source is scanned on every pass. Font files on it (<code>.ttf</code>, <code>.otf</code>, <code>.ttc</code>,
          any depth) are installed as they appear; lists on it are processed like the watched folder. Mount an SMB or
          NFS share with the OS and add it as a folder; WebDAV can be mounted the same way, or spoken to directly by
          URL.
        </p>

        {adding === 'webdav' && (
          <WebDavForm
            onCancel={() => setAdding(null)}
            onSave={async (src, password) => {
              if (password) await native.setPassword(src.id, password)
              await save({ ...settings, sources: [...settings.sources, src] })
              setAdding(null)
            }}
          />
        )}

        {settings.sources.length === 0 ? (
          <p className="muted">No sources yet.</p>
        ) : (
          <ul className="sources">
            {settings.sources.map((s) => {
              const p = probes[s.id]
              return (
                <li key={s.id} className={`source${s.enabled ? '' : ' source--off'}`}>
                  <div className="source__main">
                    <label className="source__enabled">
                      <input type="checkbox" checked={s.enabled} onChange={(e) => updateSource(s.id, { enabled: e.target.checked })} />
                      <strong>{s.label}</strong>
                    </label>
                    <code className="path">{s.kind === 'webdav' ? `${s.path}${s.username ? `  (as ${s.username})` : ''}` : s.path}</code>
                    <span className="chip">{s.kind === 'webdav' ? 'WebDAV' : 'folder'}</span>
                  </div>
                  <div className="source__opts">
                    <label>
                      <input type="checkbox" checked={s.installFonts} onChange={(e) => updateSource(s.id, { installFonts: e.target.checked })} /> install
                      font files found here
                    </label>
                    <label>
                      <input type="checkbox" checked={s.readLists} onChange={(e) => updateSource(s.id, { readLists: e.target.checked })} /> process
                      lists found here
                    </label>
                    <button type="button" className="btn btn--xs btn--ghost" onClick={() => probe(s)} disabled={p === 'probing'}>
                      {p === 'probing' ? 'Testing…' : 'Test'}
                    </button>
                    {s.kind === 'dir' && (
                      <button type="button" className="btn btn--xs btn--ghost" onClick={() => native.openPath(s.path)}>
                        Open
                      </button>
                    )}
                    <button type="button" className="btn btn--xs btn--ghost" onClick={() => removeSource(s.id)}>
                      Remove
                    </button>
                  </div>
                  {p && p !== 'probing' && (
                    <div className={`note ${p.ok ? 'note--ok' : 'note--warn'}`}>
                      {p.message}
                      {p.ok ? ` — ${p.fonts} font file${p.fonts === 1 ? '' : 's'}, ${p.lists} list${p.lists === 1 ? '' : 's'}` : ''}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="panel">
        <div className="panel__head">
          <h2>Last sync</h2>
          <button type="button" className="btn btn--sm btn--ghost" onClick={loadLog}>
            {log ? 'Refresh log' : 'Show log'}
          </button>
        </div>
        {last ? (
          <>
            <p>
              <strong>{new Date(last.finishedAt).toLocaleString()}</strong> ({last.trigger}) — {last.listsSeen} list
              {last.listsSeen === 1 ? '' : 's'} seen, {last.listsProcessed} processed, {last.familiesRequested} famil
              {last.familiesRequested === 1 ? 'y' : 'ies'} requested, {last.filesDownloaded} downloaded ·{' '}
              <strong>{last.installed} installed</strong>, {last.skipped} already present, {last.failed} failed.
            </p>
            {last.familiesUnresolved.length > 0 && (
              <p className="note note--warn">Not in any catalogue: {last.familiesUnresolved.join(', ')}</p>
            )}
            <pre className="log">{last.log.join('\n')}</pre>
          </>
        ) : (
          <p className="muted">No sync has run yet.</p>
        )}
        {log && <pre className="log log--full">{log}</pre>}
        <p className="muted small">
          Settings: <code>{status.configPath}</code> · State: <code>{status.statePath}</code> · Log: <code>{status.logPath}</code>
        </p>
      </div>
    </section>
  )
}

function WebDavForm({ onSave, onCancel }: { onSave: (src: SourceConfig, password: string) => Promise<void>; onCancel: () => void }) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    if (!/^https?:\/\//i.test(url)) {
      setErr('The URL must start with http:// or https://')
      return
    }
    setBusy(true)
    try {
      await onSave(
        {
          id: newId(),
          label: label.trim() || new URL(url).host,
          kind: 'webdav',
          path: url.trim().replace(/\/?$/, '/'),
          username: username.trim(),
          enabled: true,
          installFonts: true,
          readLists: true,
        },
        password,
      )
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form">
      <label>
        Label <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Office NAS" />
      </label>
      <label>
        Collection URL{' '}
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://nas.example.com/remote.php/dav/files/user/fonts/" />
      </label>
      <label>
        Username <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
      </label>
      <label>
        Password{' '}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <small className="muted">Stored in the system keychain, not in the settings file.</small>
      </label>
      {err && <p className="note note--warn">{err}</p>}
      <div className="cart__row">
        <button type="button" className="btn btn--primary btn--sm" onClick={submit} disabled={busy}>
          Add source
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
