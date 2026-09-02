---
name: v86
description: |
  Use this when booting or driving an x86 virtual machine with SLICC's `v86`
  shell command. Covers the ipk prerequisite, BIOS setup, QEMU-flavored boot
  flags, and the screenshot/text/type/mouse interaction loop for agents.
allowed-tools: bash
---

# v86 virtual machines

The `v86` shell command boots x86 guests (ISO, raw disk, floppy, or direct Linux kernel) on the v86 wasm engine. Nothing is bundled: install the engine first, then supply BIOS blobs and a guest image as VFS files.

## Install prerequisites

```bash
ipk add -g v86@0.5.441
mkdir -p /workspace/.v86
curl -o /workspace/.v86/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
curl -o /workspace/.v86/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
```

There is no CDN fallback; missing pieces produce an actionable error with these exact commands.

## Boot and lifecycle

```bash
v86 start -cdrom alpine.iso              # boot an ISO (prints pid)
v86 start -n dos -fda freedos.img -m 64  # named VM, floppy boot, 64 MiB RAM
v86 start -kernel bzImage -initrd rootfs.img -append "console=ttyS0" -nographic
v86 ls                                   # list running VMs
v86 stop [-n name] [--force]             # power off
v86 state [-n name] save|load <file>     # snapshot / restore full VM state
```

## Arch Linux (copy.sh demo image)

The fastest full-Linux guest is the pre-booted Arch state image from copy.sh (the same one behind https://copy.sh/v86/?profile=archlinux). It resumes straight into a root shell — no BIOS blobs, no boot wait:

```bash
curl -o "$TMPDIR/arch_state.bin.zst" https://i.copy.sh/arch_state-v3.bin.zst   # ~15 MB
v86 start -n arch -state "$TMPDIR/arch_state.bin.zst" -fs9p https://i.copy.sh/arch/ -net virtio -m 512
v86 text -n arch                         # should show a root@localhost prompt
v86 type -n arch "uname -a\n"
v86 text -n arch
```

`-state` resumes a snapshot (`.zst` decompresses inside the engine), `-fs9p` attaches the network-backed 9p root the guest's files live on (fetched on demand, host must send CORS headers), and `-net virtio` matches the NIC the snapshot was saved with.

## Guest networking (fetch relay)

`-net <model>,relay=fetch` gives the guest outbound HTTP without a gateway: v86's fetch relay answers guest DNS in-engine and turns guest port-80 connections into host fetches, which SLICC reroutes through its CORS-bypassing fetch proxy. Plain-http requests to external hosts are upgraded to https before hitting the proxy (`http://localhost` stays local).

```bash
v86 start -n kolibri -fda kolibri.img -net ne2k,relay=fetch -m 128
```

Inside the guest, configure a static IP on the relay's subnet (VM `192.168.86.100`, router/DNS `192.168.86.1`) — e.g. KolibriOS NETCFG or `ip addr add` in Linux. The guest can then browse `http://<host>/...`; https-only sites work because of the upgrade rewrite, but the guest itself only ever speaks plain HTTP on port 80.

VMs run in the background as ProcessManager-tracked units — `ps` shows them and `kill <pid>` powers them off. Default VM name is `vm0`; every subcommand accepts `-n <name>`. RAM defaults to 128 MiB, capped at 512.

## Interaction loop

The VM is not an interactive foreground process. Drive it look-then-act:

```bash
v86 text                        # text-mode screen as plain text (prefer this)
v86 screenshot [out.png]        # VGA framebuffer -> PNG (graphical mode)
v86 type "root\n"               # type on the keyboard ('\n' = Enter)
v86 key ctrl-alt-del enter f2   # named key chords
v86 mouse move 20 -5            # relative pointer move
v86 mouse click right --double  # click; --to x,y is best-effort absolute
v86 serial --send "ls\n"        # write to the guest serial console
v86 serial --tail 25            # read buffered serial output
```

Prefer `v86 text` over `screenshot` whenever the guest is in text mode — it is cheaper and machine-readable. For `-nographic` guests use the `serial` subcommands.

## Live screen streaming (iframe-able)

`v86 serve` pumps the screen into `$TMPDIR/v86-serve-<name>/` — a self-refreshing `index.html` viewer plus live `frame.png`/`screen.txt` + `state.json`. Mint an iframe-able preview URL from it with the regular `serve` command so a human (or sprinkle) can watch the VM:

```bash
v86 serve -n arch --fps 4          # start the pump (1-10 fps, default 2)
serve "$TMPDIR/v86-serve-arch"          # mint a worker-hosted URL to iframe
v86 serve -n arch --stop           # stop the pump (directory stays)
```

## SVGA / high-res video modes

The guest sees a Bochs-dispi (VBE) SVGA adapter; VESA modes are limited by video memory. The default 8 MiB covers up to 1600x1200x32 — pass `-vga <MiB>` at boot for more (e.g. `-vga 16`). Inside a Linux guest, pick a mode with `vga=` kernel parameters or the guest's own modesetting tools.

## Expectations

x86 emulation without KVM runs at a fraction of native speed. Small guests (Alpine, FreeDOS, Buildroot Linux, KolibriOS) work best; give slow boots time and poll with `v86 text` between steps.
