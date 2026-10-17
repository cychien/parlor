import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { createRootRoute, createRoute } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as zm from "zod/mini";

import { defineAgentView } from "../view.js";
import { buildUiManifest } from "./manifest.js";

const app = { id: "dev.parlor.test", name: "Test", scheme: "test" };

const task = defineAgentView({
  name: "task",
  description: "A task row.",
  keyed: true,
  schema: z.object({ title: z.string(), done: z.boolean() }),
});
const banner = defineAgentView({
  name: "banner",
  description: "The banner shown on every page.",
  schema: z.object({ message: z.string() }),
});

function tree() {
  const root = createRootRoute({ staticData: { views: [banner] } });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    staticData: { description: "Home with the task list.", views: [task] },
  });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/tasks/$taskId",
    staticData: { description: "One task.", views: [task] },
  });
  const search = createRoute({
    getParentRoute: () => root,
    path: "/search",
    validateSearch: z.object({ q: z.string().optional() }),
  });
  return root.addChildren([home, detail, search]);
}

describe("buildUiManifest", () => {
  it("lists every page with its params, search, description and views, and every view once", () => {
    const { manifest, warnings } = buildUiManifest(app, tree());
    expect(manifest).toEqual({
      protocol: 1,
      app,
      routes: [
        {
          path: "/",
          description: "Home with the task list.",
          params: [],
          views: ["banner", "task"],
        },
        {
          path: "/tasks/$taskId",
          description: "One task.",
          params: ["taskId"],
          views: ["banner", "task"],
        },
        {
          path: "/search",
          params: [],
          search: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { q: { type: "string" } },
          },
          views: ["banner"],
        },
      ],
      views: [
        {
          name: "banner",
          description: "The banner shown on every page.",
          keyed: false,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        },
        {
          name: "task",
          description: "A task row.",
          keyed: true,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { title: { type: "string" }, done: { type: "boolean" } },
            required: ["title", "done"],
            additionalProperties: false,
          },
        },
      ],
    });
    expect(warnings).toEqual(['Route "/search" has no staticData.description.']);
  });

  it("fails when two different views share a name", () => {
    const impostor = defineAgentView({
      name: "task",
      description: "Another task.",
      schema: z.object({}),
    });
    const root = createRootRoute({ staticData: { views: [task] } });
    const page = createRoute({
      getParentRoute: () => root,
      path: "/other",
      staticData: { description: "Other.", views: [impostor] },
    });
    expect(() => buildUiManifest(app, root.addChildren([page]))).toThrow(
      'Two different agent views are named "task".',
    );
  });

  it("returns an empty catalog without a route tree", () => {
    expect(buildUiManifest(app, undefined).manifest).toEqual({
      protocol: 1,
      app,
      routes: [],
      views: [],
    });
  });

  it("describes zod/mini schemas exactly like full zod ones", () => {
    const miniTask = defineAgentView({
      name: "task",
      description: "A task row.",
      keyed: true,
      schema: zm.object({ title: zm.string(), done: zm.boolean() }),
    });
    const root = createRootRoute();
    const page = createRoute({
      getParentRoute: () => root,
      path: "/search",
      staticData: { description: "Search.", views: [miniTask] },
      validateSearch: zm.object({ q: zm.optional(zm.string()) }),
    });
    const mini = buildUiManifest(app, root.addChildren([page]));
    const full = buildUiManifest(app, tree()).manifest;
    expect(mini.warnings).toEqual([]);
    expect(mini.manifest.views).toEqual(full.views.filter((v) => v.name === "task"));
    expect(mini.manifest.routes[0]?.search).toEqual(
      full.routes.find((r) => r.path === "/search")?.search,
    );
  });

  it("describes a Standard Schema through its own JSON Schema converter", () => {
    const jsonSchema = { type: "object", properties: { text: { type: "string" } } };
    const schema: StandardSchemaV1<unknown, { text: string }> &
      StandardJSONSchemaV1<unknown, { text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: value as { text: string } }),
        jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
      },
    };
    const note = defineAgentView({ name: "note", description: "A note.", schema });
    const root = createRootRoute({ staticData: { views: [note] } });
    const { manifest, warnings } = buildUiManifest(app, root);
    expect(manifest.views).toEqual([
      { name: "note", description: "A note.", keyed: false, schema: jsonSchema },
    ]);
    expect(warnings).toEqual([]);
  });

  it("lists a view without a schema and warns when its schema cannot be described", () => {
    const schema: StandardSchemaV1<unknown, { text: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: value as { text: string } }),
      },
    };
    const note = defineAgentView({ name: "note", description: "A note.", schema });
    const root = createRootRoute({ staticData: { views: [note] } });
    const { manifest, warnings } = buildUiManifest(app, root);
    expect(manifest.views).toEqual([
      { name: "note", description: "A note.", keyed: false },
    ]);
    expect(warnings).toEqual([
      'View "note" has a schema that cannot be converted to JSON Schema, so the manifest lists it without one.',
    ]);
  });
});
