# session-links

Every link your session mentions, in one row above the prompt.

Paste a docs page, let Claude point you at a pull request, start a dev server: each address becomes a chip above the prompt the moment it is mentioned. Pin the ones you keep coming back to, dismiss the noise, open any of them in your browser or read it in a pane without leaving the terminal. What you pin and dismiss is saved with the session, so it is exactly as you left it when you resume.

```
▎ ★  docs.claude.com  read   ▎ ☆  github.com/pull/12  read  ×   ▎ ☆  localhost:5173  read  ×    ≡
```

## Why

A long session scatters addresses through the transcript: the page you were reading, the issue Claude found, the server it started. Scrolling back to find them again is the tax this mod removes. The band stays out of your way (nothing is drawn while there is no link), the links that matter stay pinned, and the model never sees any of it: the mod costs zero tokens.

## Install

Needs Claude Code 2.1.291 or later.

To try it, run Claude Code with the folder:

```sh
claude --plugin-dir path/to/session-links
```

To have it in every session:

```sh
claude plugin marketplace add samaphp/session-links
claude plugin install session-links@session-links
```

Start `claude`, mention a link, and the band appears. To remove it: `claude plugin uninstall session-links`.

## The band

| Control | What it does |
|---|---|
| `☆` / `★` | Pin or unpin. A pinned link takes the first seat and stays for the whole session; it shows no `×`, so losing it takes an unpin first. |
| the address | Opens the link in your browser. |
| `read` | Reads the page in a pane inside Claude Code. |
| `×` | Dismisses the link. The first press asks (`dismiss?`), the second confirms; left alone, it lapses. A dismissed link stays hidden even when mentioned again, and can be restored from `/links`. |
| `≡` / `+N more` | Opens the full list. |

The coloured bar on each chip says what it is: orange for pinned, blue for a link that arrived since your last prompt, grey for older ones. Pinned links come first, then the most repeated. The band grows to three rows before it counts the rest, and two links on one site get a short hint of their path (`github.com/pull/12`, `github.com/issues/7`).

Keyboard: `ctrl+x` then `Tab` moves into the band; `Tab`, `Shift+Tab` and the arrows walk the controls; `Enter` presses; `Esc` returns to the prompt.

## `/links`

The pane lists every link of the session in three groups, pinned, floating and dismissed, each with `open`, `read`, `pin`, `dismiss` and `copy`, and `restore` for the dismissed ones. A text box at the top takes an address you type or paste; press `Enter` and it is added pinned (the `https://` can be left off).

`read` fetches the page and shows its text: headings, paragraphs, links, lists and code. Links inside the page can be followed in the pane, with a way back. Nothing is fetched until you press `read`; a page is never fetched because it was mentioned, and what comes back is drawn in the pane only.

## What is collected

- Addresses in what you type, in slash-command rows, and in Claude's replies.
- Left out: tool output (one search result or lockfile would bury the links the conversation is about), and addresses a writer shortened with `…`.
- Query strings are never drawn on the band: that is where tokens and signatures ride.

## Terminal notes

- In Claude Code's default layout the mouse does not reach the band; the keyboard does. The fullscreen layout (`/tui fullscreen`) makes every control clickable.
- On a terminal Claude Code does not recognise as hyperlink-capable, set `FORCE_HYPERLINK=1` (for example in the `env` block of your Claude Code settings) and the addresses become real hyperlinks your terminal can open on a click.
- Everything is laid out for terminals as narrow as 87 columns.

## How it works

A Claude Code mod is a plugin whose hooks are TypeScript functions running inside Claude Code.

- `hooks/register.tsx` watches every row the conversation keeps, draws the band and the pane, and registers `/links`. Decisions are written through to the plugin's store on every change, keyed by session id, so a resume restores them exactly.
- `hooks/links.ts` finds addresses in text, keeps the list within its cap, orders it, and writes the labels.
- `hooks/reader.ts` turns a fetched page into markdown in one pass over its tags and text, with control bytes and embedded media stripped.
- `types/index.d.ts` is the state contract the engine checks the hooks against.
- `tests/` presses the real band and pane through Claude Code's own test kit.

## Develop

```sh
git clone https://github.com/samaphp/session-links
cd session-links
claude --plugin-dir .                 # loads from disk, hot-reloads on save
claude plugin validate .
claude plugin test .
npx -y -p typescript tsc -p .         # once a load has written .claude-plugin/types/
```

## License

MIT. See [LICENSE](LICENSE).
