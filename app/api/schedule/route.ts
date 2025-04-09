import { openai } from '@ai-sdk/openai';
import { generateObject, CoreMessage } from 'ai';
import { z } from 'zod'; 
import { supabase } from '@/lib/supabaseClient'; // Assuming path is correct
import { postmarkClient } from '@/lib/postmarkClient'; // Assuming path is correct
import { NextResponse } from 'next/server'; 
import type { MessageSendingResponse, Header } from 'postmark/dist/client/models'; 
import type { InboundMessageDetails } from 'postmark/dist/client/models/messages/InboundMessage'; 
import { sendSchedulingEmail } from '../../../lib/emailUtils'; // Assuming path is correct
import { Langfuse } from "langfuse";

// --- Langfuse Initialization ---
const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  baseUrl: process.env.LANGFUSE_BASEURL // Ensure no quotes in env var!
});

// Allow streaming responses up to 30 seconds (adjust if needed)
export const maxDuration = 30; 

// --- Type Definitions ---
interface ParticipantStatusDetail {
  email: string;
  status: string; // e.g., 'pending', 'received', 'nudged_1', 'nudged_2', 'cancelled', 'timed_out'
  last_request_sent_at: string | null; // ISO string
  // Consider adding name: string | null here if we store participant names later
}

// --- Helper Functions (Copied for now, consider moving to lib/) ---

// NOTE: These are copied from the previous route.ts. Ensure they are up-to-date.
// It might be better to refactor these into a shared lib/scheduleUtils.ts file.

function detectTimeZone(emailBody: string, senderEmail: string): string | null {
    // ... (Implementation from previous route.ts) ...
    const timezonePatterns = [
        { regex: /GMT[+-]\d{1,2}(?::\d{2})?/gi, extract: (match: string) => match },
        { regex: /UTC[+-]\d{1,2}(?::\d{2})?/gi, extract: (match: string) => match },
        { regex: /(?:(?:Eastern|Pacific|Central|Mountain|Atlantic)\s+(?:Standard|Daylight|Savings)?\s*Time)/gi, extract: (match: string) => match },
        { regex: /\b(?:EST|EDT|PST|PDT|CST|CDT|MST|MDT|AKST|AKDT|HST|AEST|IST|BST|CET|EET|JST|CST)\b/g, extract: (match: string) => match },
        { regex: /\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+([a-z]{3,5})/gi, 
          extract: (match: string) => { const parts = match.match(/([a-z]{3,5})$/i); return parts ? match : null; }
        },
        { regex: /time(?:\s+)?zone(?:\s+)?(?:is|:)?\s+([a-z0-9\/\s\+\-\_]+)/gi, 
          extract: (match: string) => { const parts = match.split(/time(?:\s+)?zone(?:\s+)?(?:is|:)?\s+/i); return parts && parts.length > 1 ? parts[1].trim() : match; }
        },
        { regex: /\b(?:in|from)\s+(?:the\s+)?([a-z]{3,5}|[a-z]+\s+(?:standard|daylight|savings)\s+time)\s+(?:time\s+)?zone/gi, 
          extract: (match: string) => { const parts = match.match(/\b(?:in|from)\s+(?:the\s+)?([a-z]{3,5}|[a-z]+\s+(?:standard|daylight|savings)\s+time)/i); return parts && parts.length > 1 ? parts[1].trim() : match; }
        }
      ];
      // ... (rest of the function) ...
      return null; // Placeholder
}

function extractTimezoneFromHeaders(headers: Header[] | undefined): string | null {
    // ... (Implementation from previous route.ts) ...
    return null; // Placeholder
}

function detectMeetingDuration(emailBody: string): string | null {
    // ... (Implementation from previous route.ts) ...
     return null; // Placeholder
}

function detectMeetingLocation(emailBody: string): { isVirtual: boolean, location: string | null } {
    // ... (Implementation from previous route.ts including latest regex additions) ...
     const defaultResult = { isVirtual: true, location: "Virtual" };
     return defaultResult; // Placeholder
}

function mapDbMessageToCoreMessage(dbMessage: { message_type: string; body_text: string | null }): CoreMessage | null {
    // ... (Implementation from previous route.ts) ...
     return null; // Placeholder
}

function extractConfirmedDateTime(emailBody: string): string | null {
    // ... (Implementation from previous route.ts) ...
     return null; // Placeholder
}

function getNameFromEmail(email: string | null): string {
    // ... (Implementation from previous route.ts) ...
     return 'there'; // Placeholder
}

// --- Zod Schemas ---

// NEW: Router Output Schema
const routerOutputSchema = z.object({
  intent: z.enum([
    'new_schedule_request', 
    'provide_availability', 
    'propose_alternative', 
    'confirm_time', 
    'request_clarification_query',
    'request_cancellation', 
    'request_reschedule', 
    'simple_reply', 
    'unknown' 
  ]).describe("The primary intent of the sender's latest email message."),
  cancelling_participant_email: z.string().email().optional().describe("Email of the participant requesting cancellation/reschedule, if applicable and if the intent relates to cancellation/reschedule."),
  // Add more extracted entities here later if needed (e.g., proposed_time: z.string().optional())
}).describe("Classifies the intent of the incoming email and extracts key entities.");

// Executor Action Schema (Formerly schedulingDecisionSchema)
const executorActionSchema = z.object({
  next_step: z.enum([
    'request_clarification', // Agent needs more info from organizer
    'ask_participant_availability', // Agent emails participants for availability
    'propose_time_to_organizer', // Agent emails organizer with proposed time(s)
    'propose_time_to_participant', // Agent emails participant(s) with a proposed time
    'send_final_confirmation', // Agent emails everyone the final confirmation
    'process_cancellation', // Agent emails everyone confirming cancellation
    'inform_organizer_of_participant_cancellation', // Agent emails organizer about participant cancellation
    'process_organizer_change_request', // Agent emails participants about organizer's change request
    'inform_organizer_of_participant_change_request', // Agent emails organizer about participant's change request
    'no_action_needed', // Agent takes no email action
    'error_cannot_schedule', // Agent indicates an error state
  ]).describe("The specific action the assistant should take next."),
  recipients: z.array(z.string().email()).describe("An array of email addresses to send the generated email_body to. Should be empty if next_step is 'no_action_needed' or 'error_cannot_schedule'."),
  email_body: z.string().describe("The content of the email body to send to the specified recipients. Should be empty if next_step is 'no_action_needed'. Format as plain text."),
  confirmed_datetime: z.string().optional().describe("ISO 8601 string if a time has been confirmed via 'send_final_confirmation'."),
}).describe("Defines the next action to take in the scheduling process, including recipients and email content.");


// --- System Prompts ---

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


// Executor System Prompt (Based on the previous detailed prompt)
const executorSystemMessage = `You are an AI assistant specialized in scheduling meetings via email conversations. Your goal is to take a classified user intent and conversation context, determine the correct next action, and generate the appropriate email response.

INPUT: You will receive the conversation history, the latest user message, and a 'Session Context' containing the 'Detected Intent' (classified by a previous step) along with details about the Organizer, Participants, Session Status, Confirmed Time, Time Zones, and Meeting Details.

TASK:
1.  Review the 'Detected Intent'.
2.  Analyze the full context (history, latest message, session details).
3.  Determine the appropriate 'next_step' based *primarily* on the 'Detected Intent', but use the context to handle nuances (like specific time proposals, cancellation details, etc.).
4.  Identify the correct 'recipients' for that 'next_step'.
5.  Generate the 'email_body' according to the required format for the 'next_step', personalizing with names and details from the context.
6.  If the 'next_step' is 'send_final_confirmation', also determine and include the 'confirmed_datetime' in ISO 8601 format.
7.  Output your decision using the provided JSON schema ('executorActionSchema').

Workflow Guidance (map Detected Intent to likely next_step):
*   Detected Intent 'new_schedule_request': Usually next_step='ask_participant_availability' (to participants). Exception: if organizer proposed time -> next_step='propose_time_to_participant'. If unclear -> 'request_clarification'.
*   Detected Intent 'provide_availability': If more replies needed -> 'ask_participant_availability' / 'propose_time_to_participant'. If all replied -> 'propose_time_to_organizer'.
*   Detected Intent 'confirm_time': Usually next_step='send_final_confirmation'.
*   Detected Intent 'request_cancellation': If organizer cancelled -> next_step='process_cancellation'. If participant cancelled -> next_step='inform_organizer_of_participant_cancellation'.
*   Detected Intent 'request_reschedule': If organizer requested -> next_step='process_organizer_change_request'. If participant requested -> next_step='inform_organizer_of_participant_change_request'.
*   Detected Intent 'request_clarification_query': Address the query. Maybe next_step='request_clarification' if organizer input needed, otherwise often 'no_action_needed'.
*   Detected Intent 'propose_alternative': Treat like 'provide_availability' or trigger appropriate change/reschedule flow.
*   Detected Intent 'simple_reply' or 'unknown': Usually next_step='no_action_needed'.

IMPORTANT EMAIL BODY RULES & TONE: Follow all the detailed rules regarding greetings, subject lines, tone (warm, friendly, professional), name usage (prioritize history/signatures for participants), time zone handling, location details, and specific formats provided previously. These are crucial for generating correct and natural emails.
    
    (Include ALL the detailed formatting examples from the previous system prompt here: Time Proposal Format, Participant Availability Request Format, Participant Follow-up Format, Final Confirmation Format, Clarification Request Format, Cancellation Format, Inform Organizer Formats, etc.)

`;


// --- API Route Handler ---
export async function POST(req: Request) {
  console.log("\n--- /api/schedule_v2 POST endpoint hit ---");
  let postmarkPayload: InboundMessageDetails;
  let trace: ReturnType<Langfuse["trace"]> | undefined = undefined;

  // Variables to be populated
  let sessionId: string | null = null;
  let conversationHistory: CoreMessage[] = [];
  let sessionOrganizer: string | null = null;
  let sessionOrganizerName: string | null = null; 
  let sessionParticipants: string[] = [];
  let initialMessageIdForThread: string | null = null; 
  let participantDetails: ParticipantStatusDetail[] = []; 
  let currentSessionState: any = null; 
  let incomingMessageType: string | null = null;
  let timeZoneContext = ''; 
  let meetingDetailsContext = ''; 
  let senderEmail = ''; // Initialize
  let senderName = ''; // Initialize
  let subject = ''; // Initialize
  let textBody = ''; // Initialize
  let messageId = ''; // Initialize
  let actualMessageIdHeaderValue = ''; // Initialize
  let referencesHeader: string | null | undefined = ''; // Initialize
  let mailboxHash: string | null | undefined = ''; // Initialize

  try {
    // 1. Parse Payload & Extract Basic Info
    try {
        postmarkPayload = await req.json();
        senderEmail = postmarkPayload.FromFull?.Email || postmarkPayload.From;
        senderName = postmarkPayload.FromFull?.Name || senderEmail;
        subject = postmarkPayload.Subject || '(no subject)';
        textBody = postmarkPayload.TextBody || '';
        messageId = postmarkPayload.MessageID; // Postmark's MessageID
        mailboxHash = postmarkPayload.MailboxHash;
        // ... (extract other needed basic info like recipientEmail, agentEmail)

        const findHeader = (name: string): string | undefined => postmarkPayload.Headers?.find((h: Header) => h.Name.toLowerCase() === name.toLowerCase())?.Value;
        const rawMessageIdHeader = findHeader('Message-ID');
        actualMessageIdHeaderValue = rawMessageIdHeader?.match(/<(.+)>/)?.[1] || messageId || `missing-message-id-${Date.now()}`;
        referencesHeader = findHeader('References');

        if (!senderEmail) throw new Error("Missing sender email.");

    } catch (e) {
      console.error("Failed to parse incoming request JSON or extract basic info:", e);
      return NextResponse.json({ error: 'Invalid JSON payload or missing basic info' }, { status: 200 }); // Return 200 for Postmark
    }

    // 2. Initialize Langfuse Trace
     const initialTraceMetadata = { 
        postmarkMessageId: messageId,
        subject: subject,
        sender: senderEmail,
        mailboxHash: mailboxHash,
     };
     trace = langfuse.trace({
         id: `schedule-v2-call:${messageId}`, 
         name: "schedule-request-v2",
         userId: senderEmail, 
         metadata: initialTraceMetadata
     });

    // 3. Session Identification & State Loading
    console.log("--- Starting Session Identification ---");
    // TODO: Implement combined session finding/creation logic here
    // This block needs to set: sessionId, currentSessionState, sessionOrganizer, sessionOrganizerName, sessionParticipants, participantDetails
    // Update trace: trace?.update({ sessionId: sessionId, metadata: { ...initialTraceMetadata, isNewSession: isNewSession } });
    console.log("--- Finished Session Identification ---");

    // 4. Guard: Check Session ID
     if (!sessionId) {
         console.error("Failed to obtain a valid session ID after all checks.");
         throw new Error('Session ID could not be established.');
     }
     console.log(`Operating with Session ID: ${sessionId}`);

    // 5. Determine Message Type & Load History & Save Incoming Message
     console.log("--- Determining Message Type & Handling Message DB ---");
     // TODO: Determine incomingMessageType based on senderEmail and sessionOrganizer
     // TODO: Load conversationHistory from DB based on sessionId (if not new session)
     // TODO: Save incoming message to DB using sessionId and incomingMessageType
     console.log("--- Finished Message DB Handling ---");


    // 6. Prepare Contexts for AI
    console.log("--- Preparing Contexts ---");
    // TODO: Build timeZoneContext and meetingDetailsContext from currentSessionState
    console.log("--- Contexts Prepared ---");

    // 7. Call Router Agent
    console.log("--- Calling Router Agent ---");
    // TODO: Assemble messagesForRouter
    // TODO: Call generateObject with routerSystemMessage, routerOutputSchema
    // TODO: Trace this call (lfRouterGeneration)
    // TODO: Store result in routerDecision
    let routerDecision: any = { intent: 'unknown' }; // Placeholder
    console.log("Router Agent Decision:", routerDecision);
    const intent = routerDecision.intent;

    // 8. Perform Immediate State Updates based on Router
    console.log("--- Performing Immediate State Updates ---");
    let sessionUpdateData: Record<string, any> = {}; // Initialize updates
    // TODO: Add logic to update participant status to 'cancelled' if router detected cancellation/reschedule FROM PARTICIPANT
    // TODO: Add logic to clear confirmed_datetime if router intent is request_reschedule and meeting was confirmed
    // If updates occurred, maybe save them here or merge with final update? For simplicity, merge later.
    console.log("--- State Updates Complete ---");


    // 9. Executor Agent Logic (Conditional)
    console.log("--- Starting Executor Logic ---");
    let executorDecision: any = { next_step: 'no_action_needed', recipients: [], email_body: '' }; // Default
    
    // TODO: Implement switch(intent) to conditionally call Executor
    switch(intent) {
        case 'simple_reply':
        case 'unknown':
            console.log(`Intent ${intent} requires no executor action.`);
            break;
        default: // All other intents likely need the executor
             console.log(`Intent ${intent} requires Executor Agent action.`);
             // TODO: Assemble messagesForExecutor (History + Current + Context + Detected Intent)
             // TODO: Call generateObject with executorSystemMessage, executorActionSchema
             // TODO: Trace this call (lfExecutorGeneration)
             // TODO: Store result in executorDecision
             break;
    }
    console.log("Executor Agent Decision:", executorDecision);
    console.log("--- Executor Logic Complete ---");

    // 10. Process Executor Decision (Final Actions)
    console.log("--- Processing Executor Decision ---");
    // TODO: Move/adapt original logic here:
    // - Determine finalRecipients based on executorDecision.next_step
    // - Send email via sendSchedulingEmail if needed
    // - Save AI response message to DB if email sent
    // - Determine nextSessionStatus based on executorDecision.next_step
    // - Merge status and other final updates (duration, location, confirmed_time) into sessionUpdateData
    // - Perform final Supabase update: await supabase.from('scheduling_sessions').update(sessionUpdateData).eq('session_id', sessionId);
    console.log("--- Executor Decision Processed ---");


    // 11. Return Success Response
    console.log("Processing complete, returning 200 OK to Postmark.");
    return NextResponse.json({ 
        status: 'success', 
        router_intent: intent, 
        executor_next_step: executorDecision?.next_step || 'N/A' 
    }, { status: 200 });

  } catch (error) {
    console.error("Unhandled error in /api/schedule_v2:", error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    // Update trace with error?
    trace?.event({ name: "ProcessingError", level: "ERROR", statusMessage: errorMessage });
    return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 200 }); // Return 200 for Postmark
  } finally {
    // 12. Ensure Langfuse data is flushed
    if (trace) {
      console.log("Shutting down Langfuse...");
      await langfuse.shutdownAsync();
      console.log("Langfuse shutdown complete.");
    }
  }
}
