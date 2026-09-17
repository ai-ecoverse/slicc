export const COMPUTER_HELP = `computer — look at and poke a screen (xdotool grammar)

Usage:
  computer [-c <id>] [--json] [--native] <verb> [args] [verb ...]

Target: -c / --computer, else $COMPUTER, else last \`computer use\`, else
the only registered computer. \`computer ls\` lists ids.

Lifecycle:
  ls                         list registered computers
  add tab <targetId|url> [-n name]
                             register a browser tab (refuses SLICC app tabs)
  rm [id]                    unregister (does not stop a v86 guest)
  use <id>                   set the default computer
  info                       descriptor for the current target

Look:
  screenshot [--size low|medium|high|<N>] [--view] [file]
                             JPEG; prints WxH → wxh (scale s) and a frozen frame
  text                       text-mode dump when the backend supports it
  watch [--fps N] [--stop]   live frames to the page (phase 2 UI)

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
] as const;
