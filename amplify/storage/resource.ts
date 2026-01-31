import { defineStorage } from '@aws-amplify/backend';

/**
 * Syntrix Ingestion Storage Configuration
 * Scoped to match the regional Orchestrator's 'raw/' and 'processed/' pathing.
 */
export const storage = defineStorage({
  name: 'syntrixDocs',
  access: (allow) => ({
    // 1. INGESTION PATH: Where the browser puts files for Cape Town to Ireland transfer
    'raw/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
    // 2. RESULTS PATH: Where the Ireland Textract job returns the final JSON
    'processed/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
    ]
  })
});