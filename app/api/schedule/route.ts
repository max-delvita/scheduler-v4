import { openai } from '@ai-sdk/openai';
import { generateText, CoreMessage } from 'ai';
import { supabase } from '@/lib/supabaseClient'; // Import Supabase client
import { postmarkClient } from '@/lib/postmarkClient'; // Import Postmark client
import { NextResponse } from 'next/server'; // Use NextResponse for standard JSON responses
import type { MessageSendingResponse, Header } from 'postmark/dist/client/models'; // Adjusted imports
import type { InboundMessageDetails } from 'postmark/dist/client/models/messages/InboundMessage'; // Import Postmark Inbound type

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

// Define the initial system message to guide the AI
const systemMessage = `You are an AI assistant specialized in scheduling meetings via email conversations.
Your goal is to understand meeting requests, interact with organizers and participants to find suitable times, and confirm the meeting details.
Analyze the incoming email content (sender, subject, body) and the conversation history to determine the intent (e.g., new request, availability response, confirmation) and necessary information (topic, participants, suggested times).
Respond clearly and professionally, guiding the conversation towards a successful scheduling outcome.
If crucial information is missing, ask for it politely.
When proposing times, be clear.
When confirming, summarize the details accurately.
IMPORTANT: Your final output text should be ONLY the body of the email you want to send next. Do not include Subject lines or salutations like "Hi Bob," unless that specific person is the *only* recipient of this *next* email. If addressing multiple people, start the email body directly.`;

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
    const currentMessageContent = `Received email:
From: ${senderEmail}
Subject: ${subject}

${textBody}`;

    const messagesForAI: CoreMessage[] = [
      { role: 'system', content: systemMessage },
      ...conversationHistory,
      { role: 'user', content: currentMessageContent },
    ];

    // 5. Call AI and get stream
    const { text: aiResponseText, usage } = await generateText({
      model: openai('gpt-4o'),
      messages: messagesForAI,
    });
    console.log("AI Usage:", usage);
    console.log("AI Raw Response:", aiResponseText);

    // 6. Determine Recipients and Send Email via Postmark
    let recipients: string[] = [];
    let outgoingMessageId: string | null = null; // Store the outgoing message ID

    if (aiResponseText && aiResponseText.trim().length > 0) {
      if (incomingMessageType === 'human_organizer') {
        // Organizer sent -> Reply goes to Participants
        recipients = sessionParticipants.filter((p: string) => p !== sessionOrganizer); // Exclude organizer if they were in participants list
      } else {
        // Participant sent -> Reply goes to Organizer and *other* Participants
        recipients = [
            ...(sessionOrganizer ? [sessionOrganizer] : []),
            ...sessionParticipants.filter((p: string) => p !== senderEmail && p !== sessionOrganizer)
        ];
      }
      // Remove duplicates just in case
      recipients = [...new Set(recipients)];

      if (recipients.length > 0) {
            console.log(`Determined recipients for AI response: ${recipients.join(', ')}`);
            const outgoingSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
            // Call send function and store the returned message ID
            outgoingMessageId = await sendSchedulingEmail({
                to: recipients,
                subject: outgoingSubject,
                textBody: aiResponseText,
                replyToMessageId: initialMessageIdForThread, // Base thread ID
                referencesMessageId: messageId // ID of the message we are directly replying to
            });

            // 7. Save AI response AFTER attempting to send email
            const { error: aiSaveError } = await supabase
            .from('session_messages')
            .insert({
                session_id: sessionId,
                postmark_message_id: outgoingMessageId || null,
                sender_email: process.env.POSTMARK_SENDER_ADDRESS || 'scheduler@yourdomain.com',
                recipient_email: recipients.join(', ') || null,
                subject: outgoingSubject,
                body_text: aiResponseText,
                message_type: 'ai_agent',
                // Use `any` as a last resort to bypass persistent TS error
                in_reply_to_message_id: messageId as any,
            });

            if (aiSaveError) console.error('Supabase error saving AI message:', aiSaveError);

      } else {
          console.log("AI generated a response, but no recipients determined. Skipping email send.");
          // Save AI response anyway? Or only save if sent?
           const { error: aiSaveError } = await supabase
                .from('session_messages')
                .insert({ session_id: sessionId, sender_email: 'ai_agent', body_text: aiResponseText, message_type: 'ai_agent' }); // Minimal save
           if (aiSaveError) console.error('Supabase error saving unsent AI message:', aiSaveError);
      }

    } else {
      console.warn('AI generated an empty response. No email sent, not saving AI message.');
    }

    // 8. Return the stream response immediately
    console.log("Processing complete, returning 200 OK to Postmark.");
    // Return simple success; Postmark doesn't need the AI response content back.
    return NextResponse.json({ status: 'success' }, { status: 200 });

  } catch (error) {
    console.error("Unhandled error in /api/schedule:", error);
    // Ensure error is an instance of Error for safe message access
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    // Still return 200 to Postmark to prevent retries, but log the error.
    return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 200 });
  }
} 