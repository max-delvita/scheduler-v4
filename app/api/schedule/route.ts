import { openai } from '@ai-sdk/openai';
import { streamText, CoreMessage, StreamData } from 'ai';
import { supabase } from '@/lib/supabaseClient'; // Import Supabase client

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

// Define the initial system message to guide the AI
const systemMessage = `You are an AI assistant specialized in scheduling meetings via email conversations.
Your goal is to understand meeting requests, interact with organizers and participants to find suitable times, and confirm the meeting details.
Analyze the incoming email content (sender, subject, body) and the conversation history to determine the intent (e.g., new request, availability response, confirmation) and necessary information (topic, participants, suggested times).
Respond clearly and professionally, guiding the conversation towards a successful scheduling outcome.
If crucial information is missing, ask for it politely.
When proposing times, be clear.
When confirming, summarize the details accurately.`;

// Define the expected structure of the incoming simulated email payload
interface SimulatedEmailPayload {
  from: string;
  to: string[];
  cc?: string[]; // Added optional CC
  subject: string;
  textBody: string;
  htmlBody?: string; // Added optional HTML body
  messageId?: string; // Postmark Message-ID
  inReplyTo?: string; // Postmark Message-ID of the email being replied to
}

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

export async function POST(req: Request) {
  const emailPayload: SimulatedEmailPayload = await req.json();
  const data = new StreamData(); // For potential future use with UI

  let sessionId: string | null = null;
  let conversationHistory: CoreMessage[] = [];
  let sessionOrganizer: string | null = null;

  try {
    // 1. Identify Session based on In-Reply-To header
    if (emailPayload.inReplyTo) {
      const { data: originatingMessage, error: msgError } = await supabase
        .from('session_messages')
        .select('session_id, sessions:scheduling_sessions(organizer_email)')
        .eq('postmark_message_id', emailPayload.inReplyTo)
        .maybeSingle();

      if (msgError) {
        console.error('Supabase error fetching originating message:', msgError);
      } else if (originatingMessage && originatingMessage.session_id) {
        sessionId = originatingMessage.session_id;

        // Explicitly check the structure of sessions before accessing
        const sessionsData = originatingMessage.sessions;
        if (typeof sessionsData === 'object' && sessionsData !== null) {
             if (Array.isArray(sessionsData) && sessionsData.length > 0 && sessionsData[0].organizer_email) {
                sessionOrganizer = sessionsData[0].organizer_email;
            } else if (!Array.isArray(sessionsData) && (sessionsData as any).organizer_email) {
                sessionOrganizer = (sessionsData as any).organizer_email;
            }
        }
        if (!sessionOrganizer) { 
             console.warn('Could not determine session organizer from originating message:', originatingMessage);
             // Attempt to fetch organizer directly from session table as fallback
             const { data: sessionData, error: sessionFetchError } = await supabase
                .from('scheduling_sessions')
                .select('organizer_email')
                .eq('session_id', sessionId)
                .single();
             if (sessionFetchError) {
                 console.error('Fallback fetch for organizer failed:', sessionFetchError);
             } else {
                 sessionOrganizer = sessionData?.organizer_email ?? null;
             }
        }

        if (sessionId) { // Ensure sessionId is valid before fetching history
            const { data: historyMessages, error: historyError } = await supabase
            .from('session_messages')
            .select('message_type, body_text')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

            if (historyError) {
            console.error('Supabase error fetching history:', historyError);
            } else if (historyMessages) {
            conversationHistory = historyMessages
                .map(mapDbMessageToCoreMessage)
                .filter((msg): msg is CoreMessage => msg !== null);
            }
        }
      }
    }

    // 2. Handle New Session if no existing session was found
    if (!sessionId) {
      const { data: newSession, error: newSessionError } = await supabase
        .from('scheduling_sessions')
        .insert({
          organizer_email: emailPayload.from,
          meeting_topic: emailPayload.subject,
          status: 'pending',
          webhook_target_address: emailPayload.to[0] || 'unknown',
        })
        .select('session_id, organizer_email')
        .single();

      if (newSessionError) {
        console.error('Supabase error creating new session:', newSessionError);
        return new Response(JSON.stringify({ error: 'Failed to create scheduling session' }), { status: 500 });
      }
      sessionId = newSession.session_id;
      sessionOrganizer = newSession.organizer_email;
      conversationHistory = [];
    }

    // Ensure we have a valid sessionId before proceeding
    if (!sessionId) {
        console.error("Failed to obtain a valid session ID.");
        return new Response(JSON.stringify({ error: 'Failed to process scheduling session' }), { status: 500 });
    }

    // 3. Determine message type and save incoming message
    const incomingMessageType =
      sessionOrganizer && emailPayload.from === sessionOrganizer
        ? 'human_organizer'
        : 'human_participant';

    const { error: insertError } = await supabase
      .from('session_messages')
      .insert({
        session_id: sessionId,
        postmark_message_id: emailPayload.messageId,
        sender_email: emailPayload.from,
        recipient_email: emailPayload.to[0],
        subject: emailPayload.subject,
        body_text: emailPayload.textBody,
        body_html: emailPayload.htmlBody,
        in_reply_to_message_id: emailPayload.inReplyTo,
        message_type: incomingMessageType,
      });

    if (insertError) {
      console.error('Supabase error saving incoming message:', insertError);
    }

    // 4. Format current email for AI and construct full message list
    const currentMessageContent = `Received email:
From: ${emailPayload.from}
Subject: ${emailPayload.subject}

${emailPayload.textBody}`;

    const messagesForAI: CoreMessage[] = [
      { role: 'system', content: systemMessage },
      ...conversationHistory,
      { role: 'user', content: currentMessageContent },
    ];

    // 5. Call AI and get stream
    const result = await streamText({
      model: openai('gpt-4o'),
      messages: messagesForAI,
    });

    // 6. Save AI response asynchronously AFTER stream is returned
    (async () => {
        try {
            const final_text = await result.text;

            data.append({ sessionId });
            data.close();

            if (final_text) {
                const { error: aiSaveError } = await supabase
                .from('session_messages')
                .insert({
                    session_id: sessionId,
                    sender_email: emailPayload.to[0] || 'ai@example.com',
                    recipient_email: emailPayload.from,
                    subject: `Re: ${emailPayload.subject}`,
                    body_text: final_text,
                    message_type: 'ai_agent',
                });

                if (aiSaveError) {
                    console.error('Supabase error saving AI message:', aiSaveError);
                }
            } else {
                console.warn('AI generated an empty response.');
            }
        } catch (saveError) {
            console.error('Error saving AI response to DB:', saveError);
        }
    })().catch(err => {
        console.error("Error initiating AI response save process:", err);
    });

    // 7. Return the stream response immediately
    return result.toDataStreamResponse({ data });

  } catch (error) {
    console.error("Unhandled error in /api/schedule:", error);
    try { data.close(); } catch (_) {}
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
} 