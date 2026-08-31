import { describe, it, expect } from "vitest";
import { categorizeByVerb } from "./categorize-by-verb";

describe("categorizeByVerb", () => {
  describe("READ — pure inspection", () => {
    const cases = [
      "tool_result_get",
      "tool_result_list",
      "documents_search",
      "documents_list_sources",
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_get_event",
      "file_read",
      "file_list",
      "file_stat",
      "file_glob",
      "file_grep",
      "gmail_search",
      "gmail_get_message",
      "gmail_list_labels",
      "outlook_search",
      "outlook_get_message",
      "outlook_list_folders",
      "list_integrations",
      "get_integration_setup",
      "list_tools",
      "get_user_location",
      "list_mcp_servers",
      "memory_read",
      "memory_list",
      "list_providers",
      "describe_provider",
      "list_scheduled_tasks",
      "list_reaction_scripts",
      "list_watchers",
      "workspace_status",
      "browser_screenshot",
      "browser_extract",
      "browser_snapshot",
      "web_fetch",
      "web_search",
      "check_proposal",
      "read_agent_instruction",
      "read_agent_config",
      "list_harnesses",
      "read_harness",
      "list_skills",
      "read_skill",
      "describe_extension_surfaces",
    ];
    for (const name of cases) {
      it(`${name} → read`, () => {
        expect(categorizeByVerb(name)).toBe("read");
      });
    }
  });

  describe("WRITE — content mutations on owned data", () => {
    const cases = [
      "calendar_create_event",
      "calendar_update_event",
      "calendar_delete_event",
      "documents_add_local_source",
      "documents_add_remote_source",
      "documents_remove_source",
      "documents_reindex_source",
      "documents_index_url",
      "file_write",
      "file_edit",
      "file_move",
      "file_copy",
      "file_delete",
      "file_mkdir",
      "file_multi_edit",
      "gmail_modify_message",
      "gmail_create_draft",
      "gmail_trash_message",
      "outlook_modify_message",
      "outlook_create_draft",
      "outlook_trash_message",
      "outlook_calendar_create_event",
      "outlook_calendar_update_event",
      "outlook_calendar_delete_event",
      "memory_write",
      "memory_delete",
      "set_env_var",
      "update_agent_instruction",
      "write_skill",
      "update_scheduled_task",
      "update_watcher",
    ];
    for (const name of cases) {
      it(`${name} → write`, () => {
        expect(categorizeByVerb(name)).toBe("write");
      });
    }
  });

  describe("EXECUTE — workflow / external side-effects", () => {
    const cases = [
      "local_exec",
      "terminal",
      "delegate_to_agent",
      "generate_image",
      "generate_voice",
      "schedule_task",
      "schedule_watcher",
      "cancel_scheduled_task",
      "cancel_watcher",
      "restart_server",
      "propose_config_change",
      "browser_navigate",
      "browser_click",
      "browser_fill",
      "browser_scroll",
      "gmail_send_email",
      "outlook_send_email",
      "workspace_init",
      "workspace_close",
    ];
    for (const name of cases) {
      it(`${name} → execute`, () => {
        expect(categorizeByVerb(name)).toBe("execute");
      });
    }
  });

  describe("edge cases", () => {
    it("falls back to execute for opaque names with no verb token", () => {
      expect(categorizeByVerb("frobnicate")).toBe("execute");
      expect(categorizeByVerb("opaque_thing")).toBe("execute");
    });

    it("is case-insensitive", () => {
      expect(categorizeByVerb("FILE_READ")).toBe("read");
      expect(categorizeByVerb("Calendar_Create_Event")).toBe("write");
    });

    it("handles hyphens and underscores", () => {
      expect(categorizeByVerb("file-read")).toBe("read");
      expect(categorizeByVerb("file--read")).toBe("read");
      expect(categorizeByVerb("__memory__write__")).toBe("write");
    });

    it("returns the bucket of the FIRST recognized verb token", () => {
      // "list_and_delete" — list comes first → read.
      expect(categorizeByVerb("list_and_delete")).toBe("read");
      // "delete_after_list" — delete comes first → write.
      expect(categorizeByVerb("delete_after_list")).toBe("write");
    });
  });
});
