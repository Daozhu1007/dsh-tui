/**
 * Headless render test for the full-screen (pi-tui) path of dsh-tui.
 * Drives TuiAltScreen with a fake Terminal, feeds the same layout + events
 * the plugin uses, and captures the rendered output — no real TTY required.
 *
 * Run: node dsh-tui/test-render.mjs
 */

import { TuiAltScreen, VStack, ScrollView, Container, Text, Markdown, Editor } from '@earendil-works/pi-tui'
import { markdownTheme, editorTheme, labelUser, labelTool, labelToolResult, labelSystem, statusStyle } from './themes.mjs'

class FakeTerminal {
  constructor() { this.buf = ''; this._columns = 100; this._rows = 30; this.onInput = null }
  start(onInput) { this.onInput = onInput }
  stop() {}
  async drainInput() {}
  write(d) { this.buf += d }
  get columns() { return this._columns }
  get rows() { return this._rows }
  get kittyProtocolActive() { return false }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}

const terminal = new FakeTerminal()
const tui = new TuiAltScreen(terminal)
const transcript = new Container()
const scroll = new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto' })
const status = new Text('')
const editor = new Editor(tui, editorTheme)
tui.setLayoutRoot(new VStack([
  { component: scroll, basis: 0, grow: 1, minSize: 1 },
  { component: new VStack([editor, status]), basis: 'auto', shrink: 1, minSize: 1 },
]))

let streaming = null
const sink = {
  addLine: (styled) => { transcript.addChild(new Text(styled, 1, 0)); tui.requestRender() },
  stream: (text) => {
    if (!streaming) { streaming = { md: new Markdown('', 1, 0, markdownTheme), text: '' }; transcript.addChild(streaming.md) }
    streaming.text += text
    streaming.md.setText(streaming.text)
    tui.requestRender()
  },
  status: (s) => { status.setText(s); tui.requestRender() },
}

tui.setFocus(editor)
tui.start()

// Simulate the plugin's event-driven transcript.
sink.addLine(labelSystem('dsh-tui — DeepSeek Harness terminal UI'))
sink.addLine(labelUser('hello'))
sink.stream('Hel')
sink.stream('lo, **world**!')
sink.addLine(labelTool('pwsh', 'Run echo hi  (echo hi)'))
sink.addLine(labelToolResult('hi'))
sink.status(statusStyle.idle('done'))

// Let the render loop flush, then force a frame.
await new Promise((r) => setTimeout(r, 300))
tui.renderNow(true)
await new Promise((r) => setTimeout(r, 100))

const cleaned = terminal.buf
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // strip CSI
  .replace(/\x1b\][^\x07]*\x07/g, '')       // strip OSC (title)
console.log(`=== captured ${terminal.buf.length} bytes, cleaned ${cleaned.length} ===`)
console.log('--- rendered document ---')
console.log(cleaned)
