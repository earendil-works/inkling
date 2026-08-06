import { useEffect, useRef } from "react";
import type { ComponentPropsWithoutRef, ReactNode, RefObject } from "react";

export interface AnchoredPopoverProps extends Omit<
  ComponentPropsWithoutRef<"aside">,
  "children" | "popover"
> {
  readonly anchorRef: RefObject<HTMLElement | undefined>;
  readonly anchorRevision: number;
  readonly children: ReactNode;
  readonly open: boolean;
}

export function AnchoredPopover({
  anchorRef,
  anchorRevision,
  children,
  className,
  open,
  ...props
}: AnchoredPopoverProps): React.JSX.Element {
  const popoverRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    if (open && !popover.matches(":popover-open")) popover.showPopover();
    if (!open && popover.matches(":popover-open")) popover.hidePopover();
  }, [open]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null || !open) return;
    const position = (): void => {
      if (!popover.matches(":popover-open")) return;
      if (matchMedia("(width <= 52rem)").matches) {
        popover.style.removeProperty("--anchored-popover-left");
        popover.style.removeProperty("--anchored-popover-top");
        return;
      }
      const anchor = anchorRef.current;
      if (anchor === undefined || !anchor.isConnected) return;
      const anchorRect = anchor.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const gap = 12;
      const left = Math.max(
        gap,
        Math.min(
          innerWidth - popoverRect.width - gap,
          anchorRect.right + gap + popoverRect.width <= innerWidth
            ? anchorRect.right + gap
            : anchorRect.left - popoverRect.width - gap,
        ),
      );
      const top = Math.max(
        gap,
        Math.min(innerHeight - popoverRect.height - gap, anchorRect.top - 18),
      );
      popover.style.setProperty("--anchored-popover-left", `${left}px`);
      popover.style.setProperty("--anchored-popover-top", `${top}px`);
    };
    const frame = requestAnimationFrame(position);
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [anchorRef, anchorRevision, open]);

  return (
    <aside
      {...props}
      className={["anchored-popover", className].filter(Boolean).join(" ")}
      popover="manual"
      ref={popoverRef}
    >
      {children}
    </aside>
  );
}
