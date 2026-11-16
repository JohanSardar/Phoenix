const std = @import("std");
const io = @import("core/shared/io.zig");
const runtime = @import("core/tooling/tool_runtime.zig");
const admission = @import("core/tooling/tool_admission.zig");
const tools = @import("builtins/tools.zig");
const types = @import("core/shared/types.zig");

test "S2 Phoenix intercepts an authorized write_file before it mutates the box" {
    const alloc = std.testing.allocator;
    io.setLibcEnviron();
    defer io.resetEnvironForTest();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const workspace = try io.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(workspace);
    var call_arena = std.heap.ArenaAllocator.init(alloc);
    defer call_arena.deinit();
    var result_arena = std.heap.ArenaAllocator.init(alloc);
    defer result_arena.deinit();
    const call: types.ToolCall = .{ .id = "recorded-write", .name = "write_file", .arguments_json = "{\"path\":\"created.txt\",\"content\":\"new content\"}" };
    var rules = [_]types.PermissionRule{.{ .permission = @constCast("edit"), .pattern = @constCast("**"), .action = .allow }};
    const authorization = switch (try admission.preflightFileMutation(call_arena.allocator(), call, .{
        .tool_registry = tools.registry,
        .workspace_root = workspace,
        .permission_rules = .{ .rules = &rules },
        .permission_mode = .auto,
        .can_prompt = false,
    })) {
        .allowed => |value| value,
        else => return error.TestExpectedAllowed,
    };
    const context: runtime.Context = .{
        .workspace_root = workspace,
        .ignored_list_entries = &.{},
        .max_list_entries = 100,
        .max_read_file_bytes = 65536,
        .max_read_file_lines = 400,
        .max_read_file_line_len = 2000,
        .max_command_output_bytes = 65536,
        .api_key = "",
        .model = "",
        .gateway_retry_count = 0,
        .gateway_chat_url = "",
        .agent_step_limit = 0,
        .tool_registry = tools.registry,
        .permission_mode = .auto,
        .permission_grants = &.{},
        .permission_rules = .{},
        .worker = undefined,
        .session = undefined,
        .context_registry = undefined,
        .output_chunk_ctx = undefined,
        .on_output_chunk = undefined,
    };
    const result = try runtime.executeToolCallAuthorized(context, .{
        .call_allocator = call_arena.allocator(),
        .result_allocator = result_arena.allocator(),
        .call = call,
        .authority = .{ .file_mutation = authorization },
        .session_grants = &.{},
        .advertised_dynamic_tool_names = &.{},
        .max_tool_result_bytes = 65536,
    });
    const file = tmp.dir.openFile(io.getIo(), "created.txt", .{}) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    file.close(io.getIo());
    std.debug.print("write_file bypassed Phoenix and created the file: {s}\n", .{result.model_output});
    return error.TestUnexpectedLocalFileMutation;
}
