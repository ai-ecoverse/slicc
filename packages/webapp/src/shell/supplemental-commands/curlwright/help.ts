/** `curlwright --help` text. Kept beside the parser so the two stay honest. */

export const CURLWRIGHT_HELP = `curlwright — curl's arguments, executed inside a browser tab.

The request is issued by a page-context fetch(), so it carries that tab's
cookies, origin, TLS session and service-worker routing. Use it for an app's
own backend, where sandbox curl gets a 401/403/421.

Usage: curlwright [options] <url>

Request:
  -X, --request <method>     HTTP method (default GET, or POST with a body)
  -H, --header <line>        Add a header; repeatable. "Name;" sends it empty,
                             "Name:" suppresses a default curlwright would add
  -d, --data <data>          Request body; @file reads from the VFS
      --data-raw <data>      Body, with no @file expansion
      --data-binary <data>   Body; @file keeps newlines and raw bytes
      --data-urlencode <d>   URL-encode; content, =content, name=content, name@file
      --json <data>          Body + Content-Type/Accept: application/json
  -F, --form <name=content>  multipart/form-data; @file uploads, <file inlines
      --form-string <n=c>    multipart field, taken literally
  -G, --get                  Send --data as a query string
  -u, --user <user:pass>     Basic auth (an Authorization header)
  -e, --referer <url>        Set the request referrer
  -r, --range <range>        Add a Range header ("0-499" becomes "bytes=0-499")
      --no-credentials       Do not send cookies (they are sent by default)

Tab selection:
      --tab <targetId>       Tab to run in. Without it: the tab on the URL's
                             origin when EXACTLY ONE matches, else the only
                             open tab. Two candidates is an error listing them
      --frame <frameId>      Run in a child frame of that tab

Output:
  -o, --output <file>        Write the body to a VFS file, byte-exact ("-" = stdout)
  -O, --remote-name          Write to the URL's last path segment
  -i, --include              Print response headers before the body
  -I, --head                 Send HEAD and print only the headers
  -D, --dump-header <file>   Write the response headers to a file
  -w, --write-out <format>   Print a format string after the transfer
  -s, --silent               Suppress error messages
  -S, --show-error           Show errors even with -s
  -v, --verbose              Trace the request and response to stderr
  -f, --fail                 No body on HTTP >= 400; exit 22
  -m, --max-time <seconds>   Abort the request after this long; exit 28

--write-out variables:
  %{url_effective} %{http_code} %{content_type} %{size_download} %{size_header}
  %{size_upload} %{method} %{num_redirects} %{time_total} %{exitcode}
  %{errormsg} %{json}, %header{Name}, %% for a literal percent, \\n \\r \\t

Exit codes: 0 ok, 2 bad usage, 7 the fetch failed, 22 with --fail on HTTP >= 400,
23 write error, 26 cannot read an input file, 28 --max-time expired.

Notes:
  - A body on GET or HEAD is rejected as bad usage (exit 2), because a page
    fetch() cannot send one. Use -G to put the data in the query string.
  - --write-out is rendered even when the transfer fails, so %{exitcode} and
    %{errormsg} still reach stdout on a timeout or a network error.
  - Redirects are ALWAYS followed: a page fetch cannot surface the intermediate
    3xx, so -L is accepted and is already the behavior. %{num_redirects} is 0 or
    1 — "at least one hop" — because the page context cannot count them.
  - Cross-origin responses expose only CORS-safelisted headers unless the server
    sends Access-Control-Expose-Headers. Same-origin requests see all of them.
  - Options a page cannot honor (--cert, --insecure, -x, --resolve, --compressed,
    -b, -A, ...) are rejected by name rather than ignored.

Examples:
  curlwright -s https://app.example.com/api/me
  curlwright -X POST https://app.example.com/api/items \\
    -H 'X-CSRF-Token: abc' -d '{"name":"x"}' --tab <targetId>
  curlwright -o /tmp/deck.key https://p27-iwres.icloud.com/iwmb/keynote/.../fetchDocument
  curlwright -o /tmp/me.json -w '%{http_code} %{size_download}\\n' https://app.example.com/api/me
`;
