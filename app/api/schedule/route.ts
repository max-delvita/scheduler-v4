import { openai } from '@ai-sdk/openai';
import { generateObject, CoreMessage } from 'ai';
import { z } from 'zod'; // Import Zod
import { supabase } from '@/lib/supabaseClient'; // Import Supabase client
import { postmarkClient } from '@/lib/postmarkClient'; // Import Postmark client
import { NextResponse } from 'next/server'; // Use NextResponse for standard JSON responses
import type { MessageSendingResponse, Header } from 'postmark/dist/client/models'; // Adjusted imports
import type { InboundMessageDetails } from 'postmark/dist/client/models/messages/InboundMessage'; // Import Postmark Inbound type

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

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
  // confirmed_datetime: z.string().optional().describe("ISO 8601 string if a time has been confirmed."),
});

// Enhanced System Prompt for Structured Output
const systemMessage = `You are an AI assistant specialized in scheduling meetings via email conversations.
Your primary goal is to coordinate a meeting time between an organizer and one or more participants.

Follow these steps:
1.  Analyze the incoming email (From, Subject, Body) and the entire conversation history.
2.  Determine the current state and the most logical next step in the scheduling process.
3.  Identify the specific recipient(s) for the next communication.
4.  Generate the plain text email body for the next communication.
5.  Output your decision using the provided JSON schema with fields: 'next_step', 'recipients', 'email_body'.

Workflow Stages & 'next_step' values:
*   Initial Request Received (often CC'd): Identify participants from To/Cc (excluding organizer/self). The identified participants are listed in the user message. If the core intent is clearly to schedule a meeting and at least one participant is identified, prioritize using 'ask_participant_availability' and set 'recipients' to ONLY those identified participant emails. Assume standard meeting duration (e.g., 30-60 mins) if unspecified. Only use 'request_clarification' (emailing the organizer) if the meeting's *purpose* is completely unclear OR if *no participants* could be identified.
*   Receiving Availability: If more participants need checking, use 'ask_participant_availability' or 'propose_time_to_participant' for the *next* participant listed in the session. If all participants responded, use 'propose_time_to_organizer' and email *only* the organizer with proposed time(s).
*   Organizer Confirmation: If organizer agrees, use 'send_final_confirmation' and include *all* participants and the organizer in recipients. If organizer disagrees/suggests changes, go back to asking participants using 'ask_participant_availability' or 'propose_time_to_participant'.
*   Final Confirmation: Generate a summary email body and include all participants+organizer in recipients.
*   No Action: If the email is just a thank you or doesn't require a scheduling action, use 'no_action_needed' with empty recipients/body.
*   Error: If scheduling is impossible or request is invalid, use 'error_cannot_schedule'.

IMPORTANT EMAIL BODY RULES:
*   The 'email_body' field should contain ONLY the text for the email body.
*   Do NOT include greetings like "Hi [Name]," unless the 'recipients' array contains exactly ONE email address.
*   Do NOT include subject lines.
*   Be clear, concise, and professional.`;

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

// Helper function to send email via Postmark
async function sendSchedulingEmail({
  to,
  subject,
  textBody,
  replyToMessageId, // Original messageId this thread started from (or current if first reply)
  referencesMessageId // ID of the specific message this email is replying to
}: {
  to: string | string[];
  subject: string;
  textBody: string;
  replyToMessageId?: string | null;
  referencesMessageId?: string | null;
}): Promise<string | null> { // Explicitly return MessageID or null
  const fromAddress = process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com'; // Get sender from env or default
  if (fromAddress === 'scheduler@yourdomain.com') {
      console.warn("POSTMARK_SENDER_ADDRESS environment variable not set, using default.");
  }

  // Fix 1: Format headers correctly for Postmark
  const postmarkHeaders: Header[] = [];
  let refs = '';
  if (referencesMessageId) refs += `<${referencesMessageId}>`;
  if (replyToMessageId && replyToMessageId !== referencesMessageId) refs += ` <${replyToMessageId}>`;
  if (refs) postmarkHeaders.push({ Name: 'References', Value: refs.trim() });
  if (referencesMessageId) postmarkHeaders.push({ Name: 'In-Reply-To', Value: `<${referencesMessageId}>` });

  try {
    console.log(`Attempting to send email via Postmark to: ${Array.isArray(to) ? to.join(', ') : to}`);
    const response: MessageSendingResponse = await postmarkClient.sendEmail({
      From: fromAddress,
      To: Array.isArray(to) ? to.join(', ') : to, // Postmark expects comma-separated string
      Subject: subject,
      TextBody: textBody,
      MessageStream: 'outbound', // Or your specific message stream in Postmark
      Headers: postmarkHeaders.length > 0 ? postmarkHeaders : undefined,
    });
    console.log('Postmark email sent successfully:', response.MessageID);
    return response.MessageID; // Return the new message ID
  } catch (error) {
    console.error('Postmark send error:', error);
    // Decide if this should throw or just log
    // throw error; // Rethrow if sending failure should stop execution
    return null; // Return null if we want to continue despite send failure
  }
}

export async function POST(req: Request) {
  console.log("\n--- /api/schedule POST endpoint hit ---"); // ADDED FOR DEBUGGING
  let postmarkPayload: InboundMessageDetails;
  try {
    // Use the actual Postmark InboundMessage type for parsing
    postmarkPayload = await req.json();
    console.log("Received Postmark Payload:", JSON.stringify(postmarkPayload, null, 2)); // Log the full payload for debugging
  } catch (e) {
      console.error("Failed to parse incoming request JSON:", e);
      // Postmark expects a 200 OK even on failure, otherwise it retries.
      // Log the error but return 200.
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 200 });
  }

  // Extract key information using Postmark field names
  const senderEmail = postmarkPayload.FromFull?.Email || postmarkPayload.From;
  const recipientEmail = postmarkPayload.OriginalRecipient;
  const subject = postmarkPayload.Subject || '(no subject)';
  const textBody = postmarkPayload.TextBody || '';
  const htmlBody = postmarkPayload.HtmlBody;
  const messageId = postmarkPayload.MessageID;

  // Helper function to find specific header values
  const findHeader = (name: string): string | undefined => {
      return postmarkPayload.Headers?.find((h: Header) => h.Name.toLowerCase() === name.toLowerCase())?.Value;
  }

  const inReplyToHeader = findHeader('In-Reply-To')?.replace(/[<>]/g, ''); // Clean <> chars
  const referencesHeader = findHeader('References'); // Keep this raw for now

  // Log extracted info for debugging
  console.log(`Extracted Info: From=${senderEmail}, To=${recipientEmail}, Subject=${subject}, MessageID=${messageId}, InReplyTo=${inReplyToHeader}`);

  let sessionId: string | null = null;
  let conversationHistory: CoreMessage[] = [];
  let sessionOrganizer: string | null = null;
  let sessionParticipants: string[] = []; // Store participant list
  let initialMessageIdForThread: string | null = null; // Track the first message ID for References header

  try {
    // 1. Identify Session based on In-Reply-To header
    if (inReplyToHeader) {
      console.log(`Looking for message with postmark_message_id = ${inReplyToHeader}`);
      const { data: originatingMessage, error: msgError } = await supabase
        .from('session_messages')
        // Fetch session details directly including participants
        .select('session_id, sessions:scheduling_sessions(organizer_email, participants)')
        .eq('postmark_message_id', inReplyToHeader)
        .maybeSingle();

      if (msgError) {
        console.error('Supabase error fetching originating message by In-Reply-To:', msgError);
      } else if (originatingMessage && originatingMessage.session_id) {
        console.log(`Found existing session: ${originatingMessage.session_id}`);
        sessionId = originatingMessage.session_id;
        const sessionsData = originatingMessage.sessions as any; // Use any temporarily for simplicity
         if (sessionsData) {
             sessionOrganizer = sessionsData.organizer_email;
             sessionParticipants = sessionsData.participants || [];
         } else {
            // Fallback: fetch session data directly if join failed/was null
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

        if (sessionId) {
            const { data: historyMessages, error: historyError } = await supabase
            .from('session_messages')
            .select('message_type, body_text, postmark_message_id') // Include message ID for threading
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

            if (historyError) {
              console.error('Supabase error fetching history:', historyError);
            } else if (historyMessages) {
              conversationHistory = historyMessages
                .map(mapDbMessageToCoreMessage)
                .filter((msg): msg is CoreMessage => msg !== null);
              // Find the earliest message ID for the References header
              initialMessageIdForThread = historyMessages[0]?.postmark_message_id || inReplyToHeader;
              console.log(`Loaded ${conversationHistory.length} history messages.`);
            }
        }
      }
    }

    // 2. Handle New Session if no existing session was found
    if (!sessionId) {
        console.log("No existing session found, creating new one.");

        // --- Participant Extraction from To/Cc (Handles initial CC scenario) ---
        const agentEmail = (process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com').toLowerCase();
        let potentialParticipants: string[] = [];

        // Add recipients from ToFull array
        if (postmarkPayload.ToFull && Array.isArray(postmarkPayload.ToFull)) {
            potentialParticipants = potentialParticipants.concat(
                postmarkPayload.ToFull.map(recipient => recipient.Email)
            );
        }
        // Add recipients from CcFull array
        if (postmarkPayload.CcFull && Array.isArray(postmarkPayload.CcFull)) {
            potentialParticipants = potentialParticipants.concat(
                postmarkPayload.CcFull.map(recipient => recipient.Email)
            );
        }

        // Filter out the sender and the agent's own email, ensure lowercase comparison
        sessionParticipants = [...new Set(potentialParticipants)] // Remove duplicates first
            .filter(email => email.toLowerCase() !== senderEmail.toLowerCase() && email.toLowerCase() !== agentEmail);

        console.log(`Identified Participants (from To/Cc, excluding sender/agent): ${sessionParticipants.join(', ') || 'None'}`);

        // Fallback: If To/Cc parsing yielded no participants, maybe try regex as last resort?
        if (sessionParticipants.length === 0) {
             console.log("No participants found in To/Cc, attempting regex fallback on body...");
             const participantsMatch = textBody.match(/Participants?:\s*\n?([\s\S]*?)(?:\n\n|Thanks|Best regards)/i);
             const extractedParticipants = participantsMatch ? participantsMatch[1].split('\n').map(p => p.replace(/^-/, '').trim()).filter((p: string) => p.includes('@')) : [];
             // Ensure these aren't the sender or agent either
             sessionParticipants = extractedParticipants.filter(email => email.toLowerCase() !== senderEmail.toLowerCase() && email.toLowerCase() !== agentEmail);
             console.log(`Regex Fallback Participants: ${sessionParticipants.join(', ') || 'None'}`);
        }
        // --- End Participant Extraction ---

      const { data: newSession, error: newSessionError } = await supabase
        .from('scheduling_sessions')
        .insert({
          organizer_email: senderEmail,
          meeting_topic: subject,
          status: 'pending',
          webhook_target_address: recipientEmail || 'unknown',
          participants: sessionParticipants, // Use the correctly identified participants
        })
        .select('session_id, organizer_email, participants')
        .single();

      if (newSessionError) {
        console.error('Supabase error creating new session:', newSessionError);
        return NextResponse.json({ error: 'Failed to create scheduling session' }, { status: 200 });
      }
      sessionId = newSession.session_id;
      sessionOrganizer = newSession.organizer_email;
      // Ensure sessionParticipants uses the value from the newly created record
      sessionParticipants = newSession.participants || [];
      conversationHistory = [];
      // @ts-ignore - Bypassing persistent and likely incorrect type error
      initialMessageIdForThread = messageId || null;
      console.log(`Created new session: ${sessionId}`);
    }

    // Ensure we have a valid sessionId before proceeding
    if (!sessionId) {
        console.error("Failed to obtain a valid session ID.");
        return NextResponse.json({ error: 'Failed to process scheduling session' }, { status: 200 });
    }

    // 3. Determine message type and save incoming message
    const incomingMessageType =
      sessionOrganizer && senderEmail === sessionOrganizer
        ? 'human_organizer'
        : 'human_participant';

    const { error: insertError } = await supabase
      .from('session_messages')
      .insert({
        session_id: sessionId,
        postmark_message_id: messageId,
        sender_email: senderEmail,
        recipient_email: recipientEmail,
        subject: subject,
        body_text: textBody,
        body_html: htmlBody,
        in_reply_to_message_id: inReplyToHeader || null,
        message_type: incomingMessageType,
      });

    if (insertError) {
      console.error('Supabase error saving incoming message:', insertError);
    }

    // 4. Format current email for AI and construct full message list
    // Explicitly include identified participants in the context for the AI
    const currentMessageContent = `Received email:
From: ${senderEmail}
Subject: ${subject}
Participants involved in this request: ${sessionParticipants.join(', ') || 'None identified'}

Email Body:
${textBody}`;

    const messagesForAI: CoreMessage[] = [
      // System message is now part of generateObject call
      ...conversationHistory,
      { role: 'user', content: currentMessageContent }, // Pass enriched context
    ];
    console.log(`Sending ${messagesForAI.length} messages to AI (excluding system prompt).`);

    // 5. Call AI and get stream
    console.log("Calling generateObject...");
    const { object: aiDecision, usage } = await generateObject({
      model: openai('gpt-4o'),
      schema: schedulingDecisionSchema,
      system: systemMessage, // Pass the enhanced system prompt here
      messages: messagesForAI,
    });
    console.log("AI Usage:", usage);
    console.log("AI Decision Object:", JSON.stringify(aiDecision, null, 2));

    // 6. Determine Recipients and Send Email via Postmark
    let outgoingMessageId: string | null = null;

    if (aiDecision.next_step !== 'no_action_needed' && aiDecision.next_step !== 'error_cannot_schedule' && aiDecision.recipients && aiDecision.recipients.length > 0 && aiDecision.email_body && aiDecision.email_body.trim().length > 0) {
      console.log(`AI decided next step: ${aiDecision.next_step}. Sending email to: ${aiDecision.recipients.join(', ')}`);
      const outgoingSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
      outgoingMessageId = await sendSchedulingEmail({
        to: aiDecision.recipients,
        subject: outgoingSubject,
        textBody: aiDecision.email_body,
        replyToMessageId: initialMessageIdForThread,
        referencesMessageId: messageId
      });

      // 7. Save AI response AFTER attempting to send email
      console.log("Saving AI response to DB.");
      const { error: aiSaveError } = await supabase
        .from('session_messages')
        .insert({
          session_id: sessionId,
          postmark_message_id: outgoingMessageId || null,
          sender_email: process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com',
          recipient_email: aiDecision.recipients.join(', ') || null,
          subject: outgoingSubject,
          body_text: aiDecision.email_body,
          message_type: 'ai_agent',
          // Use `any` as a last resort to bypass persistent TS error
          in_reply_to_message_id: messageId as any,
        });

      if (aiSaveError) console.error('Supabase error saving AI message:', aiSaveError);

    } else {
      console.warn('AI generated an empty response. No email sent, not saving AI message.');
    }

    // 8. Return the stream response immediately
    console.log("Processing complete, returning 200 OK to Postmark.");
    // Return simple success; Postmark doesn't need the AI response content back.
    return NextResponse.json({ status: 'success', decision: aiDecision }, { status: 200 });

  } catch (error) {
    console.error("Unhandled error in /api/schedule:", error);
    // Ensure error is an instance of Error for safe message access
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    // Still return 200 to Postmark to prevent retries, but log the error.
    return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 200 });
  }
} 