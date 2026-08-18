-- CreateEnum
CREATE TYPE "EmailBatchStatus" AS ENUM ('CREATING', 'SCHEDULED', 'PARTIALLY_FAILED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ScheduledEmailStatus" AS ENUM ('SCHEDULED', 'RATE_LIMITED', 'PROCESSING', 'RETRYABLE', 'SENT', 'FAILED', 'DELIVERY_UNKNOWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SendAttemptOutcome" AS ENUM ('CLAIMED', 'RATE_LIMITED', 'SMTP_ACCEPTED', 'DEFINITE_FAILURE', 'TRANSIENT_FAILURE', 'DELIVERY_UNKNOWN');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "google_subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "avatar_url" TEXT,
    "last_login_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_senders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "normalized_email" VARCHAR(320) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "hourly_limit" INTEGER NOT NULL,
    "minimum_delay_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_senders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_batches" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(998) NOT NULL,
    "body_text" TEXT NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "requested_hourly_limit" INTEGER NOT NULL,
    "requested_minimum_delay_ms" INTEGER NOT NULL,
    "source_filename" VARCHAR(255) NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "valid_recipient_count" INTEGER NOT NULL,
    "invalid_recipient_count" INTEGER NOT NULL,
    "duplicate_recipient_count" INTEGER NOT NULL,
    "status" "EmailBatchStatus" NOT NULL DEFAULT 'CREATING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_emails" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "recipient_email" VARCHAR(320) NOT NULL,
    "normalized_recipient_email" VARCHAR(320) NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "status" "ScheduledEmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "bull_job_id" VARCHAR(255) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "processing_token" UUID,
    "processing_started_at" TIMESTAMPTZ(3),
    "smtp_message_id" VARCHAR(998),
    "ethereal_preview_url" TEXT,
    "last_error_code" VARCHAR(100),
    "last_error_message" TEXT,
    "rate_limited_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scheduled_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "send_attempts" (
    "id" UUID NOT NULL,
    "scheduled_email_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "attempt_token" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "outcome" "SendAttemptOutcome" NOT NULL,
    "response_metadata" JSONB,
    "error_code" VARCHAR(100),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "send_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "email_senders_user_id_is_active_idx" ON "email_senders"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "email_senders_user_id_normalized_email_key" ON "email_senders"("user_id", "normalized_email");

-- CreateIndex
CREATE INDEX "email_batches_user_id_created_at_idx" ON "email_batches"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "email_batches_sender_id_status_idx" ON "email_batches"("sender_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_batches_user_id_idempotency_key_key" ON "email_batches"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_emails_bull_job_id_key" ON "scheduled_emails"("bull_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_emails_idempotency_key_key" ON "scheduled_emails"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_emails_processing_token_key" ON "scheduled_emails"("processing_token");

-- CreateIndex
CREATE INDEX "scheduled_emails_batch_id_sequence_number_idx" ON "scheduled_emails"("batch_id", "sequence_number");

-- CreateIndex
CREATE INDEX "scheduled_emails_sender_id_status_scheduled_at_idx" ON "scheduled_emails"("sender_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "scheduled_emails_status_next_attempt_at_idx" ON "scheduled_emails"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "scheduled_emails_sent_at_idx" ON "scheduled_emails"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_emails_batch_id_normalized_recipient_email_key" ON "scheduled_emails"("batch_id", "normalized_recipient_email");

-- CreateIndex
CREATE UNIQUE INDEX "send_attempts_attempt_token_key" ON "send_attempts"("attempt_token");

-- CreateIndex
CREATE INDEX "send_attempts_scheduled_email_id_started_at_idx" ON "send_attempts"("scheduled_email_id", "started_at");

-- CreateIndex
CREATE INDEX "send_attempts_outcome_started_at_idx" ON "send_attempts"("outcome", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "send_attempts_scheduled_email_id_attempt_number_key" ON "send_attempts"("scheduled_email_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "email_senders" ADD CONSTRAINT "email_senders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_batches" ADD CONSTRAINT "email_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_batches" ADD CONSTRAINT "email_batches_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "email_senders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "email_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "email_senders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_scheduled_email_id_fkey" FOREIGN KEY ("scheduled_email_id") REFERENCES "scheduled_emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
