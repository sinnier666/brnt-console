import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "LoginProbe by BRNT™ — credential & session checking console",
  description:
    "Check logins on sites you own or are authorized to test. Credential checks, cookie-session validation, logged-in replay previews, and one-click real-site opening via the BRNT Cookie Bridge extension.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0f14'/%3E%3Ccircle cx='16' cy='16' r='9' fill='%2310b981'/%3E%3Ccircle cx='13' cy='13' r='2' fill='%23064e3b'/%3E%3Ccircle cx='20' cy='15' r='2' fill='%23064e3b'/%3E%3Ccircle cx='15' cy='20' r='2' fill='%23064e3b'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
