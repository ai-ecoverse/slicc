/**
 * Help text for the playwright-cli command family.
 *
 * Every entry's signature must show the flags the manifest
 * (`slicc-commands.json`) declares for that verb — argv validation rejects
 * anything else, so a flag documented here but absent there is a lie, and
 * vice versa. `tests/shell/supplemental-commands/playwright/help-drift.test.ts`
 * enforces the invariants (entry exists per verb, `--tab` shown where
 * required).
 */

import { subcommandHelpText } from '../subcommand-help.js';
import { PLAYWRIGHT_COMMAND_NAMES } from './state.js';

export function formatHelp(commandName: string): string {
  const aliases = PLAYWRIGHT_COMMAND_NAMES.filter((name) => name !== commandName);
  return `Usage: ${commandName} <command> [args...]

Most commands operate on a tab and REQUIRE --tab=<targetId>. There is no
implicit "current tab" — run "${commandName} tab-list" to get tab IDs.

Commands:
  open [url|/vfs/path] [--foreground|--fg] [--runtime=<id>] [--discover] [--mobile]
       [--teleport-start=<regex>] [--teleport-return=<regex>] [--timeout=<s>]
                         Open a new tab. Default: background. --foreground (or --fg) brings the
                         new tab to the FRONT (switches the user's visible/active tab to it).
                         VFS paths are served via preview service worker.
                         Use --runtime to open the tab on a remote tray runtime (e.g. --runtime=follower-abc).
                         Use --teleport-start/--teleport-return to arm auth-state teleport.
                         --mobile emulates a generic mobile device (viewport + UA), sticky for
                         the tab; mobile pages are usually lighter, which saves tokens.
                         With --discover, also fetches the URL via the proxied fetch and emits JSON
                         with parsed RFC 8288 Link headers + P0 discovery (api-catalog, llms.txt, ...).
  goto|navigate <url> --tab=<id> [--discover] [--teleport-start=<regex>] [--teleport-return=<regex>]
                         Navigate tab to URL. Supports teleport flags.
                         With --discover, emits JSON with parsed Link headers, any SLICC handoff
                         match, and P0 capability documents (api-catalog, llms.txt, ...).
  fetch <url> [--method=<verb>] [--discover]
                         Fetch a URL through the proxied fetch and emit JSON containing
                         parsed RFC 8288 Link headers (always) and, with --discover, the
                         resolved P0 capability documents.
  teleport --tab=<id> --start <regex> --return <regex> [--timeout=<s>] [--runtime=<id>]
                         Arm a teleport watcher on the tab. Triggers when the
                         leader tab URL matches --start, opens the URL on a follower
                         for human auth, then restores cookies + page storage when the
                         follower URL matches --return.
  teleport --off --tab=<id>
                         Disarm the active teleport watcher on the tab.
  teleport --list        List available follower runtimes for teleport.
  click <ref> --tab=<id> [--modifiers=Alt,Control,...] Click element by ref (e.g. e5)
  type <text> --tab=<id> [--submit] Type text into focused element
  fill <ref> <text> --tab=<id> [--submit] Fill an input by ref with text
  snapshot --tab=<id> [--frame=<frameId>] [--no-iframes] [--filename=path]
           [--depth=<n>] [--boxes]
                         Print the tab tree, or only the selected frame subtree.
                         --depth limits tree depth; --boxes appends [box=x,y,w,h]
                         viewport-relative CSS-pixel rects to main-frame refs.
  find [text] --tab=<id> [--regex=<re>]
                         Search the page snapshot for text (case-insensitive) or a regexp,
                         returning matching lines with surrounding context. Provide either
                         a text argument or --regex, not both.
  frames --tab=<id>      List frame IDs for --frame (frame IDs are not valid --tab IDs)
  screenshot [ref] --tab=<id> [--filename=path] [--max-width=N] [--fullPage|--full-page]
             [--type=png|jpeg|webp] [--hires]
                         Take screenshot. The positional is a MAIN-FRAME ELEMENT REF (e5) to
                         clip to, not a path — the output path is --filename=path. --max-width
                         downscales the image if wider than N pixels (png output only).
                         --type defaults to the --filename extension, else png. --hires
                         captures in device pixels (honors the device pixel ratio).
  eval <expression> --tab=<id> [--frame=<frameId>] [--filename=path|--output=path]
                         Evaluate JavaScript in tab or frame (accepts top-level await/return)
  dblclick <ref> [btn] --tab=<id> [--modifiers=Alt,Control,...] Double-click element by ref
  hover <ref> --tab=<id> Hover over element by ref
  select <ref> <val> --tab=<id> Select value in <select> element
  check <ref> --tab=<id> Check a checkbox/radio
  uncheck <ref> --tab=<id> Uncheck a checkbox/radio
  drag <start> <end> --tab=<id> Drag from one element to another
  eval-file <path> --tab=<id> [--frame=<frameId>] [--output=<path>|--filename=<path>]
                         Evaluate a JS file in tab or frame. Reads the file from
                         VFS, evaluates in browser context (accepts top-level
                         await/return). --frame evaluates in that frame instead
                         of the main one. With --output (or --filename), saves the
                         result to file instead of printing to stdout.
  press <key> --tab=<id> Press a keyboard key (keyDown + keyUp, e.g. Enter, Tab)
  keydown <key> --tab=<id> Hold a key down (no paired keyUp)
  keyup <key> --tab=<id> Release a held key (no paired keyDown)
  resize <w> <h> --tab=<id> Resize viewport to width x height
  dialog-accept [text] --tab=<id> Accept a JavaScript dialog
  dialog-dismiss --tab=<id> Dismiss a JavaScript dialog
  go-back --tab=<id>     Navigate back
  go-forward --tab=<id>  Navigate forward
  reload --tab=<id>      Reload current tab
  tab-list               List open tabs (each line is prefixed by its 1-based index for tab-select)
  tab-select <index>     Bring an EXISTING tab to the front / foreground (switch the user's active
                         tab to it) by its 1-based index from tab-list. This is how you focus,
                         activate, raise, or switch to a tab that is already open.
  tab-new [url] [--foreground|--fg] [--runtime=<id>] [--mobile]
       [--teleport-start=<regex>] [--teleport-return=<regex>] [--timeout=<s>]
                         Open new tab. Default: background. --foreground (or --fg) brings the new
                         tab to the FRONT. --runtime opens on a remote tray runtime.
                         Supports teleport flags and --mobile emulation.
  tab-close|close --tab=<id> Close tab by targetId
  upload [ref] <file> [file...] --tab=<id>
                         Upload VFS files to a file input as raw bytes (optional snapshot
                         ref targets hidden inputs; without a ref the input must be focused.
                         A leading eN token is a ref, never a filename.)
  pdf --tab=<id> [--filename=path]
                         Save page as PDF (not available in extension mode)
  state-save [filename] --tab=<id> [--filename=path]
                         Save cookies + localStorage to a JSON state file
  state-load <filename> --tab=<id>
                         Restore cookies + localStorage from a state file
  network-state-set <online|offline> --tab=<id>
                         Toggle the tab's network state
  record [url] [--filter=<js-expr>]
                         Open tab with HAR recording enabled
  stop-recording <id>    Stop recording and save HAR
  cookie-list --tab=<id> [--domain=<d>] [--path=<p>] List all cookies
  cookie-get <name> --tab=<id> Get cookie by name
  cookie-set <name> <value> --tab=<id> [flags]
                         Set a cookie (--domain, --path, --secure, --httpOnly, --expires, --sameSite)
  cookie-delete <name> --tab=<id> Delete a cookie (--domain, --path)
  cookie-clear --tab=<id> Clear all cookies
  localstorage-list --tab=<id> List all localStorage entries
  localstorage-get <key> --tab=<id> Get localStorage value
  localstorage-set <key> <value> --tab=<id>
                         Set localStorage value
  localstorage-delete <key> --tab=<id>
                         Delete localStorage entry
  localstorage-clear --tab=<id> Clear all localStorage
  sessionstorage-list --tab=<id> List all sessionStorage entries
  sessionstorage-get <key> --tab=<id>
                         Get sessionStorage value
  sessionstorage-set <key> <value> --tab=<id>
                         Set sessionStorage value
  sessionstorage-delete <key> --tab=<id>
                         Delete sessionStorage entry
  sessionstorage-clear --tab=<id> Clear all sessionStorage
  console [min-level] --tab=<id> [--clear]
                         List captured console messages (min-level: debug, log, info, warning, error).
                         --clear empties the buffer after reading.
  requests [--static] [--filter=<regex>] [--clear] --tab=<id>
                         List captured network requests. Excludes static resources by default.
                         --static includes images, fonts, CSS, JS. --filter=<regex> filters by URL.
                         --clear empties the buffer after reading.
  request <index> --tab=<id> [--filename=<path>]
                         Show full details for a request (headers, body, response).
  request-headers <index> --tab=<id> [--filename=<path>]
                         Show request headers only.
  request-body <index> --tab=<id> [--filename=<path>]
                         Show request body only.
  response-headers <index> --tab=<id> [--filename=<path>]
                         Show response headers only.
  response-body <index> --tab=<id> [--filename=<path>]
                         Show response body only. Binary bodies shown as [binary body, N bytes].
  mousemove <x> <y> --tab=<id> Move mouse to coordinates
  mousedown [button] --tab=<id> Press mouse button (left/right/middle, default: left)
  mouseup [button] --tab=<id>  Release mouse button (left/right/middle, default: left)
  mousewheel <dx> <dy> --tab=<id> Scroll mouse wheel
  drop --tab=<id> <ref> [--path=vfs-path] [--data=mime/type=value]
                         Drop files or data onto element by ref. --path reads the VFS
                         file as raw bytes, so binary drops stay byte-exact.
  route --tab=<id> <pattern> [--status=n] [--body=text] [--content-type=type]
        [--header=<name: value>] ...
                         Mock requests matching a URL pattern (** = any, * = segment)
  route-list --tab=<id>  List active mock routes for the tab.
  unroute [pattern] --tab=<id>
                         Remove route(s) matching pattern, or all routes if pattern is omitted.
  generate-locator --tab=<id> <ref>
                         Generate a Playwright locator string for the element
  highlight --tab=<id> [ref] [--hide] [--style=<css>]
                         Highlight an element with a visual overlay (--hide to remove)
  help                   Show this help message

Aliases: ${aliases.join(', ')}`;
}

/**
 * Help for a single subcommand — the matching entry from {@link formatHelp},
 * or the full help text when the verb is undocumented.
 *
 * `<cmd> <verb> --help` must never reach the verb's handler: `record` and
 * `open` default a missing URL to `about:blank`, so asking for help used to
 * open a tab (and, for `record`, start a HAR recording).
 */
export function formatSubcommandHelp(commandName: string, sub: string): string {
  return subcommandHelpText(commandName, sub, formatHelp(commandName));
}
