import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: true,                    // sign-in with email + password
    // phone: true,                 // uncomment if you also want phone login
  },

  userAttributes: {
    // Optional: add attributes you want to collect / store
    name: { mutable: true, required: false },
    family_name: { mutable: true, required: false },
    // email_verified: { mutable: false, required: true },
  },

  password: {
    minLength: 8,
    requireLowercase: true,
    requireUppercase: true,
    requireNumbers: true,
    requireSymbols: true,
  },

  // Allow users to sign themselves up
  userSignup: {
    selfSignUp: true,
    // autoConfirm: true,           // auto-confirm users (not recommended for production)
  },

  // Optional: add MFA later when ready
  // multifactor: {
  //   mode: 'OPTIONAL',
  //   sms: true,
  //   totp: true,
  // },
});