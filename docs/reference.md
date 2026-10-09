# session-links — reference

The full behaviour of the mod. The short version, with install and update, is the [README](../README.md).

## Why

A long session scatters addresses through the transcript: the page you were reading, the issue Claude found, the server it started. Scrolling back to find them again is the tax this mod removes. The band stays out of your way (nothing is drawn while there is no link), the links that matter stay pinned, and the model never sees any of it: the mod costs zero tokens. It never fetches anything either: no address is requested until you open it, and then it is your browser that does.

## The band

| Control | What it does |
|---|---|
| `☆` / `★` | Pin or unpin. A pinned link takes the first seat and stays for the whole session; it shows no `×`, so losing it takes an unpin first. |
| the address | Opens the link in your browser. A link you named in `/links` shows its name here instead. |
| `×` | Dismisses the link. The first press asks (`dismiss?`), the second confirms; left alone, it lapses after a few seconds. A dismissed link stays hidden even when mentioned again, and can be restored from `/links`. |
| `dismiss all` | Shown from five floating links. The first press asks (`dismiss 12?`) and turns the bar of every floating chip red: press it again to dismiss every floating link, or press `dismiss 12 & open the list` beside it to do the same and open `/links`, where any of them can be restored. Pinned links stay. |
| `≡` / `+N more` | Opens the full list. |

The coloured bar on each chip says what it is: orange for pinned, blue for a link that arrived since your last prompt, grey for older ones. Pinned links come first, then the most repeated. The band grows to three rows before it counts the rest, and two links on one site get a short hint of their path (`github.com/pull/12`, `github.com/issues/7`).

Keyboard: `ctrl+x` then `Tab` moves into the band; `Tab`, `Shift+Tab` and the arrows walk the controls; `Enter` presses; `Esc` returns to the prompt.

## `/links`

The pane lists every link of the session in three groups, pinned, floating and dismissed, each with `open`, `pin`, `dismiss`, `copy` and `rename`, and `restore` for the dismissed ones. A text box at the top takes an address you type or paste; press `Enter` and it is added pinned (the `https://` can be left off). From two floating links the FLOATING heading carries `dismiss all`, the same two-press question as the band's.

`rename` opens a text box under the link: `Enter` saves the name, which from then on leads on the chip, in the list and in the toasts, with the address beneath it in the list; an empty `Enter` clears the name. Renaming happens here only, never on the band.

## What is collected

- Addresses in what you type, in slash-command rows, and in Claude's replies.
- Left out: tool output (one search result or lockfile would bury the links the conversation is about), and addresses a writer shortened with `…`.
- Query strings are never drawn on the band: that is where tokens and signatures ride.
- A session keeps up to 300 unnamed floating links; past that the oldest leaves. Pinned, dismissed and named links are your decisions and are never dropped.

## Terminal notes

- In Claude Code's default layout the mouse does not reach the band; the keyboard does. The fullscreen layout (`/tui fullscreen`) makes every control clickable.
- On a terminal Claude Code does not recognise as hyperlink-capable, set `FORCE_HYPERLINK=1` (for example in the `env` block of your Claude Code settings) and the addresses become real hyperlinks your terminal can open on a click.
- Everything is laid out for terminals as narrow as 87 columns.

## How it works

A Claude Code mod is a plugin whose hooks are TypeScript functions running inside Claude Code.

- `hooks/register.tsx` watches every row the conversation keeps, draws the band and the pane, and registers `/links`. Decisions are written through to the plugin's store on every change, keyed by session id, so a resume restores them exactly.
- `hooks/links.ts` finds addresses in text, keeps the list within its cap, orders it, and writes the labels.
- `types/index.d.ts` is the state contract the engine checks the hooks against.
- `tests/` presses the real band and pane through Claude Code's own test kit.
