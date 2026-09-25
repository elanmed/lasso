import assert from "node:assert";

export function assertAtBuildtime(value: boolean): asserts value {
  assert(value);
}

export function assertAtRuntime(value: boolean): asserts value {
  assert(value);
}
