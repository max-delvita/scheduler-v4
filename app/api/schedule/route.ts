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
    /(?:address\s*:|building|floor|suite|room\s+\d+|rm\s+\d+)/i
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

// Define the Zod schema for the AI's structured output
const schedulingDecisionSchema = z.object({
  next_step: z.enum([
    'request_clarification', // Need more info from sender
    'ask_participant_availability', // Need to email participants for times
    'propose_time_to_organizer', // Have availability, need organizer confirmation
    'propose_time_to_participant', // Need to ask another participant about a proposed time
    'send_final_confirmation', // All agreed, send calendar invite details
    'no_action_needed', // e.g., received a simple thank you, nothing to schedule/reply to
    'error_cannot_schedule', // Cannot fulfill the request
  ]).describe("The next logical step in the scheduling process based on the conversation."),
  recipients: z.array(z.string().email()).describe("An array of email addresses to send the generated email_body to. Should be empty if next_step is 'no_action_needed' or 'error_cannot_schedule'."),
  email_body: z.string().describe("The content of the email body to send to the specified recipients. Should be empty if next_step is 'no_action_needed'. Format as plain text."),
  // Optional fields we might add later:
  // proposed_datetime: z.string().optional().describe("ISO 8601 string if a specific time is being proposed."),
  confirmed_datetime: z.string().optional().describe("ISO 8601 string if a time has been confirmed."),
});

// Enhanced System Prompt for Structured Output
const systemMessage = `You are an AI assistant specialized in scheduling meetings via email conversations.
Your primary goal is to coordinate a meeting time between an organizer and one or more participants.

Follow these steps:
1.  Analyze the incoming email (From Name and Email, Subject, Body) and the entire conversation history.
2.  Determine the current state and the most logical next step in the scheduling process.
3.  Identify the specific recipient(s) for the next communication.
4.  Generate the plain text email body for the next communication.
5.  Output your decision using the provided JSON schema with fields: 'next_step', 'recipients', 'email_body'.

Workflow Stages & 'next_step' values:
*   Initial Request Received (often CC'd): When a new meeting request is received, your FIRST action should ALWAYS be to contact the PARTICIPANTS (not the organizer) to collect their availability. The participants' emails are listed in the "Participants involved in this session" field of the user message. Set 'next_step' to 'ask_participant_availability' and set 'recipients' to contain ONLY the participant emails (never include the organizer at this stage). Only use 'request_clarification' (emailing the organizer) if the meeting's purpose is completely unclear OR if no participants could be identified.
*   Receiving Availability: Analyzing the sender's response (using their name if available, e.g., "Bob mentioned he is available..."). If more participants need checking, use 'ask_participant_availability' or 'propose_time_to_participant' for the *next* participant listed in the session. If all participants responded, use 'propose_time_to_organizer' and email *only* the organizer with proposed time(s), clearly stating who suggested which times (e.g., "Bob suggested Tuesday at 4pm.").
    When asked to propose times after receiving availability from multiple participants (identified by their separate messages in the history), analyze *all* their responses together. Identify time slots where *everyone* is available. Propose only these common slots to the organizer using 'propose_time_to_organizer'. If no common slots are found, state this clearly and summarize the individual availabilities.
*   Organizer Confirmation: If organizer agrees, use 'send_final_confirmation' and include *all* participants and the organizer in recipients. If organizer disagrees/suggests changes (e.g., proposes a new time), use 'propose_time_to_participant' to relay the organizer's new suggestion to the participant(s). Only use 'ask_participant_availability' if the organizer rejects the time but doesn't offer a specific alternative.
*   Final Confirmation: Generate a summary email body and include all participants+organizer in recipients.
*   No Action: If the email is just a thank you or doesn't require a scheduling action, use 'no_action_needed' with empty recipients/body.
*   Error: If scheduling is impossible or request is invalid, use 'error_cannot_schedule'.

IMPORTANT EMAIL BODY RULES:
*   The 'email_body' field should contain ONLY the text for the email body.
*   Do NOT include greetings like "Hi [Name]," unless the 'recipients' array contains exactly ONE email address.
*   Do NOT include subject lines.
*   Be clear, concise, and professional, but also warm and friendly.
*   **Crucially: When relaying availability or proposing times based on a participant's response, refer to them by name.**
*       - Use the Organizer's name provided in the 'Key People' context.
*       - For Participants, the 'Key People' context provides a name derived from their email (e.g., 'Jdoe' for 'j.doe@example.com'). However, **check the conversation history first!** If a participant signed off their email with a different name (e.g., "Thanks, John"), prioritize using *that* name ("John") instead of the derived name ('Jdoe') when referring to them.
*       - Example: If the context says participant is "Mdelvita (mdelvita@gmail.com)" but a previous message from them ends with "Thanks, Max", refer to them as "Max" in your response (e.g., "Max mentioned...").
*   Do not attribute availability to yourself (Amy).

TONE AND STYLE GUIDELINES:
*   Always write in a warm, friendly, and conversational tone as if you're a helpful human assistant.
*   **Initial Greeting to Participants:** When sending the *first* message to a participant (usually when the process starts and you need to ask for their availability):
       1.  **First, examine the very first message in the conversation history (which is the organizer's initial request).** Read the body text carefully. Did the organizer mention the participant's name there (e.g., "Please schedule a meeting with John Doe", "Can you find time for me and Jane?")?
       2.  **If you confidently identify the participant's name mentioned in that initial request body text, use *that* name in the greeting (e.g., "Hi John,").**
       3.  **Otherwise (if the name wasn't mentioned in the body text or you're unsure), use the generic greeting "Hi there,".** This is safer than using the name derived from the email address found in the context.
*   When writing to the organizer, you can generally use "Hi [Name]," as their name is usually known accurately from the context.
*   After the initial contact, when referring to participants, use the name guidance provided in the 'IMPORTANT EMAIL BODY RULES' section (prioritizing names found in the conversation history/signatures).
*   Use natural language and conversational phrases like "Thanks for your response", "I hope this works for you", or "Looking forward to hearing from you".
*   Balance professionalism with warmth - be efficient but not robotic.
*   Personalize messages when possible by using names and acknowledging previous communications.
*   Use occasional polite expressions like "I appreciate your quick response" or "Thanks for sharing your availability".
*   Adapt your formality based on context - more casual for quick check-ins, more formal for final confirmations.
*   Feel free to use gentle humor when appropriate, but maintain professionalism.
*   When following up with participants, reference other participants' responses to create context.

TIME ZONE HANDLING:
*   If you identify time zone information in the conversation (e.g., "I'm in EST", "3pm PST works for me"), use it when discussing times.
*   When a time is mentioned with a time zone (e.g., "4pm EST"), display this time in the recipient's time zone if known (e.g., "4pm EST / 1pm PST" when writing to someone in PST).
*   For the final confirmation, always include the meeting time in all relevant time zones if participants are in different time zones.
*   If no time zone information is provided, keep times as stated in the original messages.
*   Time zones may appear as abbreviations (EST, PST, GMT+1) or full names (Eastern Time, Pacific Standard Time).

MEETING DURATION AND LOCATION:
*   Always include meeting duration in your communications when available (e.g., "30 minutes", "1 hour").
*   If duration is not specified, ask the organizer how long the meeting will be.
*   Clearly indicate whether the meeting is virtual or in-person.
*   For virtual meetings, simply state "Location: Virtual" unless specific virtual meeting details are provided.
*   For in-person meetings, include the full location details when available.
*   When proposing times, confirm both the time and expected duration.
*   In the final confirmation, include complete details about duration and location.

Time Proposal Format: When using 'propose_time_to_organizer', format the email_body like this:

Hi [Organizer],

Good news! I've collected availability from everyone and found some possible meeting times for "[meeting_topic]".

Based on everyone's responses, here are the options that work:

OPTION 1:
Date: {date1}
Time: {start_time1} - {end_time1} {primary_timezone1}
{If participants are in different time zones, include conversions:
Time in EST: 4:00 PM - 5:00 PM
Time in PST: 1:00 PM - 2:00 PM}
Duration: {duration}
Location: {location}

OPTION 2:
Date: {date2}
Time: {start_time2} - {end_time2} {primary_timezone2}
{Include time zone conversions if needed}

AVAILABILITY SUMMARY:
{list each participant and their available times in bullet points}

Let me know which option you prefer, or if you'd like me to find alternative times.

Thanks,
Amy

Participant Availability Request Format: When using 'ask_participant_availability', format the email_body like this:

Hi [Name],

I'm Amy, [Organizer's] scheduling assistant. [Organizer] has asked me to help coordinate a meeting on "[meeting_topic]".

Could you share some times when you're available? The meeting details are:

Topic: {meeting_topic}
Duration: {duration or "30-60 minutes if not specified"}
Proposed date range: {date_range or "in the next week" if not specified"}
Location: {location or "Virtual" if not specified}

You can respond in any format that works for you - I'm flexible!

Thanks for your help,
Amy

Participant Follow-up Format: When using 'propose_time_to_participant', format the email_body like this:

Hi [Name],

Thanks for your patience. I've heard back from [name of other participant(s)] regarding the "[meeting_topic]" meeting.

Based on the availability shared so far, it looks like the following time(s) might work:

Date: {date}
Time: {time} {timezone}
{Include timezone conversions if needed}
Duration: {duration}
Location: {location}

Would this time work for you? If not, please let me know your availability and I'll find an alternative.

Thanks,
Amy

Final Confirmation Format: When using 'send_final_confirmation', format the email_body like this:

Hi everyone,

I've confirmed the meeting details for "[meeting_topic]". Here's all the information you need:

MEETING CONFIRMED

Topic: {meeting_topic}
Date: {date}
Time: {start_time} - {end_time} {primary_timezone}
{If different time zones detected, list conversions here like: 
Time in EST: 4:00 PM - 5:00 PM
Time in PST: 1:00 PM - 2:00 PM}
Duration: {duration}
Location: {location with specific details}

PARTICIPANTS:
- {organizer_name} (Organizer)
{list all participants with bullet points}

MEETING DETAILS:
{Include any additional context, agenda items, preparation needed, etc.}

I've sent this confirmation to all participants. If you need to make any changes, please let me know.

Best regards,
Amy

IMPORTANT: When using 'send_final_confirmation', you should also set the 'confirmed_datetime' field to an ISO 8601 string (e.g., "2025-04-15T15:00:00Z") representing the confirmed meeting start time. This allows the system to automatically track the confirmed meeting time.

Clarification Request Format: When using 'request_clarification', format the email_body like this:

Hi [Organizer],

I'm Amy, your scheduling assistant. I'd like to help coordinate your meeting, but I need a bit more information to get started.

{Explain what information is missing, such as:
- Specific participants' email addresses
- Preferred date range
- Meeting duration
- Meeting location details
- Any other information}

Once you provide this information, I can reach out to the participants and find a time that works for everyone.

Thanks,
Amy`;

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
  let trace: ReturnType<Langfuse["trace"]> | undefined = undefined;
  let sessionParticipants: string[] = [];
  let initialMessageIdForThread: string | null = null; // Still useful for References header

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
      // Use sessionId if available, otherwise maybe a unique ID like messageId?
      // Using messageId might create a new trace for every email if session isn't found initially.
      // Consider if upserting based on a derived session identifier is better.
      id: `schedule-session:${sessionId || messageId}`, // Keep unique ID for this specific API call
      sessionId: sessionId ?? undefined, // Add the Supabase session ID here - Langfuse will group traces with the same sessionId
      name: "schedule-request",
      userId: senderEmail, // Associate trace with the sender
      metadata: initialTraceMetadata
    });

    // --- Session Identification: Prioritize MailboxHash --- 
    if (mailboxHash && mailboxHash.length > 10) { // Basic check if hash looks valid (e.g., like a UUID)
       console.log(`Attempting session lookup using MailboxHash: ${mailboxHash}`);
       sessionId = mailboxHash; // Assuming the hash *is* the session ID
        // Fetch session data directly using the likely session ID
        const { data: sessionDirect, error: sessionDirectErr } = await supabase
            .from('scheduling_sessions')
            .select('organizer_email, participants')
            .eq('session_id', sessionId)
            .maybeSingle(); // Use maybeSingle as hash might be invalid

        if (sessionDirectErr) {
            console.error('Supabase error fetching session by MailboxHash:', sessionDirectErr);
            sessionId = null; // Reset session ID if lookup failed
        } else if (sessionDirect) {
            console.log(`Found session via MailboxHash: ${sessionId}`);
            sessionOrganizer = sessionDirect.organizer_email;
            sessionParticipants = sessionDirect.participants || [];
        } else {
            console.log(`MailboxHash ${mailboxHash} did not match any existing session.`);
            sessionId = null; // Reset session ID
        }
    } else {
        console.log("No valid MailboxHash found.");
    }

    // --- Fallback to In-Reply-To if MailboxHash didn't yield a session --- 
    if (!sessionId && inReplyToHeaderRaw) {
        const inReplyToClean = inReplyToHeaderRaw.replace(/[<>]/g, '').split('@')[0];
        console.log(`MailboxHash failed, falling back to InReplyTo lookup: ${inReplyToClean}`);
        // ... (The existing In-Reply-To lookup logic) ...
         const { data: originatingMessage, error: msgError } = await supabase
           .from('session_messages')
           .select('session_id, sessions:scheduling_sessions(organizer_email, participants)')
           .eq('postmark_message_id', inReplyToClean)
           .maybeSingle();
        // ... etc ... 
          if (msgError) {
            console.error('Supabase error fetching originating message by In-Reply-To:', msgError);
          } else if (originatingMessage && originatingMessage.session_id) {
            console.log(`Found existing session via InReplyTo fallback: ${originatingMessage.session_id}`);
             sessionId = originatingMessage.session_id;
             // Re-fetch session data if needed or trust joined data
             const sessionsData = originatingMessage.sessions as any;
              if (sessionsData) {
                  sessionOrganizer = sessionsData.organizer_email;
                  sessionParticipants = sessionsData.participants || [];
              } else {
                 // Fallback fetch if join was bad
                 const { data: sessionDirect, error: sessionDirectErr } = await supabase
                    .from('scheduling_sessions')
                    .select('organizer_email, participants')
                    .eq('session_id', sessionId)
                    .single();
                 if (sessionDirectErr) console.error('Fallback session fetch error:', sessionDirectErr);
                 else if (sessionDirect) {
                     sessionOrganizer = sessionDirect.organizer_email;
                     sessionParticipants = sessionDirect.participants || [];
                 }
              }
          } else {
               console.log(`InReplyTo fallback also failed for: ${inReplyToClean}.`);
          }
    }

    // --- Load History if Session was Found (by either method) --- 
    if (sessionId) {
         console.log(`Loading history for session: ${sessionId}`);
         const { data: historyMessages, error: historyError } = await supabase
            .from('session_messages')
            .select('message_type, body_text, postmark_message_id')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

         if (historyError) {
           console.error('Supabase error fetching history:', historyError);
         } else if (historyMessages && historyMessages.length > 0) {
           conversationHistory = historyMessages
             .map(mapDbMessageToCoreMessage)
             .filter((msg): msg is CoreMessage => msg !== null);
           // Use the FIRST message's ID for the overall thread reference
           initialMessageIdForThread = actualMessageIdHeaderValue || null;
           console.log(`Loaded ${conversationHistory.length} history messages.`);
         } else {
             console.log("Session found, but no history messages retrieved.");
             // If history is empty, maybe use the current message ID as the initial reference?
             initialMessageIdForThread = actualMessageIdHeaderValue || null;
         }
    }

    // --- New Session Creation (Only if NO session found by hash or header) ---
    if (!sessionId) {
        // ... (Keep existing new session creation logic, using extracted participants etc.) ...
         console.log("No existing session identified by hash or header, creating new one.");
         const agentEmail = (process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com').toLowerCase();
         let potentialParticipants: string[] = [];

         if (postmarkPayload.ToFull && Array.isArray(postmarkPayload.ToFull)) {
             potentialParticipants = potentialParticipants.concat(
                 postmarkPayload.ToFull.map(recipient => recipient.Email)
             );
         }
         if (postmarkPayload.CcFull && Array.isArray(postmarkPayload.CcFull)) {
             potentialParticipants = potentialParticipants.concat(
                 postmarkPayload.CcFull.map(recipient => recipient.Email)
             );
         }

         sessionParticipants = [...new Set(potentialParticipants)]
             // Filter out sender AND agent (base AND specific hash addresses)
             .filter(email => {
                 const lcEmail = email.toLowerCase();
                 const isSender = lcEmail === senderEmail.toLowerCase();
                 const isAgentBase = lcEmail === agentEmail;
                 // Check if email matches the agent's hash pattern (e.g., amy+...@...)         
                 const isAgentHashed = lcEmail.startsWith(agentEmail.split('@')[0] + '+') && lcEmail.endsWith('@' + agentEmail.split('@')[1]);
                 return !isSender && !isAgentBase && !isAgentHashed;
             });
         console.log(`Identified Participants (from To/Cc, excluding sender/agent/hash): ${sessionParticipants.join(', ') || 'None'}`);

         if (sessionParticipants.length === 0) {
              console.log("No participants found in To/Cc, attempting regex fallback on body...");
              const participantsMatch = textBody.match(/Participants?:\s*\n?([\s\S]*?)(?:\n\n|Thanks|Best regards)/i);
              const extractedParticipants = participantsMatch ? participantsMatch[1].split('\n').map(p => p.replace(/^-/, '').trim()).filter((p: string) => p.includes('@')) : [];
              sessionParticipants = extractedParticipants.filter(email => email.toLowerCase() !== senderEmail.toLowerCase() && email.toLowerCase() !== agentEmail);
              console.log(`Regex Fallback Participants: ${sessionParticipants.join(', ') || 'None'}`);
         }

         // Initialize participant status details
         const initialParticipantStatus = sessionParticipants.map((email): ParticipantStatusDetail => ({
            email: email,
            status: 'pending', // Initial status
            last_request_sent_at: null // No request sent yet
         }));

       const { data: newSession, error: newSessionError } = await supabase
         .from('scheduling_sessions')
         .insert({
           organizer_email: senderEmail,
           organizer_name: senderName,
           meeting_topic: subject,
           status: 'pending_participant_response', // Initial status
           participant_status_details: initialParticipantStatus,
           webhook_target_address: recipientEmail || 'unknown',
           participants: sessionParticipants, // Still store the simple list for quick reference? Maybe remove if participant_status_details is primary.
           organizer_timezone: detectTimeZone(textBody, senderEmail) || headerTimezone,
           meeting_duration: detectMeetingDuration(textBody),
           meeting_location: detectMeetingLocation(textBody).location,
           is_virtual: detectMeetingLocation(textBody).isVirtual,
         })
         .select('session_id, organizer_email, participants, organizer_name') // Select needed fields, including name
         .single();

       if (newSessionError) {
         console.error('Supabase error creating new session:', newSessionError);
         return NextResponse.json({ error: 'Failed to create scheduling session' }, { status: 200 });
       }
       sessionId = newSession.session_id;
       sessionOrganizer = newSession.organizer_email;
       let sessionOrganizerName = newSession.organizer_name;
       // Update trace metadata to indicate a new session was created
       trace?.update({ 
         metadata: { ...initialTraceMetadata, isNewSession: true } 
       });
       sessionParticipants = newSession.participants || []; // Keep this for now?
       conversationHistory = [];
       initialMessageIdForThread = actualMessageIdHeaderValue || null;
       console.log(`Created new session: ${sessionId}`);
    }

    // --- Guard: Ensure we have a valid sessionId now ---
    if (!sessionId) {
        console.error("Failed to obtain a valid session ID after all checks.");
        return NextResponse.json({ error: 'Failed to process scheduling session' }, { status: 200 });
    }

     // --- Fetch current session state including participant statuses ---
    const { data: currentSessionState, error: stateFetchError } = await supabase
        .from('scheduling_sessions')
        .select('status, participant_status_details, organizer_email, participants, organizer_name') // Fetch organizer_name
        .eq('session_id', sessionId)
        .single();

    if (stateFetchError || !currentSessionState) {
        console.error('Supabase error fetching current session state:', stateFetchError);
        return NextResponse.json({ error: 'Failed to fetch session state' }, { status: 200 });
    }

    // Update organizer/participant variables from fetched state if they were not set during session creation/lookup
    sessionOrganizer = currentSessionState.organizer_email;
    let sessionOrganizerName = currentSessionState.organizer_name;
    sessionParticipants = currentSessionState.participants || []; // Keep using this list?
    let participantDetails: ParticipantStatusDetail[] = currentSessionState.participant_status_details || [];

    // --- Determine Message Type ---
    const incomingMessageType =
      sessionOrganizer && senderEmail === sessionOrganizer
        ? 'human_organizer'
        : 'human_participant';

    // --- Save Incoming Message (Must happen before logic checks) ---
    console.log(`Saving incoming message as type: ${incomingMessageType}`);
    const { error: insertError } = await supabase.from('session_messages').insert({
        session_id: sessionId,
        postmark_message_id: actualMessageIdHeaderValue,
        sender_email: senderEmail,
        recipient_email: recipientEmail,
        subject: subject,
        body_text: textBody,
        body_html: htmlBody,
        in_reply_to_message_id: inReplyToHeaderRaw?.replace(/[<>]/g, '').split('@')[0] || null,
        message_type: incomingMessageType,
    });
    if (insertError) console.error('Supabase error saving incoming message:', insertError);
    else console.log("Incoming message saved to DB.");


    // --- Logic for Participant Replies ---
    if (incomingMessageType === 'human_participant') {
        console.log(`Handling reply from participant: ${senderEmail}`);
        let participantFound = false;
        let allParticipantsReplied = true; // Assume true initially

        participantDetails = participantDetails.map((p: ParticipantStatusDetail) => {
            if (p.email.toLowerCase() === senderEmail.toLowerCase()) {
                console.log(`Updating status for ${senderEmail} to 'received'`);
                participantFound = true;
                return { ...p, status: 'received' };
            }
            return p;
        });

        if (!participantFound) {
            console.warn(`Received email from ${senderEmail} who is not listed in participant_status_details for session ${sessionId}. Ignoring state update.`);
            // Decide how to handle this - maybe add them? For now, just log and continue.
        }

        // Check if all participants have replied after the update
        for (const p of participantDetails) {
            if (p.status !== 'received') {
                allParticipantsReplied = false;
                break;
            }
        }

        console.log(`All participants replied check: ${allParticipantsReplied}`);

        // Update the database with the new participant status
        const { error: statusUpdateError } = await supabase
            .from('scheduling_sessions')
            .update({ participant_status_details: participantDetails })
            .eq('session_id', sessionId);

        if (statusUpdateError) {
            console.error('Supabase error updating participant status:', statusUpdateError);
            // Consider how critical this is - maybe still proceed? For now, log and continue.
        }

        if (!allParticipantsReplied) {
            console.log(`Session ${sessionId}: Waiting for replies from other participants. No AI action taken.`);
            // Return success to Postmark, no further action needed for this email
            return NextResponse.json({ status: 'success_waiting_for_others' }, { status: 200 });
        } else {
            console.log(`Session ${sessionId}: All participants have replied. Proceeding to contact organizer.`);
            // Update session status? Maybe change to 'pending_organizer_confirmation'?
             await supabase
               .from('scheduling_sessions')
               .update({ status: 'pending_organizer_confirmation' }) // Update status
               .eq('session_id', sessionId);
             // Fall through to call AI below
        }
    }

    // --- If Organizer Reply or All Participants Replied, Proceed to AI ---
    console.log("Proceeding to prepare for AI call...");

    // --- Helper function to extract and capitalize name from email ---
    const getNameFromEmail = (email: string | null): string => {
      if (!email) return 'there'; // Default if email is missing
      const namePart = email.split('@')[0];
      // Basic capitalization, handles simple cases like 'john.doe' -> 'John.doe'
      // More complex logic could be added if needed (e.g., removing numbers, dots)
      return namePart.charAt(0).toUpperCase() + namePart.slice(1);
    };

    // Reload history INCLUDING the message just saved
    const { data: historyMessages, error: historyError } = await supabase
        .from('session_messages')
        .select('message_type, body_text, postmark_message_id') // Include ID if needed for context?
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });

    if (historyError) {
       console.error('Supabase error fetching history:', historyError);
       // Handle error - maybe return?
    } else if (historyMessages && historyMessages.length > 0) {
       conversationHistory = historyMessages
         .map(mapDbMessageToCoreMessage)
         .filter((msg): msg is CoreMessage => msg !== null);
       console.log(`Loaded ${conversationHistory.length} history messages for AI.`);
    }

    // --- Prepare for AI (Timezone/Meeting Details Context) ---
    // (Keep existing timezone/meeting details context preparation logic here...)
    let timeZoneContext = '';
    let meetingDetailsContext = '';
    // ... Fetch session details (like organizer_timezone, participant_timezones etc.) ...
     const { data: sessionDetailsForAI } = await supabase
      .from('scheduling_sessions')
      .select('organizer_timezone, participant_timezones, meeting_duration, meeting_location, is_virtual, organizer_name') // Fetch organizer_name
      .eq('session_id', sessionId)
      .single();

     if (sessionDetailsForAI) {
         // Use fetched name if available, otherwise fallback to extraction
         sessionOrganizerName = sessionDetailsForAI.organizer_name || getNameFromEmail(sessionOrganizer);
         // ... (existing logic to build timeZoneContext and meetingDetailsContext) ...
           // Process time zones
      let timeZones = [];
      if (sessionDetailsForAI.organizer_timezone) {
        timeZones.push(`${sessionOrganizerName || sessionOrganizer} (Organizer): ${sessionDetailsForAI.organizer_timezone}`);
      }
      if (sessionDetailsForAI.participant_timezones) {
        // Assuming participant_timezones is still stored separately? If not, extract from participantDetails
         const participantTzs = typeof sessionDetailsForAI.participant_timezones === 'string'
          ? JSON.parse(sessionDetailsForAI.participant_timezones)
          : sessionDetailsForAI.participant_timezones;
        for (const [email, tz] of Object.entries(participantTzs)) {
          timeZones.push(`${email}: ${tz}`);
        }
      }
      if (timeZones.length > 0) {
        timeZoneContext = `\\n\\nKnown Time Zones:\\n${timeZones.join('\\n')}`;
      }

      // Process meeting details
      let meetingDetails = [];
      if (sessionDetailsForAI.meeting_duration) {
        meetingDetails.push(`Duration: ${sessionDetailsForAI.meeting_duration}`);
      }
      if (sessionDetailsForAI.meeting_location) {
        const locationType = sessionDetailsForAI.is_virtual ? 'Virtual Location' : 'Physical Location';
        meetingDetails.push(`${locationType}: ${sessionDetailsForAI.meeting_location}`);
      }
      if (meetingDetails.length > 0) {
        meetingDetailsContext = `\\n\\nMeeting Details:\\n${meetingDetails.join('\\n')}`;
      }
     }


    const aiSystemMessage = systemMessage; // Use the global systemMessage constant

    const organizerName = sessionOrganizerName;
    const participantNames = participantDetails.map(p => getNameFromEmail(p.email));

    // Add participant status context for the AI? Optional, but could be helpful.
    const participantStatusContext = `\\n\\nParticipant Status:\\n${participantDetails.map((p: ParticipantStatusDetail) => `- ${getNameFromEmail(p.email)} (${p.email}): ${p.status}`).join('\\n')}`;

    // Add organizer name to the context
    const nameContext = `\\n\\nKey People:\\nOrganizer: ${organizerName} (${sessionOrganizer || 'Unknown'})\\nParticipants: ${participantNames.join(', ')}`;


    const messagesForAI: CoreMessage[] = [
        // System prompt is passed separately
        ...conversationHistory, // Ensure this includes the latest message
        // Add context explicitly here instead of relying on the last message content variable
        { role: 'user', content: `Session Context:${nameContext}${timeZoneContext}${meetingDetailsContext}${participantStatusContext}` } // Add name context
    ];
    console.log(`Sending ${messagesForAI.length} messages to AI (excluding system prompt). Last message should be context.`);
    // --- Call AI using generateObject ---
    console.log("Calling generateObject...");

    // --- Create Langfuse Generation ---
    const lfGeneration = trace?.generation({
      name: "scheduling-ai-decision",
      input: messagesForAI, // Log the messages sent to the AI
      model: 'gpt-4o', // Specify the model used
      metadata: {
        organizer: sessionOrganizerName || sessionOrganizer,
        participants: participantDetails.map(p => p.email),
        schemaUsed: 'schedulingDecisionSchema',
        sessionId: sessionId, // Link generation explicitly to session
      },
      // You might need modelParameters if you set any non-defaults
    });

    const { object: aiDecision, usage } = await generateObject({
      model: openai('gpt-4o'),
      schema: schedulingDecisionSchema,
      system: aiSystemMessage, // Use the updated system prompt
      messages: messagesForAI,
    });

    // --- End Langfuse Generation ---
    lfGeneration?.end({
      output: aiDecision, // Log the structured object returned by the AI
      usage: usage // Log the token usage
    });

    console.log("AI Usage:", usage);
    console.log("AI Decision Object:", JSON.stringify(aiDecision, null, 2));

    // --- Process AI Decision ---
    // (Existing logic to determine recipients based on next_step)
     let outgoingMessageId: string | null = null;
    const { next_step, recipients: aiSuggestedRecipients, email_body } = aiDecision;
    let finalRecipients: string[] = [];
    const agentEmail = (process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com').toLowerCase();
    const agentBase = agentEmail.split('@')[0];
    const agentDomain = agentEmail.split('@')[1];

    // Determine recipients based on the *AI's chosen next_step* and *session data*
    if (next_step === 'ask_participant_availability' || next_step === 'propose_time_to_participant') {
         finalRecipients = aiSuggestedRecipients || [];
         // Ensure organizer is not included if asking participants
         if (sessionOrganizer) {
            finalRecipients = finalRecipients.filter(r => r.toLowerCase() !== sessionOrganizer?.toLowerCase());
         }
         console.log(`Step requires emailing participant(s). Using AI recipients: ${finalRecipients.join(', ')}`);

         // --- Update last_request_sent_at for participants being contacted ---
         const nowISO = new Date().toISOString();
         let detailsUpdated = false;
         const updatedParticipantDetailsForRequest = participantDetails.map((p: ParticipantStatusDetail) => {
             if (finalRecipients.includes(p.email)) {
                 console.log(`Updating last_request_sent_at for ${p.email}`);
                 detailsUpdated = true;
                 // Also update status back to 'pending' or a 'followup_pending'? Or keep as 'received' if proposing a time?
                 // Let's assume the nudge logic resets status, so just update timestamp here.
                 return { ...p, last_request_sent_at: nowISO };
             }
             return p;
         });

         if (detailsUpdated) {
             const { error: requestTimeUpdateError } = await supabase
                 .from('scheduling_sessions')
                 .update({ participant_status_details: updatedParticipantDetailsForRequest })
                 .eq('session_id', sessionId);
             if (requestTimeUpdateError) {
                 console.error('Supabase error updating last_request_sent_at:', requestTimeUpdateError);
             } else {
                 // Update local variable for consistency if needed later
                 participantDetails = updatedParticipantDetailsForRequest;
             }
         }

    } else if (next_step === 'propose_time_to_organizer' || next_step === 'request_clarification') {
        if (sessionOrganizer) {
            finalRecipients = [sessionOrganizer];
             console.log(`Step requires emailing organizer. Using DB organizer: ${sessionOrganizer}`);
        } else {
            console.error(`Cannot perform step ${next_step}: Session organizer is unknown.`);
            finalRecipients = [];
        }
    } else if (next_step === 'send_final_confirmation') {
        // Final confirmation includes everyone
        const allParties = [
            ...(sessionOrganizer ? [sessionOrganizer] : []),
            ...(participantDetails.map((p: ParticipantStatusDetail) => p.email)) // Get emails from details
        ];
        finalRecipients = [...new Set(allParties)]; // Ensure uniqueness
        console.log(`Step requires emailing everyone. Final list: ${finalRecipients.join(', ')}`);
    } else {
        console.log(`Step is ${next_step}. No email recipients.`);
        finalRecipients = [];
    }

     // Safeguard: Filter out agent's own addresses
     finalRecipients = finalRecipients.filter(email => {
        const lcEmail = email.toLowerCase();
        const isAgentBase = lcEmail === agentEmail;
        const isAgentHashed = lcEmail.startsWith(agentBase + '+') && lcEmail.endsWith('@' + agentDomain);
        return !isAgentBase && !isAgentHashed;
    });


    // --- Send Email if needed ---
    if (finalRecipients.length > 0 && email_body && email_body.trim().length > 0) {
        console.log(`Attempting email send. Recipients: ${finalRecipients.join(', ')}`);
        const outgoingSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

        // Log details before sending
        console.log(`  Subject: ${outgoingSubject}`);
        console.log(`  Body snippet: ${email_body.substring(0, 100)}...`);

        // Determine sendAsGroup flag
        const sendAsGroup = next_step === 'send_final_confirmation';

        console.log(`  Calling sendSchedulingEmail function...`);

        outgoingMessageId = await sendSchedulingEmail({
            to: finalRecipients,
            subject: outgoingSubject,
            textBody: email_body,
            sessionId,
            triggeringMessageId: actualMessageIdHeaderValue,
            triggeringReferencesHeader: referencesHeader || null,
            sendAsGroup: sendAsGroup,
        });

        // --- Save AI Response ---
        if (outgoingMessageId) { // Only save if email was sent successfully (got an ID)
             console.log(`  sendSchedulingEmail returned message ID: ${outgoingMessageId}. Proceeding to save AI response.`);
             console.log("Saving AI response to DB.");
             const { error: aiSaveError } = await supabase
                .from('session_messages')
                .insert({
                    session_id: sessionId,
                    postmark_message_id: outgoingMessageId,
                    sender_email: process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com',
                    recipient_email: finalRecipients.join(', ') || null,
                    subject: outgoingSubject,
                    body_text: email_body,
                    message_type: 'ai_agent',
                    in_reply_to_message_id: actualMessageIdHeaderValue,
                });
             if (aiSaveError) console.error('Supabase error saving AI message:', aiSaveError);
             else console.log("AI Response saved to DB.");
        } else {
             console.error(`ERROR: sendSchedulingEmail failed to return a message ID. Email likely not sent to ${finalRecipients.join(', ')}. AI response NOT saved.`);
        }

    } else {
      // Log why email wasn't attempted
      if (finalRecipients.length === 0) {
        console.log(`Email not sent: No valid final recipients determined for next_step: ${next_step}.`);
      } else if (!email_body || email_body.trim().length === 0) {
        console.log(`Email not sent: AI generated an empty email body for next_step: ${next_step}.`);
      } else {
        console.log(`Email not sent: Conditions not met (Recipients: ${finalRecipients.length}, Body exists: ${!!email_body}). Next step: ${next_step}.`);
      }
    }

    // --- Update Session State ---
    // Determine the next overall status based on AI's next_step
    let nextSessionStatus = currentSessionState.status; // Default to current
    switch(next_step) {
        case 'ask_participant_availability':
        case 'propose_time_to_participant':
            nextSessionStatus = 'pending_participant_response'; // Waiting for participants again
            break;
        case 'propose_time_to_organizer':
        case 'request_clarification':
            nextSessionStatus = 'pending_organizer_confirmation'; // Waiting for organizer
            break;
        case 'send_final_confirmation':
            nextSessionStatus = 'confirmed';
            break;
        case 'error_cannot_schedule':
            nextSessionStatus = 'error';
            break;
        // 'no_action_needed' doesn't change the status from the previous state
    }

    const sessionUpdateData: Record<string, any> = { status: nextSessionStatus }; // Use status now

    // (Keep existing logic for updating meeting_duration, meeting_location, confirmed_datetime)
     // Check for duration and location in the latest message
    const detectedDuration = detectMeetingDuration(textBody);
    if (detectedDuration) {
      sessionUpdateData.meeting_duration = detectedDuration;
    }
    const detectedLocation = detectMeetingLocation(textBody);
    if (detectedLocation.location) {
      sessionUpdateData.meeting_location = detectedLocation.location;
      sessionUpdateData.is_virtual = detectedLocation.isVirtual;
    }
     if (next_step === 'send_final_confirmation') {
      if (aiDecision.confirmed_datetime) {
        sessionUpdateData.confirmed_datetime = aiDecision.confirmed_datetime;
      } else {
        const confirmedDateTime = extractConfirmedDateTime(email_body);
        if (confirmedDateTime) {
          sessionUpdateData.confirmed_datetime = confirmedDateTime;
        } else {
          console.log(`Could not extract confirmed date/time from final confirmation email`);
        }
      }
    }

    const { error: updateSessionError } = await supabase
      .from('scheduling_sessions')
      .update(sessionUpdateData)
      .eq('session_id', sessionId);

    if (updateSessionError) console.error('Supabase error updating final session info:', updateSessionError);


    // --- Return Success Response to Postmark ---
    console.log("Processing complete, returning 200 OK to Postmark.");
    return NextResponse.json({ status: 'success', decision: aiDecision }, { status: 200 });

  } catch (error) {
    console.error("Unhandled error in /api/schedule:", error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    // Ensure we still return 200 to Postmark to prevent retries on unhandled errors
    return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 200 });
  } finally {
    // --- Ensure Langfuse data is flushed --- 
    if (trace) { // Only shutdown if trace was created
      console.log("Shutting down Langfuse...");
      await langfuse.shutdownAsync();
      console.log("Langfuse shutdown complete.");
    }
  }
} 