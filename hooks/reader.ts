// Turns a fetched page into markdown the pane can draw. A reader, never a
// browser: no script runs, nothing but the one GET the person asked for leaves
// the machine, and what it returns is drawn in the pane only, so a page's
// words never reach the model.
//
// The page is someone else's and may be built to hurt: every step here walks
// the text once, front to back. A pattern that looks for a tag's partner
// (`<b>…</b>`) rescans the rest of the page for each tag left open, and a page
// of unclosed tags then costs seconds of one press. So the page is cut into
// tags and text in one pass, and everything after works on that list.

export type Rendered = { title: string; markdown: string } | { reason: string }

type Tag = { name: string; isClose: boolean; attrs: string }
type Token = string | Tag

// Bounds the work one press starts: a page past this is read up to here.
const MAX_SOURCE = 600_000
const MAX_MARKDOWN = 30_000
const MAX_TITLE = 200
const THIN = 200
// Private-use marks standing in while the prose around them is reflowed: a
// code block, and the two ends of bold and of inline code.
const FENCE = ''
const BOLD = ['', ''] as const
const CODE = ['', ''] as const
const MARKS = /[-]/g

// What is inside these is not for reading.
const NOISE = new Set([
  'head',
  'title',
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'iframe',
  'canvas',
  'video',
  'audio',
  'form',
  'button',
  'select',
  'dialog',
  'object',
])
// The site's own furniture. An article's <header> holds its headline, so
// these go only when the page marks no main region of its own.
const CHROME = new Set(['nav', 'footer', 'header', 'aside'])
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tr',
  'blockquote',
  'figure',
  'figcaption',
  'details',
  'summary',
  'header',
  'footer',
])
// A page's bytes are untrusted: an escape sequence in them would drive the terminal.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// A page's own text may spell markdown. An image there would make a surface
// that draws pictures fetch it unasked, so it is drawn as the plain link it names.
const IMAGE = /!\[/g

/** What of a page may reach the screen: no control bytes, no embedded media. */
const safe = (text: string): string => text.replace(CONTROL, '').replace(IMAGE, '[')

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  rarr: '→',
  larr: '←',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole: string, name: string) => {
    if (!name.startsWith('#')) {
      return NAMED[name.toLowerCase()] ?? whole
    }

    const isHex = name[1] === 'x' || name[1] === 'X'
    const code = isHex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)

    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

// Where a script or a style ends. Searched in the page itself, whatever its
// case: a lowercased copy is not the same length as the page (`İ` becomes two
// characters), and an index found in one then points at the wrong place in
// the other.
const RAW_END: Record<string, RegExp> = { script: /<\/script/gi, style: /<\/style/gi }

/**
 * The page as tags and the text between them, in one pass. The next `>` is
 * found once and remembered, and a comment, a script or a style is skipped
 * to its end in one search.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  let close = -2

  while (at < html.length) {
    const open = html.indexOf('<', at)

    if (open === -1) {
      tokens.push(html.slice(at))
      break
    }

    if (open > at) {
      tokens.push(html.slice(at, open))
    }

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      at = end === -1 ? html.length : end + 3
      continue
    }

    if (close !== -1 && close < open) {
      close = html.indexOf('>', open)
    }

    if (close === -1) {
      tokens.push(html.slice(open))
      break
    }

    const named = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(open, open + 40))

    if (named === null) {
      // `a < b` in prose: a character, not a tag.
      tokens.push('<')
      at = open + 1
      continue
    }

    const name = (named[2] ?? '').toLowerCase()
    const isClose = named[1] === '/'

    tokens.push({ name, isClose, attrs: html.slice(open + named[0].length, close) })
    at = close + 1

    const rawEnd = isClose ? undefined : RAW_END[name]

    if (rawEnd !== undefined) {
      // Inside these is code, where `a<b` opens nothing: none of it is kept,
      // and one left open (a page cut off mid-script) takes the rest with it.
      rawEnd.lastIndex = at
      at = rawEnd.exec(html)?.index ?? html.length
    }
  }

  return tokens
}

function anchor(href: string, inner: string, base: string): string {
  const text = oneLine(inner).replace(/[[\]]/g, '')

  if (text === '') {
    return ''
  }

  const target = decode(href).trim()

  if (target === '' || target.startsWith('#') || !URL.canParse(target, base)) {
    return text
  }

  const url = new URL(target, base)

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return text
  }

  return `[${text}](${url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`
}

function htmlToMarkdown(html: string, base: string): { title: string; markdown: string } {
  const tokens = tokenize(html)
  const lastClose = new Map<string, number>()

  tokens.forEach((token, index) => {
    if (typeof token !== 'string' && token.isClose) {
      lastClose.set(token.name, index)
    }
  })

  // An element counts as one only when its end exists further on: a tag left
  // open is dropped as a tag and what follows it is still read.
  const closesAfter = (name: string, index: number): boolean => (lastClose.get(name) ?? -1) > index
  const firstOpen = (name: string): number =>
    tokens.findIndex(token => typeof token !== 'string' && !token.isClose && token.name === name)

  let from = 0
  let to = tokens.length
  let hasRegion = false

  for (const name of ['main', 'article']) {
    const open = firstOpen(name)

    if (open !== -1 && closesAfter(name, open)) {
      from = open + 1
      to = lastClose.get(name) ?? to
      hasRegion = true
      break
    }
  }

  if (!hasRegion) {
    const open = firstOpen('body')

    if (open !== -1) {
      from = open + 1
      to = closesAfter('body', open) ? (lastClose.get('body') ?? to) : to
    }
  }

  let index = 0

  /** The text up to the end of `name`, tags dropped; `breaks` is what a <br> becomes. */
  const collect = (name: string, limit: number, breaks: string): string => {
    let text = ''

    while (index < limit) {
      const token = tokens[index]
      index += 1

      if (typeof token === 'string') {
        text += token
      } else if (token !== undefined && token.isClose && token.name === name) {
        break
      } else if (token !== undefined && token.name === 'br') {
        text += breaks
      }
    }

    return text
  }

  const titleAt = firstOpen('title')
  let title = ''

  if (titleAt !== -1 && closesAfter('title', titleAt)) {
    index = titleAt + 1
    title = safe(decode(oneLine(collect('title', tokens.length, ' ')))).slice(0, MAX_TITLE)
  }

  const isDropped = (name: string): boolean => NOISE.has(name) || (!hasRegion && CHROME.has(name))
  const out: string[] = []
  const fences: string[] = []
  // The elements being left out, innermost last, and how many of each name
  // are among them: a page can open tens of thousands, and asking "is this
  // end one of ours" by walking that stack at every closing tag cost seconds.
  const dropping: string[] = []
  const droppingOf = new Map<string, number>()
  const drop = (name: string): void => {
    dropping.push(name)
    droppingOf.set(name, (droppingOf.get(name) ?? 0) + 1)
  }

  index = from

  while (index < to) {
    const here = index
    const token = tokens[index]
    index += 1

    if (token === undefined) {
      break
    }

    if (typeof token === 'string') {
      if (dropping.length === 0) {
        out.push(token.replace(/\s+/g, ' '))
      }

      continue
    }

    const { name, isClose, attrs } = token

    if (dropping.length > 0) {
      if (isClose && (droppingOf.get(name) ?? 0) > 0) {
        // Markup nests badly in the wild: an end closes its element and whatever was left open inside it.
        for (let closed = dropping.pop(); closed !== undefined; closed = dropping.pop()) {
          droppingOf.set(closed, (droppingOf.get(closed) ?? 1) - 1)

          if (closed === name) {
            break
          }
        }
      } else if (!isClose && isDropped(name) && closesAfter(name, here)) {
        drop(name)
      }

      continue
    }

    if (!isClose && isDropped(name) && closesAfter(name, here)) {
      drop(name)
    } else if (!isClose && name === 'pre' && closesAfter('pre', here)) {
      fences.push(decode(collect('pre', to, '\n')).replace(/```/g, "'''").replace(/^\n+|\s+$/g, ''))
      out.push(` ${FENCE}${fences.length - 1}${FENCE} `)
    } else if (!isClose && name === 'a' && closesAfter('a', here)) {
      // A tag's attributes are as long as the page lets them be; an address sits near their start.
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs.slice(0, 4000))

      out.push(anchor(href?.[1] ?? href?.[2] ?? href?.[3] ?? '', collect('a', to, ' '), base))
    } else if (name === 'b' || name === 'strong') {
      out.push(isClose ? BOLD[1] : closesAfter(name, here) ? BOLD[0] : '')
    } else if (name === 'code') {
      out.push(isClose ? CODE[1] : closesAfter(name, here) ? CODE[0] : '')
    } else if (/^h[1-6]$/.test(name)) {
      out.push(isClose ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `)
    } else if (name === 'li' && !isClose) {
      out.push('\n- ')
    } else if (name === 'br') {
      out.push('\n')
    } else if (name === 'hr') {
      out.push('\n\n---\n\n')
    } else if ((name === 'td' || name === 'th') && isClose) {
      out.push('   ')
    } else if (BLOCK.has(name)) {
      out.push('\n\n')
    }
  }

  const pair = (marks: readonly [string, string], wrap: (inner: string) => string): [RegExp, (whole: string, inner: string) => string] => [
    new RegExp(`${marks[0]}([^${marks[0]}${marks[1]}]*)${marks[1]}`, 'g'),
    (_whole, inner) => (inner.trim() === '' ? '' : wrap(inner.trim())),
  ]

  const text = decode(out.join(''))
    .replace(...pair(CODE, inner => `\`${inner}\``))
    .replace(...pair(BOLD, inner => `**${inner}**`))
    .replace(MARKS, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    // `<li><p>text</p></li>` leaves the bullet a line above its text.
    .replace(/(^|\n)-\n+(?=\S)/g, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const isThin = text.replaceAll(FENCE, '').length < THIN && fences.length === 0
  const paragraphEnd = text.lastIndexOf('\n\n', MAX_MARKDOWN)
  const cut = text.length > MAX_MARKDOWN ? text.slice(0, paragraphEnd > 0 ? paragraphEnd : MAX_MARKDOWN) : text
  const tail =
    cut.length < text.length
      ? '\n\n---\n\n*The page goes on. Open it in the browser for the rest.*'
      : isThin
        ? '\n\n---\n\n*Little text came back: this page likely draws itself with JavaScript. Open it in the browser.*'
        : ''
  const restored = cut.replace(
    new RegExp(`\\s*${FENCE}(\\d+)${FENCE}\\s*`, 'g'),
    (_: string, at: string) => `\n\n\`\`\`\n${fences[Number(at)] ?? ''}\n\`\`\`\n\n`,
  )

  return { title, markdown: safe(restored.trim() + tail) }
}

const fenced = (language: string, source: string): string =>
  `\`\`\`${language}\n${source.slice(0, MAX_MARKDOWN).replace(/```/g, "'''").replace(CONTROL, '')}\n\`\`\``

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    // A body labelled JSON that does not parse is still worth reading as sent.
    return body
  }
}

/** What the pane draws for one response: by its content type, then by its looks. */
export function renderPage(url: string, contentType: string, body: string): Rendered {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  const source = body.slice(0, MAX_SOURCE)
  const { hostname, pathname } = new URL(url)
  const name = pathname.split('/').filter(Boolean).at(-1) ?? hostname

  if (type.includes('html') || (type === '' && /<html\b|<!doctype html/i.test(source.slice(0, 2000)))) {
    const page = htmlToMarkdown(source, url)

    return { title: page.title === '' ? name : page.title, markdown: page.markdown }
  }

  if (type === 'application/json' || type.endsWith('+json')) {
    return { title: name, markdown: fenced('json', prettyJson(source)) }
  }

  if (type === 'text/markdown' || /\.mdx?$/i.test(pathname)) {
    return { title: name, markdown: safe(source.slice(0, MAX_MARKDOWN)) }
  }

  if (type.startsWith('text/') || type.endsWith('xml') || type === '') {
    return { title: name, markdown: fenced('', source) }
  }

  return { reason: `This address serves ${type}, which reads best in the browser.` }
}
