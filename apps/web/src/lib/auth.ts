import { passkeyClient } from "@better-auth/passkey/client";
import { SIGNUP_SURFACE_HEADER } from "@rakazo/contracts";
import { rememberSignupAttribution } from "@rakazo/core/signup-attribution";
import type { OrganizationClientOptions } from "better-auth/client/plugins";
import { emailOTPClient, multiSessionClient, organizationClient } from "better-auth/client/plugins";
import type { ReactAuthClient } from "better-auth/react";
import { createAuthClient } from "better-auth/react";
import { accountRequestHeaders } from "./account-identity";
import { desktopBridge } from "./desktop";

const signupSurface = desktopBridge() ? "desktop" : "web";
if (typeof window !== "undefined") rememberSignupAttribution(window);

export const authClient: ReactAuthClient<{
  // An uninstantiated generic resolves to `any`, which would erase every plugin's actions.
  plugins: [
    ReturnType<typeof organizationClient<OrganizationClientOptions>>,
    ReturnType<typeof emailOTPClient>,
    ReturnType<typeof passkeyClient>,
    ReturnType<typeof multiSessionClient>,
  ];
}> = createAuthClient({
  plugins: [organizationClient(), emailOTPClient(), passkeyClient(), multiSessionClient()],
  fetchOptions: {
    headers: { [SIGNUP_SURFACE_HEADER]: signupSurface },
    onRequest: (request: { url: string | URL; headers: Headers }) => {
      // Session refresh must be able to discover a cookie selected in another tab.
      if (!String(request.url).includes("/get-session"))
        request.headers = accountRequestHeaders(request.headers);
    },
  },
});
