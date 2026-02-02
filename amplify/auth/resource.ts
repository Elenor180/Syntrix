import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: true,
  },

  userSignup: {
    selfSignUp: true,
  },

  // Optional: You can still enforce a strong password policy
  // but it goes inside loginWith.email (not at root level)
  loginWith: {
    email: {
      verification: {
        // optional email verification settings
      },
      // password policy is configured here for email login
      password: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireNumbers: true,
        requireSymbols: true,
      },
    },
  },
});