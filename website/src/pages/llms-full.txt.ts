import type { APIRoute } from "astro";

import { llmsFull } from "../llms.ts";
import { docPages } from "./llms.txt.ts";

export const GET: APIRoute = async () =>
  new Response(llmsFull(await docPages()), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
