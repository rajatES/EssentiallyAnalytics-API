import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * The one SMTP transport for the API — scheduled reports and sign-in codes
 * both send through it, configured by SMTP_HOST / SMTP_PORT / SMTP_USER /
 * SMTP_PASS (and SMTP_FROM for the sender).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;

  constructor() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
      this.logger.warn(
        'SMTP not configured — emails will be disabled. Set SMTP_HOST, SMTP_USER, SMTP_PASS.',
      );
      this.transporter = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    this.logger.log(`SMTP transporter initialized: ${host}:${port}`);
  }

  isConfigured(): boolean {
    return !!this.transporter;
  }

  fromAddress(): string {
    return process.env.SMTP_FROM || process.env.SMTP_USER || 'reports@studio.local';
  }

  /** Throws when unconfigured or when the send fails, so callers can tell "sent" from "dropped". */
  async send(options: nodemailer.SendMailOptions): Promise<void> {
    if (!this.transporter) {
      throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
    }
    await this.transporter.sendMail({ from: this.fromAddress(), ...options });
  }
}
