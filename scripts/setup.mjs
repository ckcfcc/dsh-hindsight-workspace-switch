#!/usr/bin/env node
/**
 * setup.mjs — take over the `hindsight` row so the workspace switch owns it.
 *
 * Why this exists: dsh composes layers in this order —
 *   1. bundle patches (dsh.profile.bundles, dsh-base first)
 *   2. the profile's own cordis.patch.yml
 *   3. the home-level $DSH_HOME/cordis.patch.yml
 *   4. --patch overlays
 * Later layers win per row. HindSight's installer writes its row into layer 3,
 * which beats anything a bundle declares in layer 1, so `dsh plugin add` alone
 * cannot take that row over. This script clears the home-level row (after
 * backing it up) and records the real target in layer 2.
 *
 * Usage:
 *   node scripts/setup.mjs [--profile web] [--target <url>] [--dry-run]
 *
 * Safe: the home patch is copied to a .bak before any edit. Re-running is a
 * no-op once the takeover is in place.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACKAGE = 'dsh-hindsight-workspace-switch'
const ROW_ID = 'hindsight'
const START = '# HINDSIGHT_CODING_AGENTS_DSH_START'
const END = '# HINDSIGHT_CODING_AGENTS_DSH_END'
const OURS_START = '# DSH_HINDSIGHT_WORKSPACE_SWITCH_START'
const OURS_END = '# DSH_HINDSIGHT_WORKSPACE_SWITCH_END'
const BACKUP_SUFFIX = '.hindsight-switch.bak'

/** Split on LF or CRLF without losing the file's own ending. */
const splitLines = (text) => text.split(/\r?\n/)
const joinLines = (lines) => lines.join('\n')

/** Keep the file's own line ending when writing back. */
const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n')

/** Parse --flags out of argv. */
function parseArgs(argv) {
  const out = { profile: 'web', target: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--target') out.target = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length)
    else if (arg.startsWith('--target=')) out.target = arg.slice('--target='.length)
  }
  return out
}

/** Locate the dsh home directory. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * Cut a marked block out of a patch file, markers included.
 * @param lines - the file's lines.
 * @param startMarker - opening marker line.
 * @param endMarker - closing marker line.
 * @returns { lines, removed } the remainder and the removed lines.
 */
function cutBlock(lines, startMarker, endMarker) {
  const start = lines.findIndex(line => line.trim() === startMarker)
  if (start === -1) return { lines, removed: [] }
  let end = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === endMarker) { end = i; break }
  }
  if (end === -1) return { lines, removed: [] }
  return {
    lines: [...lines.slice(0, start), ...lines.slice(end + 1)],
    removed: lines.slice(start, end + 1),
  }
}

/** Pull a `file:` URL out of arbitrary text — used to recover the target. */
function findTargetInText(text) {
  const match = text.match(/file:\/\/\/[^\s"']+/)
  return match === null ? undefined : match[0]
}

/** Windows drive paths need a file URL before import() will take them. */
function toFileUrl(raw) {
  if (/^file:\/\//i.test(raw)) return raw
  const normalized = raw.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`
  return raw
}

/**
 * Write our row into a profile patch file.
 *
 * A patch file is a single top-level YAML array. A brand-new profile ships with
 * `[]` on its own line, and that is a *complete* flow-style array: appending a
 * second array after it makes the document invalid ("end of the stream or a
 * document separator is expected"). So an empty placeholder is replaced in
 * place, while a block-style array is appended to.
 *
 * @param path - the profile patch file.
 * @param target - the HindSight module URL.
 * @param dryRun - true to skip the write.
 * @returns the text that was (or would be) written.
 */
function writeProfileRow(path, target, dryRun) {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const eol = detectEol(original)

  // Drop any row we wrote before, so re-running cannot duplicate it.
  const { lines } = cutBlock(splitLines(original), OURS_START, OURS_END)

  const entry = [
    '- insert:',
    `  - id: ${ROW_ID}`,
    `    name: ${PACKAGE}`,
    '    config:',
    `      target: ${target}`,
  ]

  const placeholderAt = lines.findIndex(line => line.trim() === '[]')
  let next
  if (placeholderAt !== -1) {
    // Replace the empty array with our row, markers around it for removal.
    next = [
      ...lines.slice(0, placeholderAt),
      OURS_START,
      ...entry,
      OURS_END,
      ...lines.slice(placeholderAt + 1),
    ].join('\n')
  } else {
    const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
    const prefix = body === '' ? '' : body + '\n\n'
    next = prefix + [OURS_START, ...entry, OURS_END].join('\n') + '\n'
  }

  if (eol === '\r\n') next = next.split('\n').join('\r\n')
  if (!dryRun) writeFileSync(path, next)
  return next
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const home = dshHome()
  const homePatch = join(home, 'cordis.patch.yml')
  const profilePatch = join(home, 'profiles', args.profile, 'cordis.patch.yml')

  if (!existsSync(homePatch)) {
    console.error(`setup: no home patch at ${homePatch} — nothing to take over.`)
    console.error('       If HindSight is not installed, install the bundle and skip this script.')
    process.exit(1)
  }

  const original = readFileSync(homePatch, 'utf8')

  // 1. Recover the target. Re-running the script is normal, so fall back to
  //    the row this script wrote last time before giving up.
  const { lines: withoutHindsight, removed } = cutBlock(splitLines(original), START, END)
  const { lines: withoutOurs } = cutBlock(withoutHindsight, OURS_START, OURS_END)

  let target = args.target
  if (target === undefined && removed.length > 0) {
    target = findTargetInText(removed.join('\n'))
  }
  if (target === undefined && existsSync(profilePatch)) {
    target = findTargetInText(readFileSync(profilePatch, 'utf8'))
  }

  if (removed.length === 0) {
    console.log('setup: the home patch has no HindSight block (already taken over).')
  }

  if (target === undefined) {
    console.error('setup: could not find the HindSight target.')
    console.error('       Re-run with --target file:///C:/Users/you/.hindsight/coding-agents/dist/dsh.js')
    process.exit(1)
  }
  target = toFileUrl(target)

  // 2. Back up once. Never overwrite an earlier backup: that one is the
  //    pristine copy teardown needs.
  const backup = homePatch + BACKUP_SUFFIX
  if (!existsSync(backup)) {
    if (!args.dryRun) copyFileSync(homePatch, backup)
    console.log(`setup: backed up the home patch -> ${backup}`)
  } else {
    console.log(`setup: reusing the existing backup ${backup}`)
  }

  // 3. Rewrite the home patch without the HindSight row.
  //
  // A patch file must stay a single top-level YAML array. Removing the only
  // entry can leave nothing but comments behind, which dsh rejects with
  // "must be a top-level YAML array of loader patch entries" — so an emptied
  // file gets the `[]` placeholder a fresh install ships with.
  const eol = detectEol(original)
  let nextHome = withoutOurs.join('\n').replace(/\n{3,}/g, '\n\n')

  const homeHasArray = withoutOurs.some(line => line.trim() === '[]')
    || withoutOurs.some(line => /^-\s/.test(line))
  if (!homeHasArray) {
    const body = nextHome.replace(/\s+$/, '')
    nextHome = body === '' ? '[]\n' : `${body}\n\n[]\n`
  }

  if (eol === '\r\n') nextHome = nextHome.split('\n').join('\r\n')
  if (nextHome !== original) {
    if (!args.dryRun) writeFileSync(homePatch, nextHome)
    console.log('setup: cleared the home-level hindsight row (layer 3).')
    if (!homeHasArray) console.log(`setup: restored the [] placeholder in ${homePatch}.`)
  }

  // 4. Record the target in the profile patch (layer 2).
  writeProfileRow(profilePatch, target, args.dryRun)
  console.log(`setup: wrote the row into ${profilePatch} (layer 2).`)
  console.log(`       target = ${target}`)
  console.log('       note: the home patch is shared by every profile — run setup for')
  console.log('       each profile that should keep using HindSight, or teardown to undo.')

  if (args.dryRun) {
    console.log('\n[dry-run] no files were changed.')
    return
  }
  console.log('\nDone. Restart dsh for the change to take effect.')
  console.log(`Undo with: node scripts/teardown.mjs --profile ${args.profile}`)
}

main()
