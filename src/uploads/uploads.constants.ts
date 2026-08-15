// "100 MB is generous" per the phase doc — generous enough for a small-to-
// medium repo zipped up, small enough that a stray huge upload fails fast
// with a clear multer error rather than filling the disk silently.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
