import { scenario, type Scenario } from "./helpers.js";

export function scenariosFor(file: number, count: number): Scenario[] {
  return Array.from({ length: count }, (_, index) => scenario(file * 100 + index));
}
