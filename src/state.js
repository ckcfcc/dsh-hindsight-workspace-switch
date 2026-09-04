/**
 * The durable switch state: which workspaces have HindSight disabled.
 *
 * State is keyed by Workspace id when the workspace registry owns the session's
 * canonical cwd, and by `dir:<canonical path>` otherwise, so a session whose
 * directory was never registered still gets its own stable key. The document is
 * one JSON file in the Harness home, replaced atomically: a half-written file
 * would silently re-enable memory for every workspace.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { harnessHome } from './patch.js'

/** Document schema version; an unknown newer version is treated as empty. */
const VERSION = 1

/**
 * Owner of the durable per-workspace switch document.
 * Reads are cached; every write goes through a temp file and a rename.
 */
export class WorkspaceSwitchState {
  #file
  #cache

  /**
   * @param file - absolute document path.
   */
  constructor(file = join(harnessHome(), 'hindsight-switch.json')) {
    this.#file = file
    this.#cache = undefined
  }

  /** @returns the absolute document path. */
  get file() {
    return this.#file
  }

  /**
   * Read the document, parsing it at most once per process. A missing,
   * unparsable, or foreign-shaped document reads as "nothing disabled" rather
   * than throwing, because a corrupt preference file must never stop a session.
   * @returns the normalized document.
   */
  read() {
    if (this.#cache !== undefined) return this.#cache
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
    } catch {
      parsed = undefined
    }
    const disabled = {}
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version === VERSION) {
      const source = parsed.disabled
      if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
        for (const [key, value] of Object.entries(source)) {
          if (key !== '' && value === true) disabled[key] = true
        }
      }
    }
    this.#cache = { version: VERSION, disabled }
    return this.#cache
  }

  /**
   * @param key - workspace key.
   * @returns whether HindSight is disabled for that workspace.
   */
  isDisabled(key) {
    return this.read().disabled[key] === true
  }

  /**
   * Store one workspace's switch position.
   * @param key - workspace key.
   * @param disabled - next switch position.
   * @returns the committed document.
   */
  setDisabled(key, disabled) {
    const document = this.read()
    const next = { version: VERSION, disabled: { ...document.disabled } }
    if (disabled) next.disabled[key] = true
    else delete next.disabled[key]
    this.persist(next)
    this.#cache = next
    return next
  }

  /**
   * Replace the document atomically: a crash between the write and the rename
   * leaves the previous state in place instead of an empty or truncated one.
   * @param document - the complete next document.
   */
  persist(document) {
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(temporary, this.#file)
  }
}

export default WorkspaceSwitchState
