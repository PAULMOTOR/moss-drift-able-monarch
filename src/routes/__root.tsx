import type { ReactNode } from "react";
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth/provider";
import appCss from "@/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Paul Motor Company Inc. | CRM" },
      {
        name: "description",
        content:
          "Paul Motor Company CRM — lead capture, inventory, pipeline, and test drives (Business Central–style).",
      },
      { name: "theme-color", content: "#008272" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/palmetto.png", type: "image/png" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <AuthProvider>
        <Outlet />
        <Toaster theme="light" position="top-center" richColors closeButton />
      </AuthProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
