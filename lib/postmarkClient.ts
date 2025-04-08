import { ServerClient } from 'postmark';

// Ensure environment variable is set
const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;

if (!postmarkToken) {
  throw new Error("Missing environment variable POSTMARK_SERVER_TOKEN");
}

// Create and export the Postmark client instance
export const postmarkClient = new ServerClient(postmarkToken); 