import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide uppercase transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        success: "border-transparent bg-success/15 text-success",
        warning: "border-transparent bg-warning/15 text-warning",
        muted: "border-transparent bg-muted text-muted-foreground",
        new: "border-transparent bg-sky-500/15 text-sky-300",
        contacted: "border-transparent bg-slate-500/20 text-slate-300",
        qualified: "border-transparent bg-teal-500/15 text-teal-300",
        proposal: "border-transparent bg-amber-500/15 text-amber-300",
        negotiation: "border-transparent bg-rose-500/15 text-rose-300",
        won: "border-transparent bg-emerald-500/15 text-emerald-300",
        lost: "border-transparent bg-zinc-500/20 text-zinc-400",
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
