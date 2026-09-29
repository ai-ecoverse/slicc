//! zigtest: a Zig 0.16 WASI program for the wasm realm (#3530 phase 5a): stdio, files, dirs, exit codes.
const std = @import("std");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;
    const args = try init.minimal.args.toSlice(arena);
    var out_buf: [4096]u8 = undefined;
    var out_w: Io.File.Writer = .init(.stdout(), io, &out_buf);
    const out = &out_w.interface;
    defer out.flush() catch {};
    if (args.len < 2) {
        std.debug.print("usage: wasidemo upper|files DIR|spin N|exit N\n", .{});
        std.process.exit(2);
    }
    const cmd = args[1];
    if (std.mem.eql(u8, cmd, "upper")) {
        var in_buf: [4096]u8 = undefined;
        var in_r = Io.File.stdin().reader(io, &in_buf);
        const r = &in_r.interface;
        var n: usize = 0;
        while (try r.takeDelimiter('\n')) |line| {
            for (line) |c| try out.writeByte(std.ascii.toUpper(c));
            try out.writeByte('\n');
            n += 1;
        }
        try out.flush();
        std.debug.print("zig: {d} lines\n", .{n});
    } else if (std.mem.eql(u8, cmd, "files")) {
        const cwd = Io.Dir.cwd();
        var dir = try cwd.openDir(io, args[2], .{ .iterate = true });
        defer dir.close(io);
        try dir.createDirPath(io, "zsub");
        try dir.writeFile(io, .{ .sub_path = "zsub/z.txt", .data = "zig was here\n" });
        const back = try dir.readFileAlloc(io, "zsub/z.txt", arena, .limited(1 << 20));
        try out.print("read {s}", .{back});
        try dir.rename("zsub/z.txt", dir, "zsub/y.txt", io);
        const st = try dir.statFile(io, "zsub/y.txt", .{});
        try out.print("size {d} kind {s}\n", .{ st.size, @tagName(st.kind) });
        var names: std.ArrayList([]const u8) = .empty;
        var it = dir.iterate();
        while (try it.next(io)) |e| try names.append(arena, try arena.dupe(u8, e.name));
        std.mem.sort([]const u8, names.items, {}, struct {
            fn lt(_: void, a: []const u8, b: []const u8) bool {
                return std.mem.lessThan(u8, a, b);
            }
        }.lt);
        try out.print("ls:", .{});
        for (names.items) |nm| try out.print(" {s}", .{nm});
        try out.print("\n", .{});
        try dir.deleteFile(io, "zsub/y.txt");
    } else if (std.mem.eql(u8, cmd, "spin")) {
        const n = try std.fmt.parseInt(usize, args[2], 10);
        const stdout = Io.File.stdout();
        var i: usize = 0;
        while (i < n) : (i += 1) try stdout.writeStreamingAll(io, "x\n");
    } else if (std.mem.eql(u8, cmd, "exit")) {
        try out.flush();
        std.process.exit(try std.fmt.parseInt(u8, args[2], 10));
    }
}
