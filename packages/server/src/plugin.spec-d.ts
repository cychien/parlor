import type { HostPrincipal, Principal, UserPrincipal } from "@parlor/core";
import { expectTypeOf, test } from "vitest";

import type { KindsOf } from "./access.js";
import type { AuthProvider } from "./auth.js";
import {
  type AnyPluginRoute,
  type Migration,
  pluginRoute,
  type ServerPlugin,
} from "./plugin.js";

test("an auth provider installs like any plugin", () => {
  expectTypeOf<AuthProvider>().toExtend<ServerPlugin>();
});

test("migration ids name their plugin and an order", () => {
  expectTypeOf<{ id: "chat/0001_threads"; sql: string }>().toExtend<Migration>();
  expectTypeOf<{ id: "0001_threads"; sql: string }>().not.toExtend<Migration>();
});

test("agents never reach plugin actions", () => {
  expectTypeOf<"agent">().not.toExtend<KindsOf<"pluginActions">>();
  expectTypeOf<"host">().toExtend<KindsOf<"pluginActions">>();
});

test("a route's access list decides its handler's caller type", () => {
  const host = pluginRoute({
    method: "POST",
    path: "/stream",
    access: ["host"],
    handle(_request, caller) {
      expectTypeOf(caller.principal).toEqualTypeOf<HostPrincipal>();
      return Promise.resolve(new Response());
    },
  });
  pluginRoute({
    method: "GET",
    path: "/hosts",
    access: ["anonymous", "user"],
    handle(_request, caller) {
      expectTypeOf(caller.principal).toEqualTypeOf<
        Extract<Principal, { kind: "anonymous" }> | UserPrincipal
      >();
      return Promise.resolve(new Response());
    },
  });
  expectTypeOf(host).toExtend<AnyPluginRoute>();
});
