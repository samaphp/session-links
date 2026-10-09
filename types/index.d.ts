/** Who brought the link into the conversation first. */
export type LinkSource = 'you' | 'claude'

/**
 * `floating`: shown while it is recent, pushed off the band by newer links.
 * `pinned`: the person locked it; it keeps its seat for the whole session.
 * `dismissed`: the person hid it; it stays hidden even when mentioned again.
 */
export type LinkStatus = 'floating' | 'pinned' | 'dismissed'

export type Link = {
  /** Normalized href; the link's identity. */
  url: string
  source: LinkSource
  status: LinkStatus
  mentions: number
  /**
   * Milliseconds since the epoch. A link recovered from a transcript that
   * predates the mod carries its message's position instead (a small number),
   * which keeps the order and claims no time.
   */
  firstAt: number
  lastAt: number
}

/** What `$.store` keeps under `session:<id>`, so a resume restores the band exactly. */
export type SessionRecord = { links: Link[]; savedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'session-links': {
      sessionId: string
      links: Link[]
      freshSince: number
      /** The url whose dismiss was pressed once and waits for the second press; '' when none does. */
      armed: string
    }
  }
}
