'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import { FileUp, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A file field that also takes a file dragged onto it (UX_ARCHITECTURE.md §4 "dropzone"; ADR-175).
 *
 * The real control is still the native `<input type="file">` (ADR-151.3): it keeps its id, so the
 * form's `<Label htmlFor>` names it, a keyboard reaches it, a screen reader announces it, and the form
 * posts it exactly as before. The drop area only puts a dropped file INTO that input. A file whose
 * type the `accept` list does not allow is refused here, with the reason under the area, before
 * anything is sent.
 */
export function FileDrop({
  id,
  name,
  accept,
  required,
  onFile,
}: {
  id: string;
  name: string;
  /** The same list the native input takes: extensions and/or MIME types, comma-separated. */
  accept: string;
  required?: boolean;
  onFile?: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (next: File | null) => {
    setFile(next);
    onFile?.(next);
  };

  const accepts = (f: File) => {
    const name = f.name.toLowerCase();
    return accept.split(',').map((a) => a.trim().toLowerCase()).some((a) =>
      a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    const dropped = event.dataTransfer.files[0];
    if (!dropped || !input.current) return;
    if (!accepts(dropped)) {
      setError(`${dropped.name} is not a kind of file APX can take here.`);
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(dropped);
    input.current.files = transfer.files;
    setError(null);
    choose(dropped);
  };

  const clear = () => {
    if (input.current) input.current.value = '';
    setError(null);
    choose(null);
  };

  return (
    <div className="space-y-1.5">
      {/* Not a <label>: the field's own label names the input, and a second one would join its name. */}
      <div
        onClick={(e) => { if (e.target !== input.current) input.current?.click(); }}
        onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors duration-100',
          'focus-within:ring-2 focus-within:ring-accent/40',
          over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface hover:border-ink-faint',
          error ? 'border-danger' : '',
        )}
      >
        <FileUp aria-hidden className={cn('size-7', over ? 'text-accent' : 'text-ink-muted')} />
        {file ? (
          <span className="text-sm font-medium text-ink break-all">{file.name}
            <span className="ml-2 font-normal text-ink-muted">{formatSize(file.size)}</span>
          </span>
        ) : (
          <span className="text-sm text-ink">
            {over ? 'Drop the file here' : <><span className="font-medium text-accent">Choose a file</span> or drag it here</>}
          </span>
        )}
        <input
          ref={input}
          id={id}
          type="file"
          name={name}
          accept={accept}
          required={required}
          aria-describedby={error ? errorId : undefined}
          className="sr-only"
          onChange={(e) => { setError(null); choose(e.target.files?.[0] ?? null); }}
        />
      </div>
      {file ? (
        <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline">
          <X aria-hidden className="size-3.5" /> Remove this file
        </button>
      ) : null}
      {error ? <p id={errorId} role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
