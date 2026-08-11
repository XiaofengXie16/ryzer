export const CASES = Number(process.env.BENCH_CASES ?? 48);
export const STEPS = 6;

export function benchmarkDelay(index: number): number {
  return 4 + (index % 5) * 3;
}

export function benchmarkUrl(index: number): string {
  const settleDelay = benchmarkDelay(index);
  const html = `<!doctype html><html><body>
    <label for="query">Query</label><input id="query">
    <button id="submit">Search</button>
    <output id="result">idle</output>
    <ul id="items"></ul>
    <script>
      const input = document.querySelector('#query');
      const button = document.querySelector('#submit');
      const result = document.querySelector('#result');
      const items = document.querySelector('#items');
      input.addEventListener('input', () => { result.textContent = 'typing:' + input.value; });
      button.addEventListener('click', () => setTimeout(() => {
        result.textContent = 'done:' + input.value;
        items.innerHTML = '<li>alpha</li><li>beta</li><li>gamma</li>';
      }, ${settleDelay}));
    </script>
  </body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
