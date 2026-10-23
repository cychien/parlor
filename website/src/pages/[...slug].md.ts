import type { APIRoute, GetStaticPaths } from "astro";

import { stripTwoslash } from "../llms.ts";
import { docPages } from "./llms.txt.ts";

export const getStaticPaths: GetStaticPaths = async () =>
  (await docPages()).map((page) => ({ params: { slug: page.slug }, props: { page } }));

export const GET: APIRoute = ({ props }) => {
  const { page } = props as { page: { title: string; body: string } };
  return new Response(`# ${page.title}\n\n${stripTwoslash(page.body).trim()}\n`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
