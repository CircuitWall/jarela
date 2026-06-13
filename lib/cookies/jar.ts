// Cookie helpers for HTTP-tool code. Tool implementations import from
// here rather than reaching into lib/stores/allowed-sites directly so
// the read surface stays narrow and the store can evolve independently.
//
// last_used_at on the matched allow-list row is bumped as a side effect
// of getCookieHeaderForUrl — no separate "mark in use" call needed.

export {
  getCookieHeaderForUrl,
  isHostAllowed,
} from "@/lib/stores/allowed-sites";
