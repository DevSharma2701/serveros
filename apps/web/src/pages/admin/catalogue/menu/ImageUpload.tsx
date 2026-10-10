import { ImageIcon, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { InlineError } from '../common';
import { api, assetUrl, errorMessage } from '@/lib/api';

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

/** Uploads a product photo and reports the stored path (the API checks the real file type again). */
export function ImageUpload({ value, onChange, disabled }: { value: string | null; onChange: (url: string | null) => void; disabled?: boolean }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!ACCEPTED.includes(file.type)) return setError('Choose a PNG, JPEG or WebP image.');
    if (file.size > MAX_BYTES) return setError('The image must be 2 MB or smaller.');
    const body = new FormData();
    body.append('file', file);
    setBusy(true);
    try {
      const saved = await api<{ url: string }>('/uploads/product-image', { method: 'POST', body });
      onChange(saved.url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        Photo
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line bg-sunken text-ink-faint">
          {value ? <img src={assetUrl(value)} alt="Current product photo" className="h-full w-full object-cover" /> : <ImageIcon className="h-7 w-7" aria-hidden />}
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={inputRef} id={inputId} type="file" accept={ACCEPTED.join(',')} className="sr-only" disabled={disabled || busy} onChange={(e) => void upload(e.target.files?.[0])} />
          <Button size="sm" loading={busy} disabled={disabled} onClick={() => inputRef.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden />
            {value ? 'Replace photo' : 'Upload photo'}
          </Button>
          {value ? (
            <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => onChange(null)}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <InlineError message={error} /> : <p className="text-sm text-ink-faint">PNG, JPEG or WebP, up to 2 MB.</p>}
    </div>
  );
}
