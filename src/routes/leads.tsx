import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AuthGate } from "@/components/app-shell";

export const Route = createFileRoute("/leads")({
  component: () => (
    <AuthGate>
      <Outlet />
    </AuthGate>
  ),
});
