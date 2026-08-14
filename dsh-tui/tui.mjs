/**
 * dsh-tui — an interactive terminal UI for DeepSeek Harness, in the spirit of
 * Claude Code / Codex CLI. Runs in-process over the dsh-base bundle (no HTTP,
 * no browser). One persistent agent drives multi-turn chat; the transcript is
 * rendered live from the `session/event` firehose.
 *
 * Dual-mode: with a TTY it renders a full-screen pi-tui interface; without one
 * (piped stdin) it falls back to a line-based REPL so the same core can be
 * driven non-interactively.
 */

import { randomUUID } from 'node:crypto'
import {
  ProcessTerminal, TuiAltScreen, VStack, ScrollView, Container, Text, Markdown, Editor, matchesKey,
} from '@earendil-works/pi-tui'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import {
  markdownTheme, editorTheme, labelUser, labelTool, labelToolResult, labelReasoning,
  labelSystem, statusStyle,
} from './themes.mjs'

export const name = 'dsh-tui'
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'approval', 'commands', 'userQuestions', 'sessionQuery', 'cmdlineArgs']

const HELP = [
  'dsh-tui commands:',
  '  /help       this help (+ native commands below)',
  '  /resume     list persisted sessions and pick one to continue',
  '  /clear      clear the transcript',
  '  /quit       exit (or Ctrl+C when idle)',
  '  /approve-test   exercise the approval prompt',
  '  /question-test  exercise an agent question',
  '  <anything else>  send a task to the agent',
  '',
].join('\n')

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

const blockText = (message) => (message?.content ?? [])
  .filter((b) => b?.type === 'text')
  .map((b) => b.text)
  .join('')

const preview = (v, max = 100) => {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s)

/** Render tool-call args readably: pull out command + description for shell tools. */
function fmtToolArgs(args) {
  try {
    const obj = JSON.parse(args)
    if (obj && typeof obj === 'object' && obj.command && obj.description) {
      return truncate(`${obj.description}  (${obj.command})`, 120)
    }
    return truncate(JSON.stringify(obj), 120)
  } catch {
    return truncate(String(args), 120)
  }
}

export function apply(ctx) {
  // Fire-and-forget, like headless-runner: awaiting the loader inline would
  // deadlock the tree.
  void run(ctx).catch((err) => {
    try {
      process.stderr.write(`dsh-tui: ${err instanceof Error ? err.stack : String(err)}\n`)
    } catch { /* stderr gone */ }
    ctx.get('appExit')?.(1)
  })
}

async function run(ctx) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const approval = ctx.get('approval')
  const commands = ctx.get('commands')
  const userQuestions = ctx.get('userQuestions')
  const sessionQuery = ctx.get('sessionQuery')
  const exit = ctx.get('appExit')
  const cmdline = ctx.get('cmdlineArgs')
  if (!agents || !defaultModel || !sessions || !approval || !exit) {
    throw new Error(`dsh-tui: missing services agents=${!!agents} model=${!!defaultModel} sessions=${!!sessions} approval=${!!approval} exit=${!!exit}`)
  }

  const lineMode = !process.stdin.isTTY

  // ======================= render sink ====================================
  // Common interface both modes implement. handleEvent only talks to this.
  let sink
  let tui = null
  let editor = null
  let pendingApproval = null
  let pendingQuestion = null // { request, resolve } from ctx.userQuestions
  let pendingResume = null // { records } — user is picking a session to resume
  let busy = false
  let agent
  let oneShot = false // line mode + initial task: exit after that turn
  let approveTestOnTurn = false // /approve-test: fire a synthetic request next turn

  if (lineMode) {
    sink = {
      addLine: (styled) => process.stdout.write(`${stripAnsi(styled)}\n`),
      stream: (text) => process.stdout.write(text),
      endStream: () => process.stdout.write('\n'),
      status: () => {},
      clear: () => {},
      reason: () => {},
    }
  } else {
    const terminal = new ProcessTerminal()
    tui = new TuiAltScreen(terminal)
    const transcript = new Container()
    const scroll = new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto' })
    const status = new Text('')
    editor = new Editor(tui, editorTheme)

    tui.setLayoutRoot(new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      { component: new VStack([editor, status]), basis: 'auto', shrink: 1, minSize: 1 },
    ]))

    let streaming = null // { markdown, text }
    let reasoning = null // { line, text }
    sink = {
      addLine: (styled) => { transcript.addChild(new Text(styled, 1, 0)); tui.requestRender() },
      stream: (text) => {
        if (!streaming) {
          const md = new Markdown('', 1, 0, markdownTheme)
          streaming = { markdown: md, text: '' }
          transcript.addChild(md)
        }
        streaming.text += text
        streaming.markdown.setText(streaming.text)
        tui.requestRender()
      },
      reason: (text) => {
        if (!reasoning) {
          reasoning = { line: new Text('', 1, 0), text: '' }
          transcript.addChild(reasoning.line)
        }
        reasoning.text = text
        reasoning.line.setText(labelReasoning(`… ${truncate(text.trim(), 300)}`))
        tui.requestRender()
      },
      endStream: (full) => {
        if (streaming) { streaming.markdown.setText(full ?? streaming.text); streaming = null; tui.requestRender() }
        if (reasoning) { reasoning = null; tui.requestRender() }
      },
      status: (styled) => { status.setText(styled); tui.requestRender() },
      clear: () => { transcript.clear(); tui.requestRender() },
    }

    tui.addInputListener((data) => {
      if (pendingApproval) {
        if (matchesKey(data, 'y')) { const p = pendingApproval; pendingApproval = null; setReady(); p.resolve('allowed-once'); return { consume: true } }
        if (matchesKey(data, 'n')) { const p = pendingApproval; pendingApproval = null; setReady(); p.resolve('rejected'); return { consume: true } }
        return { consume: true }
      }
      if (pendingQuestion) {
        const q = pendingQuestion.request.questions[0]
        const count = q?.options?.length ?? 0
        for (let i = 0; i < count; i++) {
          if (matchesKey(data, String(i + 1))) { resolveQuestion(q, String(i + 1)); return { consume: true } }
        }
        if (matchesKey(data, 'escape')) {
          const p = pendingQuestion; pendingQuestion = null; setReady()
          p.resolve({ answers: [{ id: q.id, selected: [] }] })
          return { consume: true }
        }
        return { consume: true }
      }
      if (pendingResume) {
        const p = pendingResume
        const count = Math.min(p.records.length, 20)
        for (let i = 0; i < count; i++) {
          if (matchesKey(data, String(i + 1))) { void doResume(p.records, i); return { consume: true } }
        }
        if (matchesKey(data, 'escape')) { pendingResume = null; setReady(); return { consume: true } }
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+c')) {
        if (busy) { try { agent?.cancel('interrupted') } catch { /* ignore */ } setStatus(statusStyle.ok, 'interrupted — ready') }
        else { tui.stop(); exit(0) }
        return { consume: true }
      }
    })
  }

  const setStatus = (style, text) => sink.status(style(text))
  const setReady = () => { busy = false; if (editor) editor.disableSubmit = false; setStatus(statusStyle.idle, 'ready') }
  const setWorking = () => { busy = true; if (editor) editor.disableSubmit = true; setStatus(statusStyle.working, 'working…') }

  // ======================= approval answerer ==============================
  ctx.on('approval/request', (req) => new Promise((resolve) => {
    pendingApproval = { req, resolve }
    const prompt = `approve ${req.toolName}?  ${req.reason ?? ''}   (y/n)`
    setStatus(statusStyle.approval, prompt)
    if (lineMode) process.stdout.write(`\n[dsh-tui] ${stripAnsi(prompt)}\n`)
  }))

  // ======================= user-questions provider ========================
  // The agent (and plan review via exit_plan_mode) can pause and ask the human.
  // We present the question and collect an answer through the same input plane.
  function renderQuestion(request) {
    const q = request.questions[0]
    const options = q?.options ?? []
    const header = q?.header ? `${q.header}\n` : ''
    const detail = q?.detail ? `\n${q.detail}` : ''
    const list = options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
    const promptText = `${header}${q?.question ?? ''}${detail}\n${list}\nselect (${options.length ? `1-${options.length}` : 'free text'}):`
    setStatus(statusStyle.approval, `question: ${q?.question ?? ''}`)
    if (lineMode) process.stdout.write(`\n[dsh-tui] ${stripAnsi(promptText)}\n`)
  }

  if (userQuestions) {
    userQuestions.registerProvider({
      ask: (request) => new Promise((resolve) => {
        pendingQuestion = { request, resolve }
        renderQuestion(request)
      }),
    })
  }

  function answerQuestion(q, raw) {
    const options = q?.options ?? []
    const selected = []
    let custom
    if (options.length > 0) {
      const idx = Number(raw) - 1
      const byLabel = options.find((o) => o.label === raw)
      if (byLabel) selected.push(byLabel.label)
      else if (Number.isInteger(idx) && options[idx]) selected.push(options[idx].label)
      else return null
    } else {
      custom = raw.trim() || undefined
    }
    return { answers: [{ id: q.id, selected, custom }] }
  }

  function resolveQuestion(q, raw) {
    const answer = answerQuestion(q, raw)
    if (answer === null) {
      setStatus(statusStyle.error, `invalid choice — pick 1-${q?.options?.length ?? 0}`)
      return
    }
    const p = pendingQuestion
    pendingQuestion = null
    setReady()
    p.resolve(answer)
  }

  // ======================= session resume ================================
  function renderResumeList(records) {
    const shown = records.slice(0, 20)
    const lines = shown.map((r, i) => `  ${i + 1}. ${r.header?.id ?? '?'}  ${r.header?.cwd ?? ''}`).join('\n')
    const text = `resume a session:\n${lines}\nenter 1-${shown.length}:`
    if (lineMode) process.stdout.write(`\n[dsh-tui] ${stripAnsi(text)}\n`)
    else setStatus(statusStyle.approval, `resume which session? (1-${shown.length})`)
  }

  async function doResume(records, idx) {
    const record = records[idx]
    pendingResume = null
    if (lineMode && process.env.DSH_TUI_DEBUG) process.stdout.write(`[resume] picking idx=${idx} id=${record?.header?.id ?? 'none'}\n`)
    if (!record) { setStatus(statusStyle.error, 'invalid session'); return }
    const sid = record.header?.id
    if (!sid) { setStatus(statusStyle.error, 'session has no id'); return }
    const selection = defaultModel.currentSelection()
    try {
      const resumed = await agents.resume({
        resumeSessionId: typeof sid === 'string' ? SessionId(sid) : sid,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
      })
      agent = resumed.agent
      await agent.whenIdle()
      setReady()
      if (lineMode && process.env.DSH_TUI_DEBUG) process.stdout.write(`[resume] done -> ${sid}\n`)
      sink.addLine(labelSystem(`resumed session ${sid}`))
    } catch (err) {
      setStatus(statusStyle.error, `resume failed: ${err.message}`)
    }
  }

  // ======================= live event stream ==============================
  ctx.on('session/event', (session, event) => {
    if (session !== agent?.session) return
    if (lineMode && process.env.DSH_TUI_DEBUG) process.stdout.write(`[evt] ${event.type}\n`)
    try { handleEvent(event) } catch (err) { setStatus(statusStyle.error, `render error: ${err.message}`) }
  })

  let reasoningAcc = ''
  function handleEvent(event) {
    const d = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        reasoningAcc = ''
        setWorking()
        if (approveTestOnTurn) {
          approveTestOnTurn = false
          setImmediate(() => {
            approval.request({ agent, toolName: 'approval-test', reason: 'synthetic test request' })
              .then((o) => {
                setStatus(statusStyle.ok, `approval outcome: ${o}`)
                if (lineMode) process.stdout.write(`\n[dsh-tui] approval outcome: ${o}\n`)
              })
              .catch((e) => {
                setStatus(statusStyle.error, `approval error: ${e.message}`)
                if (lineMode) process.stdout.write(`\n[dsh-tui] approval error: ${e.message}\n`)
              })
          })
        }
        break

      case 'assistant/chunk': {
        const c = d.chunk ?? {}
        if (c.type === 'text-delta') sink.stream(c.text ?? '')
        else if (c.type === 'reasoning-delta') {
          reasoningAcc += c.text ?? ''
          sink.reason(reasoningAcc)
        }
        break
      }

      case 'assistant/message': {
        const text = blockText(d.message)
        sink.endStream(text)
        reasoningAcc = ''
        break
      }

      case 'user/message': {
        if (d.source?.kind === 'user') {
          const text = blockText(d)
          if (text) sink.addLine(labelUser(text))
        }
        break
      }

      case 'tool/call':
        sink.addLine(labelTool(d.name, fmtToolArgs(d.arguments)))
        setStatus(statusStyle.working, `running ${d.name}…`)
        break

      case 'tool/result': {
        const text = blockText(d.message)
        if (text) sink.addLine(labelToolResult(truncate(text, 400)))
        else if (d.error) sink.addLine(statusStyle.error(`tool error: ${d.error.code}`))
        break
      }

      case 'turn/end': {
        setReady()
        const kind = d.reason?.kind
        setStatus(statusStyle[kind === 'completed' ? 'ok' : (kind === 'error' ? 'error' : 'idle')],
          kind === 'completed' ? 'done' : `turn ${kind ?? 'ended'}`)
        void sessions.flush(agent.session)
        if (oneShot) setImmediate(() => exit(kind === 'completed' ? 0 : 1))
        break
      }

      // ---- native service events (plan / goal / todo / subagent / commands) ----
      case 'plan/mode':
        sink.addLine(labelSystem(d.active ? '📋 plan mode on' : 'plan mode off'))
        break
      case 'goal/change':
        sink.addLine(labelSystem(`🎯 goal: ${d.goal ?? ''}`))
        break
      case 'todo/write': {
        const items = (d.todos ?? []).map((t) => `${t.completed ? '☑' : '☐'} ${t.content}`).join('\n')
        if (items) sink.addLine(labelSystem(`📝 ${items}`))
        break
      }
      case 'subagent/descriptor':
        sink.addLine(labelSystem(`🧩 subagent: ${d.name ?? ''} ${d.status ?? ''}`))
        break
      case 'command/run':
        sink.addLine(labelSystem(`▶ /${d.name}${d.args ? ` ${d.args.join(' ')}` : ''}`))
        break
      case 'command/done':
        if (d.outcome?.kind === 'error') setStatus(statusStyle.error, 'command failed')
        break
      case 'compaction/start':
        setStatus(statusStyle.working, 'compacting context…')
        break
      case 'compaction/end':
        setStatus(statusStyle.ok, 'compacted')
        break

      default:
        break
    }
  }

  // ======================= input / commands ===============================
  function sendUser(text) {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    // The user/message event renders this line; don't duplicate it here.
    setWorking()
    agent.followup(message)
  }

  function runCommand(line) {
    const [cmd] = line.split(/\s+/)
    switch (cmd) {
      case '/quit': case '/exit': tui?.stop(); exit(0); return
      case '/clear': sink.clear(); return
      case '/approve-test': {
        if (busy) { setStatus(statusStyle.error, 'busy — run /approve-test when idle'); return }
        try { approval.setPolicy(agent, 'ask') } catch { /* policy write path may vary */ }
        approveTestOnTurn = true
        sendUser('只回复一个词：ok。不要调用任何工具。')
        return
      }
      case '/question-test': {
        if (!userQuestions) { setStatus(statusStyle.error, 'userQuestions unavailable'); return }
        void userQuestions.ask({
          questions: [{ id: 'test-q', question: '你更倾向于哪个方向？', options: [{ label: '原生命令' }, { label: '更多事件渲染' }, { label: '会话恢复' }] }],
        }).then((answer) => {
          const a = answer?.answers?.[0]
          if (lineMode) process.stdout.write(`\n[dsh-tui] question answer: ${JSON.stringify(a)}\n`)
          else setStatus(statusStyle.ok, `answer: ${JSON.stringify(a)}`)
        }).catch((err) => setStatus(statusStyle.error, `question error: ${err.message}`))
        return
      }
      case '/resume': {
        if (!sessionQuery) { setStatus(statusStyle.error, 'session-query unavailable'); return }
        void sessionQuery.listSessions().then((records) => {
          if (!records?.length) { sink.addLine(labelSystem('no sessions found')); return }
          pendingResume = { records }
          renderResumeList(records)
        }).catch((err) => setStatus(statusStyle.error, `list sessions failed: ${err.message}`))
        return
      }
      case '/help': {
        const native = commands ? commands.list(agent).map((c) => `/${c.name}`) : []
        const text = HELP + (native.length ? `\nNative commands: ${native.join(' ')}\n` : '')
        sink.addLine(labelSystem(text))
        return
      }
      default: break
    }
    // Everything else goes through the official command plane (plan, goal,
    // compact, ...). Unknown commands are rejected, not sent to the model.
    if (commands) {
      if (lineMode && process.env.DSH_TUI_DEBUG) process.stdout.write(`[cmd] executing '${line}'\n`)
      const controller = new AbortController() // commands.execute needs a signal
      void commands.execute(agent, line, controller.signal).then((result) => {
        if (lineMode && process.env.DSH_TUI_DEBUG) process.stdout.write(`[cmd] done '${line}' result=${result === undefined ? 'undefined' : typeof result}\n`)
        if (result === undefined) setStatus(statusStyle.error, `unknown command: ${cmd} — try /help`)
        else if (result?.outcome?.kind === 'error') setStatus(statusStyle.error, `command ${cmd} failed`)
      }).catch((err) => {
        if (lineMode && process.env.DSH_TUI_DEBUG) process.stdout.write(`[cmd] catch '${line}': ${err.message}\n`)
        setStatus(statusStyle.error, `command ${cmd} error: ${err.message}`)
      })
      return
    }
    setStatus(statusStyle.error, `unknown command: ${cmd} — try /help`)
  }

  function onInput(text) {
    const trimmed = text.trim()
    if (!trimmed) return
    if (trimmed.startsWith('/')) { runCommand(trimmed); return }
    if (busy) { setStatus(statusStyle.error, 'busy — wait for the current turn'); return }
    sendUser(trimmed)
  }

  // ======================= agent ==========================================
  const selection = defaultModel.currentSelection()
  ;({ agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    // Block body: setupCommit must be undefined so agent-loop's
    // `setupCommit?.commit()` short-circuits (headless-runner does the same).
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  }))
  await agent.whenIdle()

  const initial = (cmdline?.get?.() ?? []).join(' ').trim()

  if (lineMode) {
    if (initial) {
      // Non-interactive one-shot: run the given task, print the stream, exit.
      oneShot = true
      process.stdout.write('dsh-tui (line mode, one-shot)\n')
      setReady()
      setImmediate(() => { try { onInput(initial) } catch { /* not ready */ } })
    } else {
      process.stdout.write('dsh-tui (line mode) — type a task or /help. /quit to exit.\n')
      setReady()
      let buf = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trimEnd()
          buf = buf.slice(idx + 1)
          if (pendingQuestion) {
            resolveQuestion(pendingQuestion.request.questions[0], line.trim())
            continue
          }
          if (pendingResume) {
            const p = pendingResume
            void doResume(p.records, Number(line.trim()) - 1)
            continue
          }
          if (pendingApproval) {
            const p = pendingApproval
            const ans = line.trim().toLowerCase()
            if (ans === 'y') { pendingApproval = null; setReady(); p.resolve('allowed-once') }
            else if (ans === 'n') { pendingApproval = null; setReady(); p.resolve('rejected') }
            else setStatus(statusStyle.error, 'reply y or n to the approval prompt')
            continue
          }
          if (line) onInput(line)
        }
      })
      process.stdin.on('end', () => { exit(0) })
    }
  } else {
    // Start the terminal first; renders/components after are safe.
    editor.onSubmit = (raw) => onInput(raw)
    tui.start()
    tui.setFocus(editor)
    sink.addLine(labelSystem('dsh-tui — DeepSeek Harness terminal UI. Type a task or /help.'))
    setReady()
    if (initial) setImmediate(() => { try { onInput(initial) } catch { /* not ready */ } })
  }
}
