import type { PlanItem } from '../core/types'

/**
 * The desktop app's native surface, reached over Tauri IPC.
 *
 * Everything here is what a browser structurally cannot do: write into the
 * OS font directory, run at login, watch a folder, read a network share.
 * The browser build never calls any of it — `isDesktop()` gates every use.
 *
 * The command names and shapes are the contract with `src-tauri/src/lib.rs`;
 * change both together.
 */

export interface SourceConfig {
  id: string
  label: string
  /** A directory (local, or an SMB/NFS/WebDAV share the OS has mounted) or a WebDAV URL. */
  kind: 'dir' | 'webdav'
  /** Directory path, or the WebDAV collection URL. */
  path: string
  username: string
  enabled: boolean
  /** Install font files found on the source, not just process its lists. */
  installFonts: boolean
  /** Process .csv/.xml/.txt lists found on the source. */
  readLists: boolean
}

export interface Settings {
  /** Local folder watched for font lists. Null = none. */
  listsDir: string | null
  syncOnStartup: boolean
  /** Minutes between passes while the app runs. 0 = only at startup / on demand. */
  syncIntervalMinutes: number
  /** Launch at login (hidden, in the tray). */
  autostart: boolean
  sources: SourceConfig[]
}

export interface SyncReport {
  startedAt: string
  finishedAt: string
  trigger: string
  listsSeen: number
  listsProcessed: number
  familiesRequested: number
  familiesUnresolved: string[]
  filesDownloaded: number
  installed: number
  skipped: number
  failed: number
  /** Human-readable lines, in order. */
  log: string[]
}

export interface Status {
  version: string
  installDir: string
  configPath: string
  statePath: string
  logPath: string
  autostartEnabled: boolean
  syncing: boolean
  lastSync: SyncReport | null
}

export interface InstallOutcome {
  filename: string
  status: 'installed' | 'already-present' | 'failed'
  detail: string | null
  path: string | null
}

export interface InstallReport {
  dir: string
  installed: number
  skipped: number
  failed: number
  outcomes: InstallOutcome[]
  note: string | null
}

export interface SaveReport {
  dir: string
  saved: number
  failed: number
  failures: Array<{ filename: string; error: string }>
}

export interface DownloadProgress {
  done: number
  failed: number
  total: number
  bytes: number
  active: string[]
}

export interface SourceProbe {
  ok: boolean
  message: string
  fonts: number
  lists: number
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export const native = {
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  getStatus: () => invoke<Status>('get_status'),
  syncNow: () => invoke<SyncReport>('sync_now'),
  installPlan: (items: PlanItem[]) => invoke<InstallReport>('install_plan', { items }),
  savePlan: (items: PlanItem[], dest: string) => invoke<SaveReport>('save_plan', { items, dest }),
  pickDirectory: (title: string) => invoke<string | null>('pick_directory', { title }),
  installedFamilies: () => invoke<string[]>('installed_families'),
  openPath: (path: string) => invoke<void>('open_path', { path }),
  readLog: (lines: number) => invoke<string>('read_log', { lines }),
  probeSource: (source: SourceConfig) => invoke<SourceProbe>('probe_source', { source }),
  setPassword: (id: string, password: string) => invoke<void>('set_source_password', { id, password }),
  hasPassword: (id: string) => invoke<boolean>('has_source_password', { id }),
  cancelDownload: () => invoke<void>('cancel_download'),
}

/** Subscribe to a native event; returns the unlisten function. */
export async function onNativeEvent<T>(name: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(name, (e) => handler(e.payload))
}
