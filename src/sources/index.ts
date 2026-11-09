export { resolveSource, classifyInput, fileId, type Classified } from "./resolve.js";
export { SourceError, type SourceErrorCode } from "./errors.js";
export { newestInboxFile, MEDIA_EXTENSIONS } from "./inbox.js";
export { cookieArgs } from "./cookies.js";
export { fetchWithCobalt, cobaltMayRetry, cobaltConfigured, cobaltOrigin } from "./cobalt.js";
export { mapYtDlpFailure, pickCaptionLanguages, platformName, maxDownloadMb, DEFAULT_MAX_DOWNLOAD_MB } from "./ytdlp.js";
export type { CaptionTrack, ResolveOptions, SourceKind, SourceRecord } from "./types.js";
