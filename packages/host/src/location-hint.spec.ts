import { describe, expect, it } from "vitest";

import { locationHintForDatabase } from "./location-hint.js";

const url = (host: string) => `postgresql://user:secret@${host}:5432/app?sslmode=require`;

describe("the location hint a database's host names", () => {
  it.each([
    ["ep-cool-sun-a1b2c3-pooler.ap-southeast-1.aws.neon.tech", "apac"],
    ["ep-cool-sun-a1b2c3.ap-northeast-1.aws.neon.tech", "apac"],
    ["ep-cool-sun-a1b2c3.ap-southeast-2.aws.neon.tech", "oc"],
    ["ep-cool-sun-a1b2c3.us-west-2.aws.neon.tech", "wnam"],
    ["ep-cool-sun-a1b2c3.us-east-2.aws.neon.tech", "enam"],
    ["ep-cool-sun-a1b2c3.eu-central-1.aws.neon.tech", "weur"],
    ["ep-cool-sun-a1b2c3.sa-east-1.aws.neon.tech", "sam"],
    ["ep-cool-sun-a1b2c3.eastus2.azure.neon.tech", "enam"],
    ["ep-cool-sun-a1b2c3.westus3.azure.neon.tech", "wnam"],
    ["ep-cool-sun-a1b2c3.germanywestcentral.azure.neon.tech", "weur"],
    ["aws-0-ap-southeast-1.pooler.supabase.com", "apac"],
    ["school.abc123.eu-west-1.rds.amazonaws.com", "weur"],
    ["school.asia-east1.gcp.example.com", "apac"],
  ])("%s → %s", (host, hint) => {
    expect(locationHintForDatabase(url(host))).toBe(hint);
  });

  it("names none for a host with no region, or no URL at all", () => {
    expect(locationHintForDatabase(url("db.internal"))).toBeUndefined();
    expect(locationHintForDatabase(url("10.0.0.5"))).toBeUndefined();
    expect(locationHintForDatabase(undefined)).toBeUndefined();
    expect(locationHintForDatabase("not a url")).toBeUndefined();
  });
});
