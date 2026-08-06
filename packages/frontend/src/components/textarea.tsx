import type { Ref, TextareaHTMLAttributes } from "react";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly ref?: Ref<HTMLTextAreaElement> | undefined;
}

export function Textarea(props: TextareaProps): React.JSX.Element {
  return <textarea {...props} />;
}
