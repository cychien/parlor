import { parlorAuth } from "@parlor/auth";

export const authOptions = parlorAuth({
  appName: "Hello",
  signInPage: "/sign-in",
  emailAndPassword: { enabled: true },
});
