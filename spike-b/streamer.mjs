/**
 * Spike B — live session event streamer.
 *
 * A minimal Cordis plugin mounted via `--patch` over the headless profile.
 * The headless runner drives the agent and creates the session; this plugin
 * only observes the global `session/event` firehose and prints each event to
 * stdout in real time, proving the live-event seam a TUI would render on.
 *
 * Mounted as: dsh --profile headless --patch ./streamer.patch.yml "task"
 */

export const name = 'spike-b-streamer'

const RESET = '\x1b[0m'
const C = {
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
}

function line(color, label, rest = '') {
  process.stdout.write(`${C[color]}[${label}]${RESET} ${rest}\n`)
}

function preview(value, max = 120) {
  if (value === undefined || value === null) return String(value)
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value
  try {
    const s = JSON.stringify(value)
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return String(value)
  }
}

/** Extract the joined text of a message-like object's content blocks. */
function blockText(message) {
  if (!message?.content) return ''
  return message.content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
}

export function apply(ctx) {
  const started = Date.now()
  let reasoning = '' // accumulated reasoning deltas
  let textLine = '' // accumulated visible-text deltas

  function flushText() {
    if (textLine) {
      process.stdout.write(textLine)
      textLine = ''
    }
  }

  function flushReasoning() {
    if (reasoning) {
      line('dim', 'reasoning', reasoning.trimStart())
      reasoning = ''
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event.type
      const d = event.data ?? {}
      switch (type) {
        case 'turn/start':
          flushReasoning()
          line('cyan', 'turn start', `turn=${d.turn}`)
          break
        case 'turn/end':
          flushText()
          flushReasoning()
          line('cyan', 'turn end', `reason=${d.reason?.kind ?? '?'}`)
          break
        case 'assistant/chunk': {
          const chunk = d.chunk ?? {}
          if (chunk.type === 'text-delta') {
            // true streaming: write the visible text immediately
            process.stdout.write(chunk.text ?? '')
          } else if (chunk.type === 'reasoning-delta') {
            // accumulate chain-of-thought; flush periodically so it still
            // appears live, but as whole lines instead of per-token noise
            reasoning += chunk.text ?? ''
            if (reasoning.length > 400) flushReasoning()
          } else if (chunk.type === 'block-start') {
            if (chunk.blockType !== 'reasoning') line('dim', 'block start', `index=${chunk.index} type=${chunk.blockType}`)
          } else if (chunk.type === 'block-end') {
            if (chunk.blockType === 'reasoning') flushReasoning()
          } else if (chunk.type === 'usage') {
            line('dim', 'usage', preview(chunk.usage ?? {}, 120))
          } else {
            line('dim', 'chunk', preview(chunk, 80))
          }
          break
        }
        case 'assistant/message': {
          const text = blockText(d.message)
          if (text) line('green', 'assistant', text)
          break
        }
        case 'user/message': {
          flushReasoning()
          const text = blockText(d)
          if (text) line('yellow', 'user', text.slice(0, 140) + (text.length > 140 ? '…' : ''))
          break
        }
        case 'tool/call':
          flushReasoning()
          line('blue', 'tool call', `${d.name} ${preview(d.arguments, 120)}`)
          break
        case 'tool/result': {
          const text = blockText(d.message)
          line('blue', 'tool result', text ? text.slice(0, 200) : (d.error ? `ERROR ${d.error.code}` : preview(d, 100)))
          break
        }
        case 'step/start':
          line('magenta', 'step start', `turn=${d.turn} step=${d.step}`)
          break
        case 'step/end':
          line('magenta', 'step end', `turn=${d.turn} step=${d.step}`)
          break
        case 'approval/asked':
          line('red', 'APPROVAL ASKED', preview(d, 160))
          break
        case 'approval/decided':
          line('red', 'approval decided', preview(d, 80))
          break
        case 'agent/inbox/spliced':
          line('dim', 'inbox spliced', `session=${session?.id ?? '?'}`)
          break
        default:
          line('dim', type, preview(d, 80))
      }
    } catch (err) {
      line('red', 'streamer-error', err instanceof Error ? err.message : String(err))
    }
  })

  ctx.on('dispose', () => {
    flushText()
    flushReasoning()
    line('dim', 'streamer end', `observed ${((Date.now() - started) / 1000).toFixed(1)}s`)
  })
}
