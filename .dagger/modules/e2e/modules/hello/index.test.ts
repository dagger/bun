import { expect, test } from "bun:test";
import { describe, greet } from "./index.ts";

test("greet returns a greeting", () => {
  expect(greet("bun")).toBe("hello, bun");
});

test("describe uses the is-number dependency", () => {
  expect(describe(3)).toBe("number:3");
  expect(describe("x")).toBe("not-a-number");
});
