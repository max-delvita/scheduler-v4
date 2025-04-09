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
1.  Analyze the incoming email (From Name and Email, Subject, Body) and the entire conversation history.
2.  Determine the current state and the most logical next step in the scheduling process.
3.  Identify the specific recipient(s) for the next communication.
4.  Generate the plain text email body for the next communication.
5.  Output your decision using the provided JSON schema with fields: 'next_step', 'recipients', 'email_body'.

Workflow Stages & 'next_step' values:
*   Initial Request Received (often CC'd): Identify participants from To/Cc (excluding organizer/self). The identified participants are listed in the user message. If the core intent is clearly to schedule a meeting and at least one participant is identified, prioritize using 'ask_participant_availability' and set 'recipients' to ONLY those identified participant emails. Assume standard meeting duration (e.g., 30-60 mins) if unspecified. Only use 'request_clarification' (emailing the organizer) if the meeting's *purpose* is completely unclear OR if *no participants* could be identified.
*   Receiving Availability: Analyze the sender's response (using their name if available, e.g., "Bob mentioned he is available..."). If more participants need checking, use 'ask_participant_availability' or 'propose_time_to_participant' for the *next* participant listed in the session. If all participants responded, use 'propose_time_to_organizer' and email *only* the organizer with proposed time(s), clearly stating who suggested which times (e.g., "Bob suggested Tuesday at 4pm.").
*   Organizer Confirmation: If organizer agrees, use 'send_final_confirmation' and include *all* participants and the organizer in recipients. If organizer disagrees/suggests changes, go back to asking participants using 'ask_participant_availability' or 'propose_time_to_participant'.
*   Final Confirmation: Generate a summary email body and include all participants+organizer in recipients.
*   No Action: If the email is just a thank you or doesn't require a scheduling action, use 'no_action_needed' with empty recipients/body.
*   Error: If scheduling is impossible or request is invalid, use 'error_cannot_schedule'.

IMPORTANT EMAIL BODY RULES:
*   The 'email_body' field should contain ONLY the text for the email body.
*   Do NOT include greetings like "Hi [Name]," unless the 'recipients' array contains exactly ONE email address.
*   Do NOT include subject lines.
*   Be clear, concise, and professional.
*   **Crucially: When relaying availability or proposing times based on a participant's response, refer to them by name if you know it (e.g., "Alice suggested...", "Regarding Bob's availability..."). Do not attribute availability to yourself (Amy).**`;

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
  sessionId, // Add sessionId to construct Reply-To
  triggeringMessageId, // ID of the email this one is replying to
  triggeringReferencesHeader, // References header from the triggering email
}: {
  to: string | string[];
  subject: string;
  textBody: string;
  sessionId: string; // Make sessionId required for sending
  triggeringMessageId: string; // The MessageID of the email that triggered this send action
  triggeringReferencesHeader: string | null; // The References header value from the triggering email
}): Promise<string | null> {
  const baseFromAddress = process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com';
  if (baseFromAddress === 'scheduler@yourdomain.com') {
      console.warn("POSTMARK_SENDER_ADDRESS environment variable not set, using default.");
  }

  // Construct the unique Reply-To address using Mailbox Hash strategy
  const replyToAddress = `${baseFromAddress.split('@')[0]}+${sessionId}@${baseFromAddress.split('@')[1]}`;
  console.log(`Setting Reply-To: ${replyToAddress}`);

  // --- Construct Threading Headers ---
  const postmarkHeaders: Header[] = [];
  const triggerIdFormatted = `<${triggeringMessageId}>`;

  // Set In-Reply-To to the triggering message ID
  postmarkHeaders.push({ Name: 'In-Reply-To', Value: triggerIdFormatted });
  console.log(`Setting In-Reply-To: ${triggerIdFormatted}`);

  // Construct References: Start with existing references, then add the triggering ID if not present
  let refs = triggeringReferencesHeader || ''; // Start with existing refs (can be null/empty)
  if (!refs.includes(triggerIdFormatted)) {
    if (refs) refs += ' '; // Add space if appending to existing refs
    refs += triggerIdFormatted;
  }

  if (refs) {
    postmarkHeaders.push({ Name: 'References', Value: refs.trim() });
    console.log(`Setting References: ${refs.trim()}`);
  } else {
    // If there were no original references, the References header is just the In-Reply-To value
    postmarkHeaders.push({ Name: 'References', Value: triggerIdFormatted });
     console.log(`Setting References (initial): ${triggerIdFormatted}`);
  }
  // --- End Threading Headers ---

  try {
    console.log(`Attempting to send email via Postmark to: ${Array.isArray(to) ? to.join(', ') : to}`);
    const response: MessageSendingResponse = await postmarkClient.sendEmail({
      From: baseFromAddress, // Send from the base address
      To: Array.isArray(to) ? to.join(', ') : to,
      Subject: subject,
      TextBody: textBody,
      ReplyTo: replyToAddress, // Set the custom Reply-To header
      MessageStream: 'outbound',
      Headers: postmarkHeaders.length > 0 ? postmarkHeaders : undefined,
    });
    console.log('Postmark email sent successfully:', response.MessageID);
    return response.MessageID;
  } catch (error) {
    console.error('Postmark send error:', error);
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
  let sessionParticipants: string[] = [];
  let initialMessageIdForThread: string | null = null; // Still useful for References header

  try {
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

       const { data: newSession, error: newSessionError } = await supabase
         .from('scheduling_sessions')
         .insert({
           organizer_email: senderEmail,
           meeting_topic: subject,
           status: 'pending',
           webhook_target_address: recipientEmail || 'unknown',
           participants: sessionParticipants,
         })
         .select('session_id, organizer_email, participants')
         .single();

       if (newSessionError) {
         console.error('Supabase error creating new session:', newSessionError);
         return NextResponse.json({ error: 'Failed to create scheduling session' }, { status: 200 });
       }
       sessionId = newSession.session_id;
       sessionOrganizer = newSession.organizer_email;
       sessionParticipants = newSession.participants || [];
       conversationHistory = [];
       initialMessageIdForThread = actualMessageIdHeaderValue || null; 
       console.log(`Created new session: ${sessionId}`);
    }

    // --- Guard: Ensure we have a valid sessionId now --- 
    if (!sessionId) {
        console.error("Failed to obtain a valid session ID after all checks.");
        return NextResponse.json({ error: 'Failed to process scheduling session' }, { status: 200 });
    }

    // --- Save Incoming Message (Ensure in_reply_to uses cleaned ID) --- 
    const incomingMessageType =
      sessionOrganizer && senderEmail === sessionOrganizer
        ? 'human_organizer'
        : 'human_participant';
    console.log(`Saving incoming message as type: ${incomingMessageType}`);
    const { error: insertError } = await supabase.from('session_messages').insert({
        session_id: sessionId,
        postmark_message_id: actualMessageIdHeaderValue,
        sender_email: senderEmail,
        recipient_email: recipientEmail,
        subject: subject,
        body_text: textBody,
        body_html: htmlBody,
        // Use the cleaned ID (UUID part) if available from header
        in_reply_to_message_id: inReplyToHeaderRaw?.replace(/[<>]/g, '').split('@')[0] || null,
        message_type: incomingMessageType,
    });
    if (insertError) console.error('Supabase error saving incoming message:', insertError);
    else console.log("Incoming message saved to DB.");

    // --- Prepare for AI (Include explicit participant list) --- 
    const currentMessageContent = `Received email:
From: ${senderName} <${senderEmail}>
Subject: ${subject}
Participants involved in this session: ${sessionParticipants.join(', ') || 'None listed'}

Email Body:
${textBody}`;
    const messagesForAI: CoreMessage[] = [
      ...conversationHistory,
      { role: 'user', content: currentMessageContent },
    ];
    console.log(`Sending ${messagesForAI.length} messages to AI (excluding system prompt).`);

    // --- Call AI using generateObject --- 
    console.log("Calling generateObject...");
    const { object: aiDecision, usage } = await generateObject({
      model: openai('gpt-4o'),
      schema: schedulingDecisionSchema,
      system: systemMessage,
      messages: messagesForAI,
    });
    console.log("AI Usage:", usage);
    console.log("AI Decision Object:", JSON.stringify(aiDecision, null, 2));

    // --- Determine Recipients based on AI Decision & DB Data --- 
    let outgoingMessageId: string | null = null;
    const { next_step, recipients: aiSuggestedRecipients, email_body } = aiDecision;
    let finalRecipients: string[] = [];
    const agentEmail = (process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com').toLowerCase();
    const agentBase = agentEmail.split('@')[0];
    const agentDomain = agentEmail.split('@')[1];

    // Determine recipients based on the *AI's chosen next_step* and *session data*
    if (next_step === 'ask_participant_availability' || next_step === 'propose_time_to_participant') {
        finalRecipients = aiSuggestedRecipients || [];
         console.log(`Step requires emailing participant(s). Using AI recipients: ${finalRecipients.join(', ')}`);
    } else if (next_step === 'propose_time_to_organizer' || next_step === 'request_clarification') {
        if (sessionOrganizer) {
            finalRecipients = [sessionOrganizer];
             console.log(`Step requires emailing organizer. Using DB organizer: ${sessionOrganizer}`);
        } else {
            console.error(`Cannot perform step ${next_step}: Session organizer is unknown.`);
            finalRecipients = [];
        }
    } else if (next_step === 'send_final_confirmation') {
        const allParties = [
            ...(sessionOrganizer ? [sessionOrganizer] : []),
            ...sessionParticipants
        ];
        finalRecipients = [...new Set(allParties)];
        console.log(`Step requires emailing everyone. Final list: ${finalRecipients.join(', ')}`);
    } else {
        console.log(`Step is ${next_step}. No email recipients.`);
        finalRecipients = [];
    }

    // Safeguard: Filter out agent's own addresses (base and hashed) from the final list
    finalRecipients = finalRecipients.filter(email => {
        const lcEmail = email.toLowerCase();
        const isAgentBase = lcEmail === agentEmail;
        const isAgentHashed = lcEmail.startsWith(agentBase + '+') && lcEmail.endsWith('@' + agentDomain);
        return !isAgentBase && !isAgentHashed;
    });

    // --- Send Email if needed --- 
    if (finalRecipients.length > 0 && email_body && email_body.trim().length > 0) {
        console.log(`Final determined recipients: ${finalRecipients.join(', ')}`);
        const outgoingSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
        outgoingMessageId = await sendSchedulingEmail({
            to: finalRecipients,
            subject: outgoingSubject,
            textBody: email_body,
            sessionId, // Pass session ID for Reply-To construction
            triggeringMessageId: actualMessageIdHeaderValue, // Pass the *actual* header value
            triggeringReferencesHeader: referencesHeader || null, // Pass the References from the received email
        });
    // --- Save AI Response --- 
    console.log("Saving AI response to DB.");
    const { error: aiSaveError } = await supabase
            .from('session_messages')
            .insert({
                session_id: sessionId,
                postmark_message_id: outgoingMessageId || null,
                sender_email: process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com',
                recipient_email: finalRecipients.join(', ') || null,
                subject: outgoingSubject,
                body_text: email_body,
                message_type: 'ai_agent',
                in_reply_to_message_id: actualMessageIdHeaderValue, // Link to the ID of the triggering email using the *actual* header value
            });
    if (aiSaveError) console.error('Supabase error saving AI message:', aiSaveError);
    else console.log("AI Response saved to DB.");

    } else {
      console.warn(`AI decided next step: ${next_step}, but no valid recipients/body found. No email sent.`);
    }

    // --- Update Session State --- 
    const { error: updateSessionError } = await supabase
      .from('scheduling_sessions')
      .update({ current_step: next_step })
      .eq('session_id', sessionId);
    if (updateSessionError) console.error('Supabase error updating session step:', updateSessionError);

    // --- Return Success Response to Postmark --- 
    console.log("Processing complete, returning 200 OK to Postmark.");
    return NextResponse.json({ status: 'success', decision: aiDecision }, { status: 200 });

  } catch (error) {
    console.error("Unhandled error in /api/schedule:", error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 200 });
  }
} 