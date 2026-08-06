import type { InputHTMLAttributes, Ref } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

export function Input(props: InputProps): React.JSX.Element {
  return <input {...props} />;
}
