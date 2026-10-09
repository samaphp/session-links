import type { Link, LinkSource } from '../types'

/**
 * Unnamed floating links per session. Past it the oldest of them leaves. A
 * pinned, dismissed or named link never does: those are the person's decisions,
 * and the list promises that a dismissed link stays dismissed when mentioned again.
 */
export const MAX_LINKS = 300

const CANDIDATE = /https?:\/\/[^\s<>"'`\\^{}|]+/gi
// Prose punctuation that ends a sentence, Arabic and CJK marks included.
const TRAILING = '.,;:!?*_~،؛؟。，'
const CLOSERS: Record<string, string> = { ')': '(', ']': '[' }
const NAMED_HOST =
  /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|([a-z0-9-]+\.)+([a-z]{2,}|xn--[a-z0-9-]+))$/i
// `http://web:3000` between containers is a real address; a bare `http://word` is prose.
const SINGLE_LABEL = /^[a-z0-9-]+$/i

const count = (text: string, mark: string): number => text.split(mark).length - 1

/** `text` cut to `max` cells, the cut marked. The one place a label is shortened. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`

/**
 * Injected context (instruction files, reminders) is not the conversation:
 * what sits between its tags is left out. One walk through the text, so a row
 * full of opening tags with no end costs one search, not one per tag.
 */
function withoutReminders(text: string): string {
  const open = '<system-reminder>'
  const close = '</system-reminder>'
  let kept = ''
  let at = 0

  for (;;) {
    const start = text.indexOf(open, at)
    const end = start === -1 ? -1 : text.indexOf(close, start)

    if (end === -1) {
      return kept + text.slice(at)
    }

    kept += `${text.slice(at, start)} `
    at = end + close.length
  }
}

function trimTail(raw: string): string {
  let url = raw

  while (url !== '') {
    const last = url.at(-1) ?? ''
    const opener = CLOSERS[last]
    // `(see https://host/a)` closes the sentence; `/wiki/Foo_(bar)` closes its own.
    const isLoose = opener !== undefined && count(url, last) > count(url, opener)

    if (!TRAILING.includes(last) && !isLoose) {
      break
    }

    url = url.slice(0, -1)
  }

  return url
}

function normalize(raw: string): string | null {
  if (!URL.canParse(raw)) {
    return null
  }

  const url = new URL(raw)
  const isAddress =
    NAMED_HOST.test(url.hostname) || (SINGLE_LABEL.test(url.hostname) && url.port !== '')

  return isAddress ? url.href : null
}

/** The http(s) links a text mentions: normalized, each once, in reading order. */
export function extractUrls(text: string): string[] {
  const found = new Set<string>()

  for (const match of withoutReminders(text).matchAll(CANDIDATE)) {
    // An address written with an ellipsis (`https://host/blog/…`) was shortened
    // by its writer: what is left opens nothing, so it is no link to collect.
    if (match[0].includes('…')) {
      continue
    }

    const url = normalize(trimTail(match[0]))

    if (url !== null) {
      found.add(url)
    }
  }

  return [...found]
}

function trim(list: Link[]): Link[] {
  const floating = list.filter(link => link.status === 'floating' && link.name === undefined).sort((a, b) => a.lastAt - b.lastAt)
  const gone = new Set(floating.slice(0, Math.max(0, floating.length - MAX_LINKS)))

  return gone.size === 0 ? list : list.filter(link => !gone.has(link))
}

/**
 * A mention never changes a decision: a dismissed link mentioned again stays
 * dismissed, a pinned one stays pinned.
 */
export function mergeMentions(
  list: readonly Link[],
  urls: readonly string[],
  source: LinkSource,
  at: number,
): Link[] {
  const merged = [...list]

  for (const url of urls) {
    const index = merged.findIndex(link => link.url === url)
    const seen = merged[index]

    if (seen === undefined) {
      merged.push({ url, source, status: 'floating', mentions: 1, firstAt: at, lastAt: at })
    } else {
      merged[index] = { ...seen, mentions: seen.mentions + 1, lastAt: at }
    }
  }

  return trim(merged)
}

/** The link the conversation keeps coming back to leads; between equals, the one mentioned last. */
export const byPriority = (a: Link, b: Link): number => b.mentions - a.mentions || b.lastAt - a.lastAt

/** What the band seats, in order: the pinned links, then the floating ones, each group by priority. */
export function bandOrder(list: readonly Link[]): Link[] {
  const pinned = list.filter(link => link.status === 'pinned').sort(byPriority)
  const floating = list.filter(link => link.status === 'floating').sort(byPriority)

  return [...pinned, ...floating]
}

const MAX_DOMAIN = 28
const MAX_HINT = 16

const siteOf = (url: string): string => new URL(url).host.replace(/^www\./, '')

const closing = (segments: readonly string[], count: number): string => segments.slice(-count).join('/')

/**
 * What tells apart the links that share a site: the closing run of each
 * one's path, as short as still differs from the others'. A last segment that
 * is only a number or a few letters brings the one before it (`pull/12`).
 */
function hintsFor(paths: readonly (readonly string[])[]): string[] {
  return paths.map((segments, index) => {
    const start = /^(\d+|.{1,3})$/.test(segments.at(-1) ?? '') ? 2 : 1

    for (let count = start; count <= segments.length; count += 1) {
      const tail = closing(segments, count)

      if (paths.every((other, at) => at === index || closing(other, count) !== tail)) {
        return tail
      }
    }

    return segments.join('/')
  })
}

/**
 * What each chip writes, by link: the name the person gave it in the list,
 * else the site alone, so that one row seats many links, and beside it a
 * short hint of the path only for links that share their site with another
 * unnamed one on the band.
 */
export function chipLabels(links: readonly Link[]): Map<string, string> {
  const bySite = new Map<string, Link[]>()
  const labels = new Map<string, string>()

  for (const link of links) {
    if (link.name !== undefined) {
      labels.set(link.url, clip(link.name, MAX_DOMAIN))
      continue
    }

    const site = siteOf(link.url)
    bySite.set(site, [...(bySite.get(site) ?? []), link])
  }

  for (const [site, group] of bySite) {
    const hints =
      group.length === 1
        ? ['']
        : hintsFor(group.map(link => new URL(link.url).pathname.split('/').filter(Boolean)))

    group.forEach((link, index) => {
      const hint = hints[index] ?? ''

      labels.set(link.url, clip(site, MAX_DOMAIN) + (hint === '' ? '' : `/${clip(hint, MAX_HINT)}`))
    })
  }

  return labels
}

/**
 * Host and path, sized to `max` cells: how a toast names the one link it is
 * about. The query string is never drawn: that is where tokens and signatures ride.
 */
export function labelOf(url: string, max: number): string {
  const { host, pathname } = new URL(url)
  const site = host.replace(/^www\./, '')
  const segments = pathname.split('/').filter(Boolean)
  const full = [site, ...segments].join('/')

  if (full.length <= max || segments.length < 2) {
    return clip(full, max)
  }

  // The end of a path names the page, the middle is the way there: the
  // middle folds first, and as many closing segments stay as the room holds.
  let tail = ''

  for (const segment of [...segments].reverse()) {
    const longer = `/${segment}${tail}`

    if (site.length + 2 + longer.length > max) {
      break
    }

    tail = longer
  }

  return clip(`${site}/…${tail === '' ? `/${segments.at(-1)}` : tail}`, max)
}

/**
 * The address as the pane labels a hyperlink: the query folded to `?…`, the
 * fragment kept. Where the terminal has no hyperlinks the pane writes the
 * address whole instead, since only a complete one can be opened on a click.
 */
export function displayOf(url: string, max: number): string {
  const { host, pathname, search, hash } = new URL(url)
  const full = host + pathname.replace(/\/$/, '') + (search === '' ? '' : '?…') + hash

  return clip(full, max)
}
