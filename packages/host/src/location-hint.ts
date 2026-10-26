/**
 * The Cloudflare location hint for a Postgres connection string, read off the cloud region
 * its host names (Neon `ep-x.ap-southeast-1.aws.neon.tech`, Supabase, RDS, GCP, Azure), so
 * the Durable Object starts beside the database. Undefined for a host that names no region.
 *
 * Self-contained: the Worker entry embeds its source.
 */
export function locationHintForDatabase(url: string | undefined): string | undefined {
  let host: string;
  try {
    host = new URL(url ?? "").hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const aws = /(?:^|[.-])(us|ca|sa|eu|me|af|ap)-([a-z]+)-(\d)(?:[.-]|$)/.exec(host);
  if (aws) {
    const [, area, direction, number] = aws;
    if (area === "us") return direction === "west" ? "wnam" : "enam";
    if (area === "ca") return "enam";
    if (area === "sa") return "sam";
    if (area === "eu") return "weur";
    if (area === "me") return "me";
    if (area === "af") return "afr";
    return direction === "southeast" && (number === "2" || number === "4")
      ? "oc"
      : "apac";
  }
  const gcp =
    /(?:^|[.-])(us|northamerica|southamerica|europe|asia|australia|me|africa)-([a-z]+)\d(?:[.-]|$)/.exec(
      host,
    );
  if (gcp) {
    const [, area, direction] = gcp;
    if (area === "us") return direction === "west" ? "wnam" : "enam";
    if (area === "northamerica") return "enam";
    if (area === "southamerica") return "sam";
    if (area === "europe") return "weur";
    if (area === "asia") return "apac";
    if (area === "australia") return "oc";
    if (area === "me") return "me";
    return "afr";
  }
  const azure =
    /(?:^|\.)(eastus2?|centralus|westus[23]?|westeurope|northeurope|germanywestcentral|uksouth|eastasia|southeastasia|japaneast|australiaeast)\./.exec(
      host,
    );
  if (!azure) return undefined;
  const region = azure[1]!;
  if (region.startsWith("west") && region.includes("us")) return "wnam";
  if (region.includes("us")) return "enam";
  if (region.includes("asia") || region === "japaneast") return "apac";
  if (region === "australiaeast") return "oc";
  return "weur";
}
