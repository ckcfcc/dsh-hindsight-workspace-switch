#!/usr/bin/env node
/**
 * teardown.mjs — put the home-level HindSight row back.
 *
 * The inverse of setup.mjs: restores $DSH_HOME/cordis.patch.yml from the backup
 * setup took, and removes the profile-level row this plugin added. Run this
 * BEFORE `dsh plugin remove`, otherwise HindSight has no row left anywhere and
 * silently stops loading.
 *
 * Usage:
 *   node scripts/teardown.mjs [--profile web] [--dry-run]
 */

import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const START = '# HINDSIGHT_CODING_AGENTS_DSH_START'
const END = '# HINDSIGHT_CODING_AGENTS_DSH_END'
const OURS_START = '# DSH_HINDSIGHT_WORKSPACE_SWITCH_START'
const OURS_END = '# DSH_HINDSIGHT_WORKSPACE_SWITCH_END'
const BACKUP_SUFFIX = '.hindsight-switch.bak'

const splitLines = (text) => text.split(/\r?\n/)
const joinLines = (lines) => lines.join('\n')

/** Parse --flags out of argv. */
function parseArgs(argv) {
  const out = { profile: 'web', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length)
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

function main() {
  const args = parseArgs(process.argv.slice(2))
  const home = dshHome()
  const homePatch = join(home, 'cordis.patch.yml')
  const backup = homePatch + BACKUP_SUFFIX
  const profilePatch = join(home, 'profiles', args.profile, 'cordis.patch.yml')

  // 1. Restore the home patch.
  if (existsSync(backup)) {
    if (!args.dryRun) copyFileSync(backup, homePatch)
    console.log(`teardown: restored the home patch from ${backup}`)
  } else {
    console.log(`teardown: no backup at ${backup} — the home patch was never moved, leaving it as is.`)
  }

  // 2. Drop the profile-level row this plugin added. If the row survived here
  //    while the home row is back, the profile layer would still win.
  if (existsSync(profilePatch)) {
    const text = readFileSync(profilePatch, 'utf8')
    const { lines, removed } = cutBlock(splitLines(text), OURS_START, OURS_END)
    if (removed.length > 0) {
      const next = joinLines(lines).replace(/\n{3,}/g, '\n\n')
      if (!args.dryRun) writeFileSync(profilePatch, next)
      console.log(`teardown: removed the switch row from ${profilePatch}.`)
    } else {
      console.log(`teardown: no switch row in ${profilePatch}.`)
    }
  }

  // 3. Drop the backup only after both files are settled.
  if (existsSync(backup) && !args.dryRun) {
    unlinkSync(backup)
    console.log(`teardown: removed the backup ${backup}.`)
  }

  if (args.dryRun) {
    console.log('\n[dry-run] no files were changed.')
    return
  }
  console.log('\nDone. Now uninstall the package:')
  console.log(`  dsh plugin --profile ${args.profile} remove dsh-hindsight-workspace-switch`)
}

main()
