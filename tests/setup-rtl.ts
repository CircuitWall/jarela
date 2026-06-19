// Shared setup for React Testing Library suites. Each component test file
// opts into jsdom via the `// @vitest-environment jsdom` pragma; this file
// just ensures the DOM is cleared between renders so tests stay isolated.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
