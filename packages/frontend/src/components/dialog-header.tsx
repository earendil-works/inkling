import type { ComponentPropsWithoutRef } from "react";

import { Button } from "./button.tsx";
import styles from "./dialog-header.module.css";

export interface DialogHeaderProps {
  readonly className?: string | undefined;
  readonly closeLabel: string;
  readonly disabled?: boolean | undefined;
  readonly eyebrow?: string | undefined;
  readonly onClose: () => void;
  readonly title: string;
  readonly titleDataAttributes?: Readonly<Record<`data-${string}`, string>> | undefined;
  readonly titleId: string;
  readonly titleProps?: Omit<ComponentPropsWithoutRef<"h2">, "children" | "id"> | undefined;
}

export function DialogHeader({
  className = styles["heading"],
  closeLabel,
  disabled = false,
  eyebrow,
  onClose,
  title,
  titleDataAttributes,
  titleId,
  titleProps,
}: DialogHeaderProps): React.JSX.Element {
  return (
    <div className={className} data-dialog-header="">
      <div>
        {eyebrow === undefined ? null : (
          <p className={styles["eyebrow"]} data-dialog-eyebrow="">
            {eyebrow}
          </p>
        )}
        <h2 {...titleDataAttributes} {...titleProps} id={titleId}>
          {title}
        </h2>
      </div>
      <Button aria-label={closeLabel} disabled={disabled} onClick={onClose} variant="icon">
        ×
      </Button>
    </div>
  );
}
