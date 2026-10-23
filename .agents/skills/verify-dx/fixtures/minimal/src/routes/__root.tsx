import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  staticData: { description: "The app shell." },
  component: Outlet,
});
