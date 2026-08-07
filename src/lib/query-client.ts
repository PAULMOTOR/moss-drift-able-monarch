import { QueryClient } from "@tanstack/react-query";

/** Shared defaults: short stale window so nav feels instant without hammering Neon. */
export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 45_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

export type LeadsQueryKey = [
  "leads",
  {
    stage?: string;
    q?: string;
    assigned?: string;
    lead_type?: string;
    limit?: number;
    offset?: number;
  },
];

export function leadsQueryKey(filters: LeadsQueryKey[1]): LeadsQueryKey {
  return ["leads", filters];
}
