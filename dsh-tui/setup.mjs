#!/usr/bin/env node
/**
 * Creates the `dsh-tui` profile under $DSH_HOME/profiles/tui, wired to this
 * repository's plugin. Replaces the headless one-shot runner with the
 * interactive terminal UI.
 *
 * Usage: node dsh-tui/setup.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import os from 'node:os'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginUrl = `file:///${repoRoot.replace(/\\/g, '/')}/dsh-tui/tui.mjs`
const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
const dir = join(home, 'profiles', 'tui')

mkdirSync(dir, { recursive: true })

writeFileSync(join(dir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-tui',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
}, null, 2) + '\n')

writeFileSync(join(dir, 'cordis.yml'), '[]\n')

writeFileSync(join(dir, 'pnpm-workspace.yaml'),
  'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

writeFileSync(join(dir, 'cordis.patch.yml'), [
  '# dsh-tui: interactive terminal UI profile (replaces the one-shot runner).',
  '- id: headless-runner',
  '  disabled: true',
  '- id: headless-startup',
  '  disabled: true',
  '- insert:',
  '    - id: dsh-tui',
  `      name: '${pluginUrl}'`,
  '      inject: [agents, agentDefaultModel, sessions, approval, commands, userQuestions, sessionQuery, cmdlineArgs]',
  '',
].join('\n'))

console.log(`dsh-tui profile: ${dir}`)
console.log(`plugin module:  ${pluginUrl}`)
console.log('Run with: npx @deepseek-ai/dsh --profile tui')
