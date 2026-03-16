import { useEffect, useState, type ChangeEvent } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import { uploadData, downloadData, list } from 'aws-amplify/storage'; // Corrected path
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { fetchAuthSession } from 'aws-amplify/auth';
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

type StorageListItem = {
  path: string;
  lastModified?: string | Date;
};

type ExtractionMetadata = {
  file_name?: string;
};

function getProcessedCsvPath(fileName: string) {
  return `${PROCESSED_RESULTS_PREFIX}${fileName}.csv`;
}

function getDownloadFileName(fileName: string) {
  return `Analysis_${fileName.replace(/\.[^.]+$/, '')}.csv`;
}

async function findExactCsvPath(fileName: string) {
  const expectedOutputPath = getProcessedCsvPath(fileName);
  const result = await list({
    path: PROCESSED_RESULTS_PREFIX,
    options: { bucket: PROCESSED_BUCKET },
  });

  const found = result.items.some((item: StorageListItem) => item.path === expectedOutputPath);
  return found ? expectedOutputPath : null;
}

async function findExtractedCsvPath(fileName: string) {
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

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('Select a document to begin.');
  const [isBusy, setIsBusy] = useState(false);
  const [isUploaded, setIsUploaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isReadyForExport, setIsReadyForExport] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    setIsUploaded(false);
    setIsProcessing(false);
    setIsReadyForExport(false);
    setExportPath(null);
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
            setExportPath(found);
            setIsReadyForExport(true);
            setIsProcessing(false);
            setStatus('Extraction Complete! CSV ready for export.');
            if (interval) clearInterval(interval);
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
      await uploadData({
        path: `raw/${file.name}`,
        data: file,
        options: { bucket: INGESTION_BUCKET },
      }).result;
      setIsUploaded(true);
      setIsReadyForExport(false);
      setExportPath(null);
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
          </div>
          <button onClick={signOut} className="logout-btn">Terminate Session</button>
        </main>
      )}
    </Authenticator>
  );
}

export default App;
