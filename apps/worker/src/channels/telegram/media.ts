// apps/worker/src/channels/telegram/media.ts
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createLogger } from '@whis/logger';
import type { Api, RawApi } from 'grammy';
import type { Message } from 'grammy/types';
import type { Attachment } from '@/channels/types';

const logger = createLogger({ service: 'worker' });

/** Hard limit for downloads via Telegram Bot API. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Whitelist of document mimetypes Whis pulls into the inbox. */
function isSupportedDocumentMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return mime.startsWith('image/') || mime === 'application/pdf';
}

export type MediaCandidate =
  | { kind: 'photo'; fileId: string; fileSize?: number; mimeType: string }
  | {
      kind: 'audio';
      fileId: string;
      fileSize?: number;
      fileName?: string;
      mimeType: string;
    }
  | { kind: 'voice'; fileId: string; fileSize?: number; mimeType: string }
  | {
      kind: 'document';
      fileId: string;
      fileSize?: number;
      fileName?: string;
      mimeType: string;
    };

/**
 * Extract supported media candidates from a Telegram Message.
 * Photo arrays return only the largest size. Videos / stickers / video_notes /
 * unsupported documents are dropped (so the agent doesn't get a broken path).
 */
export function extractMediaCandidates(message: Message): MediaCandidate[] {
  const out: MediaCandidate[] = [];

  if (message.photo && message.photo.length > 0) {
    const biggest = message.photo[message.photo.length - 1];
    out.push({
      kind: 'photo',
      fileId: biggest.file_id,
      fileSize: biggest.file_size,
      mimeType: 'image/jpeg',
    });
  }

  if (message.voice) {
    out.push({
      kind: 'voice',
      fileId: message.voice.file_id,
      fileSize: message.voice.file_size,
      mimeType: message.voice.mime_type ?? 'audio/ogg',
    });
  }

  if (message.audio) {
    out.push({
      kind: 'audio',
      fileId: message.audio.file_id,
      fileSize: message.audio.file_size,
      fileName: message.audio.file_name,
      mimeType: message.audio.mime_type ?? 'audio/mpeg',
    });
  }

  if (message.document && isSupportedDocumentMime(message.document.mime_type)) {
    out.push({
      kind: 'document',
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type ?? 'application/octet-stream',
    });
  }

  return out;
}

export interface DownloadDeps {
  api: Api<RawApi>;
  botToken: string;
  /** Test seam — defaults to global fetch. */
  fetcher?: typeof fetch;
}

/**
 * Download Telegram media into `destDir` and return `Attachment` records.
 *
 * Skips candidates larger than the Bot API 20MB limit. Per-file failures are
 * logged and skipped; the function never throws on individual downloads so a
 * broken file doesn't kill the whole turn.
 */
export async function downloadAttachments(
  deps: DownloadDeps,
  candidates: MediaCandidate[],
  destDir: string,
): Promise<Attachment[]> {
  if (candidates.length === 0) return [];
  await mkdir(destDir, { recursive: true });

  const fetcher = deps.fetcher ?? fetch;
  const out: Attachment[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];

    if (candidate.fileSize !== undefined && candidate.fileSize > MAX_FILE_BYTES) {
      logger.warn(
        {
          event: 'telegram_media_too_large',
          kind: candidate.kind,
          sizeBytes: candidate.fileSize,
          limitBytes: MAX_FILE_BYTES,
        },
        'telegram media exceeds 20MB Bot API limit, skipped',
      );
      continue;
    }

    try {
      const file = await deps.api.getFile(candidate.fileId);
      if (!file.file_path) {
        logger.warn(
          { event: 'telegram_media_no_path', kind: candidate.kind, fileId: candidate.fileId },
          'getFile returned no file_path',
        );
        continue;
      }
      const url = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
      const resp = await fetcher(url);
      if (!resp.ok) {
        logger.warn(
          { event: 'telegram_media_fetch_failed', status: resp.status, kind: candidate.kind },
          'telegram file fetch returned non-2xx',
        );
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      const filename = chooseFilename(candidate, file.file_path, i);
      const localPath = join(destDir, filename);
      await writeFile(localPath, buf);
      out.push({
        name: filename,
        mimetype: candidate.mimeType,
        localPath,
        sizeBytes: buf.byteLength,
      });
    } catch (err) {
      logger.warn(
        { event: 'telegram_media_download_failed', kind: candidate.kind, err: String(err) },
        'media download threw',
      );
    }
  }

  return out;
}

function chooseFilename(c: MediaCandidate, filePath: string, index: number): string {
  if ((c.kind === 'document' || c.kind === 'audio') && c.fileName) {
    return safeFilename(c.fileName);
  }
  const base = safeFilename(basename(filePath));
  if (base.length > 0) return `${index}-${base}`;
  return `${index}-${c.kind}`;
}

/** Strip path separators / control chars so a Telegram-supplied name can't escape destDir. */
function safeFilename(name: string): string {
  return name.replace(/[/\\\0]/g, '_').slice(0, 200);
}

/**
 * Best-effort cleanup of the inbox root: delete child directories whose newest
 * file is older than `maxAgeMs`. Returns the number of directories removed.
 * Safe to call when `root` doesn't exist yet (returns { deleted: 0 }).
 */
export async function cleanupInbox(
  root: string,
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<{ deleted: number }> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      const dirStat = await stat(dir);
      if (!dirStat.isDirectory()) continue;
      const newest = await newestMtimeMs(dir);
      if (now - newest > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        deleted++;
      }
    } catch (err) {
      logger.warn(
        { event: 'inbox_cleanup_skip', dir, err: String(err) },
        'inbox cleanup skipped entry',
      );
    }
  }
  return { deleted };
}

async function newestMtimeMs(dir: string): Promise<number> {
  const children = await readdir(dir);
  if (children.length === 0) {
    const s = await stat(dir);
    return s.mtimeMs;
  }
  let newest = 0;
  for (const child of children) {
    const childStat = await stat(join(dir, child));
    if (childStat.mtimeMs > newest) newest = childStat.mtimeMs;
  }
  return newest;
}
