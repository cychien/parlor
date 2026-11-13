import { parlorAuth } from "@parlor/auth";

export const authOptions = parlorAuth({
  appName: "Hello",
  signInPage: "/sign-in",
  connectComputerPage: "/connect-computer",
  emailAndPassword: { enabled: true },
});
