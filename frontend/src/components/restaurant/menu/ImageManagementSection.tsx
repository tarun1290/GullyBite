'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useToast } from '../../Toast';
import { bulkUploadImages, getImageStats } from '../../../api/restaurant';

const MAX_FILES = 20;

interface ImageStats {
  withImages: number;
  totalItems: number;
}

interface MatchedRow { fileName: string; itemName: string }
interface UnmatchedRow { fileName: string }

interface UploadResults {
  matched: MatchedRow[];
  unmatched: UnmatchedRow[];
  uploaded: number;
}

interface BulkUploadApi {
  matched?: MatchedRow[];
  unmatched?: UnmatchedRow[];
  uploaded?: number;
}

export default function ImageManagementSection() {
  const { showToast } = useToast();
  const [stats, setStats] = useState<ImageStats | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState<boolean>(false);
  const [results, setResults] = useState<UploadResults | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadStats = async () => {
    try {
      const s = (await getImageStats()) as ImageStats | null | undefined;
      setStats(s && typeof s.withImages === 'number' ? s : null);
    } catch {
      setStats(null);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
    const list = [...(e.target.files || [])];
    if (list.length > MAX_FILES) {
      showToast(`Maximum ${MAX_FILES} files at a time`, 'error');
      setFiles(list.slice(0, MAX_FILES));
      return;
    }
    setFiles(list);
    setResults(null);
  };

  const handleUpload = async () => {
    if (!files.length) return showToast('Select at least one image', 'error');
    if (files.length > MAX_FILES) return showToast(`Maximum ${MAX_FILES} files at a time`, 'error');
    setUploading(true);
    try {
      const data = (await bulkUploadImages(files)) as BulkUploadApi;
      setResults({
        matched: data.matched || [],
        unmatched: data.unmatched || [],
        uploaded: data.uploaded || 0,
      });
      showToast('Bulk upload complete!', 'success');
      loadStats();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Bulk upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleReset = () => {
    setFiles([]);
    setResults(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const pct = stats?.totalItems
    ? Math.round((stats.withImages / stats.totalItems) * 100)
    : 0;

  return (
    <div>
      <div className="card mb-4">
        <div className="ch"><h3>📷 Image Coverage</h3></div>
        <div className="cb">
          {stats ? (
            <>
              <div className="text-[0.84rem] mb-2">
                <strong>{stats.withImages}</strong> of <strong>{stats.totalItems}</strong> items
                have photos <span className="text-dim">({pct}%)</span>
              </div>
              <div className="h-2 bg-ink2 rounded-[4px] overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-300 ${
                    pct >= 80 ? 'bg-wa' : pct >= 40 ? 'bg-gold' : 'bg-red'
                  }`}
                  // width is the runtime image-coverage percentage —
                  // Tailwind can't pre-bake the per-render value.
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-[0.76rem] text-dim mt-[0.6rem] leading-normal">
                Meta requires every catalog item to have a photo (min 500×500 px). Items without
                images will be skipped on sync.
              </p>
            </>
          ) : (
            <p className="text-dim text-[0.84rem]">Image stats unavailable.</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="ch justify-between">
          <h3>🖼️ Bulk Image Upload</h3>
          <span className="text-[0.72rem] text-dim">Max {MAX_FILES} files</span>
        </div>
        <div className="cb">
          <p className="text-[0.82rem] text-dim mb-[0.7rem] leading-normal">
            Drop product photos here — the server will match each filename (e.g.{' '}
            <code>masala-dosa.jpg</code>) against your menu item names and attach them
            automatically. Unmatched files will be listed so you can rename and retry.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handlePick}
            className="mb-[0.6rem]"
          />

          {files.length > 0 && (
            <div className="bg-ink2 rounded-lg py-2 px-[0.7rem] mb-[0.6rem] max-h-[180px] overflow-y-auto">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="text-[0.8rem] py-[0.15rem]">
                  {i + 1}. {f.name}{' '}
                  <span className="text-dim">({(f.size / 1024).toFixed(0)} KB)</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              className="btn-p"
              onClick={handleUpload}
              disabled={uploading || !files.length}
            >
              {uploading ? 'Uploading…' : `⬆ Upload ${files.length || ''} image${files.length === 1 ? '' : 's'}`}
            </button>
            {(files.length > 0 || results) && (
              <button type="button" className="btn-g" onClick={handleReset} disabled={uploading}>
                Reset
              </button>
            )}
          </div>

          {results && (
            <div className="mt-[0.9rem] bg-ink2 rounded-lg py-[0.7rem] px-[0.85rem]">
              {results.matched.length > 0 && (
                <div className="mb-2">
                  <strong className="text-wa text-[0.82rem]">
                    Matched {results.matched.length} item{results.matched.length === 1 ? '' : 's'}:
                  </strong>
                  {results.matched.map((m, i) => (
                    <div key={`m-${i}`} className="text-[0.8rem] py-[0.15rem]">
                      ✅ {m.fileName} → {m.itemName}
                    </div>
                  ))}
                </div>
              )}
              {results.unmatched.length > 0 && (
                <div className={results.matched.length ? 'mt-2' : ''}>
                  <strong className="text-gold text-[0.82rem]">
                    {results.unmatched.length} unmatched image{results.unmatched.length === 1 ? '' : 's'}:
                  </strong>
                  {results.unmatched.map((u, i) => (
                    <div key={`u-${i}`} className="text-[0.8rem] py-[0.15rem] text-dim">
                      ⚠️ {u.fileName}
                    </div>
                  ))}
                </div>
              )}
              {!results.matched.length && !results.unmatched.length && (
                <div className="text-[0.82rem] text-dim">
                  Upload complete. {results.uploaded} image{results.uploaded === 1 ? '' : 's'} processed.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
