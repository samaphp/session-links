import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'

import { extractUrls, MAX_LINKS, mergeMentions } from '../hooks/links'
import type { Link, SessionRecord } from '../types'

const DOCS = 'https://claude.dev/blog/getting-started-with-claude-code-mods/'
const PULL = 'https://github.com/acme/app/pull/12'
const LOCAL = 'http://localhost:5173/'
type World = {
  clock: MockClock
  sessionId: string
  store: Map<string, unknown>
  messages: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]
  ran: string[][]
  toasts: string[]
  logged: string[]
  copied: string[]
  /** Every key the mod read from the store, in order. */
  reads: string[]
  /** What each opener does, by its program: an exit code, or 'missing' when the machine has no such program. */
  openers: Record<string, number | 'missing'>
  /** How many of the next saves the store refuses. */
  refusals: number
}

/** The engine beneath the mod: one session, a store in memory, and a record of what the mod asked of the host. */
function world(on: On, store?: Record<string, unknown>, env: Record<string, string> = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
    sessionId: 'session-a',
    store: new Map(Object.entries(store ?? {})),
    messages: [],
    ran: [],
    toasts: [],
    logged: [],
    copied: [],
    reads: [],
    openers: {},
    refusals: 0,
  }

  mock.env(on, env)
  // The store is answered here, not by `mock.store`, so a test can read what a resume would.
  on('store.get', ($, e) => {
    w.reads.push(e.key)

    return { value: w.store.get(e.key) }
  })
  on('store.set', ($, e) => {
    if (w.refusals > 0) {
      w.refusals -= 1
      throw new Error('the store holds 4 MiB at most')
    }

    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // What the engine draws where the mod passes: a band with no link in it.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'the engine’s own' }))
  on('classic.SessionStart', () => ({}))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.messages', () => ({ value: w.messages }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.log', ($, e) => {
    w.logged.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text?: unknown }).text))

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = [...(e as { argv: string[] }).argv]
    const outcome = w.openers[argv[0] ?? ''] ?? 0

    w.ran.push(argv)

    if (outcome === 'missing') {
      throw new Error(`${argv[0]}: no such program`)
    }

    return { value: { exitCode: outcome, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return w
}

const start = ($: Engine) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

// This build's kit has no bottom for `session.append` (a test hook that answers
// a row is skipped, as any hook is), so the call ends in "no implementation"
// after every plugin has seen the row. The mod reads a row on its way down,
// which is what these tests are about; the kit's own ending is set aside.
const say = ($: Engine, door: 'prompt' | 'response' | 'tool-result', text: string, agentId?: string) =>
  $.session
    .append({
    message: {
      type: door === 'response' ? 'assistant' : 'user',
      role: door === 'response' ? 'assistant' : 'user',
      content: [{ type: 'text', text }],
    },
    door,
    origin: door === 'response' ? { kind: 'model', model: 'test' } : { kind: 'composer' },
      uuid: `row-${Math.random()}`,
      ...(agentId === undefined ? {} : { agentId }),
    } as never)
    .catch((error: unknown) => {
      if (!String(error).includes('no implementation for session.append')) {
        throw error
      }
    })

const band = ($: Engine, columns = 120, isFullscreen = true) =>
  $.ui.mount({
    plugin: 'session-links',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns },
    viewport: { columns, rows: 40, isFullscreen },
  } as never)

const pane = ($: Engine) =>
  $.ui.mount({
    plugin: 'session-links',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'links',
    props: { title: 'Links', isFocused: true, bodyColumns: 80, placement: 'dock' },
    viewport: { columns: 200, rows: 50, isFullscreen: true },
  } as never) as unknown as Promise<Mounted<'terminal', 'Pane'>>

const saved = (w: World, id = 'session-a'): Link[] => (w.store.get(`session:${id}`) as SessionRecord).links

describe('collecting', () => {
  test('a chip is its link’s domain; the most repeated link leads, then the latest', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', `Read (${DOCS}) and the PR at ${PULL}.`)
    await w.clock.advance(60_000)
    await say($, 'response', `Dev server is up: **${LOCAL}**. The PR again: ${PULL}`)

    const ui = await band($)
    const labels = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:')).map(b => b.props.label)

    expect(labels).toEqual([' github.com ', ' localhost:5173 ', ' claude.dev '])
    expect((await ui.find({ key: `pin:${DOCS}` }))?.props.label).toBe(' ☆ ')
    expect((await ui.find({ key: `drop:${DOCS}` }))?.props.label).toBe(' × ')
    await ui.unmount()
  })

  test('tool output and a subagent stay out; a repeat counts, never duplicates', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'tool-result', `noise ${PULL}`)
    await say($, 'response', `aside ${LOCAL}`, 'agent-1')
    await say($, 'response', `See ${DOCS}`)
    await say($, 'prompt', `Again: ${DOCS}`)

    const links = saved(w)

    expect(links.map(link => [link.url, link.mentions, link.source])).toEqual([[DOCS, 2, 'claude']])
  })

  test('the band draws nothing until a link is mentioned', async ($, on) => {
    world(on)
    await start($)
    // A bare word, an empty scheme, and two addresses their writer shortened with an ellipsis.
    await say($, 'prompt', 'no address here, just http://word and https:// and https://claude.dev/blog/… and https://a.example.com/…/page')

    const ui = await band($)

    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()
  })

  test('a full row wraps to the next, up to three rows; what the third cannot seat is counted', async ($, on) => {
    world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL} ${LOCAL} https://d.example.com/4 https://e.example.com/5`)

    // 30 cells seat one chip a row.
    const ui = await band($, 30)
    const drawn = (await ui.drawn()) as unknown as { children: { children: { props: { label?: string } }[] }[] }

    expect(drawn.children).toHaveLength(3)
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:'))).toHaveLength(3)
    expect((await ui.find({ key: 'all' }))?.props.label).toBe(' +2 more ')
    // The count closes the last row, where the person's eye ends.
    expect(drawn.children[2]?.children.at(-1)?.props.label).toBe(' +2 more ')
    await ui.unmount()
  })

  test('with room to spare the band stays one row', async ($, on) => {
    world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL} ${LOCAL}`)

    const ui = await band($, 120)
    const drawn = (await ui.drawn()) as unknown as { children: unknown[] }

    expect(drawn.children).toHaveLength(1)
    expect((await ui.find({ key: 'all' }))?.props.label).toBe(' ≡ ')
    await ui.unmount()
  })
})

describe('telling links apart', () => {
  const labelsOf = async (ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined; props: Record<string, unknown> }[]> }) =>
    (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:')).map(b => b.props.label)

  test('links that share a site get a short hint of their path; a link alone on its site stays the bare domain', async ($, on) => {
    world(on)
    await start($)
    await say(
      $,
      'prompt',
      `${DOCS} ${PULL} https://github.com/acme/app/issues/7 https://github.com/other/repo/issues/7 https://github.com/acme/app/blob/main/a-very-long-file-name-here.ts`,
    )

    const ui = await band($, 200)

    expect(await labelsOf(ui)).toEqual([
      ' claude.dev ',
      // A closing number brings the segment before it.
      ' github.com/pull/12 ',
      // Two paths ending alike are told apart one segment earlier.
      ' github.com/app/issues/7 ',
      ' github.com/repo/issues/7 ',
      ' github.com/a-very-long-fil… ',
    ])
    await ui.unmount()
  })

  test('the hint goes when the other link on the site is dismissed', async ($, on) => {
    world(on)
    await start($)
    await say($, 'prompt', `${PULL} https://github.com/acme/app/issues/7`)

    const ui = await band($, 200)

    expect(await labelsOf(ui)).toEqual([' github.com/pull/12 ', ' github.com/issues/7 '])
    await ui.press({ key: 'drop:https://github.com/acme/app/issues/7' })
    await ui.press({ key: 'drop:https://github.com/acme/app/issues/7' })
    expect(await labelsOf(ui)).toEqual([' github.com '])
    await ui.unmount()
  })
})

describe('deciding', () => {
  test('a pin takes the first seat and a dismissal leaves the band', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL}`)

    // A control is keyed by its link's address, so a key stays with its link whatever the order.
    const ui = await band($)
    await ui.press({ key: `pin:${PULL}` })
    await ui.press({ key: `drop:${DOCS}` })
    await ui.press({ key: `drop:${DOCS}` })

    const seated = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:'))

    expect(seated.map(b => b.props.label)).toEqual([' github.com '])
    // The star and the cross carry their own air, so the highlight under the pointer is three cells wide.
    expect((await ui.find({ key: `pin:${PULL}` }))?.props.label).toBe(' ★ ')
    expect((await ui.find({ key: `pin:${DOCS}` }))).toBeUndefined()
    // A lock has no dismiss beside it: losing a pinned link takes an unpin first.
    expect(await ui.find({ key: `drop:${PULL}` })).toBeUndefined()
    expect(saved(w).map(link => link.status)).toEqual(['dismissed', 'pinned'])
    expect(w.toasts.at(-1)).toMatch(/Dismissed .* \/links brings it back/)
    await ui.unmount()
  })

  // After a pin the mod sends the focus ring after the link (`$.ui.focus`). The
  // kit cannot answer that call, so the ring is checked in a live session and
  // this test holds only what it can see: the order.
  test('pinned links lead whatever their count', async ($, on) => {
    world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL} ${LOCAL}`)
    await say($, 'response', `${PULL} ${PULL} and ${DOCS}`)
    await say($, 'response', PULL)

    const ui = await band($)
    const order = async () =>
      (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:')).map(b => b.props.label)

    expect(await order()).toEqual([' github.com ', ' claude.dev ', ' localhost:5173 '])
    // The least repeated link is pinned from the last seat and moves to the first.
    await ui.press({ key: `pin:${LOCAL}` })
    expect(await order()).toEqual([' localhost:5173 ', ' github.com ', ' claude.dev '])
    await ui.unmount()
  })

  test('the first press on the cross asks, the second dismisses', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL}`)

    const ui = await band($)
    await ui.press({ key: `drop:${DOCS}` })

    // Still seated, and the chip itself now carries the question.
    expect((await ui.find({ key: `drop:${DOCS}` }))?.props.label).toBe(' dismiss? ')
    expect((await ui.find({ key: `drop:${PULL}` }))?.props.label).toBe(' × ')
    expect(saved(w).map(link => link.status)).toEqual(['floating', 'floating'])
    expect(w.toasts).toEqual([])

    await ui.press({ key: `drop:${DOCS}` })
    expect(await ui.find({ key: `open:${DOCS}` })).toBeUndefined()
    expect(saved(w).map(link => link.status)).toEqual(['dismissed', 'floating'])
    await ui.unmount()
  })

  test('a question nobody answers goes back to a cross, and asking about another link moves it', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL}`)

    const ui = await band($)
    await ui.press({ key: `drop:${DOCS}` })
    await ui.press({ key: `drop:${PULL}` })
    expect((await ui.find({ key: `drop:${DOCS}` }))?.props.label).toBe(' × ')
    expect((await ui.find({ key: `drop:${PULL}` }))?.props.label).toBe(' dismiss? ')

    await w.clock.advance(5_000)
    expect((await ui.find({ key: `drop:${PULL}` }))?.props.label).toBe(' × ')
    // The press after the question lapsed asks again: nothing was dismissed along the way.
    await ui.press({ key: `drop:${PULL}` })
    expect(saved(w).map(link => link.status)).toEqual(['floating', 'floating'])
    await ui.unmount()
  })

  test('the list asks the same way before it dismisses', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', DOCS)

    const ui = await pane($)
    await ui.press({ key: `drop:${DOCS}` })
    expect((await ui.find({ key: `drop:${DOCS}` }))?.props.label).toBe(' dismiss? ')
    expect(saved(w)[0]?.status).toBe('floating')
    await ui.press({ key: `drop:${DOCS}` })
    expect(saved(w)[0]?.status).toBe('dismissed')
    await ui.unmount()
  })

  test('a dismissed link mentioned again stays dismissed', async ($, on) => {
    world(on)
    await start($)
    await say($, 'prompt', DOCS)

    const ui = await band($)
    await ui.press({ key: `drop:${DOCS}` })
    await ui.press({ key: `drop:${DOCS}` })
    await say($, 'response', `Once more: ${DOCS}`)

    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()
  })

  test('the pane lists every state and restores a dismissal', async ($, on) => {
    world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL}`)

    const strip = await band($)
    await strip.press({ key: `drop:${PULL}` })
    await strip.press({ key: `drop:${PULL}` })
    await strip.unmount()

    const ui = await pane($)

    expect(await ui.find({ type: 'Text', text: /1 floating · 1 dismissed/ })).toBeDefined()
    // No hyperlinks declared: the address is written once, whole, and nothing is a Link.
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: DOCS })).toBeDefined()
    await ui.press({ key: `restore:${PULL}` })
    expect(await ui.find({ type: 'Text', text: /2 floating · 0 dismissed/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('adding by hand', () => {
  test('an address typed into the list starts pinned', async ($, on) => {
    const w = world(on)
    await start($)

    const ui = await pane($)
    // Copied the way addresses usually are: without the scheme.
    await ui.input({ key: 'add', text: '  docs.claude.com/en/docs/claude-code/hooks ' })

    expect(saved(w).map(link => [link.url, link.status, link.source])).toEqual([
      ['https://docs.claude.com/en/docs/claude-code/hooks', 'pinned', 'you'],
    ])
    expect(w.toasts.at(-1)).toBe('Pinned docs.claude.com/en/docs/claude-code/hooks')
    await ui.unmount()
  })

  test('a link already collected is locked in where it stands; a desk machine keeps plain http', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', PULL)

    const ui = await pane($)
    await ui.input({ key: 'add', text: PULL })
    await ui.input({ key: 'add', text: 'localhost:5173/app' })

    expect(saved(w).map(link => [link.url, link.status, link.mentions])).toEqual([
      [PULL, 'pinned', 1],
      ['http://localhost:5173/app', 'pinned', 1],
    ])
    await ui.unmount()
  })

  test('what is not an address is refused, and the reason quotes it', async ($, on) => {
    const w = world(on)
    await start($)

    const ui = await pane($)
    await ui.input({ key: 'add', text: 'remember the milk' })

    expect(w.store.size).toBe(0)
    expect(w.toasts.at(-1)).toBe('"remember the milk" is not a web address')
    await ui.unmount()
  })

  test('every control in the pane carries its own air', async ($, on) => {
    world(on)
    await start($)
    await say($, 'prompt', `${DOCS} ${PULL}`)

    const strip = await band($)
    await strip.press({ key: `drop:${PULL}` })
    await strip.press({ key: `drop:${PULL}` })
    await strip.unmount()

    const ui = await pane($)
    const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))

    expect(labels.filter(label => !(label.startsWith(' ') && label.endsWith(' ')))).toEqual([])
    // The pane's close mark is the engine's own, on the frame: the mod draws none beside it.
    expect(labels).toEqual([' open ', ' pin ', ' dismiss ', ' copy ', ' restore '])
    await ui.unmount()
  })
})

describe('surviving', () => {
  test('a resumed session shows its pins and dismissals as they were left', async ($, on) => {
    const kept: Link[] = [
      { url: DOCS, source: 'you', status: 'pinned', mentions: 3, firstAt: 10, lastAt: 30 },
      { url: PULL, source: 'claude', status: 'dismissed', mentions: 1, firstAt: 20, lastAt: 20 },
      { url: LOCAL, source: 'claude', status: 'floating', mentions: 1, firstAt: 25, lastAt: 25 },
    ]
    const w = world(on, { 'session:session-a': { links: kept, savedAt: 40 } satisfies SessionRecord })

    // The transcript mentions more, and is ignored: the saved record is the truth of a session the mod has seen.
    w.messages = [{ role: 'user', text: 'https://example.com/never-saved', toolUses: [] }]
    await start($)

    const ui = await band($)
    const labels = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:')).map(b => b.props.label)

    expect(labels).toEqual([' claude.dev ', ' localhost:5173 '])
    expect((await ui.find({ key: `pin:${DOCS}` }))?.props.label).toBe(' ★ ')
    await ui.unmount()
  })

  test('a session the mod never saw starts from its transcript', async ($, on) => {
    const w = world(on)

    w.messages = [
      { role: 'user', text: `<system-reminder>ignore ${PULL}</system-reminder> start with ${DOCS}`, toolUses: [] },
      { role: 'assistant', text: `Running at ${LOCAL}`, toolUses: [] },
    ]
    await start($)

    expect((saved(w)).map(link => [link.url, link.source])).toEqual([
      [DOCS, 'you'],
      [LOCAL, 'claude'],
    ])
  })

  test('another session in the same process gets its own links', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', DOCS)

    w.sessionId = 'session-b'
    await $.classic.SessionStart({ source: 'clear' })

    const ui = await band($)

    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    await ui.unmount()

    w.sessionId = 'session-a'
    await $.classic.SessionStart({ source: 'resume' })

    const back = await band($)

    expect(await back.find({ key: `open:${DOCS}` })).toBeDefined()
    await back.unmount()
  })

  test('a resume announced before the process switches still lands on the resumed session', async ($, on) => {
    const kept: Link[] = [{ url: DOCS, source: 'you', status: 'pinned', mentions: 1, firstAt: 10, lastAt: 10 }]
    const w = world(on, { 'session:session-b': { links: kept, savedAt: 40 } satisfies SessionRecord })

    await start($)
    // The engine raises SessionStart while `$.session.id()` still answers the session being left.
    await $.classic.SessionStart({ source: 'resume' })
    w.sessionId = 'session-b'

    const ui = await band($)

    expect(await ui.find({ key: `pin:${DOCS}` })).toBeUndefined()
    await w.clock.settle()
    expect((await ui.find({ key: `pin:${DOCS}` }))?.props.label).toBe(' ★ ')
    await ui.unmount()
  })
})

describe('opening', () => {
  test('the label opens the browser detached, the address as an argument', async ($, on) => {
    const w = world(on)
    await start($)
    const TOKENED = `${PULL}?token=s3cret&x=$(reboot)`
    await say($, 'prompt', TOKENED)

    const ui = await band($)
    await ui.press({ key: `open:${TOKENED}` })

    expect((await ui.find({ key: `open:${TOKENED}` }))?.props.label).toBe(' github.com ')
    expect(w.ran).toHaveLength(1)
    expect(w.ran[0]?.slice(0, 2)).toEqual(['sh', '-c'])
    expect(w.ran[0]?.[2]).not.toMatch(/github|reboot/)
    expect(w.ran[0]?.at(-1)).toBe(TOKENED)
    await ui.unmount()
  })

  // The engine draws a Link as its text followed by the whole URL in dim on a
  // terminal it does not take to speak hyperlinks, and never says which it
  // will do: so nothing in the band is a Link unless the person declared them.
  test('on the main screen the label is a Button the keyboard presses, with no URL beside it', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', PULL)

    const ui = await band($, 120, false)

    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect((await ui.find({ key: `open:${PULL}` }))?.props.label).toBe(' github.com ')
    await ui.press({ key: `open:${PULL}` })
    expect(w.ran[0]?.at(-1)).toBe(PULL)
    await ui.unmount()
  })

  test('on the main screen with hyperlinks declared, the label is the terminal’s own hyperlink', async ($, on) => {
    world(on, undefined, { FORCE_HYPERLINK: '1' })
    await start($)
    await say($, 'prompt', PULL)

    const ui = await band($, 120, false)
    const link = await ui.find({ type: 'Link' })

    expect([link?.props.href, link?.props.label]).toEqual([PULL, ' github.com '])
    expect(await ui.find({ key: `open:${PULL}` })).toBeUndefined()
    await ui.unmount()
  })

})

describe('limits', () => {
  test('past the cap the oldest floating link leaves; a pinned one never does', () => {
    const first: Link[] = mergeMentions([], ['https://a.example.com/kept'], 'you', 1).map(link => ({ ...link, status: 'pinned' }))
    const many = Array.from({ length: MAX_LINKS + 4 }, (_, n) => `https://a.example.com/${n}`)
    const list = many.reduce((held, url, n) => mergeMentions(held, [url], 'claude', n + 2), first)

    // The cap counts floating links alone: the pinned one sits above it.
    expect(list).toHaveLength(MAX_LINKS + 1)
    expect(list[0]?.url).toBe('https://a.example.com/kept')
    expect(list.some(link => link.url === 'https://a.example.com/0')).toBe(false)
    expect(list.at(-1)?.url).toBe(`https://a.example.com/${MAX_LINKS + 3}`)
  })

  test('a dismissed link survives the cap, so mentioned again it still stays dismissed', () => {
    const first: Link[] = mergeMentions([], ['https://a.example.com/gone'], 'you', 1).map(link => ({ ...link, status: 'dismissed' }))
    const many = Array.from({ length: MAX_LINKS + 4 }, (_, n) => `https://a.example.com/${n}`)
    const list = many.reduce((held, url, n) => mergeMentions(held, [url], 'claude', n + 2), first)
    const again = mergeMentions(list, ['https://a.example.com/gone'], 'claude', 999)

    expect(again.find(link => link.url === 'https://a.example.com/gone')?.status).toBe('dismissed')
    expect(again.filter(link => link.status === 'floating')).toHaveLength(MAX_LINKS)
  })

  test('decisions never crowd a new link out: past the cap in pins and dismissals, a mention still lands', () => {
    const decided: Link[] = Array.from({ length: MAX_LINKS }, (_, n) => ({
      url: `https://a.example.com/${n}`,
      source: 'you',
      status: n % 2 === 0 ? 'pinned' : 'dismissed',
      mentions: 1,
      firstAt: n,
      lastAt: n,
    }))
    const list = mergeMentions(decided, ['https://b.example.com/new'], 'claude', 999)

    expect(list).toHaveLength(MAX_LINKS + 1)
    expect(list.at(-1)).toMatchObject({ url: 'https://b.example.com/new', status: 'floating' })
  })

  test('injected context is left out, also when its tag is never closed', () => {
    expect(extractUrls('<system-reminder>https://a.example.com/in</system-reminder> https://a.example.com/out')).toEqual([
      'https://a.example.com/out',
    ])
    expect(extractUrls(`${'<system-reminder>'.repeat(3)} https://a.example.com/seen`)).toEqual(['https://a.example.com/seen'])
  })

  test('the sessions saved longest ago make room once there are too many', async ($, on) => {
    const old = Object.fromEntries(
      Array.from({ length: 305 }, (_, n) => [`session:old-${n}`, { links: [], savedAt: n + 1 } satisfies SessionRecord]),
    )
    const w = world(on, old)

    await start($)

    const kept = [...w.store.keys()].filter(key => key.startsWith('session:'))

    // Trimmed well below the cap, so the next fifty new sessions start without reading every record.
    expect(kept).toHaveLength(250)
    expect(kept).not.toContain('session:old-54')
    expect(kept).toContain('session:old-55')
    expect(kept).toContain('session:old-304')
  })

  test('a store at its cap is left alone: no record is read to start a session', async ($, on) => {
    const full = Object.fromEntries(
      Array.from({ length: 300 }, (_, n) => [`session:old-${n}`, { links: [], savedAt: n + 1 } satisfies SessionRecord]),
    )
    const w = world(on, full)

    await start($)

    expect(w.reads.filter(key => key.startsWith('session:old-'))).toEqual([])
    expect([...w.store.keys()]).toHaveLength(300)
  })

  test('a save the store refuses is tried again after making room', async ($, on) => {
    const w = world(on)

    await start($)
    w.refusals = 1
    await say($, 'prompt', DOCS)

    expect(saved(w).map(link => link.url)).toEqual([DOCS])
    expect(w.toasts).toEqual([])

    // Refused twice running, the person is told what that costs them.
    w.refusals = 2
    await say($, 'prompt', PULL)
    expect(w.toasts.at(-1)).toMatch(/^Links were not saved, so a resume will not restore them: /)
  })
})

describe('the way to the browser', () => {
  test('an opener that takes the address is all the toast claims', async ($, on) => {
    const w = world(on)
    await start($)
    await say($, 'prompt', PULL)

    const ui = await band($)
    await ui.press({ key: `open:${PULL}` })

    expect(w.toasts.at(-1)).toBe('Sent github.com/acme/app/pull/12 to your browser')
    await ui.unmount()
  })

  test('an opener that gives up is named, the others are tried, and the link lands on the clipboard', async ($, on) => {
    const w = world(on)

    w.openers = { sh: 3, open: 'missing', rundll32: 'missing' }
    await start($)
    await say($, 'prompt', PULL)

    const ui = await band($)
    await ui.press({ key: `open:${PULL}` })

    expect(w.ran.map(argv => argv[0])).toEqual(['sh', 'open', 'rundll32'])
    expect(w.copied).toEqual([PULL])
    expect(w.toasts.at(-1)).toBe('No browser took the link (xdg-open gave up with exit 3), so the link is on your clipboard')
    await ui.unmount()
  })

  test('a machine with no opener at all says so', async ($, on) => {
    const w = world(on)

    w.openers = { sh: 127, open: 'missing', rundll32: 'missing' }
    await start($)
    await say($, 'prompt', PULL)

    const ui = await band($)
    await ui.press({ key: `open:${PULL}` })

    expect(w.toasts.at(-1)).toBe('No browser opener answered on this machine, so the link is on your clipboard')
    await ui.unmount()
  })
})
