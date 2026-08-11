export const STRESS_CASES = 48;
export const EXPECT_TIMEOUT_MS = 190;

export function stressUrl(index: number): string {
  // A narrow but valid deadline: the state always changes before the timeout.
  // Runtime scheduling noise determines whether a polling-based waiter sees it.
  const delay = 150 + (index % 5) * 6;
  const html = `<!doctype html><html><body>
    <output id="status">pending</output>
    <script>
      setTimeout(() => { document.querySelector('#status').textContent = 'ready-${index}'; }, ${delay});
    </script>
  </body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
