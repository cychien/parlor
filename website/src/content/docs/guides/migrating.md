---
title: Migrating an existing app
description: Port an app to Parlor step by step, with its data, users, logic, pages, webhooks and jobs, and what Parlor does not support yet.
---

This guide moves an existing app (a REST or GraphQL backend with a web frontend) onto Parlor. It is written for the person doing the port and for the coding agent they hand it to. **Agents: follow the steps in order. If the app needs anything under [Not supported yet](#not-supported-yet), stop and ask the person before writing a workaround.**

Every example comes from a real port: a course back office whose old system had bcrypt passwords, an admin role and a payment webhook.

## 1. Take stock

Write down what the old app does before changing anything, and map each item:

| In the old app                                     | In Parlor                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| REST or GraphQL endpoints, controllers, services   | actions in `actions/`, one per thing a user or agent can do ([step 5](#5-move-the-logic-into-actions)) |
| Database tables                                    | Drizzle tables in `schema/`, each with a `scope` column ([step 4](#4-describe-the-tables))             |
| Users, passwords, sessions                         | `--add auth` (Better Auth, email and password) ([step 6](#6-bring-the-users))                          |
| Roles, admin flags, permissions                    | a table and a check at the top of each action ([step 5](#roles))                                       |
| Pages and client routing                           | files in `src/routes/` ([step 8](#8-rebuild-the-pages))                                                |
| `fetch`, axios or React Query calls to the backend | `useActionQuery` and `useActionMutation`                                                               |
| WebSockets or polling to keep pages fresh          | nothing to port: `reads` and `writes` refresh pages                                                    |
| Webhooks and callbacks from other services         | a server plugin route ([step 9](#9-webhooks-and-scheduled-work))                                       |
| Cron jobs                                          | a server plugin timer ([step 9](#9-webhooks-and-scheduled-work))                                       |
| API keys and secrets                               | environment variables, read on the server only ([step 10](#10-configuration-and-secrets))              |

## Not supported yet

Parlor cannot do these yet. If the old app depends on one, decide with the person before porting it, and do not build a substitute inside the app:

- **Storing uploaded files on the server**, such as images or attachments. The `files` capability lets a page pick and save files on the device; there is no server storage.
- **Server-side rendering for public pages that need SEO.** A Parlor app is a single-page app.
- **Serverless hosting.** Deploy one `node-server` or `bun` server; see [Deploy](/parlor/guides/deploy/).
- **Background work spread over several server instances.** A plugin's timer runs in every process.
- **Sign-in other than email and password.** Better Auth has other methods, set in `auth.ts`, but Parlor has not verified them.

## 2. Create the project

```sh
pnpm create parlor my-app --add auth
cd my-app
pnpm add -D tsx
```

Leave the old app running, so you can compare behavior. `tsx` runs the one-off import scripts in [step 7](#7-import-the-data).

## 3. Decide the scope

Every table has a `scope` column, and every action reads and writes only rows of the caller's scope. Pick what a scope is before writing tables:

- **One per user** (the default after `--add auth`): each user sees only their own rows, as in a notes app.
- **One shared organization**: every signed-in user works on the same data, as in a school's back office. Roles decide who may change what.
- **One per organization**: users belong to an organization, and the scope is that organization's id.

For one shared organization, resolve every request to the same scope in `server.ts`:

```ts
// @filename: actions/index.ts
import { createRegistry } from "@parlor/core/registry";
export const registry = createRegistry({});
// @filename: server.ts
// ---cut---
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

import { registry } from "./actions/index.js";

const database = await createDatabase({ migrationsFolder: "migrations" });

/** One school: every signed-in user works in the same data. */
const SCHOOL = "school";

export default createServer({
  actions: registry,
  database,
  scope: () => SCHOOL,
});
```

For one scope per organization, `scope` receives the request and the caller and may be async: look up the caller's organization with `userOf(principal)` from `@parlor/core`, and return its id. Each user's agent sidebar, chats and computers stay private to that user whatever the scope is.

## 4. Describe the tables

Port each table to Drizzle in `schema/`, add `scope`, and export it from `schema/index.ts`. Keep the old column names with `text("old_name")` if other systems read the database. Use text ids; imported rows keep their old id with a prefix.

```ts
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const courses = pgTable(
  "courses",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("courses_scope_idx").on(table.scope)],
);

export const staff = pgTable(
  "staff",
  {
    scope: text("scope").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "teacher"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.userId] })],
);
```

Then run `pnpm db:generate` and commit the migration it writes.

## 5. Move the logic into actions

Turn each endpoint, or each thing a user does, into an action. The UI, external agents over MCP, the sidebar's agent and plain HTTP will all call it.

- Filter every query by `ctx.scope`.
- Declare `reads` and `writes` with the tables, so open pages refresh after a change, whoever made it.
- Validate input with zod; a bad request then answers `invalid_input`.
- Throw `ActionError` for the other failures the old API returned: `not_found` for 404, `forbidden` for 403, `unauthenticated` for 401.
- Write `description` for an agent that has never seen the app: what the action does, and where its ids come from.
- Mark destructive actions `confirm: true`, so an agent's call waits for the person to approve it.

### Roles

Keep roles in a table, and check them at the top of the actions that need them:

```ts
// @filename: schema/index.ts
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";
export const staff = pgTable(
  "staff",
  {
    scope: text("scope").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "teacher"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.userId] })],
);
export const courses = pgTable("courses", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
});
// @filename: actions/access.ts
import "@parlor/data";
// ---cut---
import { ActionError, type ActionContext, userOf } from "@parlor/core";
import { and, eq } from "drizzle-orm";

import { staff } from "../schema/index.js";

/** Throws `forbidden` unless the caller is staff in this scope with one of `roles`. */
export async function requireStaff(
  ctx: ActionContext,
  roles: readonly ("admin" | "teacher")[] = ["admin", "teacher"],
) {
  const userId = userOf(ctx.principal);
  const [member] = userId
    ? await ctx.db
        .select()
        .from(staff)
        .where(and(eq(staff.scope, ctx.scope), eq(staff.userId, userId)))
    : [];
  if (!member || !roles.includes(member.role)) {
    throw new ActionError("forbidden", "Only staff can do that.");
  }
  return member;
}
```

```ts
// @filename: schema/index.ts
import { pgTable, text } from "drizzle-orm/pg-core";
export const courses = pgTable("courses", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
});
// @filename: actions/access.ts
import type { ActionContext } from "@parlor/core";
export declare function requireStaff(ctx: ActionContext): Promise<unknown>;
// @filename: actions/courses.ts
import "@parlor/data";
// ---cut---
import { ActionError, defineAction } from "@parlor/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { courses } from "../schema/index.js";
import { requireStaff } from "./access.js";

export const updateCourse = defineAction({
  description: "Change a course's title or description (its marketing copy). Staff only.",
  input: z.object({
    id: z.string().describe("The course id, from listCourses"),
    title: z.string().trim().min(1).optional(),
    description: z
      .string()
      .optional()
      .describe("The course description shown to students"),
  }),
  writes: [courses],
  run: async ({ id, ...change }, ctx) => {
    await requireStaff(ctx);
    const [course] = await ctx.db
      .update(courses)
      .set(change)
      .where(and(eq(courses.id, id), eq(courses.scope, ctx.scope)))
      .returning();
    if (!course) throw new ActionError("not_found", `No course ${id}`);
    return course;
  },
});
```

Register each action in `actions/index.ts`.

## 6. Bring the users

Imported users go into Better Auth's `user` table, and their passwords into its `account` table: `providerId` is `"credential"`, `accountId` is the user's id, and `password` is the old hash, unchanged ([step 7](#7-import-the-data) does this).

New passwords use Better Auth's own hash. Teach `auth.ts` to also check the old format, here bcrypt (`pnpm add bcryptjs`):

```typescript
import { betterAuthProvider, parlorAuth } from "@parlor/auth";
import type { DatabaseHandle } from "@parlor/data";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword, verifyPassword } from "better-auth/crypto";

import * as schema from "./schema/index.js";

export function createAuth(database: DatabaseHandle) {
  const options = parlorAuth({
    appName: process.env.PARLOR_APP_NAME ?? "Parlor App",
    signInPage: "/sign-in",
    emailAndPassword: {
      enabled: true,
      password: {
        hash: hashPassword,
        // Imported users keep their bcrypt hash until they change their password.
        verify: ({ hash, password }) =>
          hash.startsWith("$2")
            ? bcrypt.compare(password, hash)
            : verifyPassword({ hash, password }),
      },
    },
  });
  return betterAuthProvider({
    instance: betterAuth({
      ...options,
      database: drizzleAdapter(database.db, { provider: "pg", schema }),
    }),
  });
}
```

Use the same pattern for another hash format with its library. If the old hashes cannot be verified at all, import the users without a password and have them reset it. Old sessions do not carry over, so every user signs in once.

## 7. Import the data

Write the import as a script, never as an action: actions are open to agents and to HTTP. Read the old app's export, write it with Drizzle, and make it safe to run twice:

```ts
// @filename: schema/index.ts
export * from "@parlor/auth/schema";
import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
export const courses = pgTable("courses", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  priceCents: integer("price_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const staff = pgTable(
  "staff",
  {
    scope: text("scope").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "teacher"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.userId] })],
);
// @filename: scripts/import-legacy.ts
// ---cut---
// pnpm exec tsx scripts/import-legacy.ts legacy/export.json
import { readFileSync } from "node:fs";

import { createDatabase } from "@parlor/data";

import { account, courses, staff, user } from "../schema/index.js";

interface LegacyExport {
  readonly users: readonly {
    id: number;
    name: string;
    email: string;
    password_hash: string;
    role: "admin" | "teacher" | null;
    created_at: string;
  }[];
  readonly courses: readonly {
    id: number;
    title: string;
    body: string;
    price: number;
    created_at: string;
  }[];
}

/** The scope server.ts resolves every request to. */
const SCOPE = "school";

const legacy = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as LegacyExport;
const database = await createDatabase({ migrationsFolder: "migrations" });

await database.transaction(async (tx) => {
  for (const old of legacy.users) {
    const id = `legacy-user-${old.id}`;
    const createdAt = new Date(old.created_at);
    await tx
      .insert(user)
      .values({
        id,
        name: old.name,
        email: old.email.toLowerCase(),
        emailVerified: true,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing();
    await tx
      .insert(account)
      .values({
        id: `legacy-account-${old.id}`,
        userId: id,
        accountId: id,
        providerId: "credential",
        password: old.password_hash,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing();
    if (old.role) {
      await tx
        .insert(staff)
        .values({ scope: SCOPE, userId: id, role: old.role })
        .onConflictDoNothing();
    }
  }
  for (const old of legacy.courses) {
    await tx
      .insert(courses)
      .values({
        id: `course-${old.id}`,
        scope: SCOPE,
        title: old.title,
        description: old.body,
        priceCents: old.price,
        createdAt: new Date(old.created_at),
      })
      .onConflictDoNothing();
  }
});

console.log(
  `Imported ${legacy.users.length} users and ${legacy.courses.length} courses.`,
);
await database.close();
```

`createDatabase` opens the same database the server uses: the local PGlite files in development, `DATABASE_URL` in production. PGlite allows one process at a time, so stop `pnpm dev` before running the script locally. For production, run it once with `DATABASE_URL` set to the production database.

## 8. Rebuild the pages

- One file per page in `src/routes/`, for example `src/routes/courses.$courseId.tsx` for `/courses/:courseId`.
- Read with `useActionQuery("listCourses", {})`, and change data with `useActionMutation("updateCourse")`. Never call `fetch` for app data.
- Give each page a `staticData.description`, so agents know what it is for.
- Expose what the page shows as agent views: a `keyed` view per row (keyed by the id your actions take) and a `writable` view per form. Agents can then resolve "this course" and fill a form for the user to submit. The template's todo page shows both; see [The agent sidebar](/parlor/guides/agent-sidebar/).

## 9. Webhooks and scheduled work

Anything that is not a person or an agent calling the app, such as a payment provider's webhook or a nightly job, goes in a server plugin, installed in `server.ts` with `plugins: [...]`.

A plugin route is served at `/_parlor/<plugin name><path>`. A `public` route has no session, so check the caller yourself, for example by verifying a signature. After writing, announce the tables you changed, so open pages refresh:

```ts
// @filename: schema/index.ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
export const enrollments = pgTable("enrollments", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  courseId: text("course_id").notNull(),
  email: text("email").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
});
// @filename: plugins/payments.ts
// ---cut---
import { createHmac, timingSafeEqual } from "node:crypto";

import type { DatabaseHandle } from "@parlor/data";
import type { ServerPlugin } from "@parlor/server";

import { enrollments } from "../schema/index.js";

const signed = (body: string, signature: string, secret: string) => {
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** The payment provider's webhook, at POST /_parlor/payments/webhook. */
export function payments(options: {
  readonly database: DatabaseHandle;
  readonly scope: string;
  readonly secret: string | undefined;
}): ServerPlugin {
  const { database, scope, secret } = options;
  return {
    name: "payments",
    setup: (host) => ({
      routes: [
        {
          method: "POST",
          path: "/webhook",
          access: "public",
          async handle(request) {
            const body = await request.text();
            const signature = request.headers.get("x-signature") ?? "";
            if (!secret || !signed(body, signature, secret)) {
              return new Response("Bad signature", { status: 401 });
            }
            const paid = JSON.parse(body) as {
              courseId: string;
              email: string;
              paidAt: string;
            };
            await database.transaction(async (tx) => {
              await tx.insert(enrollments).values({
                id: crypto.randomUUID(),
                scope,
                courseId: paid.courseId,
                email: paid.email,
                paidAt: new Date(paid.paidAt),
              });
              await host.announce(scope, [["enrollments"]], tx);
            });
            return Response.json({ received: true });
          },
        },
      ],
    }),
  };
}
```

A scheduled job is a timer in a plugin's `setup`. Wait for `host.ready()` (the tables exist then), and stop the timer in `close`:

```ts
// @filename: schema/index.ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
export const todos = pgTable("todos", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
// @filename: plugins/cleanup.ts
// ---cut---
import type { DatabaseHandle } from "@parlor/data";
import type { ServerPlugin } from "@parlor/server";
import { lt } from "drizzle-orm";

import { todos } from "../schema/index.js";

/** Every hour, drop todos older than 90 days. */
export function cleanup({
  database,
}: {
  readonly database: DatabaseHandle;
}): ServerPlugin {
  return {
    name: "cleanup",
    setup(host) {
      const run = async () => {
        await host.ready?.();
        const cutoff = new Date(Date.now() - 90 * 24 * 3_600_000);
        await database.db.delete(todos).where(lt(todos.createdAt, cutoff));
      };
      const timer = setInterval(() => void run().catch(console.error), 3_600_000);
      timer.unref();
      return { close: () => clearInterval(timer) };
    },
  };
}
```

The timer runs in every server process, which is right for the one instance Parlor supports.

## 10. Configuration and secrets

- Read secrets with `process.env` only in server code: actions, plugins, `auth.ts`, `server.ts`. Never read them in `src/`, which ships to the browser.
- `parlor dev` does not read `.env` files. Set variables in the shell that starts it, for example `PAYMENTS_SECRET=whsec_test pnpm dev`.
- In production, set them on the host, next to `DATABASE_URL`, `PARLOR_ORIGIN` and `BETTER_AUTH_SECRET` ([Deploy](/parlor/guides/deploy/)).

## 11. Check the port

- `pnpm typecheck` and `pnpm test` pass. Test each action as `actions/todos.spec.ts` does.
- An imported user signs in with their old password, and a wrong password is refused.
- Each role can do exactly what it could before. In the course example, a student is refused `updateCourse` and a teacher is refused `listEnrollments`.
- Every row of the inventory from [step 1](#1-take-stock) works in the app.
- An agent connected over MCP ([Agents](/parlor/guides/agents/)) can do one task in each area, such as "put this copy into the React course".
- `pnpm build` prints no warning.
