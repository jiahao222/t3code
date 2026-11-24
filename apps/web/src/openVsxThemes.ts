import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { parse, type ParseError } from "jsonc-parser";
import { msg } from "gt-react";

import { m } from "./i18n/messages";
import type { ThemeDefinition } from "./themePalette";
import {
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "./vscodeThemeImport";

const OPEN_VSX_SEARCH_URL = "https://open-vsx.org/api/-/search";
const MAX_VSIX_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SEARCH_REQUEST_TIMEOUT_MS = 10_000;
const MAX_THEME_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 8;
const MAX_PACKAGE_PATH_LENGTH = 1_024;
const MAX_COLOR_VALUE_LENGTH = 128;
const MAX_RESOLVED_THEME_FILES = MAX_THEMES_PER_EXTENSION * MAX_INCLUDE_DEPTH;
const SUPPORTED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unlicense",
]);
const USED_WORKBENCH_COLORS = new Set([
  "activityBar.background",
  "activityBarBadge.background",
  "badge.background",
  "button.background",
  "button.foreground",
  "contrastBorder",
  "descriptionForeground",
  "disabledForeground",
  "dropdown.background",
  "dropdown.border",
  "editor.background",
  "editor.foreground",
  "editor.findMatchBackground",
  "editor.findMatchForeground",
  "editor.findMatchHighlightBackground",
  "editor.findMatchHighlightForeground",
  "editor.selectionBackground",
  "editorCursor.foreground",
  "editorError.foreground",
  "editorGroup.border",
  "editorPane.background",
  "editorWarning.foreground",
  "editorWidget.background",
  "errorForeground",
  "focusBorder",
  "foreground",
  "input.border",
  "input.placeholderForeground",
  "list.activeSelectionBackground",
  "list.hoverBackground",
  "list.inactiveSelectionBackground",
  "menu.background",
  "panel.background",
  "panel.border",
  "progressBar.background",
  "quickInput.background",
  "scrollbarSlider.background",
  "sideBar.background",
  "sideBar.border",
  "sideBar.foreground",
  "terminal.background",
  "terminal.foreground",
  "terminal.selectionBackground",
  "terminalCursor.foreground",
  "textCodeBlock.background",
  "textLink.foreground",
]);

export type OpenVsxThemeSort = "downloadCount" | "rating" | "timestamp" | "relevance";

export type OpenVsxThemeExtension = {
  id: string;
  collectionId: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  iconUrl: string | null;
  sourceUrl: string | null;
  manifestUrl: string;
  sha256Url: string;
  vsixUrl: string;
  version: string;
  license: string;
};

export type OpenVsxThemeSearchOptions = {
  signal?: AbortSignal;
  sortBy?: OpenVsxThemeSort;
};

type ThemeContribution = { label?: unknown; uiTheme?: unknown; path?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortHash(value: string): string {
  return [...sha256(new TextEncoder().encode(value))]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function openVsxThemeId(extensionId: string, source: string): string {
  return `ovx-theme-${shortHash(`${extensionId}:${source}`)}`;
}

function openVsxCollectionId(extensionId: string): string {
  const normalized = `open-vsx:${extensionId.toLowerCase()}`;
  return /^[a-z0-9][a-z0-9.:-]{0,127}$/.test(normalized)
    ? normalized
    : `open-vsx:${shortHash(extensionId)}`;
}

function trustedOpenVsxUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "open-vsx.org"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function publicSourceUrl(value: unknown): string | null {
  const rawValue =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : null;
  if (!rawValue) return null;
  try {
    const url = new URL(rawValue);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function themeContributions(manifest: Record<string, unknown>): ThemeContribution[] {
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;
  return Array.isArray(contributes?.themes)
    ? (contributes.themes.filter(isRecord) as ThemeContribution[])
    : [];
}

function manifestLicenseMatches(manifest: Record<string, unknown>, license: string): boolean {
  return (
    typeof manifest.license === "string" &&
    manifest.license.trim().toLowerCase() === license.toLowerCase()
  );
}

function extensionFromDetail(value: unknown): OpenVsxThemeExtension | null {
  if (!isRecord(value) || !isRecord(value.files)) {
    throw new Error(m(msg("Open VSX returned malformed theme details.")));
  }
  const namespace = typeof value.namespace === "string" ? value.namespace.trim() : "";
  const extensionName = typeof value.name === "string" ? value.name.trim() : "";
  const displayName =
    (typeof value.displayName === "string" ? value.displayName.trim() : "") || extensionName;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const license = typeof value.license === "string" ? value.license.trim() : "";
  const manifestUrl = trustedOpenVsxUrl(value.files.manifest);
  const sha256Url = trustedOpenVsxUrl(value.files.sha256);
  const vsixUrl = trustedOpenVsxUrl(value.files.download);
  if (!namespace || !extensionName || !version || !manifestUrl || !sha256Url || !vsixUrl) {
    throw new Error(m(msg("Open VSX returned malformed theme details.")));
  }
  if (!SUPPORTED_LICENSES.has(license)) return null;
  const id = `${namespace}.${extensionName}`;
  return {
    id,
    collectionId: openVsxCollectionId(id),
    name: displayName,
    publisher: namespace,
    description: typeof value.description === "string" ? value.description : "",
    downloadCount:
      typeof value.downloadCount === "number" && Number.isFinite(value.downloadCount)
        ? value.downloadCount
        : 0,
    iconUrl: trustedOpenVsxUrl(value.files.icon),
    sourceUrl:
      publicSourceUrl(value.repository) ??
      publicSourceUrl(value.homepage) ??
      publicSourceUrl(value.url),
    manifestUrl,
    sha256Url,
    vsixUrl,
    version,
    license,
  };
}

async function withSearchTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, SEARCH_REQUEST_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      throw new Error(m(msg("Open VSX took too long to respond.")), { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}

export async function searchOpenVsxThemes(
  query: string,
  { signal, sortBy = "downloadCount" }: OpenVsxThemeSearchOptions = {},
): Promise<OpenVsxThemeExtension[]> {
  signal?.throwIfAborted();
  void sortBy;
  if (!query.trim()) return [];
  return Promise.reject(
    new Error(
      m(msg("Open VSX online search is disabled in local-only mode. Import a local theme file instead.")),
    ),
  );
}

function parseJsoncObject(source: string, description: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value))
    throw new Error(m(msg("{description} is not valid JSON.", { description })));
  return value;
}

function sanitizeThemeObject(value: Record<string, unknown>): Record<string, unknown> {
  const colors: Record<string, string> = {};
  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      if (
        USED_WORKBENCH_COLORS.has(key) &&
        typeof color === "string" &&
        color.length <= MAX_COLOR_VALUE_LENGTH
      ) {
        colors[key] = color;
      }
    }
  }
  return {
    ...(typeof value.include === "string" ? { include: value.include } : {}),
    colors,
  };
}

function normalizePackagePath(path: string, relativeTo = "extension/"): string {
  if (
    path.length > MAX_PACKAGE_PATH_LENGTH ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    throw new Error(m(msg("Theme path is not a safe relative package path.")));
  }
  const normalizedInput = path.replaceAll("\\", "/");
  const baseSegments = relativeTo.split("/").slice(0, -1);
  const segments = baseSegments;
  for (const segment of normalizedInput.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= 1)
        throw new Error(m(msg("Theme path escapes the extension package.")));
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments[0] !== "extension") segments.unshift("extension");
  return segments.join("/");
}

function contributionType(uiTheme: unknown): string | null {
  if (uiTheme === "vs") return "light";
  if (uiTheme === "vs-dark") return "dark";
  if (uiTheme === "hc-black" || uiTheme === "hc-light") return uiTheme;
  return null;
}

type ZipEntrySizes = {
  uncompressedSize?: unknown;
};

type InspectableZipObject = JSZip.JSZipObject & {
  _data?: ZipEntrySizes;
  unsafeOriginalName?: string;
  internalStream?: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
};

const extensionPackageErrors = new WeakSet<Error>();

function extensionPackageError(message: string): Error {
  const error = new Error(message);
  extensionPackageErrors.add(error);
  return error;
}

function inspectZipDirectory(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = bytes.byteLength - 22;
  while (
    endOffset >= minimumOffset &&
    (view.getUint32(endOffset, true) !== 0x06054b50 ||
      endOffset + 22 + view.getUint16(endOffset + 20, true) !== bytes.byteLength)
  ) {
    endOffset -= 1;
  }
  if (endOffset < minimumOffset)
    throw extensionPackageError(m(msg("That extension package has no ZIP directory.")));

  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) {
    throw extensionPackageError(m(msg("That extension package has an invalid ZIP directory.")));
  }

  let entryCount = 0;
  let totalUncompressed = 0;
  let offset = directoryOffset;
  while (offset < directoryEnd) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw extensionPackageError(m(msg("That extension package has an invalid ZIP directory.")));
    }
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw extensionPackageError(m(msg("That extension package has too many files.")));
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw extensionPackageError(m(msg("That extension package has unsupported ZIP64 metadata.")));
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw extensionPackageError(
        m(msg("That extension package expands beyond the safe import limit.")),
      );
    }
    if (
      uncompressed > 0 &&
      (compressed === 0 || uncompressed / compressed > MAX_COMPRESSION_RATIO)
    ) {
      throw extensionPackageError(
        m(msg("That extension package has an unsafe compression ratio.")),
      );
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryEnd)
    throw extensionPackageError(m(msg("That extension package has an invalid ZIP directory.")));

  const commentLength = view.getUint16(endOffset + 20, true);
  if (commentLength === 0) return bytes;

  // Strip ZIP comments; JSZip can mistake EOCD-like comment bytes for the real record.
  const withoutComment = bytes.slice(0, endOffset + 22);
  withoutComment[endOffset + 20] = 0;
  withoutComment[endOffset + 21] = 0;
  return withoutComment;
}

function inspectZip(zip: JSZip): void {
  const entries = Object.values(zip.files) as InspectableZipObject[];
  if (entries.length > MAX_ZIP_ENTRIES)
    throw extensionPackageError(m(msg("That extension package has too many files.")));

  for (const entry of entries) {
    if (entry.unsafeOriginalName) normalizePackagePath(entry.unsafeOriginalName);
  }
}

async function readZipText(
  zip: JSZip,
  path: string,
  description: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const file = zip.file(path) as InspectableZipObject | null;
  if (!file)
    throw new Error(
      m(msg("{description} is missing from the extension package.", { description })),
    );
  if (typeof file._data?.uncompressedSize !== "number" || !file.internalStream) {
    throw new Error(m(msg("{description} has unreadable size metadata.", { description })));
  }
  if (file._data.uncompressedSize > MAX_THEME_BYTES) {
    throw new Error(m(msg("{description} is too large.", { description })));
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;
    const stream = file.internalStream!("uint8array");
    const cleanup = () => signal?.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    stream
      .on("data", (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > MAX_THEME_BYTES) {
          settled = true;
          stream.pause();
          cleanup();
          reject(new Error(m(msg("{description} is too large.", { description }))));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(new TextDecoder().decode(bytes));
      })
      .resume();
  });
}

async function loadThemeObject(
  zip: JSZip,
  path: string,
  cache: Map<string, Record<string, unknown>>,
  budget: { files: number },
  ancestors: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  if (ancestors.size >= MAX_INCLUDE_DEPTH)
    throw new Error(m(msg("Theme includes are nested too deeply.")));
  if (ancestors.has(path)) throw new Error(m(msg("Theme includes contain a cycle.")));
  const cached = cache.get(path);
  if (cached) return cached;
  budget.files += 1;
  if (budget.files > MAX_RESOLVED_THEME_FILES) {
    throw new Error(m(msg("That extension references too many theme files.")));
  }

  const value = sanitizeThemeObject(
    parseJsoncObject(await readZipText(zip, path, path, signal), path),
  );
  if (typeof value.include !== "string") {
    cache.set(path, value);
    return value;
  }

  const includePath = normalizePackagePath(value.include, path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(path);
  const base = await loadThemeObject(zip, includePath, cache, budget, nextAncestors, signal);
  const resolved = {
    ...base,
    ...value,
    colors: {
      ...(isRecord(base.colors) ? base.colors : {}),
      ...(isRecord(value.colors) ? value.colors : {}),
    },
  };
  cache.set(path, resolved);
  return resolved;
}

async function readCappedResponse(
  response: Response,
  limit: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) throw new Error(tooLargeMessage);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(tooLargeMessage);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchPackage(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(m(msg("That Open VSX theme could not be downloaded.")));
  return readCappedResponse(
    response,
    MAX_VSIX_BYTES,
    m(msg("That theme extension is too large to import safely.")),
  );
}

export async function importOpenVsxThemeExtension(
  extension: OpenVsxThemeExtension,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThemeDefinition>> {
  void extension;
  signal?.throwIfAborted();
  return Promise.reject(
    new Error(
      m(msg("Open VSX online theme download is disabled in local-only mode. Import a local theme file instead.")),
    ),
  );
}
