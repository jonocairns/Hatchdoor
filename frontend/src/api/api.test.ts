import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch,
  clearToken,
  DEFAULT_FETCH_TIMEOUT_MS,
  getToken,
  onUnauthorized,
  reserveProxyReload,
  setToken,
  withAccessToken,
} from "./api";

afterEach(() => {
  clearToken();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("apiFetch", () => {
  it("passes an abort signal to fetch so stalled requests can time out", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    await apiFetch("/api/tree");

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts requests that never settle", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              init.signal?.reason ?? new DOMException("Aborted", "AbortError"),
            );
          });
        }),
    );

    const request = apiFetch("/api/tree");
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);

    await rejection;
  });

  it("honors a per-call timeoutMs override instead of the default timeout", async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(
              init.signal?.reason ?? new DOMException("Aborted", "AbortError"),
            );
          });
        }),
    );

    const request = apiFetch("/api/attachment", {
      method: "POST",
      timeoutMs: 60_000,
    });
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000 - DEFAULT_FETCH_TIMEOUT_MS);
    expect(aborted).toBe(true);
    await rejection;
  });

  it("preserves Headers instance values when attaching the bearer token", async () => {
    setToken("secret-token");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    await apiFetch("/api/tree", {
      headers: new Headers({ "X-Trace-Id": "trace-1" }),
    });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Trace-Id")).toBe("trace-1");
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });
});

describe("web token with site data blocked (#339)", () => {
  function blockStorage(): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    return () => {
      if (descriptor) {
        Object.defineProperty(window, "localStorage", descriptor);
      }
    };
  }

  it("keeps an unlocked token for this page when storage throws, as WebKit does", async () => {
    const restore = blockStorage();
    try {
      setToken("secret-token");
      expect(getToken()).toBe("secret-token");
      expect(withAccessToken("/api/v1/vaults/events")).toBe(
        "/api/v1/vaults/events?access_token=secret-token",
      );

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok"));
      await apiFetch("/api/tree");
      const [, init] = fetchSpy.mock.calls[0] ?? [];
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer secret-token",
      );

      clearToken();
      expect(getToken()).toBeNull();
    } finally {
      restore();
    }
  });

  it("keeps the token when storage reads but refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    setToken("secret-token");

    expect(getToken()).toBe("secret-token");
  });

  it("uses a new token the browser refused over an old one still stored", () => {
    window.localStorage.setItem("hatchdoor_web_token", "stale-token");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    setToken("secret-token");

    expect(getToken()).toBe("secret-token");
  });

  it("follows storage when it works, so a sign-out in another tab still applies", () => {
    setToken("secret-token");
    window.localStorage.removeItem("hatchdoor_web_token");

    expect(getToken()).toBeNull();
  });
});

describe("unauthorized notifications", () => {
  afterEach(() => onUnauthorized(null));

  it.each(["hatchdoor", "proxy"])(
    "ignores a %s 401 after the token changes",
    async (source) => {
      const handler = vi.fn();
      onUnauthorized(handler);
      let answer: (response: Response) => void = () => {};
      vi.spyOn(globalThis, "fetch").mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );

      const request = apiFetch("/api/v1/vaults");
      setToken("secret-token");
      answer(
        new Response(null, {
          status: 401,
          headers:
            source === "hatchdoor"
              ? { "X-Hatchdoor-Auth": "required" }
              : undefined,
        }),
      );
      await request;

      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["hatchdoor", { "X-Hatchdoor-Auth": "required" }],
    [
      "proxy",
      { "WWW-Authenticate": 'Bearer realm="OAuth", error="invalid_token"' },
    ],
    ["proxy", {}],
  ] as const)(
    "reports a %s 401 for the current token",
    async (source, headers) => {
      const handler = vi.fn();
      onUnauthorized(handler);
      setToken("wrong-token");
      const response = new Response(null, { status: 401, headers });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      expect(await apiFetch("/api/v1/vaults")).toBe(response);
      expect(handler).toHaveBeenCalledExactlyOnceWith(source);
    },
  );

  it("reports a sign-in redirect without following it or replaying the request", async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    const redirect = new Response();
    Object.defineProperty(redirect, "type", { value: "opaqueredirect" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(redirect);

    expect(await apiFetch("/api/v1/vaults", { method: "POST" })).toBe(redirect);
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/vaults",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
    expect(handler).toHaveBeenCalledExactlyOnceWith("proxy");
  });

  it("leaves network errors and proxy outages to the caller", async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(null, { status: 502 }));

    await expect(apiFetch("/api/v1/vaults")).rejects.toThrow(TypeError);
    expect((await apiFetch("/api/v1/vaults")).status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("proxy sign-in reload guard", () => {
  it("allows one reload every 30 seconds per tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    expect(reserveProxyReload()).toBe(true);
    vi.setSystemTime(89_999);
    expect(reserveProxyReload()).toBe(false);
    vi.setSystemTime(90_000);
    expect(reserveProxyReload()).toBe(true);
  });

  it("declines to reload if the browser refuses to persist the guard", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    expect(reserveProxyReload()).toBe(false);
  });
});

describe("withAccessToken", () => {
  it("leaves the URL alone when no token is stored", () => {
    expect(withAccessToken("/assets/x.pdf#page=3")).toBe(
      "/assets/x.pdf#page=3",
    );
  });

  it.each([
    ["no query", "/assets/x.pdf", "/assets/x.pdf?access_token=t%2B1"],
    [
      "an existing query",
      "/assets/x.pdf?a=1",
      "/assets/x.pdf?a=1&access_token=t%2B1",
    ],
    [
      "a fragment",
      "/assets/x.pdf#page=3",
      "/assets/x.pdf?access_token=t%2B1#page=3",
    ],
    [
      "a query and a fragment",
      "/assets/x.pdf?a=1#page=3",
      "/assets/x.pdf?a=1&access_token=t%2B1#page=3",
    ],
    [
      "a ? only inside the fragment",
      "/assets/x.pdf#page=3?zoom=2",
      "/assets/x.pdf?access_token=t%2B1#page=3?zoom=2",
    ],
  ])("puts the token in the query for a URL with %s (#755)", (_, url, want) => {
    setToken("t+1");
    expect(withAccessToken(url)).toBe(want);
  });
});
