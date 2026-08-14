/**
 * Approval-probe — deterministically verifies the bidirectional approval seam
 * that a TUI would use for its allow/deny prompts.
 *
 * Mounted over the headless profile with the headless-runner disabled:
 *   1. registers an answerer on `approval/request` (the waterfall the TUI
 *      would answer from),
 *   2. switches the session to `ask` policy,
 *   3. creates an agent, opens a turn, and fires `ctx.approval.request()` from
 *      the `turn/start` event,
 *   4. prints whether the answerer's decision made it back to the caller,
 *      plus the `approval/asked` / `approval/decided` audit events.
 *
 * No HTTP, no browser, no web adapter — exactly the TUI's situation.
 */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

export const name = 'approval-probe'
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'approval']

const RESET = '\x1b[0m'
const C = {
  dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
}
function line(color, label, rest = '') {
  process.stdout.write(`${C[color]}[${label}]${RESET} ${rest}\n`)
}
function preview(value, max = 200) {
  if (value === undefined || value === null) return String(value)
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value
  try {
    const s = JSON.stringify(value)
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return String(value)
  }
}

export function apply(ctx) {
  // Fire-and-forget, exactly like headless-runner: the loader's await() must
  // not wait on this plugin's own apply, or the tree would deadlock.
  void run(ctx).catch((err) => {
    line('red', 'probe-error', err instanceof Error ? err.message : String(err))
    ctx.get('appExit')?.(1)
  })
}

async function run(ctx) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const approval = ctx.get('approval')
  const exit = ctx.get('appExit')
  if (!agents || !defaultModel || !sessions || !approval || !exit) {
    line('red', 'probe', `missing services agents=${!!agents} model=${!!defaultModel} sessions=${!!sessions} approval=${!!approval} exit=${!!exit}`)
    exit(1)
    return
  }

  // 1. The answerer — what a TUI would render as an allow/deny prompt.
  ctx.on('approval/request', (req) => {
    line('yellow', 'ANSWERER got request', `tool=${req.toolName} reason=${req.reason ?? '(none)'}`)
    return 'allowed-once'
  })

  // 2. Observe the log-only audit pair in the session event stream.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked') line('red', 'approval/asked', preview(event.data))
    if (event.type === 'approval/decided') line('green', 'approval/decided', preview(event.data))
  })

  // 3. Agent + open turn + mid-turn request.
  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  await agent.whenIdle()
  approval.setPolicy(agent, 'ask')
  line('cyan', 'policy', 'set to ask')

  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    void approval.request({
      agent,
      toolName: 'approval-probe',
      reason: 'controlled probe — not a real tool call',
    }).then((outcome) => {
      line('cyan', 'OUTCOME', `approval.request() -> ${outcome}`)
    }).catch((err) => {
      line('red', 'request-error', err instanceof Error ? err.message : String(err))
    })
  }
  ctx.on('session/event', (session, event) => {
    // Defer past the current append's publish: approval.request() appends to
    // the same session, and a synchronous reentrant append is rejected.
    if (session === agent.session && event.type === 'turn/start') setImmediate(fire)
  })

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '只回复一个词：ok。不要调用任何工具。' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)
  line('dim', 'probe done', '')
  exit(0)
}
