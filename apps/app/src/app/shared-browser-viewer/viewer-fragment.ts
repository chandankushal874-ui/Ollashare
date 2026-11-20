export function consumeViewerFragment(location: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "replaceState">): string {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token") ?? "";
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return token;
}
