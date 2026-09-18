export const COMPUTER_HELP = `computer — look at and poke a screen (xdotool grammar)

Usage:
  computer [-c <id>] [--json] [--native] <verb> [args] [verb ...]

Target: -c / --computer, else $COMPUTER, else last \`computer use\`, else
the only registered computer. \`computer ls\` lists ids.

Lifecycle:
  ls                         list registered computers
  add tab <targetId|url> [-n name]
                             register a browser tab (refuses SLICC app tabs)
  add screen [-n name]       share this display (needs a user gesture)
  add ssh <follower> [--sim <udid>] [--allow-input] [-n name]
                             follower desktop (or iOS Simulator on a Mac).
                             --allow-input needs sudo (phone can Face ID).
                             The iOS follower itself is never a computer.
  add url <http(s)://base> [-n name]
                             HTTP remote computer (GET /computer). Trailing
                             /computer is stripped. node-server --computer-demo
                             is the in-tree reference.
  rm [id]                    unregister (stops a live screen share)
  use <id>                   set the default computer
  info                       descriptor for the current target

Look:
  screenshot [--size low|medium|high|<N>] [--view] [file]
                             JPEG; prints WxH → wxh (scale s) and a frozen frame
  text                       text-mode dump when the backend supports it
  watch [--fps N] [--stop]   live frames to the page (phase 2 UI)
  record [-V|--duration SEC] [--fps N] [file]
                             timed clip (screen: live session; other kinds:
                             JPEG stills through ffmpeg -f image2pipe, max 60s,
                             --fps ≤10, streamed into the encoder)

Poke (xdotool; every verb ends with a frozen-frame line):
  mousemove <x> <y> [--relative]
  click [1|2|3] [--at x,y] [--hold MS] [--repeat N]
  mousedown [1|2|3] [--at x,y]
  mouseup [1|2|3] [--at x,y]
  drag <x1> <y1> <x2> <y2>
  scroll <dx> <dy> [--at x,y]
  key <keysym> [keysym...]   ctrl+alt+Delete, Return, F5, super+space
  keydown <keysym>
  keyup <keysym>
  type <text...>
  wait <ms>
  exec <command...>          when the backend supports it

Anthropic aliases (same verbs):
  left_click right_click middle_click double_click triple_click
  left_click_drag mouse_move scroll key type screenshot wait

Coordinates are screenshot-space of the last shot unless --native.
Buttons: 1 left, 2 middle, 3 right. Chain verbs: computer click 1 type hello

v86 guests register as v86:<name> on \`v86 start\`. Prefer this command;
\`v86 type|key|mouse|screenshot|text\` remain as thin aliases.
`;

export const COMPUTER_VALUE_FLAGS = [
  '-c',
  '--computer',
  '--size',
  '--at',
  '--hold',
  '--repeat',
  '--fps',
  '-n',
  '--name',
  '--__resolved',
  '-V',
  '--duration',
  '--sim',
] as const;
