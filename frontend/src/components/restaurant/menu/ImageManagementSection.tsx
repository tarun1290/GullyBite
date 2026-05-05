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
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch"><h3>📷 Image Coverage</h3></div>
        <div className="cb">
          {stats ? (
            <>
              <div style={{ fontSize: '.84rem', marginBottom: '.5rem' }}>
                <strong>{stats.withImages}</strong> of <strong>{stats.totalItems}</strong> items
                have photos <span style={{ color: 'var(--dim)' }}>({pct}%)</span>
              </div>
              <div
                style={{
                  height: 8, background: 'var(--ink2,#f4f4f5)', borderRadius: 4, overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${pct}%`, height: '100%',
                    background: pct >= 80 ? 'var(--wa,#16a34a)' : pct >= 40 ? 'var(--gold,#f59e0b)' : 'var(--red,#dc2626)',
                    transition: 'width .3s',
                  }}
                />
              </div>
              <p style={{ fontSize: '.76rem', color: 'var(--dim)', marginTop: '.6rem', lineHeight: 1.5 }}>
                Meta requires every catalog item to have a photo (min 500×500 px). Items without
                images will be skipped on sync.
              </p>
            </>
          ) : (
            <p style={{ color: 'var(--dim)', fontSize: '.84rem' }}>Image stats unavailable.</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>🖼️ Bulk Image Upload</h3>
          <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>Max {MAX_FILES} files</span>
        </div>
        <div className="cb">
          <p style={{ fontSize: '.82rem', color: 'var(--dim)', marginBottom: '.7rem', lineHeight: 1.5 }}>
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
            style={{ marginBottom: '.6rem' }}
          />

          {files.length > 0 && (
            <div
              style={{
                background: 'var(--ink2,#f4f4f5)', borderRadius: 8, padding: '.5rem .7rem',
                marginBottom: '.6rem', maxHeight: 180, overflowY: 'auto',
              }}
            >
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} style={{ fontSize: '.8rem', padding: '.15rem 0' }}>
                  {i + 1}. {f.name}{' '}
                  <span style={{ color: 'var(--dim)' }}>({(f.size / 1024).toFixed(0)} KB)</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '.5rem' }}>
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
            <div
              style={{
                marginTop: '.9rem', background: 'var(--ink2,#f4f4f5)', borderRadius: 8,
                padding: '.7rem .85rem',
              }}
            >
              {results.matched.length > 0 && (
                <div style={{ marginBottom: '.5rem' }}>
                  <strong style={{ color: 'var(--wa,#16a34a)', fontSize: '.82rem' }}>
                    Matched {results.matched.length} item{results.matched.length === 1 ? '' : 's'}:
                  </strong>
                  {results.matched.map((m, i) => (
                    <div key={`m-${i}`} style={{ fontSize: '.8rem', padding: '.15rem 0' }}>
                      ✅ {m.fileName} → {m.itemName}
                    </div>
                  ))}
                </div>
              )}
              {results.unmatched.length > 0 && (
                <div style={{ marginTop: results.matched.length ? '.5rem' : 0 }}>
                  <strong style={{ color: 'var(--gold,#f59e0b)', fontSize: '.82rem' }}>
                    {results.unmatched.length} unmatched image{results.unmatched.length === 1 ? '' : 's'}:
                  </strong>
                  {results.unmatched.map((u, i) => (
                    <div key={`u-${i}`} style={{ fontSize: '.8rem', padding: '.15rem 0', color: 'var(--dim)' }}>
                      ⚠️ {u.fileName}
                    </div>
                  ))}
                </div>
              )}
              {!results.matched.length && !results.unmatched.length && (
                <div style={{ fontSize: '.82rem', color: 'var(--dim)' }}>
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
