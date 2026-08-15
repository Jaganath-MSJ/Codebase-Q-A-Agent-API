import { resolveInside } from './paths';

// Matches exactly what node:crypto's randomUUID() produces — the only shape
// a real uploadId ever has (see uploads/uploads.module.ts's diskStorage
// filename callback). `sourceRef` on a zip_upload project is otherwise
// client-supplied, unvalidated JSON body input — rejecting anything that
// isn't this exact shape, before it ever reaches a filesystem call, is what
// stops it from being used to probe or read an arbitrary file on the host as
// though it were an uploaded zip.
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUploadId(uploadId: string): boolean {
  return UPLOAD_ID_RE.test(uploadId);
}

/**
 * Throws if `uploadId` isn't that exact shape, or — belt and suspenders —
 * if the resulting path somehow still resolves outside `uploadsDir`.
 */
export function resolveUploadPath(uploadsDir: string, uploadId: string): string {
  if (!isValidUploadId(uploadId)) {
    throw new Error(`Not a valid uploadId: ${uploadId}`);
  }
  return resolveInside(uploadsDir, `${uploadId}.zip`);
}
