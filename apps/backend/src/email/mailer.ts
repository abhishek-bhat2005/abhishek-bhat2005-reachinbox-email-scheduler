import nodemailer from "nodemailer";

import type { AppConfig } from "../config/env.js";

type SmtpConfig = Pick<
  AppConfig,
  | "SMTP_CONNECTION_TIMEOUT_MS"
  | "SMTP_HOST"
  | "SMTP_PASSWORD"
  | "SMTP_PORT"
  | "SMTP_SECURE"
  | "SMTP_SOCKET_TIMEOUT_MS"
  | "SMTP_USER"
>;

export interface EmailMessage {
  scheduledEmailId: string;
  fromName: string;
  fromEmail: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
}

export interface DeliveryReceipt {
  messageId: string;
  previewUrl: string | null;
  acceptedCount: number;
  rejectedCount: number;
}

export interface Mailer {
  send(message: EmailMessage): Promise<DeliveryReceipt>;
  close(): void;
}

function messageId(scheduledEmailId: string): string {
  return `<scheduled-${scheduledEmailId}@reachinbox.local>`;
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    connectionTimeout: config.SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeout: config.SMTP_SOCKET_TIMEOUT_MS,
  });

  return {
    async send(message) {
      const info = await transporter.sendMail({
        from: { name: message.fromName, address: message.fromEmail },
        to: message.recipientEmail,
        subject: message.subject,
        text: message.bodyText,
        messageId: messageId(message.scheduledEmailId),
      });
      const previewUrl = nodemailer.getTestMessageUrl(info);

      return {
        messageId: info.messageId,
        previewUrl: previewUrl === false ? null : previewUrl,
        acceptedCount: info.accepted.length,
        rejectedCount: info.rejected.length,
      };
    },
    close() {
      transporter.close();
    },
  };
}
