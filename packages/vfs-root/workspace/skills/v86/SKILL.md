---
name: v86
description: |
  Use this when booting or driving an x86 virtual machine with SLICC's `v86`
  shell command. Covers the ipk prerequisite, BIOS setup, QEMU-flavored boot
  flags, and the look-then-act loop (`computer` after `v86 start` registers
  `v86:<name>`; `v86 type|key|mouse|screenshot|text` remain as aliases).
allowed-tools: bash
---

# v86 virtual machines

x86 guests (ISO, disk, floppy, kernel) on v86 wasm. Install engine + BIOS blobs first.

## Install

```bash
ipk add -g v86@0.5.462
mkdir -p /workspace/.v86
curl -o /workspace/.v86/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
curl -o /workspace/.v86/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
```

No CDN fallback.

## Boot

```bash
v86 start -cdrom alpine.iso
v86 start -n dos -fda freedos.img -m 64
v86 start -kernel bzImage -initrd rootfs.img -append "console=ttyS0" -nographic
v86 ls
v86 stop [-n name] [--force]
v86 state [-n name] save|load <file>
```

Default name `vm0`; RAM 128 MiB (max 512). Background ProcessManager units — `ps` / `kill <pid>`.

## Arch (copy.sh)

```bash
curl -o "$TMPDIR/arch_state.bin.zst" https://i.copy.sh/arch_state-v3.bin.zst
v86 start -n arch -state "$TMPDIR/arch_state.bin.zst" -fs9p https://i.copy.sh/arch/ -net virtio -m 512
v86 text -n arch && v86 type -n arch "uname -a\n" && v86 text -n arch
```

`-state` resumes snapshot; `-fs9p` 9p root (CORS required); `-net virtio` matches saved NIC.

## Networking

`-net <model>,relay=fetch` — guest HTTP via host fetch proxy (DNS in-engine; external http→https upgrade):

```bash
v86 start -n kolibri -fda kolibri.img -net ne2k,relay=fetch -m 128
```

Guest static IP: VM `192.168.86.100`, router/DNS `192.168.86.1`. Guest speaks plain HTTP on port 80.

## Interaction

`v86 start` registers `v86:<name>` — prefer `computer` (see `/workspace/skills/computer/SKILL.md`):

```bash
computer use v86:vm0
computer text
computer screenshot
computer type "root\n"
computer key ctrl+alt+Delete enter f2
computer mousemove 20 -5 --relative
computer click 3
```

`v86 type|key|mouse|screenshot|text` alias `computer`. `computer rm` unregisters only (doesn't power off).

```bash
v86 serial --send "ls\n"
v86 serial --tail 25
```

Prefer `text` over `screenshot` in text mode. `-nographic` → `serial`.

## Live screen

`v86 serve` retired → `computer watch -c v86:arch`. `v86 serve` exits 0 with pointer.

## SVGA

Bochs-dispi VBE; default 8 MiB → 1600×1200×32. `-vga <MiB>` for more (e.g. `-vga 16`).

Slow without KVM — poll `v86 text` between steps.
