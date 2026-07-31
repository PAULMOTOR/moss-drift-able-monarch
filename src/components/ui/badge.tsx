import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/12 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        success: "border-transparent bg-success/12 text-success",
        warning: "border-transparent bg-amber-100 text-amber-900",
        muted: "border-transparent bg-muted text-muted-foreground",
        new: "border-transparent bg-sky-100 text-sky-800",
        contacted: "border-transparent bg-slate-100 text-slate-700",
        qualified: "border-transparent bg-teal-100 text-teal-800",
        proposal: "border-transparent bg-amber-100 text-amber-900",
        negotiation: "border-transparent bg-indigo-100 text-indigo-800",
        won: "border-transparent bg-emerald-100 text-emerald-800",
        lost: "border-transparent bg-zinc-100 text-zinc-600",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
