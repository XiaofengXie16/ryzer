export interface Scenario {
  readonly heading: string;
  readonly body: string;
}

export function scenario(index: number): Scenario {
  return { heading: `case-${index}`, body: `<h1 id="target">case-${index}</h1>` };
}
