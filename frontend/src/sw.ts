/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { enable as enableNavigationPreload } from "workbox-navigation-preload";
import {
  cleanupOutdatedCaches,
  PrecacheFallbackPlugin,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0];
};

void self.skipWaiting();
clientsClaim();
enableNavigationPreload();

// Register before the precache route, which can also match / and /index.html.
// Let proxies see document requests and return their sign-in redirects. Only
// a failed or stalled fetch falls back to the installed shell.
registerRoute(
  new NavigationRoute(
    new NetworkOnly({
      networkTimeoutSeconds: 10,
      plugins: [new PrecacheFallbackPlugin({ fallbackURL: "/index.html" })],
    }),
    {
      // Keep server routes (including downloads opened by iOS standalone PWAs)
      // and proxy callbacks out of the offline shell. Tested in spa.rs.
      denylist: [
        /^\/api\//,
        /^\/vault-assets\//,
        /^\/health/,
        /^\/docs\//,
        /^\/llms\.txt/,
        /^\/cdn-cgi\//,
      ],
    },
  ),
);
// Reserved navigations can still use the preloaded network response.
registerRoute(new NavigationRoute(new NetworkOnly()));

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Lazy renderer chunks have content-hashed URLs. Cache them on first use so
// a diagram rendered once can still render offline.
registerRoute(
  ({ sameOrigin, url }) =>
    sameOrigin &&
    url.pathname.startsWith("/assets/") &&
    /\.m?js$/.test(url.pathname),
  new CacheFirst({
    cacheName: "hatchdoor-lazy-chunks",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 300,
        maxAgeSeconds: 60 * 60 * 24 * 30,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);
