import type { CapacitorConfig } from "@capacitor/cli";

// The iOS app bundles the built web app (dist/) and serves it from capacitor://localhost. Never set
// `server.url` to offbooked.com: a shell around a remote site is what App Review rejects under 4.2.
// The API stays https://api.offbooked.com (VITE_API_URL's production default). See docs/mobile.md.
// ios/ uses Swift Package Manager (ios/App/CapApp-SPM), so there is no CocoaPods or `pod install`.
const config: CapacitorConfig = {
  appId: "com.offbooked.app",
  appName: "Offbooked",
  webDir: "dist",
};

export default config;
