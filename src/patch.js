/**
 * Locate the HindSight plugin entry inside the user's Cordis patch layers.
 *
 * The composition is the only place that knows HindSight exists: this plugin
 * takes over the `hindsight` row, so the row's original target (HindSight's
 * `dist/dsh.js`) is no longer a live row anywhere. It survives either as this
 * row's `config.target`, as a comment the user kept inside the same block, or
 * as an unrelated row we must refuse to double-mount.
 *
 * The scan is line-oriented rather than YAML-parsed on purpose: a patch file is
 * user-owned, may be mid-edit, and we only need two keys out of it. Everything
 * here is dependency-free and read-only.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** This package's name: the row `name` that marks a row as our own takeover. */
export const PACKAGE = 'dsh-hindsight-workspace-switch'

/** Absolute Harness home: the directory holding `cordis.patch.yml`. */
export function harnessHome() {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/**
 * Every patch file this plugin reads, in priority order: the home-level layer
 * first, then each profile's own layer, then anything the config named. Missing
 * files are dropped; a profile without a patch layer is ordinary.
 * @param extra - additional absolute paths to scan.
 * @returns existing patch file paths.
 */
export function patchFilePaths(extra = []) {
  const home = harnessHome()
  const files = [join(home, 'cordis.patch.yml')]
  try {
    for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(join(home, 'profiles', entry.name, 'cordis.patch.yml'))
    }
  } catch {
    // No profiles directory: the home-level patch is the only layer.
  }
  return [...files, ...extra].filter(file => existsSync(file))
}

const ID_LINE = /^\s*(?:-\s*)?id:\s*(.+?)\s*$/
const NAME_LINE = /^\s*(?:-\s*)?name:\s*(.+?)\s*$/
/** Two patch keys belong to one row when they sit within this many lines. */
const ROW_WINDOW = 8

/** Strip one YAML scalar's quotes and trailing comment. */
function unquote(value) {
  const trimmed = value.trim()
  const first = trimmed[0]
  if (trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1)
  }
  return trimmed.split(/\s+#/)[0].trim()
}

/**
 * Read the `(id, name)` rows out of one patch document. Key order is not fixed
 * by the format, so whichever key arrives second closes the row; a key that no
 * partner reaches within {@link ROW_WINDOW} lines is discarded.
 * @param text - raw patch YAML.
 * @returns every complete row, in document order.
 */
export function scanRows(text) {
  const rows = []
  let pendingId
  let pendingName
  let idLine = -1
  let nameLine = -1
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*#/.test(line)) continue
    const id = ID_LINE.exec(line)
    if (id !== null) {
      pendingId = unquote(id[1])
      idLine = index
      if (pendingName !== undefined && idLine - nameLine <= ROW_WINDOW) {
        rows.push({ id: pendingId, name: pendingName })
        pendingId = undefined
        pendingName = undefined
      }
      continue
    }
    const name = NAME_LINE.exec(line)
    if (name !== null) {
      pendingName = unquote(name[1])
      nameLine = index
      if (pendingId !== undefined && nameLine - idLine <= ROW_WINDOW) {
        rows.push({ id: pendingId, name: pendingName })
        pendingId = undefined
        pendingName = undefined
      }
    }
  }
  return rows
}

/** Whether one row's `name` resolves to this package. */
export function isOurs(name) {
  return typeof name === 'string' && (name === PACKAGE || /(?:^|\/)hindsight-workspace-switch(?:\/|$)/.test(name))
}

/** Whether one row is a HindSight entry this plugin does not own. */
export function isForeignHindsight(row) {
  if (isOurs(row.name)) return false
  return /hindsight/i.test(row.id ?? '') || /hindsight/i.test(row.name ?? '')
}

/**
 * Read every row of every patch layer.
 * @param extra - additional absolute paths to scan.
 * @returns rows annotated with the file they came from.
 */
export function scanPatchRows(extra = []) {
  const rows = []
  for (const file of patchFilePaths(extra)) {
    try {
      for (const row of scanRows(readFileSync(file, 'utf8'))) rows.push({ ...row, file })
    } catch {
      // An unreadable layer is skipped; the next one may still name the target.
    }
  }
  return rows
}

/**
 * Find a `file:` module URL inside a patch document — comments included, which
 * is how the original HindSight path survives the takeover as documentation.
 * A HindSight-looking match wins over any other `file:` URL in the file.
 * @param text - raw patch YAML.
 * @returns the first usable module URL, or undefined.
 */
export function findTargetInText(text) {
  const found = []
  const pattern = /file:\/\/\/?[^\s"'`,\])]+/g
  let match = pattern.exec(text)
  while (match !== null) {
    found.push(match[0])
    match = pattern.exec(text)
  }
  return found.find(candidate => /hindsight/i.test(candidate)) ?? found[0]
}
