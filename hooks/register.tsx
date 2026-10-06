import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Link, LinkSource, LinkStatus, PaneView, ReaderPage, SessionRecord } from '../types'

import { bandOrder, byPriority, chipLabels, clip, displayOf, extractUrls, labelOf, mergeMentions } from './links'
import { renderPage } from './reader'

const PANE = 'links'
// `$.store` holds 4 MiB across every session; past this many the oldest records leave.
const MAX_SESSIONS = 300
// Making room reads every record to find the oldest. Trimming to the cap
// exactly would repeat that read at every start once the store is full, so
// it trims this far below and the read comes once in that many new sessions.
const SESSION_SLACK = 50
const LIST: PaneView = { reader: null, trail: [] }
// One chip is `▎ ☆  domain  read  × `. Each control carries a cell of air on
// each side inside its own label: the highlight under the pointer or the focus
// is the label's width, and one bare glyph made a target too tight to see or
// to hit. A pinned chip is `▎ ★  domain  read `: a lock has no dismiss beside it,
// so losing a link the person kept takes an unpin first. Both widths count the
// gap to the next chip.
const FLOATING_CELLS = 16
const PINNED_CELLS = 13
// A dismissal takes two presses. The first turns the cross into this question
// on the chip itself, so what is about to go is named where the person is
// looking; the second, on the same control, dismisses. Left alone, the
// question goes back to a cross.
const ARMED_LABEL = ' dismiss? '
const DISMISS_LABEL = ' × '
const DISARM_MS = 4000
// Room kept at a row's end for the control that closes the band, air included:
// ` +12 more ` on the last row the band may take, ` ≡ ` on an earlier one.
const BAND_TAIL = 11
const ROW_TAIL = 3
// The band grows downward before it hides a link: three rows show a busy
// session whole, and the person tidies by dismissing what they no longer need.
const MAX_ROWS = 3
const READER_ACCEPT =
  'text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5'
// xdg-open stays alive for as long as the browser it started does, and
// `$.process.run` waits on a child's output: so it is detached, its output
// dropped, and the address rides as an argument, never as script text. An
// opener with nothing to hand the address to gives up within a moment, so
// the script watches for that moment: its exit then says whether the
// address was taken, which is all "sent to your browser" may claim.
const DETACHED_XDG_OPEN = [
  'command -v xdg-open >/dev/null || exit 127',
  'if command -v setsid >/dev/null; then setsid xdg-open "$1" >/dev/null 2>&1 &',
  'else xdg-open "$1" >/dev/null 2>&1 &',
  'fi',
  'opener=$!',
  'for tick in 1 2 3 4 5 6 7 8 9 10; do',
  '  kill -0 "$opener" 2>/dev/null || break',
  '  sleep 0.1',
  'done',
  'kill -0 "$opener" 2>/dev/null && exit 0',
  'wait "$opener"',
].join('\n')

const sessionId = atom({ plugin: 'session-links', key: 'sessionId' } as const, '')
const links = atom({ plugin: 'session-links', key: 'links' } as const, [])
const freshSince = atom({ plugin: 'session-links', key: 'freshSince' } as const, 0)
const view = atom({ plugin: 'session-links', key: 'view' } as const, LIST)
const armed = atom({ plugin: 'session-links', key: 'armed' } as const, '')

type Engine = EngineInterface
// `id` is the link's address: it names the link's controls wherever the chip
// sits, so a key stays with its link when the row reorders or the cap trims.
type Chip = { link: Link; id: string; label: string }
type Kit = Pick<Elements[RenderSurface], 'Box' | 'Button' | 'Link' | 'Markdown' | 'Text'> & {
  // The mobile app draws no text field yet: there the list goes without its add box.
  Input?: Elements['terminal']['Input']
}
type Row = {
  agentId?: string
  message: { content: readonly { type: string; [field: string]: unknown }[] }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A failure of this mod must never cost the conversation a row or a prompt: it goes to the debug log. */
async function quietly($: Engine, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    // The engine tags each log line with the plugin's name: the line carries only what happened.
    $.ui.log(`could not ${what}: ${reasonOf(error)}`, { to: 'debug' })
  }
}

const keyOf = (id: string): string => `session:${id}`

const isRecord = (value: unknown): value is SessionRecord =>
  typeof value === 'object' && value !== null && Array.isArray((value as SessionRecord).links)

/** Once more than `limit` sessions are saved, drops the ones saved longest ago, down to `keep`. */
async function forget($: Engine, limit: number, keep: number): Promise<void> {
  const keys = (await $.store.keys()).filter(key => key.startsWith('session:'))

  if (keys.length <= limit) {
    return
  }

  const aged: { key: string; savedAt: number }[] = []

  for (const key of keys) {
    const record = await $.store.get(key)
    aged.push({ key, savedAt: isRecord(record) ? record.savedAt : 0 })
  }

  aged.sort((a, b) => a.savedAt - b.savedAt)

  for (const { key } of aged.slice(0, aged.length - keep)) {
    await $.store.delete(key)
  }
}

/**
 * The store is what a resume reads, so every change of the list is written
 * through at once: there is no "save on exit" to miss when the terminal dies.
 */
async function save($: Engine): Promise<void> {
  const id = await read($, sessionId)

  if (id === '') {
    return
  }

  const record: SessionRecord = { links: await read($, links), savedAt: await $.clock.now() }

  try {
    await $.store.set(keyOf(id), record)
  } catch (error) {
    $.ui.log(`the store refused a save, making room: ${reasonOf(error)}`, { to: 'debug' })
    await forget($, 0, Math.floor(MAX_SESSIONS / 2))

    try {
      await $.store.set(keyOf(id), record)
    } catch (again) {
      $.ui.toast(`Links were not saved, so a resume will not restore them: ${reasonOf(again)}`)
    }
  }
}

/** A session the mod never saw (it was installed mid-conversation) starts from what its transcript mentions. */
function fromTranscript(messages: readonly { role: 'user' | 'assistant'; text: string }[]): Link[] {
  return messages.reduce<Link[]>(
    (list, message, index) =>
      mergeMentions(list, extractUrls(message.text), message.role === 'user' ? 'you' : 'claude', index + 1),
    [],
  )
}

async function load($: Engine): Promise<void> {
  const id = await $.session.id()

  // Also true after a hot reload of this file: the host kept the state.
  if ((await read($, sessionId)) === id) {
    return
  }

  const saved = await $.store.get(keyOf(id))
  const restored = isRecord(saved) ? saved.links : fromTranscript(await $.session.messages())
  const now = await $.clock.now()

  await update($, links, () => restored)
  await update($, view, () => LIST)
  await update($, armed, () => '')
  // Nothing restored is news: only what arrives from here on is drawn fresh.
  await update($, freshSince, () => now)
  await update($, sessionId, () => id)

  if (!isRecord(saved) && restored.length > 0) {
    await save($)
  }

  await forget($, MAX_SESSIONS, MAX_SESSIONS - SESSION_SLACK)
}

let loading: Promise<void> | undefined

/**
 * The state always belongs to the session on screen. A /clear and an
 * in-process /resume go on under another id with no `session.start`, so every
 * entry point and every drawing passes through here, and a changed id reloads
 * that session's links.
 */
function ensure($: Engine): Promise<void> {
  loading ??= load($).finally(() => {
    loading = undefined
  })

  return loading
}

/**
 * A drawing never shows another session's links. An in-process /resume is
 * announced (`classic.SessionStart`) while the process is still under the
 * session it leaves, so the announcement alone reloads the wrong one: the
 * first drawing after the switch is what notices. A render cannot write
 * state, so the reload runs as a dispatch of its own and redraws when done.
 */
async function isCurrent($: Engine): Promise<boolean> {
  if ((await $.session.id()) === (await read($, sessionId))) {
    return true
  }

  $.clock.after(0, () => void quietly($, 'load the links', () => ensure($)))

  return false
}

async function capture($: Engine, row: Row, source: LinkSource): Promise<void> {
  // A subagent's conversation is its own; what matters of it reaches the main one.
  if (row.agentId !== undefined) {
    return
  }

  const text = row.message.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
  const urls = extractUrls(text)

  if (urls.length === 0) {
    return
  }

  // Before the merge, so a first load never reads this row back from the transcript as well.
  await ensure($)

  const now = await $.clock.now()
  await update($, links, list => mergeMentions(list, urls, source, now))
  await save($)
}

/** Also seats a page the conversation never mentioned, when the person pins it from the reader. */
async function setStatus($: Engine, url: string, status: LinkStatus): Promise<void> {
  const now = await $.clock.now()

  await update($, links, list => {
    const known = list.some(link => link.url === url) ? list : mergeMentions(list, [url], 'you', now)

    return known.map(link => (link.url === url ? { ...link, status } : link))
  })
  await save($)
}

/**
 * A pin moves its link to the front of the row, while the engine's focus ring
 * keeps its place in the row: the ring is sent after the link it was on.
 */
async function togglePin($: Engine, link: Link, key: string, requestId: string): Promise<void> {
  await setStatus($, link.url, link.status === 'pinned' ? 'floating' : 'pinned')

  // Answers `{ deny }` when the site does not hold the keyboard (a pointer
  // press on a surface with no ring): there is no highlight to move then.
  const moved = await $.ui.focus({ requestId, key })

  if (moved.deny !== undefined) {
    $.ui.log(`the highlight stayed where it was: ${moved.deny}`, { to: 'debug' })
  }
}

async function dismiss($: Engine, url: string): Promise<void> {
  await setStatus($, url, 'dismissed')
  // The chip is gone from the band, so the way back is said where they acted.
  $.ui.toast(`Dismissed ${labelOf(url, 40)} · /links brings it back`)
}

/**
 * What the person typed or pasted into the list's field. A link added by hand
 * is one they went out of their way to keep, so it starts locked in. Nothing
 * of this reaches the model: the field is the mod's, the prompt box is not touched.
 */
async function addByHand($: Engine, text: string): Promise<void> {
  const typed = text.trim()
  // An address is usually copied without its scheme. A machine on the desk
  // serves plain http; everything else is assumed to be the secure web.
  const isLocal = /^(localhost|\d{1,3}(\.\d{1,3}){3})([:/]|$)/i.test(typed)
  const urls = extractUrls(/https?:\/\//i.test(typed) ? typed : `${isLocal ? 'http' : 'https'}://${typed}`)

  if (urls.length === 0) {
    // The engine empties the field on Enter, so the reason quotes what was typed.
    $.ui.toast(typed === '' ? 'Type or paste a web address, then press Enter' : `"${clip(typed, 40)}" is not a web address`)

    return
  }

  for (const url of urls) {
    await setStatus($, url, 'pinned')
  }

  $.ui.toast(urls.length === 1 ? `Pinned ${labelOf(urls[0] ?? '', 44)}` : `Pinned ${urls.length} links`)
}

/** The first press on a link's dismiss asks; the second, while the question stands, answers yes. */
async function pressDismiss($: Engine, url: string): Promise<void> {
  if ((await read($, armed)) === url) {
    await update($, armed, () => '')
    await dismiss($, url)

    return
  }

  await update($, armed, () => url)
  // A question nobody answers must not wait there to catch a stray press later.
  $.clock.after(DISARM_MS, () => void quietly($, 'withdraw the question', () => update($, armed, now => (now === url ? '' : now))))
}

async function copyLink($: Engine, url: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: url, surface })

  $.ui.toast(copied.isCopied ? `Copied ${labelOf(url, 44)}` : `This surface has no clipboard: ${url}`)
}

async function openInBrowser($: Engine, url: string, surface: RenderSurface): Promise<void> {
  const openers = [
    ['sh', '-c', DETACHED_XDG_OPEN, 'sh', url],
    ['open', url],
    ['rundll32', 'url.dll,FileProtocolHandler', url],
  ]
  const refusals: string[] = []

  for (const argv of openers) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })

      if (ran.exitCode === 0) {
        // The opener took the address; whether a window then appeared is the desktop's to show.
        $.ui.toast(`Sent ${labelOf(url, 44)} to your browser`)

        return
      }

      // 127 is the script's own word for "this machine has no xdg-open": nothing gave up, nothing was there.
      if (ran.exitCode !== 127) {
        refusals.push(`${argv[0] === 'sh' ? 'xdg-open' : argv[0]} gave up with exit ${ran.exitCode}`)
      }
    } catch (error) {
      // Each opener belongs to one platform; the next one is tried.
      $.ui.log(`${argv[0]} is not an opener here: ${reasonOf(error)}`, { to: 'debug' })
    }
  }

  const copied = await $.ui.copy({ text: url, surface })
  const why = refusals.length === 0 ? 'No browser opener answered on this machine' : `No browser took the link (${refusals.join(', ')})`

  $.ui.toast(copied.isCopied ? `${why}, so the link is on your clipboard` : `${why}: ${url}`)
}

/**
 * The engine seats a pane at any width only when the open answers the
 * person's own press or command. One that arrives after that press has been
 * answered counts as the mod's own idea and waits for a 110-column terminal
 * ("waiting for room"). So a caller asks for the pane FIRST, before any other
 * await, and every press handler hands its promise back so the press stays
 * open until then. `const opening = openPane($)` ahead of the other awaits
 * is that rule, not an oversight: folding it into the awaits below breaks
 * the pane on a narrow terminal.
 */
async function openPane($: Engine): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'Links', focus: true })

  if (!opened.isPlaced) {
    $.ui.toast(`The links pane is waiting for room: ${opened.reason}`)
  }
}

async function showList($: Engine): Promise<void> {
  const opening = openPane($)

  await update($, view, () => LIST)
  await opening
}

/**
 * A bare status code read as "the reader cannot open pages" to the person it
 * was first shown to: the reason says what the code means for this address.
 */
function refusalOf(status: number): string {
  if (status === 404 || status === 410) {
    return `There is no page at this address (the server answered ${status}).`
  }

  if (status === 401 || status === 403) {
    return `This page wants a sign-in, which the reader does not have (the server answered ${status}).`
  }

  if (status >= 500) {
    return `The site is failing right now (the server answered ${status}).`
  }

  return `The server would not hand the page over (it answered ${status}).`
}

async function fetchPage($: Engine, url: string): Promise<ReaderPage> {
  try {
    const got = await $.http.fetch(url, {
      headers: { accept: READER_ACCEPT, 'user-agent': `Mozilla/5.0 (compatible; ${$.plugin.name}-reader)` },
    })

    if (!got.ok) {
      return { url, phase: 'failed', reason: refusalOf(got.status) }
    }

    const page = renderPage(url, got.headers['content-type'] ?? '', got.text)

    return 'reason' in page ? { url, phase: 'failed', reason: page.reason } : { url, phase: 'ready', ...page }
  } catch (error) {
    return { url, phase: 'failed', reason: `The page could not be fetched: ${reasonOf(error)}` }
  }
}

/**
 * A page's text can spell a link of any scheme, and can hide a web address
 * inside another one (`file:///etc/passwd#https://host/x`). The reader follows
 * the web's two schemes only, so the whole address is judged, never a part of it.
 */
function webAddress(text: string): string | null {
  if (!URL.canParse(text)) {
    return null
  }

  const { protocol, href } = new URL(text)

  return protocol === 'https:' || protocol === 'http:' ? href : null
}

/**
 * The one request this mod ever sends, and only on the person's own press:
 * a link is never fetched because it was mentioned (it may be a one-time
 * sign-in or unsubscribe address, and a GET would spend it).
 */
async function showPage($: Engine, asked: string, trail: string[]): Promise<void> {
  const url = webAddress(asked)

  if (url === null) {
    $.ui.toast('The reader opens http and https addresses only')

    return
  }

  const opening = openPane($)
  const loadingPage: PaneView = { reader: { url, phase: 'loading' }, trail }

  await update($, view, () => loadingPage)
  await opening

  const page = await fetchPage($, url)

  // A newer press owns the pane by now: this answer is for a page no longer shown.
  await update($, view, shown =>
    shown.reader?.url === url && shown.reader.phase === 'loading' ? { ...shown, reader: page } : shown,
  )

  if (page.phase !== 'ready') {
    return
  }

  const known = (await read($, links)).find(link => link.url === url)

  if (known !== undefined && known.title !== page.title) {
    await update($, links, list => list.map(link => (link.url === url ? { ...link, title: page.title } : link)))
    await save($)
  }
}

/**
 * Whether a Link will be drawn as a real hyperlink. On a terminal the engine
 * draws one only when it takes the terminal to speak hyperlinks; otherwise it
 * prints the Link's text followed by the whole URL in dim. It does not say
 * which it will do, so the mod goes by what the person has declared the
 * standard way (FORCE_HYPERLINK), and draws no Link on a terminal without it.
 */
async function drawsHyperlinks($: Engine, surface: RenderSurface): Promise<boolean> {
  if (surface !== 'terminal') {
    return true
  }

  const declared = await $.env.get('FORCE_HYPERLINK')

  return declared !== undefined && !(declared.length > 0 && parseInt(declared, 10) === 0)
}

const barOf = (link: Link, since: number): string =>
  link.status === 'pinned' ? 'claude' : link.lastAt >= since ? 'suggestion' : 'subtle'

/**
 * Chips fill a row, then the next, up to `maxRows`; what the last row cannot
 * seat whole is counted, never squeezed. Every row keeps room for the control
 * that closes the band, since any row may turn out to be its last.
 */
function seat(
  all: readonly Link[],
  columns: number,
  maxRows: number,
  asked: string,
): { rows: Chip[][]; hidden: number } {
  const ordered = bandOrder(all)
  const labels = chipLabels(ordered)
  const rows: Chip[][] = [[]]
  let used = 0
  let seated = 0

  for (const link of ordered) {
    const label = labels.get(link.url) ?? ''
    const width =
      label.length +
      (link.status === 'pinned' ? PINNED_CELLS : FLOATING_CELLS) +
      (link.url === asked ? ARMED_LABEL.length - DISMISS_LABEL.length : 0)
    const isLastRow = rows.length >= maxRows
    const isFull = used > 0 && used + width > columns - (isLastRow ? BAND_TAIL : ROW_TAIL)

    if (isFull && isLastRow) {
      break
    }

    if (isFull) {
      rows.push([])
      used = 0
    }

    rows.at(-1)?.push({ link, id: link.url, label })
    used += width
    seated += 1
  }

  return { rows, hidden: ordered.length - seated }
}

function listView(
  $: Engine,
  kit: Kit,
  all: readonly Link[],
  columns: number,
  since: number,
  isLinked: boolean,
  asked: string,
) {
  const { Box, Button, Link, Text } = kit
  const Field = kit.Input
  const run = (what: string, work: () => Promise<unknown>) => () => quietly($, what, work)
  // A row's keys carry its link's address: unique across the sections, and
  // unmoved when a link changes section or the cap trims the list.
  const pinned = all.filter(link => link.status === 'pinned').sort(byPriority)
  const floating = all.filter(link => link.status === 'floating').sort(byPriority)
  const dismissed = all.filter(link => link.status === 'dismissed')
  const width = Math.max(8, columns - 4)

  const row = (link: Link) => (
    <Box key={`row:${link.url}`} flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text color={link.url === asked ? 'error' : barOf(link, since)}>▎</Text>
        {isLinked ? (
          <Link href={link.url} label={` ${link.title === undefined ? displayOf(link.url, width) : clip(link.title, width)} `} />
        ) : (
          // Without hyperlinks the whole address is written once, as plain
          // text: that is what such a terminal can open on a click.
          <Text>{` ${link.title === undefined ? link.url : clip(link.title, width)}`}</Text>
        )}
      </Box>
      {link.title !== undefined && <Text dimColor>{`  ${isLinked ? displayOf(link.url, width) : link.url}`}</Text>}
      <Box flexDirection="row" paddingLeft={1}>
        <Button
          key={`open:${link.url}`}
          plain
          dimColor
          label=" open "
          onPress={press => quietly($, 'open the browser', () => openInBrowser($, link.url, press.surface))}
        />
        <Button key={`read:${link.url}`} plain dimColor label=" read " onPress={run('read the page', () => showPage($, link.url, []))} />
        <Button
          key={`pin:${link.url}`}
          plain
          dimColor
          label={link.status === 'pinned' ? ' unpin ' : ' pin '}
          onPress={press => quietly($, 'pin', () => togglePin($, link, `pin:${link.url}`, press.requestId))}
        />
        {link.status !== 'pinned' && (
          <Button
            key={`drop:${link.url}`}
            plain
            dimColor={link.url !== asked}
            label={link.url === asked ? ' dismiss? ' : ' dismiss '}
            onPress={run('dismiss', () => pressDismiss($, link.url))}
          />
        )}
        <Button
          key={`copy:${link.url}`}
          plain
          dimColor
          label=" copy "
          onPress={press => quietly($, 'copy', () => copyLink($, link.url, press.surface))}
        />
        {columns >= 60 && <Text dimColor>{` ${link.source === 'you' ? 'you' : 'Claude'} · ${link.mentions}×`}</Text>}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>Links</Text>
        <Text dimColor>{`  ${pinned.length} pinned · ${floating.length} floating · ${dismissed.length} dismissed`}</Text>
      </Box>
      {Field !== undefined && (
        <Box marginBottom={1}>
          <Field
            key="add"
            label="add "
            placeholder="type or paste an address"
            submitLabel="pin it"
            autoFocus
            onSubmit={value => quietly($, 'add the link', () => addByHand($, value))}
          />
        </Box>
      )}
      {all.length === 0 && <Text dimColor>Every URL you or Claude mention lands here and floats above the prompt.</Text>}
      {pinned.length > 0 && (
        <Text bold color="claude">
          ★ PINNED
        </Text>
      )}
      {pinned.map(row)}
      {floating.length > 0 && (
        <Text bold color="suggestion">
          ☆ FLOATING
        </Text>
      )}
      {floating.map(row)}
      {dismissed.length > 0 && (
        <Text bold dimColor>
          × DISMISSED
        </Text>
      )}
      {dismissed.map(link => (
        <Box key={`row:${link.url}`} flexDirection="row">
          <Text dimColor>{'  '}</Text>
          <Text dimColor strikethrough>
            {displayOf(link.url, Math.max(8, width - 12))}
          </Text>
          <Button key={`restore:${link.url}`} plain label=" restore " onPress={run('restore', () => setStatus($, link.url, 'floating'))} />
        </Box>
      ))}
      {all.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>★ locks a link in for the whole session · × hides it · both survive exit and resume</Text>
        </Box>
      )}
    </Box>
  )
}

function pageView(
  $: Engine,
  kit: Kit,
  all: readonly Link[],
  page: ReaderPage,
  trail: readonly string[],
  columns: number,
  isLinked: boolean,
) {
  const { Box, Button, Link, Markdown, Text } = kit
  const run = (what: string, work: () => Promise<unknown>) => () => quietly($, what, work)
  const known = all.find(link => link.url === page.url)
  const isPinned = known?.status === 'pinned'
  const host = new URL(page.url).host
  const title = page.phase === 'ready' ? page.title : (known?.title ?? host)
  const back = trail.at(-1)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button
          key="back"
          plain
          label={back === undefined ? ' ‹ all links ' : ' ‹ back '}
          onPress={run('go back', () => (back === undefined ? showList($) : showPage($, back, trail.slice(0, -1))))}
        />
        <Button
          key="browser"
          plain
          label=" ↗ browser "
          onPress={press => quietly($, 'open the browser', () => openInBrowser($, page.url, press.surface))}
        />
        <Button
          key="keep"
          plain
          label={isPinned ? ' ★ pinned ' : ' ☆ pin '}
          onPress={run('pin', () => setStatus($, page.url, isPinned ? 'floating' : 'pinned'))}
        />
        <Button
          key="copy"
          plain
          label=" copy link "
          onPress={press => quietly($, 'copy', () => copyLink($, page.url, press.surface))}
        />
      </Box>
      <Text bold wrap="truncate-end">
        {` ${title}`}
      </Text>
      {isLinked ? (
        <Link href={page.url} label={` ${displayOf(page.url, columns - 2)} `} />
      ) : (
        <Text dimColor>{` ${page.url}`}</Text>
      )}
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(columns)}
      </Text>
      {page.phase === 'loading' && <Text dimColor>{`Fetching ${host}…`}</Text>}
      {page.phase === 'failed' && <Text color="error">{page.reason}</Text>}
      {page.phase === 'failed' && <Text dimColor>The reader itself is working; ↗ browser above tries the same address there.</Text>}
      {page.phase === 'ready' && (
        <Markdown
          key="page"
          text={page.markdown === '' ? '*This page came back empty.*' : page.markdown}
          // A link inside the page is read in the pane too; the trail is the way back.
          onLinkPress={link => quietly($, 'follow the link', () => showPage($, link.href, [...trail, page.url].slice(-30)))}
        />
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'links',
      description: 'Every link of this session in a pane: pinned, floating and dismissed',
    })
    await quietly($, 'load the links', () => ensure($))

    return started
  })

  // Fires where `session.start` does not: a /clear lands here already under its new id.
  on('classic.SessionStart', async ($, e, next) => {
    const started = await next(e)

    await quietly($, 'load the links', () => ensure($))

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    await quietly($, 'mark the turn', async () => {
      await ensure($)

      const now = await $.clock.now()
      await update($, freshSince, () => now)
    })

    return next(e)
  })

  // What the person typed, what a command they ran said, and what Claude
  // answered, each read as it arrives. Tool output stays out: one search
  // result or lockfile would bury the links the conversation is about.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    await quietly($, 'collect links', () => capture($, e, 'you'))

    return next(e)
  })

  on('session.append', { door: 'command' }, async ($, e, next) => {
    await quietly($, 'collect links', () => capture($, e, 'you'))

    return next(e)
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    await quietly($, 'collect links', () => capture($, e, 'claude'))

    return next(e)
  })

  on('command.run', { command: 'links' }, async $ => {
    await quietly($, 'load the links', () => ensure($))
    await showList($)

    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Asked first, and of every drawing: an empty band is exactly what a session just left looks like.
    const isMine = await isCurrent($)
    const all = await read($, links)
    const shown = all.filter(link => link.status !== 'dismissed').length

    if (e.props.hasSurvey || shown === 0 || !isMine) {
      return next(e)
    }

    const since = await read($, freshSince)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const asked = await read($, armed)
    const { rows, hidden } = seat(all, e.props.bodyColumns, Math.max(1, Math.min(MAX_ROWS, e.props.maxRows)), asked)
    // A click reaches a Button only where the surface reports clicks: the
    // fullscreen terminal. On the main screen only the terminal's own
    // hyperlink answers a click, so the label is a Link there when one will
    // be drawn as a hyperlink, and a Button the keyboard presses otherwise.
    const hasClicks = e.surface === 'terminal' && e.viewport?.isFullscreen === true
    const isPressed = hasClicks || !(await drawsHyperlinks($, e.surface))
    const run = (what: string, work: () => Promise<unknown>) => () => quietly($, what, work)

    const chip = ({ link, id, label }: Chip) => {
      const isPinned = link.status === 'pinned'
      const isAsked = link.url === asked

      return (
        <Box key={`chip:${id}`} flexDirection="row" flexShrink={0} marginRight={1}>
          <Text color={isAsked ? 'error' : barOf(link, since)}>▎</Text>
          <Button
            key={`pin:${id}`}
            plain
            dimColor={!isPinned}
            label={isPinned ? ' ★ ' : ' ☆ '}
            hover={{ color: 'warning' }}
            onPress={press => quietly($, 'pin', () => togglePin($, link, `pin:${id}`, press.requestId))}
          />
          {isPressed ? (
            <Button
              key={`open:${id}`}
              plain
              label={` ${label} `}
              hover={{ underline: true }}
              onPress={press => quietly($, 'open the browser', () => openInBrowser($, link.url, press.surface))}
            />
          ) : (
            <Link href={link.url} label={` ${label} `} />
          )}
          <Button key={`read:${id}`} plain dimColor label=" read " onPress={run('read the page', () => showPage($, link.url, []))} />
          {!isPinned && (
            <Button
              key={`drop:${id}`}
              plain
              dimColor={!isAsked}
              label={isAsked ? ARMED_LABEL : DISMISS_LABEL}
              hover={{ color: 'error' }}
              onPress={run('dismiss', () => pressDismiss($, link.url))}
            />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {rows.map((row, at) => (
          <Box key={`row:${at}`} flexDirection="row">
            {row.map(chip)}
            {at === rows.length - 1 && (
              <Button
                key="all"
                plain
                dimColor
                label={hidden > 0 ? ` +${hidden} more ` : ' ≡ '}
                onPress={run('open the list', () => showList($))}
              />
            )}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = (await isCurrent($)) ? await read($, links) : []
    const { reader, trail } = await read($, view)
    const since = await read($, freshSince)
    const kit = $.ui.resolve(e)
    const columns = Math.max(24, e.props.bodyColumns)

    const isLinked = await drawsHyperlinks($, e.surface)

    const asked = await read($, armed)

    return reader === null
      ? listView($, kit, all, columns, since, isLinked, asked)
      : pageView($, kit, all, reader, trail, columns, isLinked)
  })
}
