export const DETERMINISTIC_CASES = 16;
export const TIMER_DELAY_MS = 1_000;

export function deterministicUrl(index: number): string {
  const html = `<!doctype html><html><body>
    <button>Start</button><output>pending</output>
    <script>
      document.querySelector('button').addEventListener('click', () => setTimeout(() => {
        document.querySelector('output').textContent = 'ready-${index}';
      }, ${TIMER_DELAY_MS}));
    </script>
  </body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
