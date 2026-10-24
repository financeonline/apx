import type { ComponentProps, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { Input as ShadcnInput, Label, NativeSelect, Textarea as ShadcnTextarea } from './shadcn';

/** Form fields on shadcn/ui (SOW §6; ADR-151): a Label, the control, and a hint. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}

export function Input(props: ComponentProps<'input'>) {
  return <ShadcnInput {...props} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <NativeSelect {...props}>{children}</NativeSelect>;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <ShadcnTextarea {...props} />;
}

export function Fieldset({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`space-y-4 ${className}`.trim()}>{children}</div>;
}
