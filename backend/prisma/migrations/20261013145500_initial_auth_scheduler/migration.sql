DO $$ BEGIN
  CREATE TYPE "EmailStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT NOT NULL,
  "googleId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "picture" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Email" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "userId" TEXT,
  "senderEmail" TEXT NOT NULL,
  "senderName" TEXT NOT NULL,
  "recipients" TEXT[] NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "status" "EmailStatus" NOT NULL DEFAULT 'SCHEDULED',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Email" ADD COLUMN IF NOT EXISTS "userId" TEXT;

CREATE TABLE IF NOT EXISTS "SlackIntegration" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "teamName" TEXT,
  "channelId" TEXT,
  "encryptedAccessToken" TEXT NOT NULL,
  "botUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SlackIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "Email_idempotencyKey_key" ON "Email"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "Email_status_scheduledAt_idx" ON "Email"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "Email_senderEmail_createdAt_idx" ON "Email"("senderEmail", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "SlackIntegration_userId_key" ON "SlackIntegration"("userId");

DO $$ BEGIN
  ALTER TABLE "Email" ADD CONSTRAINT "Email_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SlackIntegration" ADD CONSTRAINT "SlackIntegration_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
