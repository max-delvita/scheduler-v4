# AI Email Scheduling Assistant (Scheduler v4)

This project is an AI-powered email assistant named "Amy" designed to automate the process of scheduling meetings. It monitors an email inbox, parses meeting requests, interacts with participants via email to find suitable times, and handles confirmations and reminders.

## Overview

Amy listens for incoming emails via a Postmark webhook. When an email requests a meeting (typically by including Amy's email address in the `To` or `Cc` field), the assistant initiates a scheduling session:

1.  **Session Management:** It identifies the organizer and participants, creating or retrieving a session state stored in a Supabase database.
2.  **AI Decision Making:** It uses OpenAI (via the Vercel AI SDK's `generateObject` function) to analyze the conversation history and the latest email to determine the next logical step (e.g., ask for availability, propose times, send confirmation).
3.  **Email Communication:** Based on the AI's decision, it generates and sends emails to the relevant parties (organizer or participants) using Postmark.
4.  **Nudge Reminders:** A scheduled cron job periodically checks for participants who haven't responded within a defined timeframe and sends reminder (nudge) emails.
5.  **Observability:** Langfuse is integrated to trace the execution flow, AI interactions, and log relevant metadata for debugging and monitoring.

## Features

*   Handles multi-participant scheduling.
*   Parses incoming emails to identify intent, participants, and basic meeting details (topic, suggested timeframes).
*   Manages conversation state and participant status in a database (Supabase).
*   Uses OpenAI (GPT-4o) for intelligent decision-making and email generation.
*   Sends emails via Postmark, maintaining email threads using `In-Reply-To` and `References` headers.
*   Uses unique `Reply-To` addresses containing the session ID (`amy+<session_id>@...`) to track replies via Postmark's MailboxHash feature.
*   Automatically nudges unresponsive participants via a cron job.
*   Includes basic timezone and meeting detail detection.
*   Integrated with Langfuse for observability.

## Tech Stack

*   **Framework:** Next.js (App Router)
*   **Language:** TypeScript
*   **AI:** OpenAI (GPT-4o) via Vercel AI SDK (`@ai-sdk/openai`, `ai`)
*   **Database:** Supabase (PostgreSQL)
*   **Email Provider:** Postmark (Inbound Webhook, SMTP Sending)
*   **Deployment:** Render (Web Service + Cron Job via `render.yaml`)
*   **Observability:** Langfuse

## Project Structure

*   `app/api/schedule/route.ts`: Main API endpoint handler for incoming Postmark webhooks. Contains core scheduling logic.
*   `app/api/cron/nudge/route.ts`: API endpoint triggered by the cron job to handle participant nudges.
*   `lib/supabaseClient.ts`: Initializes the Supabase client.
*   `lib/postmarkClient.ts`: Initializes the Postmark client.
*   `lib/emailUtils.ts`: Contains helper functions for sending emails via Postmark.
*   `render.yaml`: Defines the Render deployment configuration (web service and cron job).
*   `.env.local` (local development) / Render Environment Variables: Stores API keys and configuration settings.

## Setup and Installation

Follow these steps to set up the project locally or prepare for deployment.

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd <repository-directory>
```

### 2. Install Dependencies

```bash
npm install
# or
yarn install
```

### 3. Set up Supabase

1.  Create a new project on [Supabase](https://supabase.com/).
2.  Navigate to the "SQL Editor" in your Supabase project dashboard.
3.  Create the necessary tables. You'll need at least:
    *   `scheduling_sessions`: Stores overall meeting details. Key columns likely include:
        *   `session_id` (uuid, primary key, default: `gen_random_uuid()`)
        *   `organizer_email` (text)
        *   `organizer_name` (text, nullable)
        *   `meeting_topic` (text, nullable)
        *   `participants` (text[], array of participant emails)
        *   `status` (text, e.g., 'pending_participant_response', 'confirmed', 'error')
        *   `participant_status_details` (jsonb, array of objects like `{ email: string, status: string, last_request_sent_at: timestamptz | null }`)
        *   `organizer_timezone` (text, nullable)
        *   `meeting_duration` (text, nullable)
        *   `meeting_location` (text, nullable)
        *   `is_virtual` (boolean)
        *   `confirmed_datetime` (timestamptz, nullable)
        *   `webhook_target_address` (text)
        *   `created_at` (timestamptz, default: `now()`)
        *   `updated_at` (timestamptz, default: `now()`)
        *   *(Consider adding appropriate database indexes)*
    *   `session_messages`: Stores individual email messages related to a session. Key columns likely include:
        *   `message_id` (uuid, primary key, default: `gen_random_uuid()`)
        *   `session_id` (uuid, foreign key referencing `scheduling_sessions.session_id`)
        *   `postmark_message_id` (text, unique identifier from Postmark/email header)
        *   `sender_email` (text)
        *   `recipient_email` (text)
        *   `subject` (text)
        *   `body_text` (text)
        *   `body_html` (text, nullable)
        *   `in_reply_to_message_id` (text, nullable)
        *   `message_type` (text, e.g., 'human_organizer', 'human_participant', 'ai_agent')
        *   `created_at` (timestamptz, default: `now()`)
    *   `discarded_agent_emails`: (Optional, but used in current code) Stores emails sent *from* the agent address without a valid MailboxHash to detect loops.
        *   `log_id` (uuid, primary key)
        *   `received_at` (timestamptz)
        *   `postmark_message_id` (text)
        *   `subject` (text)
        *   `from_email` (text)
        *   `to_recipients` (text)
        *   `cc_recipients` (text)
        *   `in_reply_to_header` (text)
        *   `body_text` (text)
        *   `reason` (text, e.g., 'loop detected')
        *   `full_payload` (jsonb)

    *Note: Refer to the code (`/api/schedule/route.ts` and `/api/cron/nudge/route.ts`) for exact column names and types used in Supabase queries.*

4.  Find your Supabase Project URL and Service Role Key under Project Settings > API.

### 4. Set up Postmark

1.  Create an account on [Postmark](https://postmarkapp.com/).
2.  Create a **Server** in Postmark. Note its **Server API Token**.
3.  Configure a **Sender Signature** for the email address you want Amy to send emails *from* (e.g., `amy@yourdomain.com`). This address must be verified.
4.  Configure an **Inbound Address** for receiving emails. This will be the primary address Amy listens to (e.g., `amy@yourdomain.com` or a subdomain like `amy@agent.yourdomain.com`).
5.  In the settings for your Inbound Address, set the **Webhook URL** to point to your deployed application's schedule endpoint: `https://<your-deployed-url>/api/schedule`.
6.  Ensure **"Include raw email content in JSON payload"** is **checked** for the inbound webhook settings.
7.  Ensure **"Post first attachment content"** (or similar) is likely sufficient, unless you need full attachment handling.

### 5. Set up Langfuse

1.  Create an account or self-host [Langfuse](https://langfuse.com/).
2.  Create a new project.
3.  Find your **Public Key**, **Secret Key**, and the correct **Base URL** (e.g., `https://cloud.langfuse.com` or `https://us.cloud.langfuse.com`) from the Langfuse project settings > API Keys.

### 6. Configure Environment Variables

Create a `.env.local` file in the project root for local development. For deployment (e.g., on Render), set these variables in the service's environment settings.

```bash
# .env.local

# OpenAI
OPENAI_API_KEY="sk-..."

# Supabase
SUPABASE_URL="https://<your-project-ref>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="ey..." # Use the Service Role key (secret)

# Postmark
POSTMARK_SERVER_TOKEN="..." # Your Postmark SERVER token
POSTMARK_SENDER_ADDRESS="amy@yourdomain.com" # Verified Sender Signature address

# Langfuse
LANGFUSE_SECRET_KEY="sk-lf-..."
LANGFUSE_PUBLIC_KEY="pk-lf-..."
LANGFUSE_BASEURL="https://cloud.langfuse.com" # Or your Langfuse instance URL (NO quotes)

# Optional: Cron Secret (if securing the nudge endpoint)
# CRON_SECRET="..."
```

**Important:** Never commit your `.env.local` file or secret keys directly to your Git repository. Use a `.gitignore` file to exclude it.

### 7. Running Locally

1.  Start the development server:
    ```bash
    npm run dev
    # or
    yarn dev
    ```
2.  **Webhook Testing:** Since Postmark needs a public URL for webhooks, you'll need a tool like [ngrok](https://ngrok.com/) to expose your local development server (usually on `http://localhost:3000`) to the internet.
    *   Install ngrok.
    *   Run `ngrok http 3000`.
    *   Use the public `https://*.ngrok-free.app` URL provided by ngrok as your Postmark Inbound Webhook URL for testing.
3.  **Cron Job Testing:** To test the nudge logic locally, you can manually send a GET request to your local `/api/cron/nudge` endpoint using `curl` or a tool like Postman/Insomnia:
    ```bash
    curl http://localhost:3000/api/cron/nudge
    ```

## Deployment (Render)

This project uses a `render.yaml` file for Infrastructure as Code deployment on Render.

1.  **Connect Repository:** Connect your Git repository to Render.
2.  **Create Blueprint:** Create a new "Blueprint Instance" in Render, selecting your repository. Render should automatically detect and use the `render.yaml` file.
3.  **Configure Environment Variables:** Go to the "Environment" settings for your deployed `Scheduler_agent PROD` service in the Render dashboard. Add all the environment variables listed in step 6 (OPENAI_API_KEY, SUPABASE_URL, etc.) securely. **Crucially, ensure `LANGFUSE_BASEURL` does *not* have quotes around it.**
4.  **Deploy:** Trigger a manual deploy or let Render deploy automatically based on your Git pushes.
5.  **Verify Cron Job:** After deployment, check your main application logs in Render for the `--- /api/cron/nudge GET endpoint hit ---` message appearing according to the schedule defined in `render.yaml`. Note that the cron job itself might not appear under the "Jobs" or a specific "Cron Jobs" tab for the *web service* when defined via `render.yaml`. The logs are the primary confirmation.

## How It Works - Detailed Flow

1.  **Email Received:** User sends an email to `participant(s)` and includes `amy@agent.yourdomain.com` (your configured inbound address) in `To` or `Cc`.
2.  **Postmark Webhook:** Postmark receives the email, parses it, and sends a JSON payload via HTTP POST to your `/api/schedule` endpoint.
3.  **Identify Session:**
    *   The endpoint checks the `MailboxHash` from Postmark. If present (meaning it's a reply to an email Amy sent), it uses this hash as the `sessionId` to look up the existing session in Supabase.
    *   If no `MailboxHash`, it checks the `In-Reply-To` header to potentially find the original message and its `sessionId`.
    *   If still no session found, it creates a *new* session in the `scheduling_sessions` table, identifying participants from `To`/`Cc` (excluding the sender and Amy's address), extracting the organizer's name, and attempting to detect meeting details. A new `sessionId` (UUID) is generated by Supabase.
4.  **Save Message:** The incoming email content is saved to the `session_messages` table, linked to the `sessionId`.
5.  **Participant Reply Handling:** If the sender is a participant:
    *   Their status in `participant_status_details` (within the session's JSONB column) is updated to `received`.
    *   If *all* participants for that session now have status `received`, the code proceeds to call the AI.
    *   Otherwise, it returns a success response to Postmark, waiting for other replies.
6.  **AI Interaction (If New Session or All Participants Replied):**
    *   The conversation history (from `session_messages`) and current context (participants, organizer name, timezones, meeting details, participant statuses) are formatted.
    *   A Langfuse trace and generation are started.
    *   The `generateObject` function from Vercel AI SDK is called with the history, context, system prompt, and the `schedulingDecisionSchema`.
    *   The AI returns a structured JSON object (`aiDecision`) containing `next_step`, `recipients`, and `email_body`.
    *   The Langfuse generation is ended, logging input, output, and usage.
7.  **Execute AI Decision:**
    *   Based on `aiDecision.next_step`, the code determines the final list of `recipients`.
    *   If recipients and `email_body` are valid, the `sendSchedulingEmail` helper is called.
8.  **Send Email:**
    *   `sendSchedulingEmail` uses Postmark to send the `email_body` to the `recipients`.
    *   Crucially, it sets the `Reply-To` header to `amy+<sessionId>@agent.yourdomain.com`.
    *   It sets `In-Reply-To` and `References` headers based on the triggering email to maintain threading.
9.  **Save AI Response:** If the email is sent successfully, the AI's response (`email_body`) is saved as an `ai_agent` message in `session_messages`.
10. **Update Session State:** The overall session `status` in `scheduling_sessions` is updated based on the AI's `next_step`.
11. **Return Response:** A 200 OK response is sent to Postmark.
12. **Flush Langfuse:** `langfuse.shutdownAsync()` ensures tracing data is sent.

**Nudge Flow:**

1.  **Cron Trigger:** Render's scheduler runs the `curl` command defined in `render.yaml` based on the schedule.
2.  **API Hit:** The `curl` command sends a GET request to `/api/cron/nudge`.
3.  **Check Pending Sessions:** The endpoint queries Supabase for sessions with `status = 'pending_participant_response'`.
4.  **Iterate Participants:** For each pending session, it iterates through `participant_status_details`.
5.  **Check Thresholds:** For participants whose status is *not* `received`, it calculates the time since `last_request_sent_at`. If the time exceeds `NUDGE1_THRESHOLD_MINUTES` (and status is `pending`) or `NUDGE2_THRESHOLD_MINUTES` (and status is `nudged_1`), etc., it proceeds.
6.  **Send Nudge/Notify:**
    *   It sends the appropriate nudge email to the participant.
    *   It updates the participant's status (e.g., to `nudged_1`) and resets their `last_request_sent_at` timestamp.
    *   *(Current Logic)* If Nudge 1 was sent, it also sends a notification email to the organizer.
    *   *(Future/Potential Logic)* If the escalation threshold is met, it sends an escalation email to the organizer and updates the session status.
7.  **Return Response:** The endpoint returns a success response.
