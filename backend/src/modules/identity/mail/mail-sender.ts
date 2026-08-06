/**
 * MailSender port (docs/26 §14 D2).
 *
 * Development and test environments use the captured, non-delivering
 * implementation below; production sending stays disabled until the identity
 * region and email-delivery service are owner-approved. No production
 * provider is selected or configured anywhere in this slice.
 *
 * Secrecy rule (docs/25 §7): message bodies may carry sensitive content, so
 * the ONLY sanctioned log representation of a mail is `mailLogLine`, which
 * exposes the template name and an opaque recipient digest — never the body,
 * subject line, or raw address.
 */
import { createHash } from 'node:crypto';

export interface MailMessage {
  to: string;
  /** Stable template identifier (e.g. 'account_exists_notice'). */
  template: string;
  subject: string;
  body: string;
}

export interface MailSender {
  /** Network I/O in real implementations — call outside DB transactions. */
  send(message: MailMessage): Promise<void>;
}

export interface CapturedMail extends MailMessage {
  capturedAt: Date;
}

/** Captured, non-delivering MailSender for development and tests. */
export class CaptureMailSender implements MailSender {
  readonly captured: CapturedMail[] = [];

  async send(message: MailMessage): Promise<void> {
    this.captured.push({ ...message, capturedAt: new Date() });
  }
}

/** Template + opaque recipient digest; structurally free of message content. */
export function mailLogLine(message: MailMessage): string {
  const digest = createHash('sha256').update(message.to).digest('hex').slice(0, 12);
  return `mail template=${message.template} recipient=${digest}`;
}
