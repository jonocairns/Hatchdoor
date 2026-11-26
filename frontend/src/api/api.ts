// Central API access layer. When the server requires a web bearer token
// (HATCHDOOR_WEB_BEARER_TOKEN), it is stored locally and attached to every
// request — as an Authorization header for fetch, or as an `access_token`
// query parameter for contexts that cannot set headers (<img>, downloads, SSE).
// The server takes the query form only on the GET routes in
// `QUERY_TOKEN_ROUTES` (src/auth.rs), and a Rust test holds every
// `withAccessToken` call here to that list (#703).

const TOKEN_KEY = "hatchdoor_web_token";
const PROXY_RELOAD_KEY = "hatchdoor_proxy_reload";
const PROXY_RELOAD_WINDOW_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// The token for this page only, held when the browser refuses to store it.
// WebKit with site data blocked throws from every localStorage access, and
// without this an Unlock would forget the token at once and every request
// would stay on 401 (#339). It wins over storage, which may still hold an
// older token it would not let this one replace. Null whenever storage
// accepted the token, so a sign-out in another tab still applies here.
let unstoredToken: string | null = null;

export function getToken(): string | null {
  try {
    return unstoredToken ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return unstoredToken;
  }
}

/** Remember the web token. Returns false when the browser refused to store
 * it: the token then lasts only as long as this page, so a caller must not
 * reload to apply it. */
export function setToken(token: string): boolean {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    unstoredToken = null;
    return true;
  } catch {
    unstoredToken = token;
    return false;
  }
}

export function clearToken(): void {
  unstoredToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore.
  }
}

export type AuthRefusal = "hatchdoor" | "proxy";
type UnauthorizedHandler = (source: AuthRefusal) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Register a callback for a current request refused by Hatchdoor or a proxy. */
export function onUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/** Reserve one automatic sign-in reload across page loads in this tab. */
export function reserveProxyReload(): boolean {
  try {
    const now = Date.now();
    const lastReload = sessionStorage.getItem(PROXY_RELOAD_KEY);
    if (
      lastReload !== null &&
      now - Number(lastReload) < PROXY_RELOAD_WINDOW_MS
    ) {
      return false;
    }
    sessionStorage.setItem(PROXY_RELOAD_KEY, String(now));
    return true;
  } catch {
    // A reload would forget the guard if the browser blocks site storage.
    return false;
  }
}

/** `RequestInit` plus an optional per-call timeout override. Slow-by-nature
 * requests (attachment uploads, note mutations on large vaults) need more than
 * the default read timeout. */
export type ApiFetchInit = RequestInit & { timeoutMs?: number };

/**
 * Fetch wrapper that attaches the stored token and reports API auth refusals.
 * Hatchdoor's API serves its responses directly. An intervening sign-in
 * redirect becomes an opaque redirect in manual mode, distinct from an
 * offline or failed fetch (both of which would otherwise throw TypeError).
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: ApiFetchInit,
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...requestInit } = init ?? {};
  const token = getToken();
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => {
    timeoutController.abort(
      new DOMException("Request timed out", "AbortError"),
    );
  }, timeoutMs);
  const callerSignal = init?.signal;
  const abortFromCaller = () => {
    timeoutController.abort(
      callerSignal?.reason ?? new DOMException("Aborted", "AbortError"),
    );
  };
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  let finalInit: RequestInit = requestInit;
  if (token) {
    const headers = new Headers(requestInit.headers);
    headers.set("Authorization", `Bearer ${token}`);
    finalInit = {
      ...requestInit,
      headers,
    };
  }

  try {
    const res = await fetch(input, {
      ...finalInit,
      redirect: "manual",
      signal: timeoutController.signal,
    });
    // An Unlock applied in place (#339) must ignore refusals for a token
    // that has since changed.
    if (
      (res.status === 401 || res.type === "opaqueredirect") &&
      getToken() === token
    ) {
      const source =
        res.headers.get("X-Hatchdoor-Auth") === "required"
          ? "hatchdoor"
          : "proxy";
      unauthorizedHandler?.(source);
    }
    return res;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.("hatchdoor");
}

/**
 * Append the stored token as an `access_token` query parameter, for URLs used
 * where headers cannot be set (image src, download links, EventSource). Returns
 * the URL unchanged when no token is stored, and keeps any `#fragment` last. Pass
 * a literal URL on one of the server's `QUERY_TOKEN_ROUTES`: any other route
 * answers `401` to it.
 */
export function withAccessToken(url: string): string {
  const token = getToken();
  if (!token) {
    return url;
  }
  // The token goes before any `#fragment`: a browser never sends the fragment,
  // so a token inside it is lost (`![[x.pdf#page=3]]`, #755).
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}access_token=${encodeURIComponent(token)}${fragment}`;
}
