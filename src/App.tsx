import { Suspense, lazy, useEffect, useState, type ChangeEvent } from 'react';
import '@aws-amplify/ui-react/styles.css';
import outputs from '../amplify_outputs.json';
import './App.css';

const PROCESSED_RESULTS_PREFIX = 'processed/raw/';
const EXTRACTED_RESULTS_PREFIX = 'extracted/';
const INGESTION_BUCKET = {
  bucketName: 'syntrix-doc-ingestion',
  region: 'af-south-1',
} as const;
const PROCESSED_BUCKET = {
  bucketName: outputs.custom.processedBucketName,
  region: 'af-south-1',
} as const;
const Authenticator = lazy(async () => {
  const module = await import('@aws-amplify/ui-react');
  return { default: module.Authenticator };
});
const storageModulePromise = import('aws-amplify/storage');
const authModulePromise = import('aws-amplify/auth');
const lambdaModulePromise = import('@aws-sdk/client-lambda');

type StorageListItem = {
  path: string;
  lastModified?: string | Date;
};

type ExtractionMetadata = {
  file_name?: string;
};

type ParsedDataset = {
  headers: string[];
  rows: string[][];
};

function getProcessedCsvPath(fileName: string) {
  return `${PROCESSED_RESULTS_PREFIX}${fileName}.csv`;
}

function getDownloadFileName(fileName: string) {
  return `Analysis_${fileName.replace(/\.[^.]+$/, '')}.csv`;
}

async function findExactCsvPath(fileName: string) {
  const expectedOutputPath = getProcessedCsvPath(fileName);
  const { list } = await storageModulePromise;
  const result = await list({
    path: PROCESSED_RESULTS_PREFIX,
    options: { bucket: PROCESSED_BUCKET },
  });

  const found = result.items.some((item: StorageListItem) => item.path === expectedOutputPath);
  return found ? expectedOutputPath : null;
}

async function findExtractedCsvPath(fileName: string) {
  const { list, downloadData } = await storageModulePromise;
  const result = await list({
    path: EXTRACTED_RESULTS_PREFIX,
    options: { bucket: PROCESSED_BUCKET },
  });

  const metadataItems = result.items
    .filter((item: StorageListItem) => item.path.endsWith('/metadata.json'))
    .sort((left: StorageListItem, right: StorageListItem) => {
      const leftTime = new Date(left.lastModified ?? 0).getTime();
      const rightTime = new Date(right.lastModified ?? 0).getTime();
      return rightTime - leftTime;
    });

  for (const item of metadataItems) {
      const metadataDownload = await downloadData({
        path: item.path,
        options: { bucket: PROCESSED_BUCKET },
    }).result;
    const metadataBlob = await metadataDownload.body.blob();
    const metadataText = await metadataBlob.text();
    const metadata = JSON.parse(metadataText) as ExtractionMetadata;

    if (metadata.file_name === fileName) {
      return item.path.replace(/metadata\.json$/, 'data.csv');
    }
  }

  return null;
}

async function findAvailableCsvPath(fileName: string) {
  const exactPath = await findExactCsvPath(fileName);
  if (exactPath) {
    return exactPath;
  }

  return findExtractedCsvPath(fileName);
}

function parseCsv(text: string): ParsedDataset {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = '';
  let inQuotes = false;
  const normalizedText = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < normalizedText.length; index += 1) {
    const character = normalizedText[index];
    const nextCharacter = normalizedText[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        currentValue += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === ',' && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }

      currentRow.push(currentValue);
      if (currentRow.some((value) => value.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentValue = '';
      continue;
    }

    currentValue += character;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  const [headers = [], ...dataRows] = rows;
  return {
    headers,
    rows: dataRows.filter((row) => row.some((value) => value.length > 0)),
  };
}

function formatFileSize(fileSize: number) {
  if (fileSize < 1024) {
    return `${fileSize} B`;
  }

  if (fileSize < 1024 * 1024) {
    return `${(fileSize / 1024).toFixed(1)} KB`;
  }

  return `${(fileSize / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDatasetValue(value: string) {
  if (!value) {
    return { text: 'Not provided', structured: false };
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return {
        text: JSON.stringify(JSON.parse(trimmed), null, 2),
        structured: true,
      };
    } catch {
      return { text: value, structured: false };
    }
  }

  return { text: value, structured: false };
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('Select a document to begin.');
  const [isBusy, setIsBusy] = useState(false);
  const [isUploaded, setIsUploaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isReadyForExport, setIsReadyForExport] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [datasetPreview, setDatasetPreview] = useState<ParsedDataset | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [isDatasetLoading, setIsDatasetLoading] = useState(false);

  const pipelineStage = isReadyForExport
    ? 'Ready for export'
    : isDatasetLoading
      ? 'Loading dataset preview'
      : isProcessing
        ? 'Processing'
        : isUploaded
          ? 'Uploaded'
          : file
            ? 'Selected'
            : 'Idle';

  const datasetEntries = datasetPreview?.rows[0]
    ? datasetPreview.headers.map((header, index) => ({
      field: header,
      value: datasetPreview.rows[0][index] ?? '',
    }))
    : [];

  const loadDatasetPreview = async (outputPath: string) => {
    try {
      setIsDatasetLoading(true);
      setDatasetError(null);

      const { downloadData } = await storageModulePromise;
      const result = await downloadData({
        path: outputPath,
        options: { bucket: PROCESSED_BUCKET },
      }).result;
      const csvBlob = await result.body.blob();
      const csvText = await csvBlob.text();
      const parsedDataset = parseCsv(csvText);
      setDatasetPreview(parsedDataset);
    } catch (error) {
      console.error("Dataset preview error:", error);
      setDatasetPreview(null);
      setDatasetError('The CSV is available, but the in-app dataset preview could not be loaded.');
    } finally {
      setIsDatasetLoading(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    setIsUploaded(false);
    setIsProcessing(false);
    setIsReadyForExport(false);
    setExportPath(null);
    setDatasetPreview(null);
    setDatasetError(null);
    setIsDatasetLoading(false);
    setStatus(nextFile ? `Selected ${nextFile.name}. Ready to upload.` : 'Select a document to begin.');
  };

  useEffect(() => {
    let interval: number | undefined;
    let attempts = 0;
    const maxAttempts = 60;

    if (isProcessing && !isReadyForExport && file) {
      interval = window.setInterval(async () => {
        try {
          attempts++;
          const found = await findAvailableCsvPath(file.name);

          if (found) {
            if (interval) clearInterval(interval);
            setExportPath(found);
            setIsProcessing(false);
            setStatus('Extraction complete. Loading dataset preview...');
            await loadDatasetPreview(found);
            setIsReadyForExport(true);
            setStatus('Extraction complete. Review the dataset and export when ready.');
            return;
          }

          if (attempts >= maxAttempts) {
            setStatus('Processing timed out.');
            setIsProcessing(false);
            if (interval) clearInterval(interval);
          }
        } catch (e) {
          console.error("Polling error:", e);
        }
      }, 5000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isProcessing, isReadyForExport, file]);

  const handleUpload = async () => {
    if (!file) return;

    try {
      setIsBusy(true);
      setStatus('Ingesting to Cape Town...');
      const { uploadData } = await storageModulePromise;
      await uploadData({
        path: `raw/${file.name}`,
        data: file,
        options: { bucket: INGESTION_BUCKET },
      }).result;
      setIsUploaded(true);
      setIsReadyForExport(false);
      setExportPath(null);
      setDatasetPreview(null);
      setDatasetError(null);
      setStatus('Upload complete. Ready to start processing.');
    } catch (error) {
      console.error("Upload error:", error);
      setStatus('Upload Error.');
    } finally { setIsBusy(false); }
  };

  const handleProcess = async () => {
    if (!file) return;

    try {
      setIsBusy(true);
      setStatus('Starting AI Analysis...');
      setIsReadyForExport(false);
      setExportPath(null);
      setDatasetPreview(null);
      setDatasetError(null);
      const [{ fetchAuthSession }, { LambdaClient, InvokeCommand }] = await Promise.all([
        authModulePromise,
        lambdaModulePromise,
      ]);
      const session = await fetchAuthSession();
      if (!session.credentials) throw new Error("No session");

      const client = new LambdaClient({ region: 'af-south-1', credentials: session.credentials });
      const command = new InvokeCommand({
        FunctionName: outputs.custom.orchestratorFunctionArn,
        Payload: new TextEncoder().encode(JSON.stringify({
          Records: [{ s3: { bucket: { name: INGESTION_BUCKET.bucketName }, object: { key: `raw/${file?.name}` } } }]
        })),
      });

      await client.send(command);
      setIsProcessing(true);
      setStatus('Textract and Bedrock processing started. Waiting for CSV...');
    } catch (error) {
      console.error("Processing error:", error);
      setStatus('Processing Error.');
    } finally { setIsBusy(false); }
  };

  const handleExport = async () => {
    if (!file) return;

    try {
      setIsBusy(true);
      const outputPath = exportPath ?? getProcessedCsvPath(file.name);
      const downloadFileName = getDownloadFileName(file.name);
      const { downloadData } = await storageModulePromise;
      const result = await downloadData({
        path: outputPath,
        options: { bucket: PROCESSED_BUCKET }
      }).result;
      const blob = await result.body.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadFileName;
      a.click();
      window.URL.revokeObjectURL(url);
      setStatus('Success!');
    } catch (error) {
      console.error("Download error:", error);
      setStatus('Download Error.');
    } finally { setIsBusy(false); }
  };

  return (
    <Suspense fallback={<main className="syntrix-dashboard"><p className="status-bar">Loading authentication workspace...</p></main>}>
      <Authenticator>
        {({ signOut }) => (
          <main className="syntrix-dashboard">
            <h1>SYNTRIX INTELLIGENCE PORTAL</h1>
            <div className="action-card">
              <p className="file-meta">
                {file ? `Selected document: ${file.name}` : 'No document selected.'}
              </p>
              <input type="file" accept=".pdf" disabled={isBusy} onChange={handleFileChange} />
              <div className="button-group">
                <button onClick={handleUpload} disabled={isBusy || isUploaded || !file}>1. UPLOAD</button>
                <button onClick={handleProcess} disabled={isBusy || !isUploaded || isProcessing}>2. PROCESS</button>
                <button onClick={handleExport} disabled={isBusy || !isReadyForExport} className={isReadyForExport ? 'pulse' : ''}>3. EXPORT</button>
              </div>
              {status && <p className="status-bar">{status}</p>}

              <div className="dataset-shell">
                <div className="dataset-overview">
                  <section className="dataset-panel">
                    <div className="panel-heading">
                      <div>
                        <p className="panel-label">Uploaded Document</p>
                        <h2>Source Record</h2>
                      </div>
                      <span className="dataset-badge">{pipelineStage}</span>
                    </div>
                    <div className="dataset-meta-grid">
                      <div className="meta-item">
                        <span>File Name</span>
                        <strong>{file?.name ?? 'Waiting for upload'}</strong>
                      </div>
                      <div className="meta-item">
                        <span>File Size</span>
                        <strong>{file ? formatFileSize(file.size) : 'Pending'}</strong>
                      </div>
                      <div className="meta-item">
                        <span>Upload Bucket</span>
                        <strong>{INGESTION_BUCKET.bucketName}</strong>
                      </div>
                      <div className="meta-item">
                        <span>Ingestion Key</span>
                        <strong>{file ? `raw/${file.name}` : 'Pending'}</strong>
                      </div>
                    </div>
                  </section>

                  <section className="dataset-panel">
                    <div className="panel-heading">
                      <div>
                        <p className="panel-label">Dataset Output</p>
                        <h2>Extraction Artifact</h2>
                      </div>
                      <span className="dataset-badge">{datasetPreview?.rows.length ?? 0} row{datasetPreview?.rows.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="dataset-meta-grid">
                      <div className="meta-item">
                        <span>Processed Bucket</span>
                        <strong>{PROCESSED_BUCKET.bucketName}</strong>
                      </div>
                      <div className="meta-item">
                        <span>Export Path</span>
                        <strong>{exportPath ?? 'Pending'}</strong>
                      </div>
                      <div className="meta-item">
                        <span>Columns</span>
                        <strong>{datasetPreview?.headers.length ?? 0}</strong>
                      </div>
                      <div className="meta-item">
                        <span>Preview Status</span>
                        <strong>{isDatasetLoading ? 'Loading' : datasetError ? 'Preview unavailable' : datasetPreview ? 'Ready' : 'Waiting'}</strong>
                      </div>
                    </div>
                  </section>
                </div>

                <section className="dataset-panel dataset-panel-wide">
                  <div className="panel-heading">
                    <div>
                      <p className="panel-label">Dataset View</p>
                      <h2>Bedrock Extraction Preview</h2>
                    </div>
                  </div>

                  {!file && (
                    <div className="dataset-placeholder">
                      Select a document to start a dataset record.
                    </div>
                  )}

                  {file && !datasetPreview && !isDatasetLoading && !datasetError && (
                    <div className="dataset-placeholder">
                      Upload and process the document to load the extraction dataset before export.
                    </div>
                  )}

                  {isDatasetLoading && (
                    <div className="dataset-placeholder">
                      Loading the extracted dataset from the processed bucket...
                    </div>
                  )}

                  {datasetError && (
                    <div className="dataset-error">
                      {datasetError}
                    </div>
                  )}

                  {datasetPreview && datasetPreview.rows.length === 1 && (
                    <div className="dataset-kv-grid">
                      {datasetEntries.map((entry) => {
                        const formattedValue = formatDatasetValue(entry.value);
                        return (
                          <article className="dataset-kv-card" key={entry.field}>
                            <h3>{entry.field}</h3>
                            {formattedValue.structured ? (
                              <pre className="dataset-value structured">{formattedValue.text}</pre>
                            ) : (
                              <p className="dataset-value">{formattedValue.text}</p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}

                  {datasetPreview && datasetPreview.rows.length > 1 && (
                    <div className="dataset-table-wrap">
                      <table className="dataset-table">
                        <thead>
                          <tr>
                            {datasetPreview.headers.map((header) => (
                              <th key={header}>{header}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {datasetPreview.rows.map((row, rowIndex) => (
                            <tr key={`row-${rowIndex}`}>
                              {datasetPreview.headers.map((header, cellIndex) => (
                                <td key={`${header}-${rowIndex}`}>
                                  {formatDatasetValue(row[cellIndex] ?? '').text}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            </div>
            <button onClick={() => signOut?.()} className="logout-btn">Terminate Session</button>
          </main>
        )}
      </Authenticator>
    </Suspense>
  );
}

export default App;
