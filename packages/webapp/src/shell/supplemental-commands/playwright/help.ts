/**
 * Help text for the playwright-cli command family.
 */

import { PLAYWRIGHT_COMMAND_NAMES } from './state.js';

export function formatHelp(commandName: string): string {
  const aliases = PLAYWRIGHT_COMMAND_NAMES.filter((name) => name !== commandName);
  return `Usage: ${commandName} <command> [args...]

Commands:
  open [url|/vfs/path] [--foreground|--fg] [--runtime=<id>] [--discover]
       [--teleport-start=<regex>] [--teleport-return=<regex>] [--timeout=<s>]
                         Open a new tab (default: background). VFS paths are served via preview service worker.
                         Use --runtime to open the tab on a remote tray runtime (e.g. --runtime=follower-abc).
                         Use --teleport-start/--teleport-return to arm auth-state teleport.
                         With --discover, also fetches the URL via the proxied fetch and emits JSON
                         with parsed RFC 8288 Link headers + P0 discovery (api-catalog, llms.txt, ...).
  goto|navigate <url> [--discover] [--teleport-start=<regex>] [--teleport-return=<regex>]
                         Navigate current tab to URL. Supports teleport flags.
                         With --discover, emits JSON with parsed Link headers, any SLICC handoff
                         match, and P0 capability documents (api-catalog, llms.txt, ...).
  fetch <url> [--method=<verb>] [--discover]
                         Fetch a URL through the proxied fetch and emit JSON containing
                         parsed RFC 8288 Link headers (always) and, with --discover, the
                         resolved P0 capability documents.
  teleport --start <regex> --return <regex> [--timeout=<s>] [--runtime=<id>]
                         Arm a teleport watcher on the current tab. Triggers when the
                         leader tab URL matches --start, opens the URL on a follower
                         for human auth, then restores cookies + page storage when the
                         follower URL matches --return.
  teleport --off         Disarm the active teleport watcher.
  teleport --list        List available follower runtimes for teleport.
  click <ref>            Click element by ref (e.g. e5)
  type <text>            Type text into focused element
  fill <ref> <text>      Fill an input by ref with text
  snapshot [--no-iframes] Print accessibility tree with refs
  frames                 List all frames (iframes) in the current tab
  screenshot [--filename=path] [--max-width=N] [--fullPage=true]
                         Take screenshot. --max-width downscales the image
                         if wider than N pixels (e.g. --max-width=1024).
  pdf --tab=<id> [--filename=path]  Save current page as PDF
  eval <expression>      Evaluate JavaScript in tab
  dblclick <ref> [btn]   Double-click element by ref
  hover <ref>            Hover over element by ref
  select <ref> <val>     Select value in <select> element
  check <ref>            Check a checkbox/radio
  uncheck <ref>          Uncheck a checkbox/radio
  drag <start> <end>     Drag from one element to another
  eval-file <path> [--output=<path>]
                         Evaluate a JS file in the page. Reads the file from
                         VFS, evaluates in browser context. With --output,
                         saves the result to file instead of printing to stdout.
  press <key>            Press a keyboard key (e.g. Enter, Tab)
  keydown <key>          Hold a key down (sends keyDown without paired keyUp)
  keyup <key>            Release a held key (sends keyUp without paired keyDown)
  resize <w> <h>         Resize viewport to width x height
  dialog-accept [text]   Accept a JavaScript dialog
  dialog-dismiss         Dismiss a JavaScript dialog
  go-back                Navigate back
  go-forward             Navigate forward
  reload                 Reload current tab
  tab-list               List open tabs
  tab-select <index>     Select (bring to front) a tab by its index from tab-list
  tab-new [url] [--foreground|--fg] [--runtime=<id>]
       [--teleport-start=<regex>] [--teleport-return=<regex>] [--timeout=<s>]
                         Open new tab (default: background). --runtime opens on a remote tray runtime.
                         Supports teleport flags.
  tab-close --tab=<id>   Close tab by targetId
  record [url] [--filter=<js-expr>]
                         Open tab with HAR recording enabled
  stop-recording <id>    Stop recording and save HAR
  cookie-list            List all cookies
  cookie-get <name>      Get cookie by name
  cookie-set <name> <value> [flags]
                         Set a cookie (--domain, --path, --secure, --httpOnly, --expires)
  cookie-delete <name>   Delete a cookie (--domain, --path)
  cookie-clear           Clear all cookies
  localstorage-list      List all localStorage entries
  localstorage-get <key> Get localStorage value
  localstorage-set <key> <value>
                         Set localStorage value
  localstorage-delete <key>
                         Delete localStorage entry
  localstorage-clear     Clear all localStorage
  sessionstorage-list    List all sessionStorage entries
  sessionstorage-get <key>
                         Get sessionStorage value
  sessionstorage-set <key> <value>
                         Set sessionStorage value
  sessionstorage-delete <key>
                         Delete sessionStorage entry
  sessionstorage-clear   Clear all sessionStorage
  network-state-set --tab=<id> <state>
                         Set network state: online or offline
  upload <file> [file...] Upload file(s) to the focused file input element (paths from VFS)
  help                   Show this help message

Aliases: ${aliases.join(', ')}`;
}
