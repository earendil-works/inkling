import type { HTMLAttributes, ReactNode } from "react";

import type { DocumentMetadataDto } from "@earendil-works/inkling-protocol";

import styles from "./chip.module.css";

export interface ChipProps extends Omit<HTMLAttributes<HTMLElement>, "className"> {
  readonly children: ReactNode;
  /** Makes the chip a link, such as to a search for its value. */
  readonly href?: string | undefined;
}

/** A small status or label chip. Elanor has no badge component. */
export function Chip({ href, ...props }: ChipProps): React.JSX.Element {
  return href === undefined ? (
    <span {...props} className={styles["chip"]} />
  ) : (
    <a {...props} className={styles["chip"]} href={href} />
  );
}

export function LifecycleStateChip({
  href,
  state,
}: {
  readonly href?: string | undefined;
  readonly state: string;
}): React.JSX.Element {
  return (
    <Chip data-lifecycle-state={state.trim().toLocaleLowerCase("en")} href={href}>
      {state}
    </Chip>
  );
}

export function VisibilityChip({
  href,
  visibility,
}: {
  readonly href?: string | undefined;
  readonly visibility: string;
}): React.JSX.Element {
  return (
    <Chip data-document-visibility={visibility} href={href}>
      {visibility}
    </Chip>
  );
}

/**
 * Who can see a document: a personal or shared chip for personal documents,
 * whose visibility only applies once they move to the workspace, and the
 * visibility chip otherwise.
 */
export function AudienceChip({
  linked = false,
  metadata,
}: {
  /** Links the chip to a search for documents like this one. */
  readonly linked?: boolean | undefined;
  readonly metadata: Pick<
    DocumentMetadataDto,
    "personalOwner" | "sharedWith" | "sharing" | "visibility"
  >;
}): React.JSX.Element {
  const sharedPeople = metadata.sharedWith?.length ?? 0;
  if (
    metadata.personalOwner !== undefined &&
    (sharedPeople > 0 || metadata.sharing.access !== "disabled")
  ) {
    return (
      <Chip
        data-personal-document=""
        data-shared-document=""
        title={
          sharedPeople === 0
            ? "A personal document shared through links."
            : `A personal document shared with ${sharedPeople} ${sharedPeople === 1 ? "person" : "people"}.`
        }
      >
        shared
      </Chip>
    );
  }
  if (metadata.personalOwner !== undefined) {
    return (
      <Chip
        data-personal-document=""
        href={linked ? `/?q=${encodeURIComponent("is:personal")}` : undefined}
        title="Only you can see this document."
      >
        personal
      </Chip>
    );
  }
  return (
    <VisibilityChip
      href={linked ? `/?q=${encodeURIComponent(`visibility:${metadata.visibility}`)}` : undefined}
      visibility={metadata.visibility}
    />
  );
}
