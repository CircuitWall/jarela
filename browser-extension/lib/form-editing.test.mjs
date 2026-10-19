// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureField, clearFillTarget, fillFocusedField, getFillContext } from "./form-editing.mjs";

const executeScript = vi.fn();

beforeEach(() => {
  executeScript.mockReset();
  vi.stubGlobal("chrome", { scripting: { executeScript } });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("replaces the captured selection even after the field loses focus", async () => {
  document.body.innerHTML = "<textarea>before target after</textarea><button>menu</button>";
  const field = document.querySelector("textarea");
  field.focus();
  field.setSelectionRange(7, 13);
  executeScript.mockImplementation(async ({ func, args = [] }) => [{ frameId: 3, result: await func(...args) }]);

  expect(await captureField(7)).toEqual({ ok: true, frameId: 3, hasField: true, original: "target" });
  document.querySelector("button").focus();
  expect(await fillFocusedField(7, 3, "replacement")).toEqual({ ok: true });
  expect(field.value).toBe("before replacement after");
  expect(executeScript.mock.calls[1][0].target).toEqual({ tabId: 7, frameIds: [3] });
});

it("prefers the first editable frame over a longer loose selection", async () => {
  executeScript.mockResolvedValue([
    { frameId: 0, result: { hasField: false, original: "a long loose selection" } },
    { frameId: 2, result: { hasField: true, original: "field" } },
    { frameId: 4, result: { hasField: true, original: "another field" } },
  ]);
  expect(await captureField(7)).toEqual({ ok: true, frameId: 2, hasField: true, original: "field" });
});

it("uses the longest loose selection when no frame has an editable field", async () => {
  executeScript.mockResolvedValue([
    { frameId: 0, result: { hasField: false, original: "short" } },
    { frameId: 2, result: { hasField: false, original: "longer selection" } },
  ]);
  expect(await captureField(7)).toEqual({ ok: true, frameId: 2, hasField: false, original: "longer selection" });
});

it("returns a failed capture when the tab is gone", async () => {
  executeScript.mockRejectedValue(new Error("No tab"));
  expect(await captureField(7)).toEqual({ ok: false });
  await expect(clearFillTarget(7)).resolves.toBeUndefined();
  expect(executeScript.mock.calls[1][0].target).toEqual({ tabId: 7 });
});

it.each(["textarea", "input"])("shares the pinned %s across nested shadow roots after focus changes", async (tag) => {
  document.body.innerHTML = "<div id='host'></div><button>menu</button>";
  const outer = document.getElementById("host").attachShadow({ mode: "open" });
  const nestedHost = document.createElement("div");
  outer.appendChild(nestedHost);
  const inner = nestedHost.attachShadow({ mode: "open" });
  const field = document.createElement(tag);
  field.value = "before target after";
  inner.appendChild(field);
  field.focus();
  field.setSelectionRange(7, 13);
  executeScript.mockImplementation(async ({ func, args = [] }) => {
    const injected = new Function(`return (${func.toString()});`)();
    return [{ frameId: 0, result: await injected(...args) }];
  });

  expect(await captureField(7)).toMatchObject({ ok: true, hasField: true, original: "target" });
  document.querySelector("button").focus();
  expect(await getFillContext(7, 0)).toMatchObject({ has_target: true, text: "target" });
  expect(await fillFocusedField(7, 0, "replacement")).toEqual({ ok: true });
  expect(field.value).toBe("before replacement after");
  await clearFillTarget(7, 0);
  expect(field.hasAttribute("data-jarela-fill-target")).toBe(false);
  expect(field.dataset.jarelaFillStart).toBeUndefined();
});