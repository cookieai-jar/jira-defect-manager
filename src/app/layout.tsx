import "./globals.css";
import type { Metadata } from "next";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "Customer Triage",
  description: "JIRA customer issue triage powered by Claude",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen flex">
        <Nav />
        <main className="flex-1 min-w-0 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
