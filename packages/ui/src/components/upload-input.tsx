"use client";

import {
  type UploadFileResponse,
} from "@xixixao/uploadstuff/react";
import { type InputHTMLAttributes, useRef, useState } from "react";

export function UploadInput({
  generateUploadUrl,
  onUploadComplete,
  ...props
}: {
  generateUploadUrl: () => Promise<{ url: string; token: string }>;
  onUploadComplete: (uploaded: UploadFileResponse[]) => void | Promise<unknown>;
} & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "accept" | "id" | "type" | "className" | "required" | "tabIndex"
>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
    <input
      ref={fileInputRef}
      type="file"
      disabled={pending}
      onChange={async (event) => {
        if (!event.target.files) {
          return;
        }
        const files = Array.from(event.target.files);
        if (files.length === 0) {
          return;
        }
        if (pending) return;
        setPending(true);
        setError('');
        try {
          const file = files[0]!;
          const ticket = await generateUploadUrl();
          const response = await fetch(ticket.url, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': file.type, Authorization: `Bearer ${ticket.token}` }, body: file });
          if (!response.ok) throw new Error('Upload rejected');
          const result = await response.json();
          if (typeof result.storageId !== 'string') throw new Error('Invalid upload');
          await onUploadComplete([{ name: file.name, type: file.type, size: file.size, response: result }]);
          if (fileInputRef.current) fileInputRef.current.value = '';
        } catch { setError('Upload failed. Choose a supported image and try again.'); }
        finally { setPending(false); }
      }}
      {...props}
    />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>
  );
}
