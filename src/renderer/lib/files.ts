/** Read a File as a base64 data URL (e.g. `data:image/png;base64,...`). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/** Split a data URL into its mime type and the raw base64 payload (without
 *  the `data:...;base64,` prefix). Returns null for non-base64 / malformed
 *  inputs. */
export function splitDataUrl(
  dataUrl: string,
): { mediaType: string; base64: string } | null {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  return { mediaType: m[1] ?? 'application/octet-stream', base64: m[2] ?? '' };
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
