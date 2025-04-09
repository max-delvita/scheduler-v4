import { postmarkClient } from './postmarkClient';
import { Header } from 'postmark'; // Import Header directly
import * as PostmarkAPI from 'postmark'; // Import full library under an alias for namespaced types

// Define interface for email parameters
interface SendEmailParams {
  to: string | string[];
  subject: string;
  textBody: string;
  sessionId: string; 
  triggeringMessageId: string; // The MessageID header value of the email that triggered this send action
  triggeringReferencesHeader: string | null; // The References header value from the triggering email
  sendAsGroup: boolean;
}

/**
 * Sends an email using Postmark, handling individual vs group sending and threading.
 */
export async function sendSchedulingEmail({
  to,
  subject,
  textBody,
  sessionId,
  triggeringMessageId,
  triggeringReferencesHeader,
  sendAsGroup,
}: SendEmailParams): Promise<string | null> {
  const baseFromAddress = process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com';
  if (baseFromAddress === 'scheduler@yourdomain.com') {
      console.warn("POSTMARK_SENDER_ADDRESS environment variable not set, using default.");
  }

  // Construct the unique Reply-To address using Mailbox Hash strategy
  const replyToAddress = `${baseFromAddress.split('@')[0]}+${sessionId}@${baseFromAddress.split('@')[1]}`;
  console.log(`Setting Reply-To: ${replyToAddress}`);

  // --- Construct Threading Headers ---
  const postmarkHeaders: Header[] = [];
  // Ensure triggeringMessageId has angle brackets for headers
  const triggerIdFormatted = triggeringMessageId.startsWith('<') && triggeringMessageId.endsWith('>')
    ? triggeringMessageId
    : `<${triggeringMessageId}>`;

  // Set In-Reply-To to the triggering message ID
  postmarkHeaders.push({ Name: 'In-Reply-To', Value: triggerIdFormatted });
  console.log(`Setting In-Reply-To: ${triggerIdFormatted}`);

  // Construct References: Start with existing references, then add the triggering ID if not present
  let refs = triggeringReferencesHeader || ''; 
  if (!refs.includes(triggerIdFormatted)) {
    if (refs) refs += ' '; // Add space if appending to existing refs
    refs += triggerIdFormatted;
  }
  // Add References header only if it's not empty
  if (refs.trim()) {
      postmarkHeaders.push({ Name: 'References', Value: refs.trim() });
      console.log(`Setting References: ${refs.trim()}`);
  }
  
  // --- Handle Recipients and Individual/Group Sending ---
  let firstRecipient: string;
  let remainingRecipients: string[] = [];
  let postmarkToField: string;
  const isMultipleRecipients = Array.isArray(to) && to.length > 1;

  if (Array.isArray(to)) {
    if (to.length === 0) {
        console.error('sendSchedulingEmail called with empty recipient array.');
        return null; // Cannot send email with no recipients
    }
    firstRecipient = to[0];
    remainingRecipients = to.slice(1);
  } else {
    firstRecipient = to;
  }

  if (isMultipleRecipients && sendAsGroup) {
    // Send as one email to everyone
    console.log(`Group email requested. Sending to all ${to.length} recipients in one email.`);
    postmarkToField = to.join(', '); // Join all recipients for the To field
    remainingRecipients = []; // No individual follow-up emails needed
    // Note: No specific anti-reply-all tag added for group sends (e.g., final confirmation)
  } else {
    // Send individually (or it's just one recipient anyway)
    console.log(`Individual email sending logic. First recipient: ${firstRecipient}`);
    postmarkToField = firstRecipient; // Send first email only to the first recipient
    // Add tag to discourage reply-all for individual sends
    postmarkHeaders.push({ Name: 'X-PM-Tag', Value: 'individual-recipient' });
  }

  // Add instruction for individual sends if multiple were intended
  let modifiedTextBody = textBody;
  if (isMultipleRecipients && !sendAsGroup && !textBody.includes("Please reply directly to me only")) {
    modifiedTextBody = textBody + "\n\nPlease reply directly to me only.";
  }
  
  // --- Send Email(s) --- 
  try {
    console.log(`Attempting to send email via Postmark to: ${postmarkToField}`);
    const response: PostmarkAPI.Models.MessageSendingResponse = await postmarkClient.sendEmail({
      From: baseFromAddress,
      To: postmarkToField, 
      Subject: subject,
      TextBody: modifiedTextBody,
      ReplyTo: replyToAddress, 
      MessageStream: 'outbound',
      Headers: postmarkHeaders.length > 0 ? postmarkHeaders : undefined,
    });
    console.log('Postmark email sent successfully:', response.MessageID);
    const firstMessageId = response.MessageID; // Capture the ID of the first message sent
    
    // Send to remaining recipients individually if needed
    if (remainingRecipients.length > 0) {
      // Use the same headers as the first email
      for (const recipient of remainingRecipients) {
        console.log(`Sending individual email to additional recipient: ${recipient}`);
        try {
            await postmarkClient.sendEmail({
              From: baseFromAddress,
              To: recipient, 
              Subject: subject,
              TextBody: modifiedTextBody, 
              ReplyTo: replyToAddress,
              MessageStream: 'outbound',
              Headers: postmarkHeaders.length > 0 ? postmarkHeaders : undefined,
            });
        } catch (loopError) {
            console.error(`Postmark send error for recipient ${recipient}:`, loopError);
            // Continue sending to others even if one fails?
        }
      }
    }
    
    // Return the MessageID of the *first* email sent in the batch
    return firstMessageId; 
  } catch (error) {
    console.error('Postmark send error (initial recipient): ', error);
    return null;
  }
} 