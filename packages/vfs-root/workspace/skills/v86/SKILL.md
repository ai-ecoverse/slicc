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
ipk add v86@0.5.424
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

## Expectations

x86 emulation without KVM runs at a fraction of native speed. Small guests (Alpine, FreeDOS, Buildroot Linux, KolibriOS) work best; give slow boots time and poll with `v86 text` between steps.
