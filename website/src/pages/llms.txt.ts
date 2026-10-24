import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

import { type DocPage, llmsIndex } from "../llms.ts";

export const SUMMARY =
  "Parlor is a TypeScript framework for apps that agents can operate: every action is a UI hook, an HTTP endpoint and an MCP tool, and one React app ships to web, desktop and mobile.";

export async function docPages(): Promise<DocPage[]> {
  return (await getCollection("docs")).map((entry) => ({
    slug: entry.id === "index" ? "index" : entry.id,
    title: entry.data.title,
    description: entry.data.description,
    body: entry.body ?? "",
  }));
}

const docsRoot = (site: URL | undefined) =>
  new URL(
    import.meta.env.BASE_URL.replace(/\/?$/, "/"),
    site ?? "https://cychien.github.io",
  );

export const GET: APIRoute = async ({ site }) =>
  new Response(llmsIndex(await docPages(), docsRoot(site), SUMMARY), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
