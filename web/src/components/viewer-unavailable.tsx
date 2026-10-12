/**
 * What the viewer shows in place of a page it could not fetch.
 *
 * The viewer only ever proxies the operator's read API, so an unreachable operator is the one
 * failure the audience will actually meet — a stopped container, a timeout, a refused
 * connection. It is not an error in the reader's own use of the site, so it is answered with a
 * plain sentence and a suggestion to reload rather than a status code they cannot act on.
 */
export function ViewerUnavailable() {
  return (
    <main className="shell">
      <section className="panel empty-state">
        <p className="eyebrow">The village is off the air</p>
        <p>The live feed is unavailable at the moment. Reload the page in a moment to try again.</p>
      </section>
    </main>
  );
}
