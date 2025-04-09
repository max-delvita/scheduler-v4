import { NextResponse } from 'next/server';
import { supabase } from '../../../../lib/supabaseClient';
import { sendSchedulingEmail } from '../../../../lib/emailUtils';

// Define participant status detail type (Duplicate from schedule route - consider sharing types)
interface ParticipantStatusDetail {
  email: string;
  status: string; // 'pending', 'received', 'nudged_1', 'nudged_2', 'timed_out', 'escalated'
  last_request_sent_at: string | null; // ISO string
}

// Define nudge thresholds (in minutes for easier testing initially)
const NUDGE1_THRESHOLD_MINUTES = 1; // Time after last_request_sent_at to send nudge 1
const NUDGE2_THRESHOLD_MINUTES = 2; // Time after last_request_sent_at to send nudge 2
const ESCALATION_THRESHOLD_MINUTES = 3; // Time after last_request_sent_at to escalate

export async function GET(request: Request) {
  console.log('\n--- /api/cron/nudge GET endpoint hit ---');

  // Optional: Secure the endpoint, e.g., check for a secret header/token
  // const authToken = (request.headers.get('authorization') || '').split('Bearer ')[1];
  // if (authToken !== process.env.CRON_SECRET) {
  //   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // }

  try {
    const now = new Date();
    console.log(`Cron job running at: ${now.toISOString()}`);

    // 1. Find sessions waiting for participant responses
    const { data: pendingSessions, error: fetchError } = await supabase
      .from('scheduling_sessions')
      .select('session_id, organizer_email, meeting_topic, participant_status_details')
      .eq('session_status', 'pending_participant_response');

    if (fetchError) {
      console.error('Cron: Error fetching pending sessions:', fetchError);
      return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
    }

    if (!pendingSessions || pendingSessions.length === 0) {
      console.log('Cron: No sessions currently pending participant response.');
      return NextResponse.json({ status: 'success', message: 'No pending sessions' });
    }

    console.log(`Cron: Found ${pendingSessions.length} sessions to check.`);

    // 2. Process each session
    for (const session of pendingSessions) {
      console.log(`Cron: Processing session ${session.session_id}`);
      let participantDetails: ParticipantStatusDetail[] = session.participant_status_details || [];
      let detailsUpdated = false;
      let sessionEscalated = false;

      for (let i = 0; i < participantDetails.length; i++) {
        const participant = participantDetails[i];

        if (participant.status === 'received' || !participant.last_request_sent_at) {
          continue; // Skip if already received or initial request not yet sent (shouldn't happen in pending state)
        }

        const lastRequestTime = new Date(participant.last_request_sent_at);
        const minutesSinceLastRequest = (now.getTime() - lastRequestTime.getTime()) / (1000 * 60);

        let nextStatus = participant.status;
        let emailSubject = '';
        let emailBody = '';
        let recipient = participant.email;
        let isEscalation = false;

        // Determine action based on status and time elapsed
        if (participant.status === 'pending' && minutesSinceLastRequest >= NUDGE1_THRESHOLD_MINUTES) {
          console.log(`Cron: Participant ${participant.email} needs Nudge 1.`);
          nextStatus = 'nudged_1';
          emailSubject = `Reminder: Availability for ${session.meeting_topic || 'meeting'}`;
          emailBody = `Hi ${participant.email.split('@')[0]},\n\nJust a friendly reminder to share your availability for the meeting "${session.meeting_topic || 'meeting'}" requested by ${session.organizer_email}.\n\nPlease reply to this email with times you are available.\n\nThanks,\nAmy (Scheduling Assistant)`;
        } else if (participant.status === 'nudged_1' && minutesSinceLastRequest >= NUDGE2_THRESHOLD_MINUTES) {
           console.log(`Cron: Participant ${participant.email} needs Nudge 2.`);
           nextStatus = 'nudged_2';
           emailSubject = `Second Reminder: Availability for ${session.meeting_topic || 'meeting'}`;
           emailBody = `Hi ${participant.email.split('@')[0]},\n\nFollowing up again on the request for your availability for the meeting "${session.meeting_topic || 'meeting'}" requested by ${session.organizer_email}.\n\nPlease let me know your availability as soon as possible.\n\nThanks,\nAmy (Scheduling Assistant)`;
        } else if (participant.status === 'nudged_2' && minutesSinceLastRequest >= ESCALATION_THRESHOLD_MINUTES) {
           console.log(`Cron: Participant ${participant.email} needs Escalation.`);
           nextStatus = 'escalated'; 
           sessionEscalated = true; 
           recipient = session.organizer_email; 
           isEscalation = true; // Flag this as an escalation email
           emailSubject = `Action Required: Issue scheduling ${session.meeting_topic || 'meeting'}`;
           emailBody = `Hi ${session.organizer_email.split('@')[0]},\n\nI haven't received an availability response from ${participant.email} for the meeting "${session.meeting_topic || 'meeting'}", even after sending two reminders.\n\nHow would you like to proceed?\n- Try scheduling with the participants who have responded?\n- Ask me to send another reminder?\n- Contact ${participant.email} directly?\n\nPlease let me know.\n\nThanks,\nAmy (Scheduling Assistant)`;
        }

        // If an action is needed, send email and update status
        if (nextStatus !== participant.status) {
          const pseudoTriggerId = `cron-nudge-${session.session_id}-${participant.email}`;
          
          const messageId = await sendSchedulingEmail({
            to: recipient,
            subject: emailSubject,
            textBody: emailBody,
            sessionId: session.session_id,
            triggeringMessageId: pseudoTriggerId,
            triggeringReferencesHeader: null,
            sendAsGroup: false,
          });

          if (messageId) {
            console.log(`Cron: Email sent (Message ID: ${messageId}), updating status for ${participant.email} to ${nextStatus}`);
            // Update timestamp on nudge/escalation too, so thresholds reset relative to the last action
            participantDetails[i] = { ...participant, status: nextStatus, last_request_sent_at: new Date().toISOString() }; 
            detailsUpdated = true;
          } else {
            console.error(`Cron: Failed to send email for ${participant.email} in session ${session.session_id}`);
            // Decide if we should retry later or just log
          }
        }
      } // End loop through participants

      // 3. Update database if changes were made
      if (detailsUpdated) {
          const updateData: { participant_status_details: ParticipantStatusDetail[]; session_status?: string } = {
              participant_status_details: participantDetails,
          };
          if (sessionEscalated) {
              console.log(`Cron: Session ${session.session_id} escalated to organizer.`);
              updateData.session_status = 'escalated_to_organizer';
          }

          const { error: updateError } = await supabase
              .from('scheduling_sessions')
              .update(updateData)
              .eq('session_id', session.session_id);

          if (updateError) {
              console.error(`Cron: Error updating session ${session.session_id}:`, updateError);
          }
      }
    } // End loop through sessions

    console.log('Cron: Nudge check completed.');
    return NextResponse.json({ status: 'success' });

  } catch (error) {
    console.error("Cron: Unhandled error in nudge job:", error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Internal Server Error', details: errorMessage }, { status: 500 });
  }
} 