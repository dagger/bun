import isNumber from "is-number";

export function greet(name: string): string {
  return `hello, ${name}`;
}

export function describe(n: unknown): string {
  return isNumber(n) ? `number:${n}` : "not-a-number";
}

if (import.meta.main) {
  console.log(greet("bun"));
}
