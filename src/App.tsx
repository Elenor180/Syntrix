import { useState, useEffect } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import { uploadData, downloadData, list } from 'aws-amplify/storage';
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { fetchAuthSession } from 'aws-amplify/auth';
import '@aws-amplify/ui-react/styles.css';
import outputs from '../amplify_outputs.json';
import './App.css';

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('Select a document to begin.');
  const [isBusy, setIsBusy] = useState(false);
  
  const [isUploaded, setIsUploaded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isReadyForExport, setIsReadyForExport] = useState(false);

  // --- POLLING LOGIC ---
  useEffect(() => {
    let interval: number | undefined;
    let attempts = 0;
    const maxAttempts = 60; // ~5 minutes at 5-second interval

    if (isProcessing && !isReadyForExport && file) {
      interval = window.setInterval(async () => {
        try {
          attempts++;
          console.log(`Polling attempt ${attempts} for processed/raw/${file.name}.json`);

          const result = await list({
            path: `processed/raw/`,
            options: { 
              bucket: {
                bucketName: outputs.custom.processedBucketName,
                region: 'af-south-1' 
              } 
            }
          });

          console.log('Polling result - items found:', result.items.length);
          console.log('Files:', result.items.map(item => item.path));

          // More forgiving match (handles spaces/special chars better)
          const found = result.items.some(item => 
            item.path.endsWith(`${file.name}.json`) ||
            item.path.includes(file.name) && item.path.endsWith('.json')
          );

          if (found) {
            console.log('Processed file detected!');
            setIsReadyForExport(true);
            setIsProcessing(false);
            setStatus('Extraction Complete! Click Export.');
            if (interval) clearInterval(interval);
          }

          if (attempts >= maxAttempts) {
            console.log('Polling timed out after', maxAttempts, 'attempts');
            setStatus('Processing timed out. Please try again.');
            setIsProcessing(false);
            if (interval) clearInterval(interval);
          }
        } catch (e) {
          console.error("Polling error:", e);
        }
      }, 5000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isProcessing, isReadyForExport, file]);

  const handleUpload = async () => {
    if (!file) return;
    try {
      setIsBusy(true);
      setStatus('Ingesting to Cape Town...');
      await uploadData({ path: `raw/${file.name}`, data: file }).result;
      setIsUploaded(true);
      setStatus('Ready for Processing.');
    } catch (e) { 
      setStatus('Upload Error.'); 
      console.error(e);
    } finally { setIsBusy(false); }
  };

  const handleProcess = async () => {
    try {
      setIsBusy(true);
      setStatus('Starting AI Analysis...');
      
      const session = await fetchAuthSession();
      if (!session.credentials) throw new Error("No active AWS session found.");

      const client = new LambdaClient({ 
        region: 'af-south-1', 
        credentials: session.credentials 
      });

      const command = new InvokeCommand({
        FunctionName: outputs.custom.orchestratorFunctionArn,
        Payload: new TextEncoder().encode(JSON.stringify({
          Records: [{ 
            s3: { 
              bucket: { name: outputs.storage.bucket_name }, 
              object: { key: `raw/${file?.name}` } 
            } 
          }]
        })),
      });

      await client.send(command);

      setIsProcessing(true);
      setStatus('Processing in Ireland (Polling Active)...');
    } catch (e) { 
      setStatus('Processing Error. Check Console.'); 
      console.error(e);
    } finally { setIsBusy(false); }
  };

  const handleExport = async () => {
    try {
      setIsBusy(true);
      const result = await downloadData({
        path: `processed/raw/${file?.name}.json`, 
        options: { 
          bucket: {
            bucketName: outputs.custom.processedBucketName,
            region: 'af-south-1'
          }
        }
      }).result;

      const blob = await (result.body as any).blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Analysis_${file?.name}.json`;
      a.click();
      setStatus('Success! Resetting...');
      setTimeout(resetApp, 3000);
    } catch (e) { 
      setStatus('Download Error.'); 
      console.error(e);
    } finally { setIsBusy(false); }
  };

  const resetApp = () => {
    setFile(null);
    setIsUploaded(false);
    setIsProcessing(false);
    setIsReadyForExport(false);
    setStatus('Select a document to begin.');
  };

  const LoadingSpinner = () => <span className="spinner"></span>;

  return (
    <Authenticator>
      {({ signOut }) => (
        <main className="syntrix-dashboard">
          <h1>SYNTRIX INTELLIGENCE PORTAL</h1>
          <div className="action-card">
            <input type="file" accept=".pdf" disabled={isBusy} onChange={(e) => {
              const selectedFile = e.target.files?.[0] || null;
              setFile(selectedFile);
              if (selectedFile) {
                setIsUploaded(false);
                setIsProcessing(false);
                setIsReadyForExport(false);
                setStatus('File selected. Click Upload.');
              }
            }} />
            
            <div className="button-group">
              <button onClick={handleUpload} disabled={isBusy || !file || isUploaded}>
                {isBusy && !isUploaded ? <LoadingSpinner /> : "1. UPLOAD"}
              </button>
              <button onClick={handleProcess} disabled={isBusy || !isUploaded || isProcessing || isReadyForExport}>
                {isBusy && isUploaded && !isProcessing ? <LoadingSpinner /> : "2. PROCESS"}
              </button>
              <button onClick={handleExport} disabled={isBusy || !isReadyForExport} className={isReadyForExport ? 'pulse' : ''}>
                {isBusy && isReadyForExport ? <LoadingSpinner /> : "3. EXPORT"}
              </button>
            </div>
            {status && <p className="status-bar">{isProcessing ? "🔍 " : ""}{status}</p>}
          </div>
          <button onClick={signOut} className="logout-btn">Terminate Session</button>
        </main>
      )}
    </Authenticator>
  );
}

export default App;