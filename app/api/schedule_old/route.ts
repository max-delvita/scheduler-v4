import { openai } from '@ai-sdk/openai';
import { generateObject, CoreMessage } from 'ai';
import { z } from 'zod'; // Import Zod
import { supabase } from '@/lib/supabaseClient'; // Import Supabase client
import { postmarkClient } from '@/lib/postmarkClient'; // Import Postmark client
import { NextResponse } from 'next/server'; // Use NextResponse for standard JSON responses
import type { MessageSendingResponse, Header } from 'postmark/dist/client/models'; // Adjusted imports
import type { InboundMessageDetails } from 'postmark/dist/client/models/messages/InboundMessage'; // Import Postmark Inbound type
import { sendSchedulingEmail } from '../../../lib/emailUtils'; // Import the refactored function
import { Langfuse } from "langfuse";

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  baseUrl: process.env.LANGFUSE_BASEURL
});


// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

// Define participant status detail type
interface ParticipantStatusDetail {
  email: string;
  status: string; // e.g., 'pending', 'received', 'nudged_1', 'nudged_2', 'timed_out'
  last_request_sent_at: string | null; // ISO string
}

// Helper function to detect time zone information in email content
function detectTimeZone(emailBody: string, senderEmail: string): string | null {
  // Common timezone patterns and abbreviations
  const timezonePatterns = [
    // GMT/UTC patterns
    { regex: /GMT[+-]\d{1,2}(?::\d{2})?/gi, extract: (match: string) => match },
    { regex: /UTC[+-]\d{1,2}(?::\d{2})?/gi, extract: (match: string) => match },
    
    // Named time zones with potential offsets
    { regex: /(?:(?:Eastern|Pacific|Central|Mountain|Atlantic)\s+(?:Standard|Daylight|Savings)?\s*Time)/gi, extract: (match: string) => match },
    
    // Common abbreviations
    { regex: /\b(?:EST|EDT|PST|PDT|CST|CDT|MST|MDT|AKST|AKDT|HST|AEST|IST|BST|CET|EET|JST|CST)\b/g, extract: (match: string) => match },
    
    // Time with explicit zone - FIX: This regex wasn't extracting the capture group correctly
    { regex: /\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+([a-z]{3,5})/gi, 
      extract: (match: string) => {
        const parts = match.match(/([a-z]{3,5})$/i); // Extract the timezone part only
        return parts ? match : null;
      }
    },
    
    // Common timezone mentions - FIX: This regex wasn't extracting the capture group correctly
    { regex: /time(?:\s+)?zone(?:\s+)?(?:is|:)?\s+([a-z0-9\/\s\+\-\_]+)/gi, 
      extract: (match: string) => {
        const parts = match.split(/time(?:\s+)?zone(?:\s+)?(?:is|:)?\s+/i);
        return parts && parts.length > 1 ? parts[1].trim() : match;
      }
    },
    
    // Additional common patterns
    { regex: /\b(?:in|from)\s+(?:the\s+)?([a-z]{3,5}|[a-z]+\s+(?:standard|daylight|savings)\s+time)\s+(?:time\s+)?zone/gi, 
      extract: (match: string) => {
        const parts = match.match(/\b(?:in|from)\s+(?:the\s+)?([a-z]{3,5}|[a-z]+\s+(?:standard|daylight|savings)\s+time)/i);
        return parts && parts.length > 1 ? parts[1].trim() : match;
      }
    }
  ];
  
  console.log(`DEBUG: Checking for time zone in email from ${senderEmail}`);
  
  // Try each pattern
  for (const pattern of timezonePatterns) {
    const matches = emailBody.match(pattern.regex);
    if (matches && matches.length > 0) {
      // Return the first match
      const extracted = pattern.extract(matches[0]);
      console.log(`DEBUG: Detected time zone: ${extracted} using pattern: ${pattern.regex}`);
      return extracted;
    }
  }
  
  // Try to extract from common phrases
  if (emailBody.includes("my timezone") || emailBody.includes("my time zone")) {
    const timezoneContext = emailBody.split(/my\s+time(?:\s+)?zone(?:\s+)?(?:is|:)?/i)[1]?.trim().split(/[.,\n]/)[0]?.trim();
    if (timezoneContext) {
      console.log(`DEBUG: Detected time zone from phrase: ${timezoneContext}`);
      return timezoneContext;
    }
  }
  
  console.log(`DEBUG: No time zone detected in email body from ${senderEmail}`);
  return null;
}

// Extract timezone from email headers (typically from the Date header)
function extractTimezoneFromHeaders(headers: Header[] | undefined): string | null {
  if (!headers || !Array.isArray(headers)) {
    console.log("DEBUG: No headers available to extract timezone");
    return null;
  }
  
  // Find the Date header
  const dateHeader = headers.find(h => h.Name.toLowerCase() === 'date');
  if (!dateHeader || !dateHeader.Value) {
    console.log("DEBUG: No Date header found");
    return null;
  }
  
  console.log(`DEBUG: Found Date header: ${dateHeader.Value}`);
  
  // Extract timezone from date header
  // Format is typically: "Wed, 25 May 2022 14:56:34 +0000 (UTC)" or similar
  
  // Try to extract timezone offset (e.g., +0000, -0700)
  const offsetMatch = dateHeader.Value.match(/\s([+-]\d{4})\s/);
  if (offsetMatch && offsetMatch[1]) {
    const offset = offsetMatch[1];
    console.log(`DEBUG: Extracted timezone offset from Date header: ${offset}`);
    return `GMT${offset}`;
  }
  
  // Try to extract timezone abbreviation (e.g., UTC, EST)
  const tzAbbrevMatch = dateHeader.Value.match(/\([A-Z]{3,5}\)$/);
  if (tzAbbrevMatch && tzAbbrevMatch[0]) {
    const tz = tzAbbrevMatch[0].replace(/[()]/g, '');
    console.log(`DEBUG: Extracted timezone abbreviation from Date header: ${tz}`);
    return tz;
  }
  
  console.log("DEBUG: Could not extract timezone from Date header");
  return null;
}

// Helper function to detect meeting duration from email content
function detectMeetingDuration(emailBody: string): string | null {
  // Common duration patterns
  const durationPatterns = [
    // Duration in minutes or hours with units
    { regex: /(?:for|duration|length|lasting)?\s*(?:of)?\s*(\d+)\s*(?:hour|hr|hours|hrs|min|minute|minutes)/gi, extract: (match: string) => match.trim() },
    
    // X-minute or X-hour mentions
    { regex: /(\d+)[-\s](?:hour|hr|minute|min)(?:\s+meeting|\s+call)?/gi, extract: (match: string) => match.trim() },
    
    // Duration range
    { regex: /(\d+)(?:\s*-\s*|\s+to\s+)(\d+)\s*(?:mins?|minutes|hours|hrs)/gi, extract: (match: string) => match.trim() },
    
    // Time range like "from 2pm to 3pm" or "2-3pm"
    { regex: /(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*-\s*|\s+to\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi, 
      extract: (match: string) => {
        // Simple extractor - future enhancement could calculate actual duration
        return match.trim();
      }
    },
    
    // Standard meeting durations
    { regex: /(?:standard|regular|typical|quick|brief|short|long)\s+(?:meeting|call)/gi, 
      extract: (match: string) => {
        const lowerMatch = match.toLowerCase().trim();
        // Map common descriptions to durations
        if (lowerMatch.includes('quick') || lowerMatch.includes('brief') || lowerMatch.includes('short')) {
          return '30 minutes';
        } else if (lowerMatch.includes('standard') || lowerMatch.includes('regular') || lowerMatch.includes('typical')) {
          return '60 minutes';
        } else if (lowerMatch.includes('long')) {
          return '90 minutes';
        }
        return match.trim();
      }
    }
  ];
  
  // Try each pattern
  for (const pattern of durationPatterns) {
    const matches = emailBody.match(pattern.regex);
    if (matches && matches.length > 0) {
      // Return the first match
      return pattern.extract(matches[0]);
    }
  }
  
  return null;
}

// Helper function to detect meeting location from email content
function detectMeetingLocation(emailBody: string): { isVirtual: boolean, location: string | null } {
  const defaultResult = { isVirtual: true, location: "Virtual" };
  
  // Check for virtual meeting indicators
  const virtualMeetingPatterns = [
    /(?:zoom|teams|google meet|meet\.google|webex|skype|hangouts|virtual|online|web|video|conference call)/i,
    /(?:call|conference|meeting) link/i,
    /(?:join|connect)(?:\s+the)?\s+(?:meeting|call)/i,
    /meeting url|url for (?:the|our) (?:meeting|call)/i
  ];
  
  // Check for in-person meeting indicators
  const inPersonPatterns = [
    /(?:in[-\s]person|on[-\s]site|face[-\s]to[-\s]face|in[-\s]office|at\s+(?:the\s+)?office)/i,
    /(?:meeting\s+room|conference\s+room|office\s+space|location\s*:)/i,
    /(?:address\s*:|building|floor|suite|room\s+\d+|rm\s+\d+)/i,
    /(?:grab|have|get|for)\s+(?:a\s+)?(coffee|lunch|drinks?)/i,
    /meet\s+(?:at|in)\s+(?:my|your|the)\s+office/i
  ];
  
  // Check for specific locations
  const locationExtractPatterns = [
    // Address pattern
    { regex: /(?:at|in|location|address|place)\s*:?\s*((?:\d+\s+[a-z0-9\s\.,]+\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|place|pl|court|ct|way|circle|cir|square|sq))[^.]*)/i, 
      extract: (match: string, groups: string[]) => groups[0]?.trim() 
    },
    
    // Room/building pattern
    { regex: /(?:in|at)\s+(?:the\s+)?((?:conference|meeting)\s+room|(?:building|room|office)\s+[a-zA-Z0-9-]+)/i,
      extract: (match: string, groups: string[]) => groups[0]?.trim()
    },
    
    // Office/location name
    { regex: /(?:at|in)\s+(?:the\s+)?([a-z0-9\s]+\b(?:office|headquarters|hq|building|campus|center|location))/i,
      extract: (match: string, groups: string[]) => groups[0]?.trim()
    },
    
    // Location directly after "at" or "in"
    { regex: /(?:at|in)\s+(?:the\s+)?([A-Z][a-zA-Z0-9\s]+)(?:\s+(?:on|at)\s+)/i,
      extract: (match: string, groups: string[]) => groups[0]?.trim()
    }
  ];
  
  // First check if it's a virtual meeting
  for (const pattern of virtualMeetingPatterns) {
    if (pattern.test(emailBody)) {
      return defaultResult;
    }
  }
  
  // Then check if it's explicitly in-person
  let isInPerson = false;
  for (const pattern of inPersonPatterns) {
    if (pattern.test(emailBody)) {
      isInPerson = true;
      break;
    }
  }
  
  // If it seems to be in-person, try to extract the location
  if (isInPerson) {
    for (const pattern of locationExtractPatterns) {
      const match = emailBody.match(pattern.regex);
      if (match && match.length > 1) {
        return { isVirtual: false, location: match[1].trim() };
      }
    }
    
    // If we know it's in-person but couldn't extract a specific location
    return { isVirtual: false, location: "In-person (location not specified)" };
  }
  
  // Default to virtual if no clear indicators
  return defaultResult;
}

// --- SCHEMAS --- 

// Keep existing Executor Schema (ensure it includes all necessary fields like 'process_cancellation', etc.)
const schedulingDecisionSchema = z.object({
  next_step: z.enum([
    'request_clarification', 
    'ask_participant_availability', 
    'propose_time_to_organizer', 
    'propose_time_to_participant', 
    'send_final_confirmation', 
    'process_cancellation', 
    'inform_organizer_of_participant_cancellation',
    'process_organizer_change_request',
    'inform_organizer_of_participant_change_request',
    'no_action_needed',
    'error_cannot_schedule',
  ]).describe("The next logical step in the scheduling process based on the conversation."),
  recipients: z.array(z.string().email()).describe("An array of email addresses to send the generated email_body to. Should be empty if next_step is 'no_action_needed' or 'error_cannot_schedule'."),
  email_body: z.string().describe("The content of the email body to send to the specified recipients. Should be empty if next_step is 'no_action_needed'. Format as plain text."),
  confirmed_datetime: z.string().optional().describe("ISO 8601 string if a time has been confirmed."),
});

// NEW: Router Output Schema
const routerOutputSchema = z.object({
  intent: z.enum([
    'new_schedule_request', // Organizer initiating a new request
    'provide_availability', // Participant replying with availability
    'propose_alternative', // Participant/Organizer suggesting different time/details than proposed
    'confirm_time', // Participant/Organizer agreeing to a proposed time
    'request_clarification_query', // Participant/Organizer asking a question needing clarification (distinct from agent needing clarification)
    'request_cancellation', // Explicit request to cancel
    'request_reschedule', // Explicit request to change/reschedule a confirmed/pending meeting
    'simple_reply', // Non-actionable reply (e.g., "thanks", "ok")
    'unknown' // Could not determine intent
  ]).describe("The primary intent of the sender's latest email message."),
  cancelling_participant_email: z.string().email().optional().describe("Email of the participant requesting cancellation/reschedule, if applicable and if the intent is request_cancellation or request_reschedule."),
  // Add more extracted entities here later if needed
}).describe("Classifies the intent of the incoming email and extracts key entities.");

// --- SYSTEM PROMPTS --- 

// Rename original system prompt to executorSystemMessage
// Ensure this contains ALL the detailed instructions for generating emails, handling different steps, etc.
const executorSystemMessage = `You are an AI assistant specialized in scheduling meetings via email conversations.
Your primary goal is to coordinate a meeting time between an organizer and one or more participants.

Follow these steps:
1.  Analyze the incoming email (From Name and Email, Subject, Body), the entire conversation history, AND the provided 'Detected Intent'.
2.  Determine the most logical next step in the scheduling process based on the 'Detected Intent' and conversation state.
3.  Identify the specific recipient(s) for the next communication.
4.  Generate the plain text email body for the next communication according to the required format for the determined 'next_step'.
5.  Output your decision using the provided JSON schema with fields: 'next_step', 'recipients', 'email_body'.

Workflow Stages & 'next_step' values:
*   Detected Intent 'new_schedule_request': Your FIRST action should usually be 'ask_participant_availability' (emailing PARTICIPANTS only). Exception: If the organizer proposed a specific time in their first email (check history/context), use 'propose_time_to_participant'. Only use 'request_clarification' if purpose/participants are truly unclear.
*   Detected Intent 'provide_availability': Analyze the sender's response. If more participants need checking, use 'ask_participant_availability' or 'propose_time_to_participant'. If all participants have responded (check context), use 'propose_time_to_organizer' (email organizer only with proposed times/summary).
*   Detected Intent 'confirm_time': If the sender confirmed a time, use 'send_final_confirmation' (recipients = all).
*   Detected Intent 'request_cancellation': Use the cancellation logic: If organizer cancelled, next_step='process_cancellation'. If participant cancelled, next_step='inform_organizer_of_participant_cancellation'.
*   Detected Intent 'request_reschedule': Use the reschedule logic: If organizer requested change, next_step='process_organizer_change_request'. If participant requested change, next_step='inform_organizer_of_participant_change_request'.
*   Detected Intent 'request_clarification_query': Address the query. If it requires organizer input (e.g., location unclear), use 'request_clarification'. Otherwise, answer directly and likely use 'no_action_needed' unless it changes the scheduling flow.
*   Detected Intent 'propose_alternative': Treat like 'provide_availability' or trigger appropriate change/reschedule flow if meeting was confirmed.
*   Detected Intent 'simple_reply' or 'unknown': Use 'no_action_needed'.

IMPORTANT EMAIL BODY RULES:
*   The 'email_body' field should contain ONLY the text for the email body.
*   Do NOT include greetings like "Hi [Name]," unless the 'recipients' array contains exactly ONE email address (except for specific formats like Cancellation/Confirmation).
*   Do NOT include subject lines.
*   Be clear, concise, professional, but also warm and friendly.
*   **Crucially: Use names correctly.** Refer to the 'Key People' context. Prioritize names found in signatures/history for participants over derived names.

TONE AND STYLE GUIDELINES:
*   Always write in a warm, friendly, and conversational tone.
*   Initial Greeting to Participants: Check original request body for name, otherwise use "Hi there,". Use "Hi [Name]," for the organizer.
*   Use natural language, personalize when possible.

TIME ZONE HANDLING:
*   Use identified time zones when discussing times. Convert if necessary and possible based on context.

MEETING DURATION AND LOCATION:
*   Use Location Context provided. Clarify ambiguous locations with the organizer ('request_clarification'). Include known details when proposing/confirming.

Time Proposal Format: When using 'propose_time_to_organizer', format the email_body like this:
   (Keep format example)

Participant Availability Request Format: When using 'ask_participant_availability', format the email_body like this:
   (Keep format example)

Participant Follow-up Format: When using 'propose_time_to_participant', format the email_body like this:
   (Keep format example)

Final Confirmation Format: When using 'send_final_confirmation', format the email_body like this:
   (Keep format example)
   (Remember to also output 'confirmed_datetime' in the JSON)

Clarification Request Format: When using 'request_clarification', format the email_body like this:
   (Keep format example)

Cancellation Format: When using 'process_cancellation', format the email_body like this:
   (Keep format example)

Inform Organizer of Participant Cancellation Format: When using 'inform_organizer_of_participant_cancellation', format the email_body like this:
   (Keep format example)

Process Organizer Change Request Format: When using 'process_organizer_change_request', format the email_body like this:
   (Keep format example)

Inform Organizer of Participant Change Request Format: When using 'inform_organizer_of_participant_change_request', format the email_body like this:
   (Keep format example)
`;

// NEW: Router System Prompt
const routerSystemMessage = `You are an expert email analyser. Your task is to read the latest incoming email message in the context of a scheduling conversation history and determine the sender's primary intent. The conversation involves an Organizer and one or more Participants trying to schedule a meeting.

Analyze the latest message ('user' role) based on the preceding history ('assistant' and 'user' roles) and the provided Session Context.

Output your analysis using the provided JSON schema with the fields 'intent' and optional 'cancelling_participant_email'.

Intent Definitions:
- new_schedule_request: The very first email from the organizer starting the scheduling process. Check if a session already exists based on context/history.
- provide_availability: The sender (usually a participant) is providing times they are available.
- propose_alternative: The sender suggests different times or details than what was previously discussed or proposed.
- confirm_time: The sender explicitly agrees to a previously proposed time.
- request_clarification_query: The sender is asking a question about the schedule or process (e.g., "Is this virtual?").
- request_cancellation: The sender explicitly wants to cancel the meeting (e.g., "cancel", "can't make it", "won't be able to join"). If a participant requests cancellation, populate 'cancelling_participant_email' with their email.
- request_reschedule: The sender explicitly wants to change the time/date/details of a pending or confirmed meeting (e.g., "need to reschedule", "can we move it?"). If a participant requests rescheduling, populate 'cancelling_participant_email' with their email.
- simple_reply: The email is short and non-actionable (e.g., "Thanks", "Got it", "Ok", "Sounds good").
- unknown: You cannot confidently determine the intent from the message.

Focus ONLY on classifying the intent and extracting the specified entities for the LATEST message. Do not generate replies or decide the next step for the overall scheduling process.`;

// Helper function to map DB message types to AI CoreMessage roles
function mapDbMessageToCoreMessage(dbMessage: { message_type: string; body_text: string | null }): CoreMessage | null {
  if (!dbMessage.body_text) return null; // Skip messages without text body

  switch (dbMessage.message_type) {
    case 'human_organizer':
    case 'human_participant':
      return { role: 'user', content: dbMessage.body_text };
    case 'ai_agent':
      return { role: 'assistant', content: dbMessage.body_text };
    default:
      return null; // Ignore unknown types
  }
}

// Helper function to extract meeting date and time from email body
function extractConfirmedDateTime(emailBody: string): string | null {
  // Look for the date and time in the final confirmation email format
  // Format is typically:
  // Date: Tuesday, April 15, 2025
  // Time: 3:00 PM - 4:00 PM EST
  
  let dateMatch = emailBody.match(/Date:\s*([^\n]+)/);
  let timeMatch = emailBody.match(/Time:\s*([^\n]+)/);
  
  if (!dateMatch || !timeMatch) return null;
  
  const dateStr = dateMatch[1].trim();
  const timeStr = timeMatch[1].trim();
  
  console.log(`Extracted date: ${dateStr}, time: ${timeStr}`);
  
  try {
    // Try to parse the date and time into a standardized format
    // This is a simple implementation - a more robust solution would use a date library
    const combinedStr = `${dateStr} ${timeStr.split('-')[0].trim()}`;
    const date = new Date(combinedStr);
    
    if (isNaN(date.getTime())) {
      console.log(`Could not parse date/time: ${combinedStr}`);
      return null;
    }
    
    // Return in ISO format
    return date.toISOString();
  } catch (e) {
    console.error('Error parsing confirmed date/time:', e);
    return null;
  }
}

export async function POST(req: Request) {
  console.log("\n--- /api/schedule POST endpoint hit ---");
  let postmarkPayload: InboundMessageDetails;
  try {
    postmarkPayload = await req.json();
  } catch (e) {
      console.error("Failed to parse incoming request JSON:", e);
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 200 });
  }

  // Extract key info
  const mailboxHash = postmarkPayload.MailboxHash;
  const senderEmail = postmarkPayload.FromFull?.Email || postmarkPayload.From;
  const senderName = postmarkPayload.FromFull?.Name || senderEmail; // Extract name, fallback to email
  const recipientEmail = postmarkPayload.OriginalRecipient;
  const subject = postmarkPayload.Subject || '(no subject)';
  const textBody = postmarkPayload.TextBody || '';
  const htmlBody = postmarkPayload.HtmlBody;
  const messageId = postmarkPayload.MessageID;
  const agentEmail = (process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com').toLowerCase();

  // --- Pre-check: Ensure essential sender info exists --- 
  if (!senderEmail || typeof senderEmail !== 'string') {
      // Log a warning, but return 200 OK so Postmark's webhook check passes.
      // Real emails should always have sender info.
      console.warn("Payload missing sender email. Assuming test ping or invalid data. Payload:", postmarkPayload);
      return NextResponse.json({ status: 'ignored_missing_sender' }, { status: 200 }); 
  }

  const findHeader = (name: string): string | undefined => {
      return postmarkPayload.Headers?.find((h: Header) => h.Name.toLowerCase() === name.toLowerCase())?.Value;
  }
  const inReplyToHeaderRaw = findHeader('In-Reply-To');
  const referencesHeader = findHeader('References');

  // --- Extract timezone from headers ---
  const headerTimezone = extractTimezoneFromHeaders(postmarkPayload.Headers);
  console.log(`Timezone from headers: ${headerTimezone || 'None detected'}`);
  
  // --- Find the ACTUAL Message-ID header for threading ---
  const rawMessageIdHeader = findHeader('Message-ID');
  // Extract the value *between* the angle brackets < >
  // If match fails, fallback to Postmark's ID or generate a temporary one.
  const actualMessageIdHeaderValue = rawMessageIdHeader?.match(/<(.+)>/)?.[1] || messageId || `missing-message-id-${Date.now()}`;

  // --- Loop Prevention & Logging Check --- 
  if (senderEmail.toLowerCase() === agentEmail) {
    console.log(`Received email FROM the agent itself (${senderEmail}). Checking for MailboxHash...`);
    if (!mailboxHash || mailboxHash.length < 10) { // Basic check if hash looks like a session ID
        console.warn(`Email from agent lacks valid MailboxHash. Assuming loop/error. Saving to discarded_agent_emails and discarding.`);
        
        // Save the problematic payload for later investigation
        try {
            const { error: logError } = await supabase
                .from('discarded_agent_emails')
                .insert({
                    postmark_message_id: messageId,
                    subject: subject,
                    from_email: senderEmail,
                    to_recipients: postmarkPayload.To, // Raw To string
                    cc_recipients: postmarkPayload.Cc, // Raw Cc string
                    in_reply_to_header: inReplyToHeaderRaw,
                    body_text: textBody,
                    full_payload: postmarkPayload // Store the whole object
                });
            if (logError) {
                console.error("Failed to save discarded email payload to DB:", logError);
            }
        } catch (dbError) {
            console.error("Exception while saving discarded email payload:", dbError);
        }
        
        // Return 200 OK to Postmark to stop retries
        return NextResponse.json({ status: 'discarded_agent_loop_detected' }, { status: 200 }); 
    }
    console.log("Email from agent HAS MailboxHash, proceeding with session lookup (unexpected but allowed)...");
  }
  // --- End Loop Prevention Check ---

  // Log key extracted info if proceeding
  console.log(`Extracted Info: From=${senderEmail}, Subject=${subject}, PostmarkID=${messageId}, ActualMessageIDHeader=${actualMessageIdHeaderValue}, MailboxHash=${mailboxHash || 'None'}, InReplyToRaw=${inReplyToHeaderRaw || 'None'}`);

  let sessionId: string | null = null;
  let conversationHistory: CoreMessage[] = [];
  let sessionOrganizer: string | null = null;
  let sessionOrganizerName: string | null = null; 
  let trace: ReturnType<Langfuse["trace"]> | undefined = undefined;
  let sessionParticipants: string[] = [];
  let initialMessageIdForThread: string | null = null; 
  let participantDetails: ParticipantStatusDetail[] = []; 
  let currentSessionState: any = null; 
  let incomingMessageType: string | null = null; // Define high up
  let timeZoneContext = ''; // Define high up
  let meetingDetailsContext = ''; // Define high up

  try {
    // --- Initialize Langfuse Trace ---
    const initialTraceMetadata = { 
      mailboxHash: mailboxHash,
      postmarkMessageId: messageId,
      subject: subject,
      recipientEmail: recipientEmail,
      // isNewSession will be updated later if session created
    };
    trace = langfuse.trace({
      id: `schedule-api-call:${messageId}`, // Use message ID for unique call trace
      sessionId: sessionId ?? undefined, 
      name: "schedule-request",
      userId: senderEmail, 
      metadata: initialTraceMetadata
    });

    // --- Session Identification & Initial State Population ---
    let isNewSession = false; 
    
    // 1. Try MailboxHash
    if (mailboxHash && mailboxHash.length > 10) { 
       console.log(`Attempting session lookup using MailboxHash: ${mailboxHash}`);
       sessionId = mailboxHash; 
       // Fetch essential data needed immediately + state
       const { data: sessionDirect, error: sessionDirectErr } = await supabase
           .from('scheduling_sessions')
           .select('session_id, organizer_email, organizer_name, participants, status, confirmed_datetime, participant_status_details(*)') // Fetch more details
           .eq('session_id', sessionId)
           .maybeSingle(); 

       if (sessionDirectErr) {
           console.error('Supabase error fetching session by MailboxHash:', sessionDirectErr);
           sessionId = null; // Reset session ID if lookup failed
       } else if (sessionDirect) {
           console.log(`Found session via MailboxHash: ${sessionId}`);
           currentSessionState = sessionDirect; // Store the fetched state
           sessionOrganizer = currentSessionState.organizer_email;
           sessionOrganizerName = currentSessionState.organizer_name;
           sessionParticipants = currentSessionState.participants || [];
           participantDetails = currentSessionState.participant_status_details || [];
           // Update trace with session ID now that we know it
           trace?.update({ sessionId: sessionId }); 
       } else {
           console.log(`MailboxHash ${mailboxHash} did not match any existing session.`);
           sessionId = null; // Reset session ID
       }
    } else {
        console.log("No valid MailboxHash found.");
    }

    // 2. Try In-Reply-To if session still unknown
    if (!sessionId && inReplyToHeaderRaw) {
        const inReplyToClean = inReplyToHeaderRaw.replace(/[<>]/g, '').split('@')[0];
        console.log(`MailboxHash failed or absent, falling back to InReplyTo lookup: ${inReplyToClean}`);
         const { data: originatingMessage, error: msgError } = await supabase
           .from('session_messages')
           // Join to get session details directly if possible
           .select('session_id, sessions:scheduling_sessions(session_id, organizer_email, organizer_name, participants, status, confirmed_datetime, participant_status_details(*))') 
           .eq('postmark_message_id', inReplyToClean)
           .maybeSingle();

        if (msgError) {
          console.error('Supabase error fetching originating message by In-Reply-To:', msgError);
        } else if (originatingMessage?.sessions) { // Check if join worked and session exists
           sessionId = originatingMessage.session_id;
           console.log(`Found existing session via InReplyTo fallback: ${sessionId}`);
           currentSessionState = originatingMessage.sessions as any; // Use joined data
           sessionOrganizer = currentSessionState.organizer_email;
           sessionOrganizerName = currentSessionState.organizer_name;
           sessionParticipants = currentSessionState.participants || [];
           participantDetails = currentSessionState.participant_status_details || [];
           trace?.update({ sessionId: sessionId }); // Update trace with session ID
        } else {
             console.log(`InReplyTo fallback failed for: ${inReplyToClean}.`);
        }
    }

    // 3. Create New Session if still not found
    if (!sessionId) {
         isNewSession = true;
         console.log("No existing session identified by hash or header, creating new one.");
         // --- Participant Extraction Logic --- (Keep existing To/Cc/Body fallback logic)
         const agentEmailForFilter = agentEmail; // Use variable for clarity
         let potentialParticipants: string[] = [];
         if (postmarkPayload.ToFull) { potentialParticipants = potentialParticipants.concat(postmarkPayload.ToFull.map(r => r.Email)); }
         if (postmarkPayload.CcFull) { potentialParticipants = potentialParticipants.concat(postmarkPayload.CcFull.map(r => r.Email)); }
         sessionParticipants = [...new Set(potentialParticipants)].filter(email => { /* Keep existing filter logic */
            const lcEmail = email.toLowerCase();
            const isSender = lcEmail === senderEmail.toLowerCase();
            const isAgentBase = lcEmail === agentEmailForFilter;        
            const isAgentHashed = lcEmail.startsWith(agentEmailForFilter.split('@')[0] + '+') && lcEmail.endsWith('@' + agentEmailForFilter.split('@')[1]);
            return !isSender && !isAgentBase && !isAgentHashed;
         });
         console.log(`Identified Participants (To/Cc): ${sessionParticipants.join(', ') || 'None'}`);
         if (sessionParticipants.length === 0) { /* Keep existing body regex fallback */ 
            const participantsMatch = textBody.match(/Participants?:\s*\n?([\s\S]*?)(?:\n\n|Thanks|Best regards)/i);
            const extractedParticipants = participantsMatch ? participantsMatch[1].split('\n').map(p => p.replace(/^-/, '').trim()).filter((p: string) => p.includes('@')) : [];
            sessionParticipants = extractedParticipants.filter(email => email.toLowerCase() !== senderEmail.toLowerCase() && email.toLowerCase() !== agentEmailForFilter);
            console.log(`Regex Fallback Participants: ${sessionParticipants.join(', ') || 'None'}`);
         }
         // --- End Participant Extraction ---

         const initialParticipantStatus = sessionParticipants.map((email): ParticipantStatusDetail => ({
            email: email, status: 'pending', last_request_sent_at: null 
         }));
         participantDetails = initialParticipantStatus; // Set initial details for later use

         // --- Insert New Session ---
       const { data: newSession, error: newSessionError } = await supabase
         .from('scheduling_sessions')
         .insert({
           organizer_email: senderEmail,
           organizer_name: senderName,
           meeting_topic: subject,
           status: 'pending_participant_response', 
           participant_status_details: initialParticipantStatus,
           webhook_target_address: recipientEmail || 'unknown',
           participants: sessionParticipants, 
           organizer_timezone: detectTimeZone(textBody, senderEmail) || headerTimezone,
           meeting_duration: detectMeetingDuration(textBody),
           meeting_location: detectMeetingLocation(textBody).location,
           is_virtual: detectMeetingLocation(textBody).isVirtual,
         })
         .select('*') // Select all fields to populate currentSessionState
         .single();

       if (newSessionError) {
         console.error('Supabase error creating new session:', newSessionError);
         throw new Error('Failed to create scheduling session'); // Throw error to be caught by outer catch
       }
       
       // --- Populate variables for the new session ---
       sessionId = newSession.session_id;
       sessionOrganizer = newSession.organizer_email;
       sessionOrganizerName = newSession.organizer_name;
       currentSessionState = newSession; // Use the newly created record as current state
       // sessionParticipants and participantDetails already set above
       conversationHistory = []; // Start with empty history for new session
       initialMessageIdForThread = actualMessageIdHeaderValue || null;
       
       // Update trace with session ID and new session flag
       trace?.update({ sessionId: sessionId, metadata: { ...initialTraceMetadata, isNewSession: true } });
       console.log(`Created new session: ${sessionId}`);
    }

    // --- Guard: Ensure we have a valid sessionId NOW --- 
    // (Redundant check, but safe)
    if (!sessionId) {
      console.error("Session ID is null after attempting find/create.");
      throw new Error('Session ID could not be established.');
    }

    // --- Load History if not a new session ---
    if (!isNewSession) {
         console.log(`Loading history for existing session: ${sessionId}`);
         const { data: historyMessages, error: historyError } = await supabase
            .from('session_messages')
            .select('message_type, body_text, postmark_message_id')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

         if (historyError) {
           console.error('Supabase error fetching history:', historyError);
           // Decide if this is fatal - perhaps continue with partial history? For now, log error.
         } else if (historyMessages && historyMessages.length > 0) {
           conversationHistory = historyMessages
             .map(mapDbMessageToCoreMessage)
             .filter((msg): msg is CoreMessage => msg !== null);
           console.log(`Loaded ${conversationHistory.length} history messages.`);
         } else {
             console.log("Session found, but no history messages retrieved.");
         }
    }

    // --- Determine Message Type (Now Safe) ---
    incomingMessageType =
        sessionOrganizer && senderEmail.toLowerCase() === sessionOrganizer.toLowerCase()
            ? 'human_organizer'
            : 'human_participant';

    // --- Save Incoming Message (Now Safe) ---
    console.log(`Saving incoming message as type: ${incomingMessageType}`);
    // ... (Existing insert message logic using sessionId, incomingMessageType) ...
    
    // --- Prepare Timezone/Meeting Context (Now Safe) ---
    // ... (Existing logic to build timeZoneContext/meetingDetailsContext using currentSessionState) ...

    // --- Prepare Messages for Router --- 
    const messagesForRouter: CoreMessage[] = [
        ...conversationHistory, 
        { role: 'user', content: textBody }, 
        { role: 'user', content: `Session Context:\nOrganizer: ${sessionOrganizerName || sessionOrganizer} (${sessionOrganizer || 'Unknown'})\nParticipants: ${participantDetails.map(p => p.email).join(', ')}\nCurrent Session Status: ${currentSessionState?.status || 'new'}\nConfirmed Datetime: ${currentSessionState?.confirmed_datetime || 'None'}` }
    ];

    // --- Call Router Agent --- 
    console.log(`Calling Router Agent...`);
    const lfRouterGeneration = trace?.generation({ /* ... */ });
    const { object: routerDecision } = await generateObject({ /* ... */ });
    lfRouterGeneration?.end({ /* ... */ });
    console.log("Router Agent Decision:", routerDecision);

    // --- Process Router Intent --- 
    const intent = routerDecision.intent;
    let executorDecision; // = { next_step: 'no_action_needed', recipients: [], email_body: '' }; // Default
    let finalRecipients: string[] = [];
    let outgoingMessageId: string | null = null;
    let nextSessionStatus = currentSessionState?.status; 
    let sessionUpdateData: Record<string, any> = {}; 

    // == Perform state updates based on router intent FIRST ==
    if ((intent === 'request_cancellation' || intent === 'request_reschedule') && incomingMessageType === 'human_participant') {
        const cancellingEmail = routerDecision.cancelling_participant_email?.toLowerCase();
        const senderEmailLower = senderEmail.toLowerCase();
        if (cancellingEmail && cancellingEmail === senderEmailLower) {
            // ... (Participant status update logic, update sessionUpdateData.participant_status_details) ...
        }
        if (intent === 'request_reschedule' && currentSessionState?.status === 'confirmed') {
            sessionUpdateData.confirmed_datetime = null;
        }
    }

    // == Determine next action (Executor Call or Skip) ==
    switch (intent) {
        case 'new_schedule_request':
        // ... other cases needing executor ...
            console.log(`Intent ${intent} requires Executor Agent action.`);
            const messagesForExecutor: CoreMessage[] = [
                // ... (Assemble messages including timeZone/meeting context) ...
            ];
            console.log(`Calling Executor Agent...`);
            const lfExecutorGeneration = trace?.generation({ /* ... */ });
            const { object: decisionFromExecutor, usage } = await generateObject({ /* ... executor args ... */ });
            lfExecutorGeneration?.end({ /* ... */ });
            executorDecision = decisionFromExecutor;
            console.log("Executor Agent Decision:", executorDecision);
            break;
        // ... other cases (simple_reply, unknown) ...
        default:
             executorDecision = { next_step: 'no_action_needed', recipients: [], email_body: '' };
             break;
    }

    // --- Process Executor Decision --- 
    // (This is where the bulk of the *original* logic after the AI call should be moved/adapted)
    const { next_step, recipients: aiSuggestedRecipients, email_body } = executorDecision;

    // Determine final recipients based on EXECUTOR'S next_step
    // ... (Existing complex recipient logic based on next_step) ...
    
    // --- Send Email if needed (based on executor decision) ---
    // ... (Existing email sending logic) ...

    // --- Update Session State (based on executor decision) ---
    // ... (Existing switch statement to set nextSessionStatus based on next_step) ...
    sessionUpdateData = { ...sessionUpdateData, status: nextSessionStatus }; // Merge status
    // ... (Existing logic to update duration/location/confirmed_datetime based on executor decision) ...

    // Final DB Update
    if (Object.keys(sessionUpdateData).length > 0) {
        // ... (Existing Supabase update call) ...
    }

    // --- Return Success Response --- 
    console.log("Processing complete, returning 200 OK to Postmark.");
    return NextResponse.json({ /* ... */ });

  } catch (error) {
      console.error("Unhandled error in /api/schedule:", error);
      // ... Error Handling ...
  } finally {
      // ... Langfuse Shutdown ...
  }
} 