/**
 * pi-tui themes for dsh-tui. Follows the archived official TUI design notes:
 * a single small palette, status headers over recessed detail, semantic colors.
 */

const RESET = '\x1b[0m'
const wrap = (code) => (s) => `\x1b[${code}m${s}${RESET}`
const dim = wrap('2')
const cyan = wrap('36')
const green = wrap('32')
const yellow = wrap('33')
const red = wrap('31')
const blue = wrap('34')
const magenta = wrap('35')
const bold = wrap('1')

/** Render one markdown element. */
export const markdownTheme = {
  heading: (s) => bold(cyan(s)),
  link: (s) => `\x1b[4;34m${s}${RESET}`,
  linkUrl: (s) => dim(s),
  code: (s) => yellow(s),
  codeBlock: (s) => yellow(s),
  codeBlockBorder: (s) => dim(s),
  codeBlockIndent: '  ',
  quote: (s) => dim(s),
  quoteBorder: (s) => dim(s),
  hr: (s) => dim(s),
  listBullet: (s) => cyan(s),
  bold: (s) => bold(s),
  italic: (s) => `\x1b[3m${s}${RESET}`,
  strikethrough: (s) => `\x1b[9m${s}${RESET}`,
  underline: (s) => `\x1b[4m${s}${RESET}`,
}

/** Theme for the bottom input editor + its autocomplete select list. */
export const editorTheme = {
  borderColor: (s) => cyan(s),
  selectList: {
    selectedPrefix: (s) => cyan(s),
    selectedText: (s) => bold(s),
    description: (s) => dim(s),
    scrollInfo: (s) => dim(s),
    noMatch: (s) => red(s),
  },
}

/** Message labels. */
export const labelUser = (s) => `${bold(yellow('You'))} ${s}`
export const labelAssistant = (s) => `${bold(green('dsh'))} ${s}`
export const labelTool = (name, args) => `${bold(blue('▸'))} ${bold(name)}${args ? ` ${dim(args)}` : ''}`
export const labelToolResult = (s) => dim(s)
export const labelReasoning = (s) => dim(s)
export const labelSystem = (s) => dim(s)

export const statusStyle = {
  idle: (s) => dim(s),
  working: (s) => magenta(s),
  approval: (s) => `${bold(red('⚠'))} ${s}`,
  error: (s) => red(s),
  ok: (s) => green(s),
}
