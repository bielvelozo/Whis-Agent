// apps/worker/src/channels/telegram/media.test.ts
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupInbox,
  downloadAttachments,
  extractMediaCandidates,
  type MediaCandidate,
} from './media';

function makeApi(getFile: (id: string) => { file_path?: string }): Api {
  return {
    getFile: vi.fn(async (id: string) => getFile(id)),
  } as unknown as Api;
}

function okFetch(body: string | Uint8Array): typeof fetch {
  return vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  ) as unknown as typeof fetch;
}

describe('extractMediaCandidates', () => {
  it('picks the largest photo from the array', () => {
    const m = {
      photo: [
        { file_id: 'small', file_unique_id: 'a', width: 90, height: 90, file_size: 1000 },
        { file_id: 'big', file_unique_id: 'b', width: 1280, height: 1280, file_size: 50000 },
      ],
    } as unknown as Message;
    const out = extractMediaCandidates(m);
    expect(out).toEqual([
      { kind: 'photo', fileId: 'big', fileSize: 50000, mimeType: 'image/jpeg' },
    ]);
  });

  it('extracts voice with mime fallback', () => {
    const m = { voice: { file_id: 'v', file_unique_id: 'u', duration: 3 } } as unknown as Message;
    expect(extractMediaCandidates(m)).toEqual([
      { kind: 'voice', fileId: 'v', fileSize: undefined, mimeType: 'audio/ogg' },
    ]);
  });

  it('extracts pdf document', () => {
    const m = {
      document: {
        file_id: 'd',
        file_unique_id: 'u',
        file_name: 'invoice.pdf',
        mime_type: 'application/pdf',
        file_size: 2048,
      },
    } as unknown as Message;
    expect(extractMediaCandidates(m)).toEqual([
      {
        kind: 'document',
        fileId: 'd',
        fileSize: 2048,
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  });

  it('drops document with unsupported mimetype', () => {
    const m = {
      document: { file_id: 'd', file_unique_id: 'u', mime_type: 'application/zip' },
    } as unknown as Message;
    expect(extractMediaCandidates(m)).toEqual([]);
  });

  it('drops video / sticker / video_note silently', () => {
    const m = {
      video: { file_id: 'v', mime_type: 'video/mp4' },
      sticker: { file_id: 's' },
      video_note: { file_id: 'vn' },
    } as unknown as Message;
    expect(extractMediaCandidates(m)).toEqual([]);
  });

  it('returns multiple candidates when message has photo + caption + document', () => {
    const m = {
      photo: [{ file_id: 'p', file_unique_id: 'u', width: 1, height: 1 }],
      document: {
        file_id: 'd',
        file_unique_id: 'u',
        file_name: 'ref.png',
        mime_type: 'image/png',
      },
    } as unknown as Message;
    const out = extractMediaCandidates(m);
    expect(out.map((c) => c.kind).sort()).toEqual(['document', 'photo']);
  });
});

describe('downloadAttachments', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'whis-media-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('downloads a photo into destDir and returns Attachment', async () => {
    const api = makeApi(() => ({ file_path: 'photos/file_42.jpg' }));
    const fetcher = okFetch(new Uint8Array([1, 2, 3, 4, 5]));
    const candidates: MediaCandidate[] = [
      { kind: 'photo', fileId: 'big', fileSize: 5, mimeType: 'image/jpeg' },
    ];
    const out = await downloadAttachments(
      { api, botToken: 'TOK', fetcher },
      candidates,
      join(tmp, 'cid-1'),
    );
    expect(out).toHaveLength(1);
    expect(out[0].mimetype).toBe('image/jpeg');
    expect(out[0].sizeBytes).toBe(5);
    expect(out[0].localPath).toMatch(/cid-1/);
    const written = await readFile(out[0].localPath);
    expect(written.length).toBe(5);
    expect(fetcher).toHaveBeenCalledWith('https://api.telegram.org/file/botTOK/photos/file_42.jpg');
  });

  it('keeps original filename for documents', async () => {
    const api = makeApi(() => ({ file_path: 'documents/abc' }));
    const fetcher = okFetch('pdfcontent');
    const out = await downloadAttachments(
      { api, botToken: 'TOK', fetcher },
      [
        {
          kind: 'document',
          fileId: 'd',
          fileSize: 10,
          fileName: 'fatura.pdf',
          mimeType: 'application/pdf',
        },
      ],
      join(tmp, 'cid-doc'),
    );
    expect(out[0].name).toBe('fatura.pdf');
    expect(out[0].localPath.endsWith('/fatura.pdf')).toBe(true);
  });

  it('strips path separators from supplied filenames (no escape)', async () => {
    const api = makeApi(() => ({ file_path: 'documents/x' }));
    const fetcher = okFetch('x');
    const out = await downloadAttachments(
      { api, botToken: 'TOK', fetcher },
      [
        {
          kind: 'document',
          fileId: 'd',
          fileName: '../../etc/passwd',
          mimeType: 'application/pdf',
        },
      ],
      join(tmp, 'cid-evil'),
    );
    expect(out[0].name).toBe('.._.._etc_passwd');
    expect(out[0].localPath).toContain('cid-evil/.._.._etc_passwd');
    expect(out[0].name).not.toMatch(/[/\\]/);
  });

  it('skips a candidate larger than 20MB', async () => {
    const api = makeApi(() => ({ file_path: 'x/y' }));
    const fetcher = okFetch('x');
    const out = await downloadAttachments(
      { api, botToken: 'TOK', fetcher },
      [
        {
          kind: 'document',
          fileId: 'big',
          fileSize: 21 * 1024 * 1024,
          fileName: 'huge.pdf',
          mimeType: 'application/pdf',
        },
      ],
      join(tmp, 'cid-big'),
    );
    expect(out).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips candidates with non-2xx fetch but keeps processing the rest', async () => {
    const api = makeApi(() => ({ file_path: 'x/y' }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const out = await downloadAttachments(
      { api, botToken: 'TOK', fetcher },
      [
        { kind: 'photo', fileId: 'a', mimeType: 'image/jpeg' },
        { kind: 'photo', fileId: 'b', mimeType: 'image/jpeg' },
      ],
      join(tmp, 'cid-mix'),
    );
    expect(out).toHaveLength(1);
  });

  it('returns [] when given no candidates (no fs work)', async () => {
    const api = makeApi(() => ({ file_path: 'x' }));
    const fetcher = okFetch('x');
    const out = await downloadAttachments(
      { api, botToken: 'TOK', fetcher },
      [],
      join(tmp, 'never-made'),
    );
    expect(out).toEqual([]);
    await expect(stat(join(tmp, 'never-made'))).rejects.toThrow();
  });
});

describe('cleanupInbox', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'whis-inbox-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns deleted=0 when root does not exist', async () => {
    const out = await cleanupInbox(join(tmp, 'missing'), 1000);
    expect(out.deleted).toBe(0);
  });

  it('removes only directories whose newest file is older than threshold', async () => {
    const fresh = join(tmp, 'fresh');
    const stale = join(tmp, 'stale');
    const now = Date.now();
    await mkRecur(fresh, 'a.jpg', now - 60_000);
    await mkRecur(stale, 'a.jpg', now - 30 * 24 * 3_600_000);
    const out = await cleanupInbox(tmp, 7 * 24 * 3_600_000, now);
    expect(out.deleted).toBe(1);
    await expect(stat(fresh)).resolves.toBeDefined();
    await expect(stat(stale)).rejects.toThrow();
  });

  it('ignores non-directory entries at root', async () => {
    await writeFile(join(tmp, 'loose.txt'), 'x');
    const out = await cleanupInbox(tmp, 1000);
    expect(out.deleted).toBe(0);
    await expect(stat(join(tmp, 'loose.txt'))).resolves.toBeDefined();
  });
});

async function mkRecur(dir: string, filename: string, mtimeMs: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, '.');
  const s = mtimeMs / 1000;
  await utimes(filePath, s, s);
  await utimes(dir, s, s);
}
