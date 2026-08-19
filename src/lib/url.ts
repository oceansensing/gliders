/**
 * The base path, applied once.
 *
 * The site is served from a subdirectory (`/gliders/`), so no internal URL
 * may be written root-absolute. Astro rewrites nothing for us — `base` is a
 * value we are handed, not a transform it applies — so every link, every
 * asset fetch and the worker's own URL go through here.
 *
 * `BASE_URL` already carries a trailing slash in every Astro version this
 * has been built against, but it has not always, and a doubled slash is a
 * 404 on Pages rather than a redirect. So the join is written to survive
 * both rather than to assume one.
 */
const BASE = import.meta.env.BASE_URL ?? '/';

/** An internal path, prefixed with the site's base. Pass a leading slash. */
export function withBase(path: string): string {
  const base = BASE.endsWith('/') ? BASE.slice(0, -1) : BASE;
  const tail = path.startsWith('/') ? path : `/${path}`;
  return `${base}${tail}`;
}

/** True when `href` is the page currently open. Used for `aria-current`. */
export function isCurrent(href: string, pathname: string): boolean {
  const target = withBase(href);
  if (target.endsWith('/')) {
    // `/gliders/` must not light up on `/gliders/local/`.
    return pathname === target || pathname === target.slice(0, -1);
  }
  return pathname === target || pathname === `${target}/`;
}
