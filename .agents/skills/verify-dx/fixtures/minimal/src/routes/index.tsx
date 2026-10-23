import { useActionQuery } from "@parlor/client/react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  staticData: { description: "Pings the server." },
  component: Home,
});

function Home() {
  const ping = useActionQuery("ping", {});
  return (
    <h1 className="text-[#0a0b0c]" data-testid="pong">
      {ping.data?.pong ? "pong" : "..."}
    </h1>
  );
}
