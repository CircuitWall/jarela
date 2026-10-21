// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { isMarkedFirstRunThread, rememberFirstRunThread } from "./first-run-thread";

afterEach(() => window.localStorage.clear());

it("marks each onboarding thread across tabs without replacing earlier markers", () => {
  expect(isMarkedFirstRunThread("thread-1")).toBe(false);
  rememberFirstRunThread("thread-1");
  rememberFirstRunThread("thread-2");
  expect(isMarkedFirstRunThread("thread-1")).toBe(true);
  expect(isMarkedFirstRunThread("thread-2")).toBe(true);
});