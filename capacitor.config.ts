// capacitor.config.ts
//
// SUPERSEDED / NOT IN USE.
//
// The project is deployed as a web application on Vercel and does not require
// a native iPad wrapper, App Store package, or Xcode build. This file remains
// only as historical configuration and is not part of the Vercel deployment.

import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.charukrishna.googleopusbridge",
  appName: "Google Nexus",
  webDir: "dist",
  server: {
    url: "https://google-opus-bridge-a1e80030.vercel.app",
    cleartext: false,
  },
};

export default config;
